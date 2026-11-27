import { randomUUID } from "node:crypto";
import { backfillFeedEvents } from "./ranking/backfill.ts";
import { Router, type Request } from "express";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import { feedEvents, feedFeedback, feedRequests, users } from "./db/schema.ts";
import { cookie, requireApprovedUser, requireUser } from "./auth/request.ts";
import { readSession } from "./auth/session.ts";
import { AuthError } from "./auth/provider.ts";
import { followingFeed } from "./feed-entries.ts";
import { clientKind, ingestClientEvents, readFeedContext } from "./ranking/events.ts";
import { bumpCounter } from "./ranking/counters.ts";
import { forYouPage, shadowFollowing } from "./ranking/pipeline.ts";
import { loadConfig } from "./ranking/config.ts";
import { clearFeedback, listFeedback, removeFeedback, upsertFeedback } from "./ranking/feedback.ts";
import { explain } from "./ranking/explain.ts";
import { isTopicName, normalizeTopic } from "./topics-text.ts";

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

export async function readFeedViewer(req: Request) {
  const token = cookie(req, "session");
  if (!token) return { id: null, personal: false, optedOut: false };
  try {
    const session = await readSession(token);
    const user = session.kind === "authenticated" ? session.user : null;
    if (!user) return { id: null, personal: false, optedOut: false };
    const active = Boolean(user.approvedAt) && !user.bannedAt;
    const chosen = user.feedChoiceAt !== null;
    return {
      id: user.id,
      personal: active && chosen && user.feedPersonalize,
      optedOut: active && chosen && !user.feedPersonalize,
    };
  } catch (error) {
    if (error instanceof AuthError && error.status === 503) return { id: null, personal: false, optedOut: false };
    throw error;
  }
}

export async function forYouResponse(req: Request) {
  const viewer = await readFeedViewer(req);
  if (viewer.optedOut) throw new AuthError(403, "feed_personalization_required");
  const page = await forYouPage(viewer, req.query.cursor);
  return { ...page, serverNow: new Date().toISOString() };
}

router.post("/events", async (req, res) => {
  const user = await requireUser(req);
  if (user.feedPersonalize && user.feedChoiceAt) await ingestClientEvents(user.id, req.body, clientKind(req));
  res.status(204).end();
});

router.get("/for-you", async (req, res) => {
  res.json(await forYouResponse(req));
});

const followingCursorSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
  n: z.number().int().min(0).max(100_000).optional(),
  c: z.uuid().optional(),
});
function readFollowingCursor(value: unknown) {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== "string" || value.length > 512) throw new Error();
    return followingCursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw new AuthError(400, "invalid_cursor");
  }
}

router.get("/following", async (req, res) => {
  const user = await requireApprovedUser(req);
  const cursor = readFollowingCursor(req.query.cursor);
  const feed = await followingFeed(user.id, cursor && { createdAt: cursor.createdAt, id: cursor.id }, 20);
  const offset = cursor?.n ?? 0;
  const chainId = cursor?.c ?? randomUUID();
  const shadow = user.feedPersonalize && user.feedChoiceAt
    ? await shadowFollowing(user.id, feed.posts, offset, chainId).catch(() => {
      console.error({ event: "feed_shadow_failed" });
      return { requestId: null, placements: {} };
    })
    : { requestId: null, placements: {} };
  const nextCursor = feed.nextCursor
    ? Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(feed.nextCursor, "base64url").toString("utf8")),
      n: offset + feed.posts.length,
      c: chainId,
    })).toString("base64url")
    : null;
  res.json({ ...feed, nextCursor, ...shadow, serverNow: new Date().toISOString() });
});

router.get("/preferences", async (req, res) => {
  const user = await requireApprovedUser(req);
  res.json({
    personalize: user.feedPersonalize,
    chosen: user.feedChoiceAt !== null,
    discovery: user.feedDiscovery,
    freshness: user.feedFreshness,
    replies: user.feedReplies,
  });
});

const sliderSchema = z.number().int().min(-2).max(2);
const preferencesSchema = z.strictObject({
  personalize: z.boolean().optional(),
  discovery: sliderSchema.optional(),
  freshness: sliderSchema.optional(),
  replies: sliderSchema.optional(),
  source: z.enum(["nav"]).optional(),
}).refine((value) => value.personalize !== undefined || value.discovery !== undefined || value.freshness !== undefined || value.replies !== undefined)
  .refine((value) => value.source === undefined || value.personalize !== undefined);
router.patch("/preferences", async (req, res) => {
  const user = await requireUser(req);
  const input = preferencesSchema.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_feed_preferences");
  const { personalize, discovery, freshness, replies } = input.data;
  const alreadyOn = user.feedPersonalize && user.feedChoiceAt !== null;
  const saved = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({
        ...(personalize === undefined ? {} : { feedPersonalize: personalize, feedChoiceAt: sql`coalesce(${users.feedChoiceAt}, now())` }),
        ...(discovery === undefined ? {} : { feedDiscovery: discovery }),
        ...(freshness === undefined ? {} : { feedFreshness: freshness }),
        ...(replies === undefined ? {} : { feedReplies: replies }),
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, user.id))
      .returning({
        personalize: users.feedPersonalize,
        chosenAt: users.feedChoiceAt,
        discovery: users.feedDiscovery,
        freshness: users.feedFreshness,
        replies: users.feedReplies,
      });
    const { chosenAt, ...values } = row!;
    const result = { ...values, chosen: chosenAt !== null, cleared: 0 };
    if (personalize === true && !alreadyOn) await backfillFeedEvents(tx, user.id);
    if (personalize !== false) return result;
    const cleared = await tx.delete(feedEvents).where(eq(feedEvents.userId, user.id));
    await tx.delete(feedRequests).where(eq(feedRequests.userId, user.id));
    return { ...result, cleared: cleared.rowCount ?? 0 };
  });
  if (input.data.source === "nav") await bumpCounter(personalize ? "choice_unlock_nav" : "choice_decline_nav");
  res.json(saved);
});

const direction = z.union([z.literal(1), z.literal(-1)]);
const lowerUuid = z.uuid().transform((id) => id.toLowerCase());
const topicSchema = z.string().max(40).transform((value) => normalizeTopic(value.trim().replace(/^#/, ""))).refine(isTopicName);
const feedbackSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("post"), postId: lowerUuid, direction }),
  z.strictObject({ kind: z.literal("author"), authorId: lowerUuid, direction }),
  z.strictObject({ kind: z.literal("snooze"), authorId: lowerUuid }),
  z.strictObject({ kind: z.literal("topic"), topic: topicSchema, direction }),
]);

router.get("/feedback", async (req, res) => {
  const user = await requireApprovedUser(req);
  res.json(await listFeedback(user.id));
});

router.post("/feedback", async (req, res) => {
  const user = await requireApprovedUser(req);
  const input = feedbackSchema.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_feed_feedback");
  const { config } = await loadConfig();
  const row = await upsertFeedback(user.id, input.data, readFeedContext(req), config);
  res.status(201).json({ id: row.id, direction: row.direction, previousDirection: row.previousDirection, expiresAt: row.expiresAt?.toISOString() ?? null });
});

router.delete("/feedback", async (req, res) => {
  const user = await requireApprovedUser(req);
  const kind = z.enum(["post", "author", "snooze", "topic"]).safeParse(req.query.kind);
  if (!kind.success) throw new AuthError(400, "invalid_feed_feedback");
  res.json({ removed: await clearFeedback(user.id, kind.data) });
});

router.delete("/feedback/:id", async (req, res) => {
  const user = await requireApprovedUser(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "feed_feedback_not_found");
  await removeFeedback(user.id, id.data.toLowerCase());
  res.status(204).end();
});

router.get("/why/:postId", async (req, res) => {
  const user = await requireApprovedUser(req);
  const postId = z.uuid().safeParse(req.params.postId);
  const requestId = z.uuid().safeParse(req.query.request);
  if (!postId.success || !requestId.success) throw new AuthError(404, "feed_explanation_unavailable");
  res.json(await explain(user.id, postId.data.toLowerCase(), requestId.data.toLowerCase()));
});

router.post("/choice-declined", async (req, res) => {
  await requireUser(req);
  await bumpCounter("choice_decline_nav");
  res.status(204).end();
});

router.post("/reset", async (req, res) => {
  const user = await requireUser(req);
  const result = await db.transaction(async (tx) => {
    const cleared = await tx.delete(feedEvents).where(eq(feedEvents.userId, user.id));
    await tx.delete(feedRequests).where(eq(feedRequests.userId, user.id));
    await tx.delete(feedFeedback).where(eq(feedFeedback.userId, user.id));
    await tx.update(users).set({ feedDiscovery: 0, feedFreshness: 0, feedReplies: 0, updatedAt: sql`now()` }).where(eq(users.id, user.id));
    return cleared.rowCount ?? 0;
  });
  res.json({ cleared: result });
});

export default router;
