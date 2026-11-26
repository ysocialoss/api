import express, { type Response } from "express";
import { randomUUID } from "node:crypto";
import { and, count, eq, gt, isNull, lte } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { requireUser, readViewerId } from "./auth/request.ts";
import { db } from "./db/index.ts";
import { postImageFlags, postImages, posts, users } from "./db/schema.ts";
import { screenImage, withImageModeration } from "./image-moderation.ts";
import { isAnimatedPng } from "./storage/animated-png.ts";
import { scanUpload } from "./safety/hash-match.ts";

export const maxPostImages = 4;
const maxUploadBytes = 8 * 1024 * 1024;
const draftLifetimeMs = 60 * 60 * 1000;
const flagLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const outputType = "image/avif";
export const imageFlagCutoff = () => new Date(Date.now() - flagLifetimeMs);
const formats = new Set(["jpeg", "png", "webp"]);

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

function uploadFilename(header: string | undefined) {
  if (!header) return null;
  try {
    const name = decodeURIComponent(header).split(/[\\/]/).at(-1) ?? "";
    return Array.from(name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim()).slice(0, 255).join("") || null;
  } catch {
    return null;
  }
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
  { body, uploaderId, filename, ip }: { body: unknown; uploaderId: string; filename: string | undefined; ip?: string | null },
  save: (data: Buffer) => Promise<T>,
): Promise<T> {
  if (!Buffer.isBuffer(body) || !body.length)
    throw new AuthError(400, "invalid_post_image");
  await scanUpload({ bytes: body, mime: "application/octet-stream", surface: "post_image", uploaderId, ip });
  return withImageModeration(async () => {
    const data = await normalizeImage(body);
    await screenImage({ data, uploaderId, filename: uploadFilename(filename) });
    return save(data);
  });
}

router.post("/", async (req, res, next) => {
  res.locals.uploaderId = (await requireUser(req)).id;
  next();
}, postImageUploadBody, async (req, res) => {
  const uploaderId: string = res.locals.uploaderId;
  const id = await processPostImage(
    { body: req.body, uploaderId, filename: req.get("x-post-image-name"), ip: req.ip },
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
    .innerJoin(posts, eq(posts.id, postImages.postId))
    .where(and(eq(postImages.id, id.data), isNull(users.bannedAt), isNull(posts.hiddenAt)));
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
