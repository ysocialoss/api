import express, { type Response } from "express";
import { randomUUID } from "node:crypto";
import { and, count, eq, gt, isNotNull, isNull, lte } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { requireUser, readViewerId } from "./auth/request.ts";
import { env } from "./config.ts";
import { db } from "./db/index.ts";
import { mediaDeletions, postImageFlags, postImages, users } from "./db/schema.ts";
import { stageMediaUpload } from "./storage/media-lifecycle.ts";
import { avatarStorage } from "./storage/r2.ts";

export const maxPostImages = 4;
const maxUploadBytes = 8 * 1024 * 1024;
const draftLifetimeMs = 60 * 60 * 1000;
const flagLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const outputType = "image/avif";
export const imageFlagCutoff = () => new Date(Date.now() - flagLifetimeMs);
const formats = new Set(["jpeg", "png", "webp"]);
const scanner = new URL("/v1/detect", env.NSFW_CHECK_URL ?? (
  env.NODE_ENV === "production"
    ? "http://nsfw-api.nsfw-api.svc.cluster.local:8000"
    : "http://127.0.0.1:8000"
));
const verdictSchema = z.object({
  is_nsfw: z.boolean(),
  confidence_percentage: z.number().min(0).max(100).optional(),
});
let processing = 0;

function isAnimatedPng(data: Buffer) {
  // libvips may expose only the default frame of an APNG as a PNG image.
  // APNG declares animation in an acTL chunk before the first IDAT chunk.
  for (let offset = 8; offset + 12 <= data.length;) {
    const chunk = data.toString("ascii", offset + 4, offset + 8);
    if (chunk === "acTL") return true;
    if (chunk === "IDAT") return false;
    offset += 12 + data.readUInt32BE(offset);
  }
  return false;
}

async function normalizeImage(data: Buffer) {
  try {
    const image = sharp(data, { limitInputPixels: 25_000_000, failOn: "warning" });
    const { format, pages } = await image.metadata();
    if (!format || !formats.has(format) || (pages ?? 1) !== 1 ||
        (format === "png" && isAnimatedPng(data)))
      throw new Error("Unsupported image format");
    return await image.autoOrient()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .avif({ quality: 60, effort: 4 })
      .toBuffer();
  } catch {
    throw new AuthError(400, "invalid_post_image");
  }
}

async function checkImage(data: Buffer<ArrayBuffer>) {
  const body = new FormData();
  body.set("file", new Blob([data], { type: outputType }), "image.avif");
  try {
    const response = await fetch(scanner, {
      method: "POST", body, signal: AbortSignal.timeout(15_000), redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Image check returned HTTP ${response.status}`);
    }
    return verdictSchema.parse(await response.json());
  } catch (cause) {
    console.warn({ event: "post_image_check_failed", cause });
    throw new AuthError(503, "post_image_check_unavailable");
  }
}

function uploadFilename(header: string | undefined) {
  if (!header) return null;
  try {
    const name = decodeURIComponent(header).split(/[\\/]/).at(-1) ?? "";
    return Array.from(name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim()).slice(0, 255).join("") || null;
  } catch {
    return null;
  }
}

async function recordFlag({
  uploaderId, filename, confidence, data,
}: Pick<typeof postImageFlags.$inferInsert, "uploaderId" | "filename" | "confidence"> & { data: Buffer }) {
  const flag = { uploaderId, filename, confidence };
  if (avatarStorage) {
    const objectKey = `flagged-images/${randomUUID()}.avif`;
    try {
      await stageMediaUpload(objectKey, data, outputType);
      await db.transaction(async (tx) => {
        const [staged] = await tx.delete(mediaDeletions)
          .where(and(eq(mediaDeletions.key, objectKey), gt(mediaDeletions.availableAt, new Date())))
          .returning({ key: mediaDeletions.key });
        if (!staged) throw new AuthError(503, "avatar_storage_unavailable");
        await tx.insert(postImageFlags).values({ ...flag, objectKey });
      });
      return;
    } catch (error) {
      if (!(error instanceof AuthError) || error.code !== "avatar_storage_unavailable") throw error;
      console.warn({ event: "post_image_flag_storage_unavailable" });
    }
  }
  await db.insert(postImageFlags).values({ ...flag, data });
}

export function sendPostImage(res: Response, data: Buffer) {
  res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.type(outputType).send(data);
}

const router = express.Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
const draft = isNull(postImages.postId);
export const postImageUploadBody = express.raw({ type: "application/octet-stream", limit: maxUploadBytes, inflate: false });

export async function processPostImage<T>(
  { body, uploaderId, filename }: { body: unknown; uploaderId: string; filename: string | undefined },
  save: (data: Buffer) => Promise<T>,
): Promise<T> {
  if (!Buffer.isBuffer(body) || !body.length)
    throw new AuthError(400, "invalid_post_image");
  if (processing >= 4) throw new AuthError(429, "post_image_busy");
  processing++;
  try {
    const data = await normalizeImage(body);
    const verdict = await checkImage(data);
    if (verdict.is_nsfw) {
      await recordFlag({
        uploaderId,
        filename: uploadFilename(filename),
        confidence: verdict.confidence_percentage,
        data,
      });
      throw new AuthError(422, "post_image_rejected");
    }
    return await save(data);
  } finally {
    processing--;
  }
}

router.post("/", async (req, res, next) => {
  res.locals.uploaderId = (await requireUser(req)).id;
  next();
}, postImageUploadBody, async (req, res) => {
  const uploaderId: string = res.locals.uploaderId;
  const id = await processPostImage(
    { body: req.body, uploaderId, filename: req.get("x-post-image-name") },
    (data) => db.transaction(async (tx) => {
      const [uploader] = await tx.select({ approvedAt: users.approvedAt, bannedAt: users.bannedAt })
        .from(users).where(eq(users.id, uploaderId)).for("update");
      if (!uploader?.approvedAt || uploader.bannedAt) throw new AuthError(403, "post_image_upload_forbidden");
      const now = new Date();
      const [pending] = await tx.select({ value: count() }).from(postImages)
        .where(and(eq(postImages.uploaderId, uploaderId), draft, gt(postImages.expiresAt, now)));
      if (pending.value >= 16) throw new AuthError(429, "post_image_draft_limit");
      const [saved] = await tx.insert(postImages)
        .values({ uploaderId, data, expiresAt: new Date(now.getTime() + draftLifetimeMs) })
        .returning({ id: postImages.id });
      return saved.id;
    }),
  );
  res.status(201).json({ id });
});

router.get("/:id", async (req, res) => {
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "post_image_not_found");
  const [published] = await db.select({ data: postImages.data }).from(postImages)
    .innerJoin(users, eq(users.id, postImages.uploaderId))
    .where(and(eq(postImages.id, id.data), isNotNull(postImages.postId), isNull(users.bannedAt)));
  if (published) return sendPostImage(res, published.data);

  const viewerId = await readViewerId(req);
  const [owned] = viewerId ? await db.select({ data: postImages.data }).from(postImages)
    .innerJoin(users, eq(users.id, postImages.uploaderId))
    .where(and(eq(postImages.id, id.data), eq(postImages.uploaderId, viewerId), draft,
      gt(postImages.expiresAt, new Date()), isNull(users.bannedAt))) : [];
  if (!owned) throw new AuthError(404, "post_image_not_found");
  sendPostImage(res, owned.data);
});

router.delete("/:id", async (req, res) => {
  const user = await requireUser(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "post_image_not_found");
  await db.delete(postImages).where(and(eq(postImages.id, id.data), eq(postImages.uploaderId, user.id), draft));
  res.sendStatus(204);
});

export function startPostImageCleanup() {
  const sweep = () => {
    void db.delete(postImages).where(and(draft, lte(postImages.expiresAt, new Date())))
      .catch((cause: unknown) => console.error({ event: "post_image_cleanup_failed", cause }));
    void db.delete(postImageFlags).where(lte(postImageFlags.createdAt, imageFlagCutoff()))
      .catch((cause: unknown) => console.error({ event: "post_image_flag_cleanup_failed", cause }));
  };
  sweep();
  const timer = setInterval(sweep, 15 * 60 * 1000);
  return () => clearInterval(timer);
}

export default router;
