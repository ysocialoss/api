import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { env } from "./config.ts";
import { db } from "./db/index.ts";
import { mediaDeletions, postImageFlags } from "./db/schema.ts";
import { stageMediaUpload } from "./storage/media-lifecycle.ts";

const imageType = "image/avif";
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

export async function withImageModeration<T>(work: () => Promise<T>): Promise<T> {
  if (processing >= 4) throw new AuthError(429, "post_image_busy");
  processing++;
  try {
    return await work();
  } finally {
    processing--;
  }
}

async function checkImage(data: Buffer<ArrayBuffer>) {
  const body = new FormData();
  body.set("file", new Blob([data], { type: imageType }), "image.avif");
  try {
    const response = await fetch(scanner, {
      method: "POST", body,
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
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

async function recordFlag({
  uploaderId, filename, confidence, data,
}: Pick<typeof postImageFlags.$inferInsert, "uploaderId" | "filename" | "confidence"> & { data: Buffer }) {
  const objectKey = `flagged-images/${randomUUID()}.avif`;
  await stageMediaUpload(objectKey, data, imageType);
  await db.transaction(async (tx) => {
    const [staged] = await tx.delete(mediaDeletions)
      .where(and(eq(mediaDeletions.key, objectKey), gt(mediaDeletions.availableAt, new Date())))
      .returning({ key: mediaDeletions.key });
    if (!staged) throw new AuthError(503, "avatar_storage_unavailable");
    await tx.insert(postImageFlags).values({ uploaderId, filename, confidence, objectKey });
  });
}

export async function screenImage({ data, uploaderId, filename = null }: {
  data: Buffer<ArrayBuffer>;
  uploaderId: string;
  filename?: string | null;
}) {
  const verdict = await checkImage(data);
  if (!verdict.is_nsfw) return;
  await recordFlag({ uploaderId, filename, confidence: verdict.confidence_percentage, data });
  throw new AuthError(422, "post_image_rejected");
}
