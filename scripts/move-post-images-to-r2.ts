// I should sleep more. In the last few days i've implemented attachments multiple times.
// This time, I want to make sure that the images are stored in R2 instead of Postgres.
// Code below copies post images still stored in Postgres to R2.
// Run with --dry-run to only count what is left.
import { randomUUID } from "node:crypto";
import { and, asc, count, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { db, pool } from "../src/db/index.ts";
import { mediaDeletions, postImages } from "../src/db/schema.ts";
import { flushMediaDeletions, stageMediaUpload } from "../src/storage/media-lifecycle.ts";
import { requireAvatarStorage } from "../src/storage/r2.ts";

const batchSize = 50;
const inDatabase = and(isNull(postImages.objectKey), isNotNull(postImages.data));

try {
  requireAvatarStorage();
  const [{ value: remaining }] = await db.select({ value: count() }).from(postImages).where(inDatabase);
  console.info({ event: "post_images_in_database", count: remaining });
  if (!process.argv.includes("--dry-run")) {
    let moved = 0;
    let skipped = 0;
    let after: string | undefined;
    for (;;) {
      const batch = await db.select({ id: postImages.id, data: postImages.data }).from(postImages)
        .where(and(inDatabase, after ? gt(postImages.id, after) : undefined))
        .orderBy(asc(postImages.id)).limit(batchSize);
      if (!batch.length) break;
      for (const { id, data } of batch) {
        after = id;
        if (!data) continue;
        const key = `post-images/${randomUUID()}.avif`;
        await stageMediaUpload(key, data, "image/avif");
        const saved = await db.transaction(async (tx) => {
          const [row] = await tx.update(postImages).set({ objectKey: key, data: null })
            .where(and(eq(postImages.id, id), isNull(postImages.objectKey)))
            .returning({ id: postImages.id });
          if (row) await tx.delete(mediaDeletions).where(eq(mediaDeletions.key, key));
          return Boolean(row);
        });
        if (saved) {
          moved++;
        } else {
          // The row was deleted or moved while this upload ran; drop the copy.
          skipped++;
          await db.update(mediaDeletions).set({ availableAt: new Date() }).where(eq(mediaDeletions.key, key));
          await flushMediaDeletions(key);
        }
      }
      console.info({ event: "post_images_moved", moved, skipped });
    }
    console.info({
      event: "post_images_move_finished", moved, skipped,
      next: "Run VACUUM FULL post_images to return the freed space to disk.",
    });
  }
} finally {
  await pool.end();
}
