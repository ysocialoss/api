import { and, eq, or, isNull, lte } from "drizzle-orm";
import { db } from "./db/index.ts";
import {
  notifications,
  pushDeliveries,
  pushSubscriptions,
} from "./db/schema.ts";
import { env } from "./config.ts";
import { blockState } from "./blocks.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Event = Pick<
  typeof notifications.$inferInsert,
  "recipientId" | "actorId" | "kind" | "postId" | "subject" | "conversationId"
>;

// Call in the action's transaction. Failed or replayed actions never fan out.
export async function recordNotification(tx: Transaction, event: Event) {
  if (event.recipientId === event.actorId) return;
  const state = await blockState(tx, event.recipientId, event.actorId);
  if (state.blocking || state.blockedBy) return;
  const [saved] = await tx
    .insert(notifications)
    .values(event)
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  if (!saved || !env.PUSH) return;
  const subscriptions = await tx
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, event.recipientId),
        eq(pushSubscriptions.mutedForever, false),
        or(
          isNull(pushSubscriptions.mutedUntil),
          lte(pushSubscriptions.mutedUntil, new Date()),
        ),
      ),
    );
  if (subscriptions.length)
    await tx.insert(pushDeliveries).values(
      subscriptions.map(({ id }) => ({
        notificationId: saved.id,
        subscriptionId: id,
      })),
    );
}
