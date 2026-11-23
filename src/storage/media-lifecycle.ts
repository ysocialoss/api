import type { PoolClient } from "pg";
import { sweepUnusedMedia } from "./media-sweep.ts";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { and, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { createDatabase, db, pool } from "../db/index.ts";
import { avatarHistory, mediaDeletions, moderationActivity, posts, users } from "../db/schema.ts";
import { AuthError } from "../auth/provider.ts";
import type { BannerCrop } from "./banner-crop.ts";
import { avatarStorage, putAvatar } from "./r2.ts";

// Future media routes use stageMediaUpload before writing an object, then remove
// its pending deletion in the same transaction that attaches it to its owner.
export async function stageMediaUpload(
  key: string,
  body: Buffer,
  contentType = "image/avif",
  lifetimeMs = 3600000,
) {
  const [pending] = await db
    .insert(mediaDeletions)
    .values({ key, availableAt: sql`now() + ${lifetimeMs} * interval '1 millisecond'` })
    .returning({ availableAt: mediaDeletions.availableAt });
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
  return pending.availableAt;
}

export const recentAvatarLimit = 5;

type ProfileMedia =
  | { kind: "avatar"; key: string; fromRecent?: boolean }
  | {
      kind: "banner";
      key: string | null;
      url: string | null;
      crop: BannerCrop | null;
    };

export async function queueDeletion(tx: Pick<typeof db, "insert">, key: string) {
  await tx
    .insert(mediaDeletions)
    .values({ key })
    .onConflictDoUpdate({
      target: mediaDeletions.key,
      set: { availableAt: new Date() },
    });
}

export async function replaceProfileMedia(userId: string, media: ProfileMedia, adminId?: string) {
  let removed: string[] = [];
  try {
    removed = await db.transaction(async (tx) => {
      const locked = await tx
        .select({
          id: users.id, handle: users.handle, role: users.role, bannedAt: users.bannedAt,
          avatarKey: users.avatarKey, bannerKey: users.bannerKey,
        })
        .from(users)
        .where(inArray(users.id, adminId ? [adminId, userId] : [userId]))
        .orderBy(users.id)
        .for("update");
      const user = locked.find((row) => row.id === userId);
      if (adminId) {
        const actor = locked.find((row) => row.id === adminId);
        if (actor?.role !== "admin" || actor.bannedAt)
          throw new AuthError(403, "admin_required");
        if (!user) throw new AuthError(404, "user_not_found");
        await tx.insert(moderationActivity).values({
          actorId: actor.id, actorHandle: actor.handle, targetId: user.id, targetHandle: user.handle,
          action: media.kind === "avatar" ? "replaceAvatar" : "replaceBanner",
        });
      }
      if (!user) throw new AuthError(401, "sign_in_required");
      if (media.kind === "avatar") {
        if (media.fromRecent) {
          const [recent] = await tx
            .select({ key: avatarHistory.key })
            .from(avatarHistory)
            .where(
              and(
                eq(avatarHistory.key, media.key),
                eq(avatarHistory.userId, userId),
              ),
            );
          if (!recent) throw new AuthError(404, "avatar_not_found");
        }
        await tx
          .update(users)
          .set({ avatarKey: media.key, identityAvatarHidden: false, updatedAt: new Date() })
          .where(eq(users.id, userId));
        if (user.avatarKey && user.avatarKey !== media.key)
          await tx
            .insert(avatarHistory)
            .values({
              key: user.avatarKey,
              userId,
              usedAt: new Date(Date.now() - 1),
            })
            .onConflictDoNothing();
        await tx
          .insert(avatarHistory)
          .values({ key: media.key, userId })
          .onConflictDoUpdate({
            target: avatarHistory.key,
            set: { usedAt: new Date() },
          });
        await tx
          .delete(mediaDeletions)
          .where(eq(mediaDeletions.key, media.key));
        const stale = (
          await tx
            .select({ key: avatarHistory.key })
            .from(avatarHistory)
            .where(eq(avatarHistory.userId, userId))
            .orderBy(desc(avatarHistory.usedAt))
            .offset(recentAvatarLimit + 1)
        ).map((row) => row.key);
        for (const key of stale) {
          await tx.delete(avatarHistory).where(eq(avatarHistory.key, key));
          await queueDeletion(tx, key);
        }
        return stale;
      }
      await tx
        .update(users)
        .set({
          bannerKey: media.key,
          bannerExternalUrl: media.url,
          bannerCrop: media.crop,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
      if (media.key)
        await tx
          .delete(mediaDeletions)
          .where(eq(mediaDeletions.key, media.key));
      if (user.bannerKey && user.bannerKey !== media.key) {
        await queueDeletion(tx, user.bannerKey);
        return [user.bannerKey];
      }
      return [];
    });
  } catch (error) {
    // An unattached upload is already in the outbox; make it immediately due.
    if (media.key && !(media.kind === "avatar" && media.fromRecent)) {
      await db
        .update(mediaDeletions)
        .set({ availableAt: new Date() })
        .where(eq(mediaDeletions.key, media.key));
      await flushMediaDeletions(media.key);
    }
    throw error;
  }
  for (const key of removed) await flushMediaDeletions(key);
}

// The caller locks the profile row before clearing media.
export async function clearProfileMedia(
  tx: Pick<typeof db, "update" | "insert" | "delete">,
  user: { id: string; avatarKey: string | null; bannerKey: string | null },
  kind: "avatar" | "banner",
) {
  const key = kind === "avatar" ? user.avatarKey : user.bannerKey;
  const fields = kind === "avatar"
    ? { avatarKey: null, identityAvatarHidden: true }
    : { bannerKey: null, bannerExternalUrl: null, bannerCrop: null };
  await tx.update(users).set({ ...fields, updatedAt: new Date() }).where(eq(users.id, user.id));
  if (!key) return;
  if (kind === "avatar") {
    await tx.delete(avatarHistory).where(and(eq(avatarHistory.userId, user.id), eq(avatarHistory.key, key)));
  }
  await queueDeletion(tx, key);
}

export async function removeRecentAvatar(userId: string, key: string) {
  await db.transaction(async (tx) => {
    const [user] = await tx
      .select({ avatarKey: users.avatarKey })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!user) throw new AuthError(401, "sign_in_required");
    if (user.avatarKey === key) throw new AuthError(409, "avatar_in_use");
    const deleted = await tx
      .delete(avatarHistory)
      .where(and(eq(avatarHistory.key, key), eq(avatarHistory.userId, userId)))
      .returning({ key: avatarHistory.key });
    if (!deleted.length) throw new AuthError(404, "avatar_not_found");
    await queueDeletion(tx, key);
  });
  await flushMediaDeletions(key);
}

export async function flushMediaDeletions(key?: string, database = db) {
  if (!avatarStorage) return;
  const { client, bucket } = avatarStorage;
  try {
    for (let processed = 0; processed < 25; processed++) {
      const found = await database.transaction(async (tx) => {
        // Multiple API processes can safely drain the same outbox.
        const [job] = await tx
          .select()
          .from(mediaDeletions)
          .where(
            and(
              lte(mediaDeletions.availableAt, sql`now()`),
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
        const [kept] = active
          ? []
          : await tx
              .select({ key: avatarHistory.key })
              .from(avatarHistory)
              .where(eq(avatarHistory.key, job.key))
              .limit(1);
        const [voicePost] = job.key.startsWith("voices/") ? await tx.select({ id: posts.id }).from(posts)
          .where(eq(sql`${posts.voice}->>'key'`, job.key)).limit(1) : [];
        if (!active && !kept && !voicePost) {
          try {
            // Deleting an already absent key succeeds, including after a crash.
            await client.send(
              new DeleteObjectCommand({ Bucket: bucket, Key: job.key }),
              { abortSignal: AbortSignal.timeout(5000) },
            );
          } catch (error) {
            const voice = job.key.startsWith("voices/");
            if (voice) console.warn({
              event: "voice_deletion_retry",
              key: job.key,
              attempt: job.attempts + 1,
              error: error instanceof Error ? error.name : undefined,
            });
            const delay = Math.min(
              voice ? 30_000 : 3_600_000,
              (voice ? 3000 : 30_000) * 2 ** Math.min(job.attempts, 7),
            );
            await tx
              .update(mediaDeletions)
              .set({
                attempts: job.attempts + 1,
                availableAt: sql`now() + ${delay} * interval '1 millisecond'`,
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

const MEDIA_SWEEP_LOCK = 7_001_001;

export function startMediaCleanup() {
  if (!avatarStorage) return () => {};
  let sweeping = false;
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    let lock: PoolClient | undefined;
    try {
      lock = await pool.connect();
      const { rows } = await lock.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [MEDIA_SWEEP_LOCK],
      );
      if (!rows[0]?.locked) return;
      const database = createDatabase(lock);
      await sweepUnusedMedia(true, database);
      await flushMediaDeletions(undefined, database);
    } catch {
      console.error({ event: "media_sweep_unavailable" });
    } finally {
      lock?.release(true);
      sweeping = false;
    }
  }
  void sweep();
  const sweepTimer = setInterval(() => void sweep(), 6 * 60 * 60 * 1000);
  sweepTimer.unref();
  let running = false;
  function drain() {
    if (running) return;
    running = true;
    void flushMediaDeletions().finally(() => {
      running = false;
    });
  }
  drain();
  const timer = setInterval(drain, 3000);
  timer.unref();
  return () => {
    clearInterval(timer);
    clearInterval(sweepTimer);
  };
}
