import { Router } from "express";
import { z } from "zod";
import { requireStaff } from "./admin-access.ts";
import { defaultConfig, loadConfig } from "./ranking/config.ts";
import { feedDashboard } from "./ranking/stats.ts";

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const rangeSchema = z.object({ days: z.coerce.number().int().refine((value) => [7, 14, 30].includes(value)).default(14) });
const cache = new Map<number, { at: number; value: Awaited<ReturnType<typeof feedDashboard>> }>();

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

export default router;
