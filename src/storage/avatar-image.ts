import sharp from "sharp";
import { AuthError } from "../auth/provider.ts";

export const avatarUploadLimit = 2 * 1024 * 1024;

export async function normalizeAvatar(input: Buffer) {
  if (!input.length || input.length > avatarUploadLimit)
    throw new AuthError(400, "invalid_avatar");
  try {
    const image = sharp(input, {
      limitInputPixels: 4096 * 4096,
      animated: false,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    if (
      !["png", "jpeg", "webp"].includes(metadata.format) ||
      (metadata.pages ?? 1) > 1
    )
      throw new Error("Unsupported image");
    // Decode and re-encode; never persist source metadata or client-supplied bytes.
    return await image
      .rotate()
      .resize(512, 512, { fit: "cover", withoutEnlargement: true })
      .avif({ quality: 55, effort: 4 })
      .toBuffer();
  } catch {
    throw new AuthError(400, "invalid_avatar");
  }
}
