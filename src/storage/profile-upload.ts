import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { AuthError } from "../auth/provider.ts";
import { screenImage, withImageModeration } from "../image-moderation.ts";
import { avatarUploadLimit, normalizeAvatar } from "./avatar-image.ts";
import { bannerCropSchema } from "./banner-crop.ts";
import { bannerScreeningImage, bannerUploadLimit, normalizeBanner } from "./banner-image.ts";
import { stageMediaUpload } from "./media-lifecycle.ts";
import { requireAvatarStorage } from "./r2.ts";
import { scanUpload } from "../safety/hash-match.ts";

export async function stageAvatarUpload(req: Request, res: Response, uploaderId: string) {
  requireAvatarStorage();
  if (!req.is("image/png")) throw new AuthError(415, "avatar_png_required");
  await new Promise<void>((resolve, reject) => {
    express.raw({ type: "image/png", limit: avatarUploadLimit })(
      req,
      res,
      (error) => (error ? reject(error) : resolve()),
    );
  });
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body)) throw new AuthError(400, "invalid_avatar");
  await scanUpload({ bytes: body, mime: "image/png", surface: "avatar", uploaderId, ip: req.ip });
  return withImageModeration(async () => {
    const image = await normalizeAvatar(body);
    await screenImage({ data: image, uploaderId });
    const key = `avatars/${randomUUID()}.avif`;
    await stageMediaUpload(key, image);
    return { kind: "avatar" as const, key };
  });
}

export async function stageBannerUpload(req: Request, res: Response, uploaderId: string) {
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
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body)) throw new AuthError(400, "invalid_banner");
  let crop;
  try {
    crop = bannerCropSchema.parse(JSON.parse(String(req.query.crop)));
  } catch {
    throw new AuthError(400, "invalid_banner_crop");
  }
  await scanUpload({ bytes: body, mime: req.get("content-type") ?? "", surface: "banner", uploaderId, ip: req.ip });
  const image = await normalizeBanner(body);
  if (!image.animated) {
    await withImageModeration(async () => {
      const data = await bannerScreeningImage(image.body);
      await screenImage({ data, uploaderId });
    });
  }
  const key = `banners/${randomUUID()}.${image.extension}`;
  await stageMediaUpload(key, image.body, image.contentType);
  return { kind: "banner" as const, key, url: null, crop };
}
