import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { inArray, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { avatarHistory, mediaDeletions, postImages, posts, users } from "../db/schema.ts";
import { requireAvatarStorage } from "./r2.ts";

export async function sweepUnusedMedia(remove = false, database = db) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const { client, bucket } = requireAvatarStorage();
  let unused = 0;
  for (const media of [
    { prefix: "avatars/", column: users.avatarKey, table: users },
    { prefix: "banners/", column: users.bannerKey, table: users },
    { prefix: "voices/", column: sql<string>`${posts.voice}->>'key'`, table: posts },
    { prefix: "post-images/", column: postImages.objectKey, table: postImages },
  ]) {
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: media.prefix,
          ContinuationToken: continuationToken,
        }),
        { abortSignal: AbortSignal.timeout(15000) },
      );
      const candidates = (page.Contents ?? []).flatMap((object) =>
        object.Key &&
        /^(avatars|banners|voices|post-images)\/[a-f0-9-]{36}\.(avif|png|webp|gif|jpg|m4a)$/.test(
          object.Key,
        ) &&
        object.LastModified &&
        object.LastModified.getTime() < cutoff
          ? [object.Key]
          : [],
      );
      const saved = candidates.length
        ? await database
            .select({ key: media.column })
            .from(media.table)
            .where(inArray(sql<string>`${media.column}`, candidates))
        : [];
      const recent =
        candidates.length && media.prefix === "avatars/"
          ? await database
              .select({ key: avatarHistory.key })
              .from(avatarHistory)
              .where(inArray(avatarHistory.key, candidates))
          : [];
      const active = new Set([...saved, ...recent].map((row) => row.key));
      for (const key of candidates) {
        if (active.has(key)) continue;
        if (remove)
          await database.insert(mediaDeletions).values({ key }).onConflictDoNothing();
        unused++;
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
  }
  return unused;
}
