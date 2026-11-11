import { sweepUnusedMedia } from "./media-sweep.ts";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { and, eq, lte, or } from "drizzle-orm";
import { db } from "../db/index.ts";
import { mediaDeletions, users } from "../db/schema.ts";
import { AuthError } from "../auth/provider.ts";
import type { BannerCrop } from "./banner-crop.ts";
import { avatarStorage, putAvatar } from "./r2.ts";

// Future media routes use stageMediaUpload before writing an object, then remove
// its pending deletion in the same transaction that attaches it to its owner.
export async function stageMediaUpload(
  key: string,
  body: Buffer,
  contentType = "image/avif",
) {
  await db
    .insert(mediaDeletions)
    .values({ key, availableAt: new Date(Date.now() + 3600000) });
  try {
    await putAvatar(key, body, contentType);
  } catch (error) {
    await db
      .update(mediaDeletions)
      .set({ availableAt: new Date() })
      .where(eq(mediaDeletions.key, key));
    await flushMediaDeletions(key);
    throw error;
  }
}

type ProfileMedia =
  | { kind: "avatar"; key: string }
  | {
      kind: "banner";
      key: string | null;
      url: string | null;
      crop: BannerCrop | null;
    };
export async function replaceProfileMedia(userId: string, media: ProfileMedia) {
  let previous: string | null = null;
  try {
    previous = await db.transaction(async (tx) => {
      const [user] = await tx
        .select({ avatarKey: users.avatarKey, bannerKey: users.bannerKey })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      if (!user) throw new AuthError(401, "sign_in_required");
      const previous =
        media.kind === "avatar" ? user.avatarKey : user.bannerKey;
      await tx
        .update(users)
        .set(
          media.kind === "avatar"
            ? { avatarKey: media.key, updatedAt: new Date() }
            : {
                bannerKey: media.key,
                bannerExternalUrl: media.url,
                bannerCrop: media.crop,
                updatedAt: new Date(),
              },
        )
        .where(eq(users.id, userId));
      if (media.key)
        await tx
          .delete(mediaDeletions)
          .where(eq(mediaDeletions.key, media.key));
      if (previous && previous !== media.key)
        await tx
          .insert(mediaDeletions)
          .values({ key: previous })
          .onConflictDoUpdate({
            target: mediaDeletions.key,
            set: { availableAt: new Date() },
          });
      return previous;
    });
  } catch (error) {
    // An unattached upload is already in the outbox; make it immediately due.
    if (media.key)
      await db
        .update(mediaDeletions)
        .set({ availableAt: new Date() })
        .where(eq(mediaDeletions.key, media.key));
    if (media.key) await flushMediaDeletions(media.key);
    throw error;
  }
  if (previous && previous !== media.key) await flushMediaDeletions(previous);
}

export async function flushMediaDeletions(key?: string) {
  if (!avatarStorage) return;
  const { client, bucket } = avatarStorage;
  try {
    for (let processed = 0; processed < 25; processed++) {
      const found = await db.transaction(async (tx) => {
        // Multiple API processes can safely drain the same outbox.
        const [job] = await tx
          .select()
          .from(mediaDeletions)
          .where(
            and(
              lte(mediaDeletions.availableAt, new Date()),
              key ? eq(mediaDeletions.key, key) : undefined,
            ),
          )
          .orderBy(mediaDeletions.availableAt)
          .limit(1)
          .for("update", { skipLocked: true });
        if (!job) return false;
        const [active] = await tx
          .select({ id: users.id })
          .from(users)
          .where(or(eq(users.avatarKey, job.key), eq(users.bannerKey, job.key)))
          .limit(1);
        if (!active) {
          try {
            // Deleting an already absent key succeeds, including after a crash.
            await client.send(
              new DeleteObjectCommand({ Bucket: bucket, Key: job.key }),
              { abortSignal: AbortSignal.timeout(5000) },
            );
          } catch {
            await tx
              .update(mediaDeletions)
              .set({
                attempts: job.attempts + 1,
                availableAt: new Date(
                  Date.now() +
                    Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 7)),
                ),
              })
              .where(eq(mediaDeletions.key, job.key));
            return true;
          }
        }
        await tx.delete(mediaDeletions).where(eq(mediaDeletions.key, job.key));
        return true;
      });
      if (!found) break;
    }
  } catch {
    console.error({ event: "media_cleanup_unavailable" });
  }
}

export function startMediaCleanup() {
  if (!avatarStorage) return () => {};
  void flushMediaDeletions();
  let sweeping = false;
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      await sweepUnusedMedia(true);
      await flushMediaDeletions();
    } catch {
      console.error({ event: "media_sweep_unavailable" });
    } finally {
      sweeping = false;
    }
  }
  void sweep();
  const sweepTimer = setInterval(() => void sweep(), 6 * 60 * 60 * 1000);
  sweepTimer.unref();
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void flushMediaDeletions().finally(() => {
      running = false;
    });
  }, 30000);
  timer.unref();
  return () => {
    clearInterval(timer);
    clearInterval(sweepTimer);
  };
}
