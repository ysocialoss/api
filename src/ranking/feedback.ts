import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { feedFeedback, posts, users } from "../db/schema.ts";
import { AuthError } from "../auth/provider.ts";
import { loadUsers } from "../feed-entries.ts";
import { recordFeedEvent, type FeedContext } from "./events.ts";
import type { FeedConfig } from "./config.ts";
import { buildControls, neutralSliders, type ControlRow, type Controls, type FeedbackKind } from "./controls.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function loadControls(viewerId: string, config: FeedConfig): Promise<Controls> {
  const [user] = await db.select({ discovery: users.feedDiscovery, freshness: users.feedFreshness, replies: users.feedReplies })
    .from(users).where(eq(users.id, viewerId)).limit(1);
  const { rows } = await db.execute<ControlRow>(sql`
    select f.kind, f.direction, f.post_id, coalesce(f.author_id, p.author_id) as author_id, f.topic,
      case when f.kind = 'post' then (select array_agg(pt.topic) from post_topics pt where pt.post_id = f.post_id) end as post_topics
    from feed_feedback f left join posts p on p.id = f.post_id
    where f.user_id = ${viewerId}::uuid and (f.expires_at is null or f.expires_at > now())
    order by f.created_at`);
  return buildControls(user ?? neutralSliders, rows, config);
}

export async function loadPostTopics(postIds: string[]) {
  const result = new Map<string, string[]>();
  if (!postIds.length) return result;
  const { rows } = await db.execute<{ post_id: string; topic: string }>(sql`
    select post_id, topic from post_topics where post_id = any(${`{${postIds.join(",")}}`}::uuid[])`);
  for (const row of rows) result.set(row.post_id, [...(result.get(row.post_id) ?? []), row.topic]);
  return result;
}

export type FeedbackInput =
  | { kind: "post"; postId: string; direction: 1 | -1 }
  | { kind: "author"; authorId: string; direction: 1 | -1 }
  | { kind: "snooze"; authorId: string }
  | { kind: "topic"; topic: string; direction: 1 | -1 };

const eventFor = (input: FeedbackInput) => {
  if (input.kind === "snooze") return "snooze" as const;
  if (input.kind === "topic") return input.direction > 0 ? "topic_more" as const : "topic_less" as const;
  return input.direction > 0 ? "more" as const : "less" as const;
};

async function targetAuthor(tx: Transaction, input: FeedbackInput) {
  if (input.kind === "post") {
    const [post] = await tx.select({ authorId: posts.authorId }).from(posts)
      .where(and(eq(posts.id, input.postId), sql`${posts.hiddenAt} is null`)).limit(1);
    if (!post) throw new AuthError(404, "post_not_found");
    return post.authorId;
  }
  if (input.kind === "topic") return null;
  const [author] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.authorId)).limit(1);
  if (!author) throw new AuthError(404, "profile_not_found");
  return author.id;
}

export async function upsertFeedback(userId: string, input: FeedbackInput, context: FeedContext | null, config: FeedConfig) {
  return db.transaction(async (tx) => {
    const authorId = await targetAuthor(tx, input);
    if (authorId === userId) throw new AuthError(400, "invalid_feed_feedback");
    const days = input.kind === "snooze" ? config.controls.snoozeDays : input.kind === "topic" ? null : config.controls.feedbackDays;
    const expiresAt = days === null ? null : sql`now() + ${days} * interval '1 day'`;
    const direction = input.kind === "snooze" ? -1 : input.direction;
    const values = {
      userId,
      kind: input.kind,
      postId: input.kind === "post" ? input.postId : null,
      authorId: input.kind === "author" || input.kind === "snooze" ? input.authorId : null,
      topic: input.kind === "topic" ? input.topic : null,
      direction,
    };
    const target = input.kind === "post"
      ? { target: [feedFeedback.userId, feedFeedback.postId], targetWhere: sql`${feedFeedback.postId} is not null` }
      : input.kind === "topic"
        ? { target: [feedFeedback.userId, feedFeedback.topic], targetWhere: sql`${feedFeedback.topic} is not null` }
        : { target: [feedFeedback.userId, feedFeedback.kind, feedFeedback.authorId], targetWhere: sql`${feedFeedback.authorId} is not null` };
    const [row] = await tx.insert(feedFeedback).values({ ...values, expiresAt })
      .onConflictDoUpdate({ ...target, set: { direction, createdAt: sql`now()`, expiresAt } })
      .returning({ id: feedFeedback.id, expiresAt: feedFeedback.expiresAt, direction: feedFeedback.direction });
    await recordFeedEvent(tx, {
      userId,
      type: eventFor(input),
      postId: input.kind === "post" ? input.postId : null,
      authorId,
      context,
      detail: input.kind === "topic" ? input.topic : null,
    });
    return row!;
  });
}

export async function removeFeedback(userId: string, id: string) {
  const deleted = await db.delete(feedFeedback).where(and(eq(feedFeedback.id, id), eq(feedFeedback.userId, userId)))
    .returning({ id: feedFeedback.id });
  if (!deleted.length) throw new AuthError(404, "feed_feedback_not_found");
}

export async function clearFeedback(userId: string, kind: FeedbackKind) {
  const deleted = await db.delete(feedFeedback).where(and(eq(feedFeedback.userId, userId), eq(feedFeedback.kind, kind)))
    .returning({ id: feedFeedback.id });
  return deleted.length;
}

export async function listFeedback(userId: string) {
  const { rows } = await db.execute<{
    id: string; kind: FeedbackKind; direction: number; author_id: string | null; topic: string | null; expires_at: Date | string | null;
  }>(sql`
    select id, kind, direction, author_id, topic, expires_at from feed_feedback
    where user_id = ${userId}::uuid and (expires_at is null or expires_at > now())
    order by created_at desc`);
  const authorIds = rows.filter((row) => row.kind === "snooze" || row.kind === "author").flatMap((row) => row.author_id ?? []);
  const people = await loadUsers([...new Set(authorIds)]);
  const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
  const { rows: suggested } = await db.execute<{ topic: string }>(sql`
    select pt.topic from feed_events e join post_topics pt on pt.post_id = e.post_id
    where e.user_id = ${userId}::uuid and e.type in ('like', 'reply', 'repost', 'quote', 'save', 'open', 'topic_open')
      and e.created_at > now() - interval '60 days'
      and not exists (select 1 from feed_feedback f where f.user_id = ${userId}::uuid and f.topic = pt.topic)
    group by pt.topic order by count(*) desc, pt.topic limit 8`);
  return {
    snoozed: rows.filter((row) => row.kind === "snooze").flatMap((row) => {
      const user = row.author_id ? people.get(row.author_id) : undefined;
      return user ? [{ id: row.id, user, expiresAt: iso(row.expires_at) }] : [];
    }),
    authors: rows.filter((row) => row.kind === "author").flatMap((row) => {
      const user = row.author_id ? people.get(row.author_id) : undefined;
      return user ? [{ id: row.id, user, direction: row.direction, expiresAt: iso(row.expires_at) }] : [];
    }),
    topics: rows.filter((row) => row.kind === "topic").map((row) => ({ id: row.id, topic: row.topic!, direction: row.direction })),
    posts: {
      interested: rows.filter((row) => row.kind === "post" && row.direction > 0).length,
      notInterested: rows.filter((row) => row.kind === "post" && row.direction < 0).length,
    },
    suggestedTopics: suggested.map((row) => row.topic),
  };
}
