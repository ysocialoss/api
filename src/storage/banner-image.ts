import sharp, { type Metadata } from "sharp";
import { AuthError } from "../auth/provider.ts";
import { isAnimatedPng } from "./animated-png.ts";

export const bannerUploadLimit = 10 * 1024 * 1024;
const stillMaxSide = 1600;
const animatedMaxWidth = 960;
const animatedKeepBytes = 1024 * 1024;
const limitInputPixels = 40_000_000;

type Banner = { body: Buffer; extension: string; contentType: string };

const pngKeep = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "acTL", "fcTL", "fdAT", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "bKGD"]);

export function stripPngMetadata(data: Buffer) {
  const parts = [data.subarray(0, 8)];
  for (let offset = 8; offset + 12 <= data.length;) {
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) throw new Error("Truncated PNG");
    if (pngKeep.has(data.toString("ascii", offset + 4, offset + 8))) parts.push(data.subarray(offset, end));
    offset = end;
  }
  return Buffer.concat(parts);
}

const formats = {
  gif: { extension: "gif", contentType: "image/gif" },
  webp: { extension: "webp", contentType: "image/webp" },
  png: { extension: "png", contentType: "image/png" },
  jpeg: { extension: "jpg", contentType: "image/jpeg" },
  avif: { extension: "avif", contentType: "image/avif" },
} as const;

async function animatedBanner(input: Buffer, metadata: Metadata): Promise<Banner> {
  const width = metadata.width ?? 0;
  const pipeline = sharp(input, { animated: true, limitInputPixels, failOn: "warning" });
  if (input.length <= animatedKeepBytes && width <= animatedMaxWidth && (metadata.format === "gif" || metadata.format === "webp")) {
    const body = metadata.format === "gif"
      ? await pipeline.gif({ loop: metadata.loop }).toBuffer()
      : await pipeline.webp({ quality: 80, effort: 3, loop: metadata.loop }).toBuffer();
    return { body, ...formats[metadata.format] };
  }
  const body = await pipeline
    .resize({ width: animatedMaxWidth, withoutEnlargement: true })
    .webp({ quality: 70, effort: 3, loop: metadata.loop })
    .toBuffer();
  return { body, ...formats.webp };
}

async function stillBanner(input: Buffer, metadata: Metadata): Promise<Banner> {
  const base = () => sharp(input, { limitInputPixels, failOn: "warning" }).rotate().resize({
    width: stillMaxSide,
    height: stillMaxSide,
    fit: "inside",
    withoutEnlargement: true,
  });
  const avif = { body: await base().avif({ quality: 60, effort: 4 }).toBuffer(), ...formats.avif };
  if (avif.body.length < input.length) return avif;
  const format = metadata.format === "heif" ? "avif" : metadata.format as keyof typeof formats;
  if (!(format in formats) || format === "avif") return avif;
  const same = { body: await base().toFormat(format).toBuffer(), ...formats[format] };
  return same.body.length < avif.body.length ? same : avif;
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
  try {
    if (metadata.format === "png" && isAnimatedPng(input))
      return { body: stripPngMetadata(input), ...formats.png, animated: true };
    if ((metadata.pages ?? 1) > 1) return { ...(await animatedBanner(input, metadata)), animated: true };
    return { ...(await stillBanner(input, metadata)), animated: false };
  } catch {
    throw new AuthError(400, "invalid_banner");
  }
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
