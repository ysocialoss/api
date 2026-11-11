import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users, mediaDeletions } from "../db/schema.ts";
import { requireAvatarStorage } from "./r2.ts";

export async function sweepUnusedMedia(remove = false) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const { client, bucket } = requireAvatarStorage();
  let unused = 0;
  for (const media of [
    { prefix: "avatars/", column: users.avatarKey },
    { prefix: "banners/", column: users.bannerKey },
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
        /^(avatars|banners)\/[a-f0-9-]{36}\.(avif|png|webp|gif|jpg)$/.test(
          object.Key,
        ) &&
        object.LastModified &&
        object.LastModified.getTime() < cutoff
          ? [object.Key]
          : [],
      );
      const saved = candidates.length
        ? await db
            .select({ key: media.column })
            .from(users)
            .where(inArray(media.column, candidates))
        : [];
      const active = new Set(saved.map((row) => row.key));
      for (const key of candidates) {
        if (active.has(key)) continue;
        if (remove)
          await db.insert(mediaDeletions).values({ key }).onConflictDoNothing();
        unused++;
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
  }
  return unused;
}
