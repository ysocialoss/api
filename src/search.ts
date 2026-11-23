import { Router, type Request } from "express";
import { and, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import { postTopics, posts, userFollows, users } from "./db/schema.ts";
import { AuthError } from "./auth/provider.ts";
import { visiblePost } from "./post-data.ts";
import { SEARCH_MAX_LENGTH, parseSearchQuery, type SearchQuery } from "./search-text.ts";
import { userSelection } from "./user-data.ts";

const PREVIEW_LIMIT = 3;
const PAGE_LIMIT = 20;
const MAX_OFFSET = 200;

export function readSearchQuery(value: unknown) {
  if (typeof value !== "string" || value.length > SEARCH_MAX_LENGTH)
    throw new AuthError(400, "invalid_search");
  return parseSearchQuery(value);
}

const filterSchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  user: z
    .string()
    .regex(/^@?[a-z0-9_]{3,32}$/i)
    .transform((handle) => handle.replace(/^@/, "").toLowerCase())
    .optional(),
  sort: z.enum(["newest", "oldest"]).default("newest"),
});

export function readPostFilters(query: Request["query"]) {
  const parsed = filterSchema.safeParse({
    from: query.from,
    to: query.to,
    user: query.user,
    sort: query.sort,
  });
  if (!parsed.success) throw new AuthError(400, "invalid_search");
  const { from, to, user, sort } = parsed.data;
  return {
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
    user,
    sort,
    active: from !== undefined || to !== undefined || user !== undefined,
  };
}

export function postFilterConditions(filters: ReturnType<typeof readPostFilters>) {
  return [
    filters.from ? gte(posts.createdAt, filters.from) : undefined,
    filters.to ? lt(posts.createdAt, filters.to) : undefined,
    filters.user
      ? sql`${posts.authorId} in (select user_id from user_handles where handle = ${filters.user})`
      : undefined,
  ];
}

export const postMatchesSql = (query: SearchQuery) =>
  sql`to_tsvector('simple', ${posts.content}) @@ to_tsquery('simple', ${query.tsquery})`;

async function findUsers(query: SearchQuery, limit: number, offset: number) {
  if (!query.usable) return [];
  const term = query.term;
  const matchRank = sql`case
    when ${users.handle} = ${term} then 0
    when starts_with(${users.handle}, ${term}) then 1
    when strpos(' ' || lower(${users.displayName}), ' ' || ${term}) > 0 then 2
    else 3 end`;
  const followers = sql`(select count(*)::int from ${userFollows} where ${userFollows.followingId} = ${users.id})`;
  return db
    .select({
      ...userSelection,
      bio: users.bio,
      followerCount: sql<number>`${followers}`,
    })
    .from(users)
    .where(
      and(
        isNull(users.bannedAt),
        isNotNull(users.approvedAt),
        sql`(strpos(${users.handle}, ${term}) > 0 or strpos(lower(${users.displayName}), ${term}) > 0)`,
      ),
    )
    .orderBy(matchRank, desc(followers), users.handle)
    .limit(limit)
    .offset(offset);
}

async function findTopics(query: SearchQuery, limit: number, offset: number) {
  const name = query.usable && query.words.length === 1 ? query.words[0] : null;
  if (!name) return [];
  const matchRank = sql`case when ${postTopics.topic} = ${name} then 0
    when starts_with(${postTopics.topic}, ${name}) then 1 else 2 end`;
  return db
    .select({ name: postTopics.topic, count: sql<number>`count(*)::int` })
    .from(postTopics)
    .innerJoin(posts, eq(posts.id, postTopics.postId))
    .where(and(visiblePost, sql`strpos(${postTopics.topic}, ${name}) > 0`))
    .groupBy(postTopics.topic)
    .orderBy(matchRank, desc(sql`count(*)`), postTopics.topic)
    .limit(limit)
    .offset(offset);
}

const cursorSchema = z.strictObject({ offset: z.number().int().min(PAGE_LIMIT).max(MAX_OFFSET) });
function readOffset(value: unknown) {
  if (value === undefined) return 0;
  try {
    if (typeof value !== "string" || value.length > 64) throw new Error();
    return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))).offset;
  } catch {
    throw new AuthError(400, "invalid_cursor");
  }
}
function paged<T>(rows: T[], offset: number) {
  const items = rows.slice(0, PAGE_LIMIT);
  const next = offset + PAGE_LIMIT;
  return {
    items,
    nextCursor:
      rows.length > PAGE_LIMIT && next <= MAX_OFFSET
        ? Buffer.from(JSON.stringify({ offset: next })).toString("base64url")
        : null,
  };
}

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.get("/", async (req, res) => {
  const query = readSearchQuery(req.query.q ?? "");
  const type = req.query.type;
  if (type === undefined) {
    const [foundUsers, foundTopics] = await Promise.all([
      findUsers(query, PREVIEW_LIMIT + 1, 0),
      findTopics(query, PREVIEW_LIMIT + 1, 0),
    ]);
    res.json({
      users: foundUsers.slice(0, PREVIEW_LIMIT),
      topics: foundTopics.slice(0, PREVIEW_LIMIT),
      moreUsers: foundUsers.length > PREVIEW_LIMIT,
      moreTopics: foundTopics.length > PREVIEW_LIMIT,
    });
    return;
  }
  const offset = readOffset(req.query.cursor);
  if (type === "users") {
    const { items, nextCursor } = paged(await findUsers(query, PAGE_LIMIT + 1, offset), offset);
    res.json({ users: items, nextCursor });
    return;
  }
  if (type === "topics") {
    const { items, nextCursor } = paged(await findTopics(query, PAGE_LIMIT + 1, offset), offset);
    res.json({ topics: items, nextCursor });
    return;
  }
  throw new AuthError(400, "invalid_search");
});
export default router;
