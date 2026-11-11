import {
  stageMediaUpload,
  replaceProfileMedia,
} from "./storage/media-lifecycle.ts";
import { bannerCropSchema } from "./storage/banner-crop.ts";
import { searchGifs, selectedGifUrl } from "./storage/klipy.ts";
import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "./auth/request.ts";
import { AuthError } from "./auth/provider.ts";
import { db } from "./db/index.ts";
import { users } from "./db/schema.ts";
import { bannerUploadLimit, normalizeBanner } from "./storage/banner-image.ts";
import { getAvatar, requireAvatarStorage } from "./storage/r2.ts";

const router = Router();
router.use((_req, res, next) => {
  res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  next();
});
router.post("/gifs/search", async (req, res) => {
  const viewer = await requireUser(req);
  const input = z
    .object({
      query: z.string().trim().max(100).default(""),
      page: z.number().int().min(1).max(100).default(1),
    })
    .safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_search");
  res.json(await searchGifs(input.data.query, input.data.page, viewer.id));
});
router.post("/gifs", async (req, res) => {
  const viewer = await requireUser(req);
  const input = z
    .object({
      token: z.string().max(4096),
      crop: bannerCropSchema.nullable().default(null),
    })
    .safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_gif_selection");
  const url = selectedGifUrl(input.data.token, viewer.id);
  await replaceProfileMedia(viewer.id, {
    kind: "banner",
    key: null,
    url,
    crop: input.data.crop,
  });
  res.json({ bannerUrl: url });
});
router.put("/me", async (req, res) => {
  const viewer = await requireUser(req);
  requireAvatarStorage();
  if (
    !req.is([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "image/avif",
    ])
  )
    throw new AuthError(415, "invalid_banner");
  await new Promise<void>((resolve, reject) => {
    express.raw({ type: () => true, limit: bannerUploadLimit })(
      req,
      res,
      (error) => (error ? reject(error) : resolve()),
    );
  });
  if (!Buffer.isBuffer(req.body)) throw new AuthError(400, "invalid_banner");
  let crop;
  try {
    crop = bannerCropSchema.parse(JSON.parse(String(req.query.crop)));
  } catch {
    throw new AuthError(400, "invalid_banner_crop");
  }
  const image = await normalizeBanner(req.body);
  const key = `banners/${randomUUID()}.${image.extension}`;
  await stageMediaUpload(key, image.body, image.contentType);
  await replaceProfileMedia(viewer.id, {
    kind: "banner",
    key,
    url: null,
    crop,
  });
  res.json({ bannerUrl: `/api/${key}` });
});
router.delete("/me", async (req, res) => {
  const viewer = await requireUser(req);
  await replaceProfileMedia(viewer.id, {
    kind: "banner",
    key: null,
    url: null,
    crop: null,
  });
  res.sendStatus(204);
});
router.get("/:file", async (req, res) => {
  const file = z
    .string()
    .regex(/^[a-f0-9-]{36}\.(avif|webp|gif|jpg|png)$/)
    .safeParse(req.params.file);
  if (
    !file.success ||
    !z.string().uuid().safeParse(file.data.split(".")[0]).success
  )
    throw new AuthError(404, "banner_not_found");
  const key = `banners/${file.data}`;
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.bannerKey, key))
    .limit(1);
  if (!user) throw new AuthError(404, "banner_not_found");
  res
    .type(key.split(".").pop() ?? "application/octet-stream")
    .send(Buffer.from(await getAvatar(key)));
});
export default router;
