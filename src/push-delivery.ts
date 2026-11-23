import * as webpush from "web-push";
import { and, eq, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "./db/index.ts";
import {
  authSessions,
  authIdentities,
  notifications,
  posts,
  pushDeliveries,
  pushSubscriptions,
  users,
} from "./db/schema.ts";
import { env } from "./config.ts";
import { userSelection } from "./user-data.ts";
import { pushNotificationContent } from "./notification-content.ts";
import { visiblePost } from "./post-data.ts";

const recipient = alias(users, "push_recipient");

export async function flushPushDeliveries(send = webpush.sendNotification) {
  const vapidDetails = env.PUSH;
  if (!vapidDetails) return;
  // available_at is set by the database in microseconds while Date truncates
  // to milliseconds, so a row made due in the same millisecond would look not
  // yet due and be skipped.
  const dueBy = new Date(Date.now() + 1);
  // Bounded batches and SKIP LOCKED let multiple API replicas drain safely.
  for (let i = 0; i < 25; i++) {
    const found = await db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(pushDeliveries)
        .where(lte(pushDeliveries.availableAt, dueBy))
        .orderBy(pushDeliveries.availableAt)
        .limit(1)
        .for("update", { skipLocked: true });
      if (!job) return false;
      const where = and(
        eq(pushDeliveries.notificationId, job.notificationId),
        eq(pushDeliveries.subscriptionId, job.subscriptionId),
      );
      const [event] = await tx
        .select({
          notification: notifications,
          subscription: pushSubscriptions,
          actor: userSelection,
          hideContent: recipient.hideNotificationContent,
          mutedKinds: recipient.mutedNotificationKinds,
          content: posts.content,
          hasGif: sql<boolean>`${posts.gif} IS NOT NULL`,
          hasVoice: sql<boolean>`${posts.voice} IS NOT NULL`,
          expiresAt: authSessions.expiresAt,
        })
        .from(notifications)
        .innerJoin(users, eq(users.id, notifications.actorId))
        .innerJoin(recipient, and(eq(recipient.id, notifications.recipientId), sql`${recipient.bannedAt} is null`))
        .leftJoin(posts, and(eq(posts.id, notifications.postId), visiblePost))
        .innerJoin(
          pushSubscriptions,
          eq(pushSubscriptions.id, job.subscriptionId),
        )
        .innerJoin(
          authSessions,
          eq(authSessions.tokenHash, pushSubscriptions.sessionHash),
        )
        .innerJoin(authIdentities, and(
          eq(authIdentities.id, authSessions.identityId),
          eq(authIdentities.userId, pushSubscriptions.userId),
          eq(authIdentities.sessionVersion, authSessions.sessionVersion),
          sql`${authIdentities.deletedAt} is null`,
        ))
        .where(eq(notifications.id, job.notificationId));
      if (
        !event ||
        event.notification.readAt ||
        event.mutedKinds.includes(event.notification.kind) ||
        event.subscription.mutedForever ||
        (event.subscription.mutedUntil &&
          event.subscription.mutedUntil > new Date()) ||
        event.expiresAt <= new Date() ||
        event.notification.recipientId !== event.subscription.userId
      ) {
        await tx.delete(pushDeliveries).where(where);
        return true;
      }
      const { notification, subscription } = event;
      try {
        await send(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify(pushNotificationContent(event)),
          { vapidDetails, TTL: 3600, timeout: 10_000, urgency: "normal" },
        );
      } catch (error) {
        if (
          error instanceof webpush.WebPushError &&
          [404, 410].includes(error.statusCode)
        ) {
          await tx
            .delete(pushSubscriptions)
            .where(eq(pushSubscriptions.id, subscription.id));
          return true;
        }
        if (job.attempts < 5) {
          await tx
            .update(pushDeliveries)
            .set({
              attempts: job.attempts + 1,
              availableAt: new Date(
                Date.now() + Math.min(3600_000, 30_000 * 2 ** job.attempts),
              ),
            })
            .where(where);
          console.warn({
            event: "push_delivery_retry",
            notificationId: notification.id,
          });
          return true;
        }
        console.error({
          event: "push_delivery_failed",
          notificationId: notification.id,
        });
      }
      await tx.delete(pushDeliveries).where(where);
      return true;
    });
    if (!found) break;
  }
}

export function startPushDelivery() {
  if (!env.PUSH) return () => {};
  let running = false;
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      await flushPushDeliveries();
    } catch {
      console.error({ event: "push_worker_unavailable" });
    } finally {
      running = false;
    }
  };
  void drain();
  const timer = setInterval(() => void drain(), 5000);
  timer.unref();
  return () => clearInterval(timer);
}
