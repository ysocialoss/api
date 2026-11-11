import {
  stageMediaUpload,
  replaceProfileMedia,
} from "./storage/media-lifecycle.ts";
import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "./auth/request.ts";
import { AuthError } from "./auth/provider.ts";
import { db } from "./db/index.ts";
import { users } from "./db/schema.ts";
import { avatarUploadLimit, normalizeAvatar } from "./storage/avatar-image.ts";
import { getAvatar, requireAvatarStorage } from "./storage/r2.ts";

const router = Router();
router.use((_req, res, next) => {
  res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  next();
});
router.put("/me", async (req, res) => {
  // Authenticate and check the origin before buffering any upload.
  const viewer = await requireUser(req);
  requireAvatarStorage();
  if (!req.is("image/png")) throw new AuthError(415, "avatar_png_required");
  await new Promise<void>((resolve, reject) => {
    express.raw({ type: "image/png", limit: avatarUploadLimit })(
      req,
      res,
      (error) => (error ? reject(error) : resolve()),
    );
  });
  if (!Buffer.isBuffer(req.body)) throw new AuthError(400, "invalid_avatar");
  const image = await normalizeAvatar(req.body);
  const key = `avatars/${randomUUID()}.avif`;
  // Store first. Failed writes never replace the currently saved avatar.
  await stageMediaUpload(key, image);
  await replaceProfileMedia(viewer.id, { kind: "avatar", key });
  res.json({ avatarUrl: `/api/${key}` });
});
router.get("/:file", async (req, res) => {
  const file = z
    .string()
    .regex(/^[a-f0-9-]{36}\.(avif|png)$/)
    .safeParse(req.params.file);
  if (
    !file.success ||
    !z.string().uuid().safeParse(file.data.split(".")[0]).success
  )
    throw new AuthError(404, "avatar_not_found");
  // Keep previously uploaded PNG avatars readable.
  const key = `avatars/${file.data}`;
  // Only the current avatar is public; replaced and orphaned objects are inaccessible.
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.avatarKey, key))
    .limit(1);
  if (!user) throw new AuthError(404, "avatar_not_found");
  const body = await getAvatar(key);
  res
    .type(key.endsWith(".avif") ? "image/avif" : "image/png")
    .send(Buffer.from(body));
});
export default router;
