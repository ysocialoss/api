import { Router } from "express";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { db } from "./db/index.ts";
import { postTopics, posts } from "./db/schema.ts";
import { AuthError } from "./auth/provider.ts";
import { extractTopics, isTopicName, normalizeTopic } from "./topics-text.ts";
import { visiblePost } from "./post-data.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const TRENDING_WINDOW_HOURS = 24;
const TRENDING_LIMIT = 3;
const SUGGESTION_LIMIT = 6;

// Make a post's topics match its text. Call in the transaction that
// writes the post. A topic repeated in the text is stored, and counted, once.
export async function syncPostTopics(
  tx: Transaction,
  postId: string,
  content: string,
) {
  const topics = extractTopics(content);
  await tx
    .delete(postTopics)
    .where(
      and(
        eq(postTopics.postId, postId),
        topics.length ? notInArray(postTopics.topic, topics) : undefined,
      ),
    );
  if (topics.length)
    await tx
      .insert(postTopics)
      .values(topics.map((topic) => ({ postId, topic })))
      .onConflictDoNothing();
}

/** A topic name from a URL or query string, or a 400. */
export function parseTopicName(value: unknown) {
  if (typeof value !== "string") throw new AuthError(400, "invalid_topic");
  const topic = normalizeTopic(value);
  if (!isTopicName(topic)) throw new AuthError(400, "invalid_topic");
  return topic;
}

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
// Without a prefix: the most used topics of the last 24 hours. With one:
// existing topics starting with it, most used first, for autocomplete.
router.get("/", async (req, res) => {
  if (req.query.prefix === undefined) {
    const rows = await db
      .select({
        name: postTopics.topic,
        count: sql<number>`count(*)::int`,
      })
      .from(postTopics)
      .innerJoin(posts, eq(posts.id, postTopics.postId))
      .where(
        and(visiblePost, sql`${posts.createdAt} > now() - make_interval(hours => ${TRENDING_WINDOW_HOURS})`),
      )
      .groupBy(postTopics.topic)
      .orderBy(
        desc(sql`count(*)`),
        desc(sql`max(${posts.createdAt})`),
        postTopics.topic,
      )
      .limit(TRENDING_LIMIT);
    res.json({ topics: rows, windowHours: TRENDING_WINDOW_HOURS });
    return;
  }
  const prefix = parseTopicName(req.query.prefix);
  const rows = await db
    .select({ name: postTopics.topic, count: sql<number>`count(*)::int` })
    .from(postTopics)
    .innerJoin(posts, eq(posts.id, postTopics.postId))
    .where(and(visiblePost, sql`starts_with(${postTopics.topic}, ${prefix})`))
    .groupBy(postTopics.topic)
    .orderBy(desc(sql`count(*)`), postTopics.topic)
    .limit(SUGGESTION_LIMIT);
  res.json({ topics: rows });
});
router.get("/:name", async (req, res) => {
  const name = parseTopicName(req.params.name);
  const [row] = await db
    .select({ posts: sql<number>`count(*)::int` })
    .from(postTopics)
    .innerJoin(posts, eq(posts.id, postTopics.postId))
    .where(and(visiblePost, eq(postTopics.topic, name)));
  res.json({ topic: { name, posts: row?.posts ?? 0 } });
});
export default router;
