import { randomUUID } from "node:crypto";
import { backfillFeedEvents } from "./ranking/backfill.ts";
import { Router, type Request } from "express";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import { feedEvents, feedRequests, users } from "./db/schema.ts";
import { cookie, requireApprovedUser, requireUser } from "./auth/request.ts";
import { readSession } from "./auth/session.ts";
import { AuthError } from "./auth/provider.ts";
import { followingFeed } from "./feed-entries.ts";
import { clientKind, ingestClientEvents } from "./ranking/events.ts";
import { bumpCounter } from "./ranking/counters.ts";
import { forYouPage, shadowFollowing } from "./ranking/pipeline.ts";

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
  res.json({ personalize: user.feedPersonalize, chosen: user.feedChoiceAt !== null });
});

const preferencesSchema = z.strictObject({ personalize: z.boolean(), source: z.enum(["nav"]).optional() });
router.patch("/preferences", async (req, res) => {
  const user = await requireUser(req);
  const input = preferencesSchema.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_feed_preferences");
  const alreadyOn = user.feedPersonalize && user.feedChoiceAt !== null;
  const saved = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({ feedPersonalize: input.data.personalize, feedChoiceAt: sql`coalesce(${users.feedChoiceAt}, now())`, updatedAt: sql`now()` })
      .where(eq(users.id, user.id))
      .returning({ personalize: users.feedPersonalize });
    if (input.data.personalize && !alreadyOn) await backfillFeedEvents(tx, user.id);
    if (input.data.personalize) return { ...row, chosen: true, cleared: 0 };
    const cleared = await tx.delete(feedEvents).where(eq(feedEvents.userId, user.id));
    await tx.delete(feedRequests).where(eq(feedRequests.userId, user.id));
    return { ...row, chosen: true, cleared: cleared.rowCount ?? 0 };
  });
  if (input.data.source === "nav") await bumpCounter(input.data.personalize ? "choice_unlock_nav" : "choice_decline_nav");
  res.json(saved);
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
    return cleared.rowCount ?? 0;
  });
  res.json({ cleared: result });
});

export default router;
