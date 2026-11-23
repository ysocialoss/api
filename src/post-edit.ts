import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import type { db } from "./db/index.ts";
import { postEdits, posts } from "./db/schema.ts";
import { affectedPostIds, publishLiveChange } from "./live-events.ts";
import { syncMentions } from "./mentions.ts";
import { syncPostTopics } from "./topics.ts";

export const postContentSchema = z.strictObject({
  content: z.string().trim()
    .refine((value) => !value.includes("\u0000"))
    .refine(
      (value) => !/(?:^|\n)(?:[^\S\n]*\n){3}/.test(value.replace(/\r\n?|[\u2028\u2029]/g, "\n")),
      "Use at most two blank lines in a row.",
    )
    .refine((value) => Array.from(value).length <= 2000),
});

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Editor = { kind: "author"; id: string } | { kind: "admin" };

export async function editPost(tx: Transaction, { id, content, editor }: {
  id: string;
  content: string;
  editor: Editor;
}) {
  // Acquire the row before evaluating the author's edit window.
  const [existing] = await tx.select({
    authorId: posts.authorId,
    content: posts.content,
    gif: posts.gif,
    voice: posts.voice,
    imageIds: posts.imageIds,
    poll: posts.poll,
    createdAt: posts.createdAt,
    editedAt: posts.editedAt,
  }).from(posts).where(eq(posts.id, id)).for("update");
  if (!existing) throw new AuthError(404, "post_not_found");
  if (editor.kind === "author" && existing.authorId !== editor.id)
    throw new AuthError(403, "not_post_author");
  if (!content && !existing.gif && !existing.poll && !existing.voice && !existing.imageIds.length)
    throw new AuthError(400, "invalid_content");

  const changed = existing.content !== content;
  if (editor.kind === "admin" && !changed) return { authorId: existing.authorId, changed };

  const [saved] = await tx.update(posts)
    .set({ content, editedAt: sql`clock_timestamp()` })
    .where(and(
      eq(posts.id, id),
      editor.kind === "author" ? sql`clock_timestamp() < ${posts.createdAt} + interval '15 minutes'` : undefined,
    ))
    .returning({ id: posts.id });
  if (!saved) throw new AuthError(409, "edit_window_expired");
  await syncPostTopics(tx, id, content);
  if (changed) {
    await tx.insert(postEdits).values({
      postId: id, content: existing.content, versionAt: existing.editedAt ?? existing.createdAt,
    });
  }
  await syncMentions(tx, id, editor.kind === "author" ? editor.id : null, content);
  await publishLiveChange(tx, await affectedPostIds(tx, id));
  return { authorId: existing.authorId, changed };
}
