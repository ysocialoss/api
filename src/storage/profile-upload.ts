import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { AuthError } from "../auth/provider.ts";
import { avatarUploadLimit, normalizeAvatar } from "./avatar-image.ts";
import { bannerCropSchema } from "./banner-crop.ts";
import { bannerUploadLimit, normalizeBanner } from "./banner-image.ts";
import { stageMediaUpload } from "./media-lifecycle.ts";
import { requireAvatarStorage } from "./r2.ts";

export async function stageAvatarUpload(req: Request, res: Response) {
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
  return { kind: "avatar" as const, key };
}

export async function stageBannerUpload(req: Request, res: Response) {
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
  return { kind: "banner" as const, key, url: null, crop };
}
