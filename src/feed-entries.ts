import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { notBlockedSql } from "./blocks.ts";
import { db } from "./db/index.ts";
import { posts, users } from "./db/schema.ts";
import { postSelection, repostVisibleSql, serializePost } from "./post-data.ts";
import { type UserPaint, userSelection } from "./user-data.ts";
import { attachSelfReplies } from "./self-replies.ts";

type FeedUser = { id: string; handle: string; displayName: string; avatarUrl: string | null; paint: UserPaint | null };
type Audience = "public" | "friends";
type PostRecord = ReturnType<typeof serializePost<Awaited<ReturnType<typeof selectPosts>>[number]>>;

/** Why a post is in a list as a repost: who shared it and how widely. */
export type RepostContext = {
  by: FeedUser;
  audience: Audience;
  /** Other people the viewer can see who also reposted this post. */
  others: number;
};
/** Repost context for the posts of one list, keyed by post id. */
export type RepostContexts = Record<string, RepostContext>;

function selectPosts(ids: string[], viewerId: string | null) {
  return db
    .select(postSelection(viewerId))
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(and(inArray(posts.id, ids), isNull(users.bannedAt), isNull(posts.hiddenAt)));
}
async function loadPosts(ids: string[], viewerId: string | null) {
  if (!ids.length) return new Map<string, PostRecord>();
  const rows = await selectPosts(ids, viewerId);
  return new Map(rows.map((row) => [row.id, serializePost(row)]));
}
async function loadUsers(ids: string[]) {
  if (!ids.length) return new Map<string, FeedUser>();
  const rows = await db.select(userSelection).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

// Raw queries return timestamps as text, so activity times travel as epoch milliseconds.
const epochMs = (column: ReturnType<typeof sql>) =>
  sql`round(extract(epoch from ${column}) * 1000)::bigint::text`;
type HomeRow = {
  post_id: string;
  at_ms: string;
  reposter_id: string | null;
  audience: Audience | null;
  others: number | null;
};
/**
 * The home feed. Every top-level post appears once, at its latest activity: its
 * creation, or the newest repost the viewer may see. Reposted replies join the
 * feed the same way. The response carries the posts in order, and the repost
 * that surfaced each one (if any) in `repostedBy`.
 */
export function homeFeed(
  viewerId: string | null,
  cursor: { createdAt: string; id: string } | undefined,
  limit: number,
) {
  return chronologicalFeed(viewerId, cursor, limit, null);
}

export function followingFeed(
  viewerId: string,
  cursor: { createdAt: string; id: string } | undefined,
  limit: number,
) {
  return chronologicalFeed(viewerId, cursor, limit, viewerId);
}

async function chronologicalFeed(
  viewerId: string | null,
  cursor: { createdAt: string; id: string } | undefined,
  limit: number,
  followerId: string | null,
) {
  const activity = sql`coalesce(lr.created_at, p.created_at)`;
  const network = followerId
    ? sql`(select ${followerId}::uuid union select following_id from user_follows where follower_id = ${followerId})`
    : null;
  const { rows } = await db.execute<HomeRow>(sql`
    select p.id as post_id, ${activity} as at, ${epochMs(activity)} as at_ms, lr.user_id as reposter_id,
      lr.audience as audience, lr.n::int as others
    from posts p
    join users author on author.id = p.author_id and author.banned_at is null
    left join lateral (
      select r.user_id, r.created_at, r.audience, count(*) over () - 1 as n
      from post_reposts r join users reposter on reposter.id = r.user_id
      where r.post_id = p.id and reposter.banned_at is null and ${repostVisibleSql(viewerId)}
        ${network ? sql`and r.user_id in ${network}` : sql``}
        ${viewerId ? sql`and ${notBlockedSql(viewerId, sql`r.user_id`)}` : sql``}
      order by r.created_at desc, r.user_id desc
      limit 1
    ) lr on true
    where p.hidden_at is null
      ${
        network
          ? sql`and p.id in (
              select id from posts where parent_id is null and author_id in ${network}
              union select post_id from post_reposts where user_id in ${network})
            and ((p.parent_id is null and p.author_id in ${network}) or lr.user_id is not null)`
          : sql`and (p.parent_id is null or lr.user_id is not null)`
      }
      ${viewerId ? sql`and ${notBlockedSql(viewerId, sql`p.author_id`)}` : sql``}
      ${
        cursor
          ? sql`and (${activity} < ${cursor.createdAt}::timestamptz
              or (${activity} = ${cursor.createdAt}::timestamptz and p.id < ${cursor.id}::uuid))`
          : sql``
      }
    order by at desc, p.id desc
    limit ${limit + 1}
  `);
  const page = rows.slice(0, limit);
  const [postsById, usersById] = await Promise.all([
    loadPosts(page.map((row) => row.post_id), viewerId),
    loadUsers([...new Set(page.flatMap((row) => (row.reposter_id ? [row.reposter_id] : [])))]),
  ]);
  const list: PostRecord[] = [];
  const repostedBy: RepostContexts = {};
  for (const row of page) {
    const post = postsById.get(row.post_id);
    if (!post) continue;
    list.push(post);
    const by = row.reposter_id ? usersById.get(row.reposter_id) : undefined;
    if (by && row.audience)
      repostedBy[post.id] = { by, audience: row.audience, others: row.others ?? 0 };
  }
  const last = page.at(-1);
  return {
    posts: await attachSelfReplies(list, viewerId),
    repostedBy,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify({ createdAt: new Date(Number(last.at_ms)).toISOString(), id: last.post_id })).toString("base64url")
        : null,
  };
}

type ProfileRow = { post_id: string; kind: "repost" | "quote"; audience: Audience | null };
/**
 * A profile's Reposts tab: what the person reposted (as the viewer may see it)
 * and the quote posts they wrote, newest first. A quote is listed as its own
 * post; a plain repost lists the original with the person as `repostedBy`.
 */
export async function profileReposts(profile: FeedUser, viewerId: string | null, limit = 20) {
  const { rows } = await db.execute<ProfileRow>(sql`
    select post_id, at, kind, audience from (
      select r.post_id, r.created_at as at, 'repost' as kind, r.audience
      from post_reposts r
      join posts p on p.id = r.post_id
      where r.user_id = ${profile.id} and p.hidden_at is null and ${repostVisibleSql(viewerId)}
      union all
      select q.id, q.created_at, 'quote', null::text
      from posts q where q.author_id = ${profile.id} and q.is_quote and q.hidden_at is null
    ) e
    order by at desc, post_id desc
    limit ${limit}
  `);
  const postsById = await loadPosts(rows.map((row) => row.post_id), viewerId);
  const list: PostRecord[] = [];
  const repostedBy: RepostContexts = {};
  for (const row of rows) {
    const post = postsById.get(row.post_id);
    if (!post) continue;
    list.push(post);
    if (row.kind === "repost" && row.audience)
      repostedBy[post.id] = { by: profile, audience: row.audience, others: 0 };
  }
  return { posts: list, repostedBy };
}
