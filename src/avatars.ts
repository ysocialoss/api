import {
  replaceProfileMedia,
  removeRecentAvatar,
  recentAvatarLimit,
} from "./storage/media-lifecycle.ts";
import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { readViewerId, requireUser } from "./auth/request.ts";
import { AuthError } from "./auth/provider.ts";
import { db } from "./db/index.ts";
import { avatarHistory, users } from "./db/schema.ts";
import { stageAvatarUpload } from "./storage/profile-upload.ts";
import { getAvatar } from "./storage/r2.ts";

const router = Router();
router.use((_req, res, next) => {
  res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  next();
});
router.put("/me", async (req, res) => {
  // Authenticate and check the origin before buffering any upload.
  const viewer = await requireUser(req);
  const media = await stageAvatarUpload(req, res, viewer.id);
  await replaceProfileMedia(viewer.id, media);
  res.json({ avatarUrl: `/api/${media.key}` });
});
function avatarFile(value: unknown) {
  const file = z
    .string()
    .regex(/^[a-f0-9-]{36}\.(avif|png)$/)
    .safeParse(value);
  if (
    !file.success ||
    !z.string().uuid().safeParse(file.data.split(".")[0]).success
  )
    throw new AuthError(404, "avatar_not_found");
  return file.data;
}
router.get("/recent", async (req, res) => {
  const viewerId = await readViewerId(req);
  if (!viewerId) throw new AuthError(401, "sign_in_required");
  const rows = await db
    .select({ key: avatarHistory.key })
    .from(avatarHistory)
    .innerJoin(users, eq(users.id, avatarHistory.userId))
    .where(
      and(
        eq(avatarHistory.userId, viewerId),
        sql`${avatarHistory.key} is distinct from ${users.avatarKey}`,
      ),
    )
    .orderBy(desc(avatarHistory.usedAt))
    .limit(recentAvatarLimit);
  res.json({
    avatars: rows.map(({ key }) => ({
      id: key.slice("avatars/".length),
      avatarUrl: `/api/${key}`,
    })),
  });
});
router.post("/recent/:file", async (req, res) => {
  const viewer = await requireUser(req);
  const key = `avatars/${avatarFile(req.params.file)}`;
  await replaceProfileMedia(viewer.id, { kind: "avatar", key, fromRecent: true });
  res.json({ avatarUrl: `/api/${key}` });
});
router.delete("/recent/:file", async (req, res) => {
  const viewer = await requireUser(req);
  await removeRecentAvatar(viewer.id, `avatars/${avatarFile(req.params.file)}`);
  res.sendStatus(204);
});
router.get("/:file", async (req, res) => {
  // Keep previously uploaded PNG avatars readable.
  const key = `avatars/${avatarFile(req.params.file)}`;
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.avatarKey, key))
    .limit(1);
  if (!user) {
    const viewerId = await readViewerId(req);
    const [recent] = viewerId
      ? await db
          .select({ key: avatarHistory.key })
          .from(avatarHistory)
          .where(
            and(eq(avatarHistory.key, key), eq(avatarHistory.userId, viewerId)),
          )
          .limit(1)
      : [];
    if (!recent) throw new AuthError(404, "avatar_not_found");
    res.set("Cache-Control", "private, max-age=3600");
  }
  const body = await getAvatar(key);
  res
    .type(key.endsWith(".avif") ? "image/avif" : "image/png")
    .send(Buffer.from(body));
});
export default router;
