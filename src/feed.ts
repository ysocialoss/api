import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import { feedEvents, users } from "./db/schema.ts";
import { requireApprovedUser, requireUser } from "./auth/request.ts";
import { AuthError } from "./auth/provider.ts";
import { followingFeed } from "./feed-entries.ts";
import { readCursor } from "./posts.ts";
import { clientKind, ingestClientEvents } from "./ranking/events.ts";

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.post("/events", async (req, res) => {
  const user = await requireUser(req);
  if (user.feedPersonalize && user.feedChoiceAt) await ingestClientEvents(user.id, req.body, clientKind(req));
  res.status(204).end();
});

router.get("/following", async (req, res) => {
  const user = await requireApprovedUser(req);
  const cursor = readCursor(req.query.cursor);
  const feed = await followingFeed(user.id, cursor && { createdAt: cursor.createdAt, id: cursor.id }, 20);
  res.json({ ...feed, serverNow: new Date().toISOString() });
});

router.get("/preferences", async (req, res) => {
  const user = await requireApprovedUser(req);
  res.json({ personalize: user.feedPersonalize, chosen: user.feedChoiceAt !== null });
});

const preferencesSchema = z.strictObject({ personalize: z.boolean() });
router.patch("/preferences", async (req, res) => {
  const user = await requireUser(req);
  const input = preferencesSchema.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_feed_preferences");
  const saved = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({ feedPersonalize: input.data.personalize, feedChoiceAt: sql`coalesce(${users.feedChoiceAt}, now())`, updatedAt: sql`now()` })
      .where(eq(users.id, user.id))
      .returning({ personalize: users.feedPersonalize });
    const cleared = input.data.personalize ? null : await tx.delete(feedEvents).where(eq(feedEvents.userId, user.id));
    return { ...row, chosen: true, cleared: cleared?.rowCount ?? 0 };
  });
  res.json(saved);
});

router.post("/reset", async (req, res) => {
  const user = await requireUser(req);
  const result = await db.delete(feedEvents).where(eq(feedEvents.userId, user.id));
  res.json({ cleared: result.rowCount ?? 0 });
});

export default router;
