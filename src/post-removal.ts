import { and, eq, type SQL } from "drizzle-orm";
import type { db } from "./db/index.ts";
import { posts } from "./db/schema.ts";
import { affectedPostIds, publishLiveChange } from "./live-events.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function removePost(tx: Transaction, id: string, options: { condition?: SQL; keepReplies?: boolean } = {}) {
  const where = and(eq(posts.id, id), options.condition);
  let replies: { id: string }[] = [];
  if (options.keepReplies) {
    // Lock the parent against new replies before moving its existing replies.
    const [post] = await tx.select({ parentId: posts.parentId }).from(posts).where(where).for("update");
    if (!post) return;
    replies = await tx.update(posts).set({ parentId: post.parentId }).where(eq(posts.parentId, id)).returning({ id: posts.id });
  }
  const affected = await affectedPostIds(tx, id);
  const [removed] = await tx.delete(posts)
    .where(where)
    .returning({ voice: posts.voice, authorId: posts.authorId });
  if (removed) await publishLiveChange(tx, [...affected, ...replies.map((reply) => reply.id)]);
  return removed;
}
