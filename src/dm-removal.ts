import { and, eq, isNull } from "drizzle-orm";
import type { db } from "./db/index.ts";
import { dmAttachments, dmMessages, dmPollVotes, dmReactions, notifications } from "./db/schema.ts";
import { publishDmChange } from "./dm-events.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function eraseDmMessage(tx: Transaction, conversationId: string, messageId: string, participantIds: string[], senderId?: string) {
  const [deleted] = await tx.update(dmMessages)
    .set({ deletedAt: new Date(), iv: "", ciphertext: "", signature: "", envelopes: {} })
    .where(and(
      eq(dmMessages.id, messageId), eq(dmMessages.conversationId, conversationId),
      senderId ? eq(dmMessages.senderId, senderId) : undefined, isNull(dmMessages.deletedAt),
    ))
    .returning({ id: dmMessages.id });
  if (!deleted) return false;
  await tx.delete(dmReactions).where(eq(dmReactions.messageId, messageId));
  await tx.delete(dmPollVotes).where(eq(dmPollVotes.messageId, messageId));
  await tx.delete(dmAttachments).where(eq(dmAttachments.messageId, messageId));
  await tx.delete(notifications).where(and(eq(notifications.conversationId, conversationId), eq(notifications.kind, "dm_message"), eq(notifications.subject, messageId)));
  for (const userId of participantIds) await publishDmChange(tx, userId, { type: "conversation", id: conversationId, roster: false, message: messageId });
  return true;
}
