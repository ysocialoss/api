import { Router } from "express";
import { and, count, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { requireUser } from "./auth/request.ts";
import { db } from "./db/index.ts";
import { dmConversations, dmMessages, posts, reports, users, type ReportSnapshot } from "./db/schema.ts";
import { avatarUrlSelection, publicProfileSelection } from "./user-data.ts";

export const reportReasons = [
  "spam", "harassment", "hate", "violence", "sexual", "self_harm", "misinformation", "impersonation", "illegal", "other",
] as const;
export const maxContextMessages = 5;
const windowMs = 10 * 60_000;
const windowLimit = 20;

const plain = (max: number) => z.string().max(max).refine((value) => !value.includes("\u0000"));
const messageText = z.strictObject({ id: z.uuid(), text: plain(4000) });
const reportInput = z.strictObject({
  reason: z.enum(reportReasons),
  details: plain(1000).trim().default(""),
  target: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("post"), id: z.uuid() }),
    z.strictObject({ type: z.literal("user"), id: z.uuid() }),
    z.strictObject({
      type: z.literal("message"),
      conversationId: z.uuid(),
      messageId: z.uuid(),
      messages: z.array(messageText).min(1).max(maxContextMessages + 1),
    }),
  ]),
});

type Target = { key: string; userId: string; handle: string; conversationId: string | null; snapshot: ReportSnapshot };

async function postTarget(viewerId: string, id: string): Promise<Target> {
  const [post] = await db.select({
    authorId: posts.authorId,
    authorHandle: users.handle,
    authorName: users.displayName,
    content: posts.content,
    parentId: posts.parentId,
    quotedPostId: posts.quotedPostId,
    isQuote: posts.isQuote,
    gifUrl: sql<string | null>`${posts.gif}->>'url'`,
    imageIds: posts.imageIds,
    hasVoice: sql<boolean>`${posts.voice} is not null`,
    pollTitle: sql<string | null>`${posts.poll}->>'title'`,
    createdAt: posts.createdAt,
  }).from(posts).innerJoin(users, eq(users.id, posts.authorId))
    .where(and(eq(posts.id, id), isNull(users.bannedAt), isNull(posts.hiddenAt)));
  if (!post) throw new AuthError(404, "post_not_found");
  if (post.authorId === viewerId) throw new AuthError(409, "own_content");
  return {
    key: id, userId: post.authorId, handle: post.authorHandle, conversationId: null,
    snapshot: {
      type: "post",
      kind: post.isQuote ? "Quote" : post.parentId ? "Reply" : "Post",
      authorHandle: post.authorHandle,
      authorName: post.authorName,
      content: post.content,
      parentId: post.parentId,
      quotedPostId: post.quotedPostId,
      gifUrl: post.gifUrl,
      imageIds: post.imageIds,
      hasVoice: post.hasVoice,
      pollTitle: post.pollTitle,
      createdAt: post.createdAt.toISOString(),
    },
  };
}

async function userTarget(viewerId: string, id: string): Promise<Target> {
  if (id === viewerId) throw new AuthError(409, "own_content");
  const [user] = await db.select({
    handle: users.handle,
    displayName: users.displayName,
    bio: users.bio,
    pronouns: users.pronouns,
    avatarUrl: avatarUrlSelection(users),
    bannerUrl: publicProfileSelection.bannerUrl,
  }).from(users).where(and(eq(users.id, id), isNull(users.bannedAt)));
  if (!user) throw new AuthError(404, "user_not_found");
  return { key: id, userId: id, handle: user.handle, conversationId: null, snapshot: { type: "user", ...user } };
}

async function messageTarget(viewerId: string, input: { conversationId: string; messageId: string; messages: z.infer<typeof messageText>[] }): Promise<Target> {
  const [conversation] = await db.select().from(dmConversations).where(and(
    eq(dmConversations.id, input.conversationId),
    or(eq(dmConversations.firstUserId, viewerId), eq(dmConversations.secondUserId, viewerId)),
  ));
  if (!conversation) throw new AuthError(404, "dm_conversation_not_found");
  const ids = [...new Set(input.messages.map(({ id }) => id))];
  if (ids.length !== input.messages.length || !ids.includes(input.messageId)) throw new AuthError(400, "invalid_report");
  const rows = await db.select({
    id: dmMessages.id,
    senderId: dmMessages.senderId,
    senderHandle: users.handle,
    sequence: dmMessages.sequence,
    createdAt: dmMessages.createdAt,
  }).from(dmMessages).innerJoin(users, eq(users.id, dmMessages.senderId)).where(and(
    eq(dmMessages.conversationId, conversation.id), inArray(dmMessages.id, ids), isNull(dmMessages.deletedAt),
  ));
  if (rows.length !== ids.length) throw new AuthError(404, "dm_message_not_found");
  const reported = rows.find(({ id }) => id === input.messageId)!;
  if (reported.senderId === viewerId) throw new AuthError(409, "own_content");
  if (rows.some(({ sequence }) => sequence > reported.sequence)) throw new AuthError(400, "invalid_report");
  const texts = new Map(input.messages.map(({ id, text }) => [id, text]));
  const peerId = conversation.firstUserId === viewerId ? conversation.secondUserId : conversation.firstUserId;
  const [peer] = await db.select({ handle: users.handle }).from(users).where(eq(users.id, peerId));
  return {
    key: reported.id, userId: reported.senderId, handle: reported.senderHandle, conversationId: conversation.id,
    snapshot: {
      type: "message",
      peerHandle: peer?.handle ?? reported.senderHandle,
      messages: rows.sort((a, b) => (a.sequence < b.sequence ? -1 : 1)).map((row) => ({
        id: row.id,
        senderId: row.senderId,
        senderHandle: row.senderHandle,
        text: texts.get(row.id) ?? "",
        createdAt: row.createdAt.toISOString(),
        reported: row.id === reported.id,
      })),
    },
  };
}

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get("/reasons", (_req, res) => {
  res.json({ reasons: reportReasons, maxContextMessages });
});

router.post("/", async (req, res) => {
  const viewer = await requireUser(req);
  const input = reportInput.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_report");
  const { target, reason, details } = input.data;
  const [recent] = await db.select({ total: count() }).from(reports)
    .where(and(eq(reports.reporterId, viewer.id), gte(reports.createdAt, new Date(Date.now() - windowMs))));
  if (recent.total >= windowLimit) throw new AuthError(429, "report_rate_limited");
  const resolved = target.type === "post" ? await postTarget(viewer.id, target.id)
    : target.type === "user" ? await userTarget(viewer.id, target.id)
    : await messageTarget(viewer.id, target);
  const [created] = await db.insert(reports).values({
    reporterId: viewer.id,
    reporterHandle: viewer.handle,
    targetType: target.type,
    targetKey: resolved.key,
    targetUserId: resolved.userId,
    targetHandle: resolved.handle,
    conversationId: resolved.conversationId,
    reason,
    details,
    snapshot: resolved.snapshot,
  }).onConflictDoNothing().returning({ id: reports.id });
  res.status(created ? 201 : 200).json({ status: created ? "reported" : "already_reported" });
});

export default router;
