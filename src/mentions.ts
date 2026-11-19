import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "./db/index.ts";
import { postMentions, userHandles } from "./db/schema.ts";
import { recordNotification } from "./notification-events.ts";

// Reject email addresses, URL paths, and partial/overlong handles.
export function mentionHandles(content: string) {
  return [...new Set(Array.from(
    content.matchAll(/(?<![\p{L}\p{N}_@/.])@([a-z0-9_]{3,32})(?![\p{L}\p{N}_])/giu),
    (match) => match[1].toLowerCase(),
  ))];
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function syncMentions(tx: Transaction, postId: string, actorId: string, content: string) {
  const handles = mentionHandles(content);
  await tx.delete(postMentions).where(and(
    eq(postMentions.postId, postId),
    handles.length ? notInArray(postMentions.handle, handles) : undefined,
  ));
  if (!handles.length) return;
  const current = await tx.select({ handle: postMentions.handle }).from(postMentions)
    .where(eq(postMentions.postId, postId));
  const existing = new Set(current.map(({ handle }) => handle));
  const unresolved = handles.filter((handle) => !existing.has(handle));
  if (!unresolved.length) return;
  const targets = await tx.select({ id: userHandles.userId, handle: userHandles.handle }).from(userHandles)
    .where(inArray(userHandles.handle, unresolved));
  if (!targets.length) return;
  const added = await tx.insert(postMentions).values(targets.map((user) => ({
    postId, userId: user.id, handle: user.handle,
  }))).onConflictDoNothing().returning({ userId: postMentions.userId });
  for (const target of added) {
    await recordNotification(tx, {
      recipientId: target.userId, actorId, kind: "mention", postId, subject: postId,
    });
  }
}
