import sharp, { type Metadata } from "sharp";
import { AuthError } from "../auth/provider.ts";
import { isAnimatedPng } from "./animated-png.ts";

export const bannerUploadLimit = 10 * 1024 * 1024;
const stillMaxSide = 1600;
const animatedMaxWidth = 960;
const animatedKeepBytes = 1024 * 1024;
const limitInputPixels = 40_000_000;

type Banner = { body: Buffer; extension: string; contentType: string };

async function compress(
  input: Buffer,
  metadata: Metadata,
): Promise<Banner | null> {
  const pages = metadata.pages ?? 1;
  if (pages > 1) {
    const width = metadata.width ?? 0;
    if (input.length <= animatedKeepBytes && width <= animatedMaxWidth)
      return null;
    const body = await sharp(input, {
      animated: true,
      limitInputPixels,
      failOn: "warning",
    })
      .resize({ width: animatedMaxWidth, withoutEnlargement: true })
      .webp({ quality: 70, effort: 3, loop: metadata.loop })
      .toBuffer();
    return { body, extension: "webp", contentType: "image/webp" };
  }
  const body = await sharp(input, {
    limitInputPixels,
    failOn: "warning",
  })
    .rotate()
    .resize({
      width: stillMaxSide,
      height: stillMaxSide,
      fit: "inside",
      withoutEnlargement: true,
    })
    .avif({ quality: 60, effort: 4 })
    .toBuffer();
  return { body, extension: "avif", contentType: "image/avif" };
}

export async function normalizeBanner(input: Buffer): Promise<Banner & { animated: boolean }> {
  if (!input.length || input.length > bannerUploadLimit)
    throw new AuthError(400, "invalid_banner");
  let metadata: Metadata;
  try {
    const image = sharp(input, {
      animated: true,
      limitInputPixels,
      failOn: "warning",
    });
    metadata = await image.metadata();
    const avif = metadata.format === "heif" && metadata.compression === "av1";
    if (
      (!avif && !["jpeg", "png", "webp", "gif"].includes(metadata.format)) ||
      (metadata.pages ?? 1) > 120
    )
      throw new Error("Unsupported banner");
  } catch {
    throw new AuthError(400, "invalid_banner");
  }
  const animated = (metadata.pages ?? 1) > 1 ||
    (metadata.format === "png" && isAnimatedPng(input));
  const original = {
    body: input,
    animated,
    extension:
      metadata.format === "heif"
        ? "avif"
        : metadata.format === "jpeg"
          ? "jpg"
          : metadata.format,
    contentType:
      metadata.format === "jpeg"
        ? "image/jpeg"
        : metadata.format === "heif"
          ? "image/avif"
          : `image/${metadata.format}`,
  };
  try {
    const compressed = await compress(input, metadata);
    if (compressed && compressed.body.length < input.length) return { ...compressed, animated };
  } catch {
  }
  return original;
}

export async function bannerScreeningImage(body: Buffer) {
  try {
    return await sharp(body, { limitInputPixels, failOn: "warning" })
      .autoOrient()
      .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
      .avif({ effort: 1 })
      .toBuffer();
  } catch {
    throw new AuthError(400, "invalid_banner");
  }
}
