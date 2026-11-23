import { Router } from "express";
import { and, desc, eq, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import {
  notifications,
  notificationKind,
  posts,
  pushDeliveries,
  pushSubscriptions,
  users,
} from "./db/schema.ts";
import { cookie, readViewerId, requireApprovedUser, requireUser } from "./auth/request.ts";
import { hash } from "./auth/secrets.ts";
import { AuthError } from "./auth/provider.ts";
import { env } from "./config.ts";
import { endpointSchema, subscriptionSchema } from "./push-config.ts";
import { userSelection } from "./user-data.ts";
import { notificationPreview } from "./notification-content.ts";
import { visiblePostAuthor } from "./post-data.ts";
import { notBlockedSql } from "./blocks.ts";
import { publishDmChange } from "./dm-events.ts";

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });
const preferenceSchema = z.enum(notificationKind.enumValues);

router.get("/preferences", async (req, res) => {
  const user = await requireApprovedUser(req);
  const [preferences] = await db.select({ mutedKinds: users.mutedNotificationKinds })
    .from(users).where(eq(users.id, user.id));
  res.json(preferences);
});

router.patch("/preferences", async (req, res) => {
  const user = await requireUser(req);
  const input = z.strictObject({ kind: preferenceSchema, enabled: z.boolean() }).safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_notification_preference");
  const { kind, enabled } = input.data;
  const preferences = await db.transaction(async (tx) => {
    const [saved] = await tx.update(users).set({
      mutedNotificationKinds: enabled
        ? sql`array_remove(${users.mutedNotificationKinds}, ${kind}::text)`
        : sql`case when ${kind}::text = any(${users.mutedNotificationKinds})
            then ${users.mutedNotificationKinds}
            else array_append(${users.mutedNotificationKinds}, ${kind}::text) end`,
    }).where(eq(users.id, user.id)).returning({ mutedKinds: users.mutedNotificationKinds });
    if (kind === "dm_message" || kind === "dm_invite")
      await publishDmChange(tx, user.id, { type: "notifications" });
    return saved;
  });
  res.json(preferences);
});

router.get("/", async (req, res) => {
  const userId = await readViewerId(req);
  if (!userId) throw new AuthError(401, "sign_in_required");
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (req.query.cursor !== undefined) {
    try {
      if (typeof req.query.cursor !== "string" || req.query.cursor.length > 512)
        throw new Error();
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(req.query.cursor, "base64url").toString("utf8")),
      );
    } catch {
      throw new AuthError(400, "invalid_cursor");
    }
  }
  const unreadQuery = z
    .enum(["true", "false"])
    .optional()
    .safeParse(req.query.unread);
  if (!unreadQuery.success)
    throw new AuthError(400, "invalid_notification_query");
  const unread = unreadQuery.data === "true";
  const [preferences] = await db.select({
    hideContent: users.hideNotificationContent,
    mutedKinds: users.mutedNotificationKinds,
  }).from(users)
    .where(eq(users.id, userId));
  const hideContent = preferences?.hideContent ?? true;
  const mutedDmKinds = preferences?.mutedKinds.filter((kind) => kind === "dm_message" || kind === "dm_invite") ?? [];
  const visibleKind = req.query.includeDms === "true"
    ? mutedDmKinds.length ? notInArray(notifications.kind, mutedDmKinds) : undefined
    : isNull(notifications.conversationId);
  // Older clients validate a closed set of social notification kinds.
  const extendedKinds = req.query.extendedKinds === "true";
  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      postId: notifications.postId,
      conversationId: notifications.conversationId,
      preview: sql<string | null>`case when ${hideContent}::boolean then null else ${posts.content} end`,
      chatPreview: sql<boolean>`not ${hideContent}::boolean and ${notifications.kind} = 'dm_message'`,
      hasGif: sql<boolean>`${posts.gif} IS NOT NULL`,
      hasVoice: sql<boolean>`${posts.voice} IS NOT NULL`,
      imageIds: sql<string[]>`case when ${hideContent}::boolean or ${posts.imageIds} is null then '{}'::uuid[] else ${posts.imageIds} end`,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
      actor: userSelection,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.actorId))
    .leftJoin(posts, and(eq(posts.id, notifications.postId), visiblePostAuthor))
    .where(
      and(
        eq(notifications.recipientId, userId),
        visibleKind,
        notBlockedSql(userId, notifications.actorId),
        unread ? isNull(notifications.readAt) : undefined,
        cursor
          ? or(
              lt(notifications.createdAt, new Date(cursor.createdAt)),
              and(
                eq(notifications.createdAt, new Date(cursor.createdAt)),
                lt(notifications.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(21);
  const [count] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(eq(notifications.recipientId, userId), visibleKind, isNull(notifications.readAt)),
    );
  const page = rows.slice(0, 20),
    last = page.at(-1);
  res.json({
    notifications: page.map(({ hasGif, hasVoice, ...row }) => ({
      ...row,
      kind: extendedKinds ? row.kind : legacyKind(row.kind),
      preview: row.preview === null ? null : notificationPreview(row.preview, hasGif, hasVoice),
    })),
    unreadCount: count.value,
    hideContent,
    nextCursor:
      rows.length > 20 && last
        ? Buffer.from(
            JSON.stringify({
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            }),
          ).toString("base64url")
        : null,
  });
});
function legacyKind(kind: (typeof notificationKind.enumValues)[number]) {
  if (kind === "friends_repost") return "repost";
  if (kind === "friend") return "follow";
  return kind;
}
router.put("/read", async (req, res) => {
  const user = await requireUser(req);
  const input = z
    .strictObject({ through: z.iso.datetime() })
    .safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_notification_query");
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.recipientId, user.id),
        isNull(notifications.readAt),
        req.query.includeDms === "true" ? undefined : isNull(notifications.conversationId),
        sql`${notifications.createdAt} <= ${new Date(input.data.through)}`,
      ),
    );
  res.sendStatus(204);
});
router.put("/:id/read", async (req, res) => {
  const user = await requireUser(req);
  if (!z.uuid().safeParse(req.params.id).success)
    throw new AuthError(400, "invalid_notification_id");
  const [saved] = await db
    .update(notifications)
    .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
    .where(
      and(
        eq(notifications.id, req.params.id),
        eq(notifications.recipientId, user.id),
      ),
    )
    .returning({ id: notifications.id });
  if (!saved) throw new AuthError(404, "notification_not_found");
  res.sendStatus(204);
});
router.patch("/previews", async (req, res) => {
  const user = await requireUser(req);
  const input = z.strictObject({ hideContent: z.boolean() }).safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_notification_query");
  await db.transaction(async (tx) => {
    await tx.update(users).set({ hideNotificationContent: input.data.hideContent }).where(eq(users.id, user.id));
    await publishDmChange(tx, user.id, { type: "previews", hidden: input.data.hideContent });
  });
  res.sendStatus(204);
});
router.get("/push", async (req, res) => {
  const userId = await readViewerId(req);
  if (!userId) throw new AuthError(401, "sign_in_required");
  const endpoint = endpointSchema.optional().safeParse(req.query.endpoint);
  if (!endpoint.success) throw new AuthError(400, "invalid_push_subscription");
  const [user] = await db
    .select({ promptDismissed: users.notificationPromptDismissed, hideContent: users.hideNotificationContent })
    .from(users)
    .where(eq(users.id, userId));
  const [subscription] = endpoint.data
    ? await db
        .select({
          id: pushSubscriptions.id,
          mutedUntil: pushSubscriptions.mutedUntil,
          mutedForever: pushSubscriptions.mutedForever,
        })
        .from(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.endpoint, endpoint.data),
            eq(pushSubscriptions.userId, userId),
            eq(pushSubscriptions.sessionHash, hash(cookie(req, "session"))),
          ),
        )
    : [];
  res.json({
    publicKey: env.PUSH?.publicKey ?? null,
    promptDismissed: user.promptDismissed,
    hideContent: user.hideContent,
    subscribed: !!subscription,
    mutedUntil: subscription?.mutedUntil ?? null,
    mutedForever: subscription?.mutedForever ?? false,
  });
});
router.put("/push/prompt-dismissal", async (req, res) => {
  const user = await requireUser(req);
  await db
    .update(users)
    .set({ notificationPromptDismissed: true })
    .where(eq(users.id, user.id));
  res.sendStatus(204);
});
router.put("/push", async (req, res) => {
  const user = await requireUser(req);
  if (!env.PUSH) throw new AuthError(503, "push_not_configured");
  const input = subscriptionSchema.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_push_subscription");
  const { endpoint, keys } = input.data;
  const values = {
    userId: user.id,
    sessionHash: hash(cookie(req, "session")),
    endpoint,
    ...keys,
  };
  await db
    .insert(pushSubscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        ...values,
        mutedUntil: sql`case when ${pushSubscriptions.userId} = ${user.id} then ${pushSubscriptions.mutedUntil} else null end`,
        mutedForever: sql`case when ${pushSubscriptions.userId} = ${user.id} then ${pushSubscriptions.mutedForever} else false end`,
      },
    });
  res.sendStatus(204);
});
router.patch("/push/mute", async (req, res) => {
  const user = await requireUser(req);
  const input = z
    .strictObject({
      endpoint: endpointSchema,
      duration: z.enum(["1h", "8h", "24h", "1w", "forever", "off"]),
    })
    .safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_push_mute");
  const { endpoint, duration } = input.data;
  const muteHours = { "1h": 1, "8h": 8, "24h": 24, "1w": 168 } as const;
  const mutedUntil =
    duration in muteHours
      ? new Date(Date.now() + muteHours[duration as keyof typeof muteHours] * 3600_000)
      : null;
  const saved = await db.transaction(async (tx) => {
    const [saved] = await tx
      .update(pushSubscriptions)
      .set({ mutedUntil, mutedForever: duration === "forever" })
      .where(
        and(
          eq(pushSubscriptions.endpoint, endpoint),
          eq(pushSubscriptions.userId, user.id),
          eq(pushSubscriptions.sessionHash, hash(cookie(req, "session"))),
        ),
      )
      .returning({
        id: pushSubscriptions.id,
        mutedUntil: pushSubscriptions.mutedUntil,
        mutedForever: pushSubscriptions.mutedForever,
      });
    if (!saved) throw new AuthError(404, "push_subscription_not_found");
    if (duration !== "off")
      await tx
        .delete(pushDeliveries)
        .where(eq(pushDeliveries.subscriptionId, saved.id));
    return { mutedUntil: saved.mutedUntil, mutedForever: saved.mutedForever };
  });
  res.json(saved);
});
router.delete("/push", async (req, res) => {
  const user = await requireUser(req);
  const input = z
    .strictObject({ endpoint: endpointSchema })
    .safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_push_subscription");
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, user.id),
        eq(pushSubscriptions.endpoint, input.data.endpoint),
      ),
    );
  res.sendStatus(204);
});
export default router;
