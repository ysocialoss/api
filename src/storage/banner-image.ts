import sharp from "sharp";
import { AuthError } from "../auth/provider.ts";

export const bannerUploadLimit = 10 * 1024 * 1024;
export async function normalizeBanner(input: Buffer) {
  if (!input.length || input.length > bannerUploadLimit)
    throw new AuthError(400, "invalid_banner");
  try {
    const image = sharp(input, {
      animated: true,
      limitInputPixels: 40_000_000,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    const avif = metadata.format === "heif" && metadata.compression === "av1";
    if (
      (!avif && !["jpeg", "png", "webp", "gif"].includes(metadata.format)) ||
      (metadata.pages ?? 1) > 120
    )
      throw new Error("Unsupported banner");
    // Validate the decoded content, but keep the original bytes and animation.
    const contentType =
      metadata.format === "jpeg"
        ? "image/jpeg"
        : metadata.format === "heif"
          ? "image/avif"
          : `image/${metadata.format}`;
    if (!contentType) throw new Error("Unsupported banner");
    return {
      body: input,
      extension:
        metadata.format === "heif"
          ? "avif"
          : metadata.format === "jpeg"
            ? "jpg"
            : metadata.format,
      contentType,
    };
  } catch {
    throw new AuthError(400, "invalid_banner");
  }
}
