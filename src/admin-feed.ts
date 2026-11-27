import { Router } from "express";
import { z } from "zod";
import { requireAdminWrite, requireStaff } from "./admin-access.ts";
import { AuthError } from "./auth/provider.ts";
import { db } from "./db/index.ts";
import { feedConfig, moderationActivity } from "./db/schema.ts";
import { clearConfigCache, configSchema, defaultConfig, loadConfig } from "./ranking/config.ts";
import { feedDashboard } from "./ranking/stats.ts";

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const rangeSchema = z.object({ days: z.coerce.number().int().refine((value) => [7, 14, 30].includes(value)).default(14) });
const cache = new Map<number, { at: number; value: Awaited<ReturnType<typeof feedDashboard>> }>();

export function clearFeedDashboardCache() {
  cache.clear();
}

router.get("/", async (req, res) => {
  await requireStaff(req);
  const input = rangeSchema.safeParse(req.query);
  const range = input.success ? input.data.days : 14;
  const hit = cache.get(range);
  if (hit && Date.now() - hit.at < 60_000) {
    res.json(hit.value);
    return;
  }
  const value = await feedDashboard(range);
  cache.set(range, { at: Date.now(), value });
  res.json(value);
});

router.get("/config", async (req, res) => {
  await requireStaff(req);
  const { id, config } = await loadConfig();
  res.json({ id, config, defaults: defaultConfig });
});

const changeSchema = z.strictObject({ config: configSchema, note: z.string().trim().max(200).optional() });

router.put("/config", async (req, res) => {
  const viewer = await requireAdminWrite(req);
  const input = changeSchema.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_feed_config");
  if (input.data.config.wideWindowHours < input.data.config.windowHours) throw new AuthError(400, "invalid_feed_config");
  const saved = await db.transaction(async (tx) => {
    const [row] = await tx.insert(feedConfig).values({ values: input.data.config, createdBy: viewer.id })
      .returning({ id: feedConfig.id, createdAt: feedConfig.createdAt });
    await tx.insert(moderationActivity).values({
      actorId: viewer.id,
      actorHandle: viewer.handle,
      targetId: viewer.id,
      targetHandle: viewer.handle,
      action: "updateFeedConfig",
      detail: input.data.note || null,
    });
    return row;
  });
  clearConfigCache();
  clearFeedDashboardCache();
  res.json({ id: saved?.id, config: input.data.config });
});

export default router;
