import {
  postFields,
  postSelection,
  serializePost,
  reactionSelection,
  repostSelection,
  pollSelection,
  mutualFollowSql,
  repostVisibleSql,
  visiblePostAuthor,
} from "./post-data.ts";
import { homeFeed } from "./feed-entries.ts";
import { Router, type Request } from "express";
import { alias } from "drizzle-orm/pg-core";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { db } from "./db/index.ts";
import {
  postEdits,
  pollVotes,
  postLikes,
  notifications,
  postMentions,
  postReposts,
  postTopics,
  posts,
  mediaDeletions,
  users,
} from "./db/schema.ts";
import { requireUser, readViewerId } from "./auth/request.ts";
import { AuthError } from "./auth/provider.ts";
import { userSelection } from "./user-data.ts";
import { recordNotification } from "./notification-events.ts";
import { parseTopicName, syncPostTopics } from "./topics.ts";
import { postFilterConditions, postMatchesSql, readPostFilters, readSearchQuery } from "./search.ts";
import { extractTopics } from "./topics-text.ts";
import { affectedPostIds, publishLiveChange, publishLivePost } from "./live-events.ts";
import { removePost } from "./post-removal.ts";

import { syncMentions } from "./mentions.ts";
import { attachSelfReplies } from "./self-replies.ts";
import { easterEggGif, easterEggToken } from "./easter-egg.ts";
import { readGifSelection } from "./storage/klipy.ts";
import { pollDefinitionSchema } from "./poll-schema.ts";
import { flushMediaDeletions } from "./storage/media-lifecycle.ts";
import { readVoiceSelection } from "./storage/voice-selection.ts";
import { previewIconForPost, previewImageForPost, previewsForPost } from "./link-previews.ts";

const router = Router();

const contentSchema = z.strictObject({
  content: z
    .string()
    .trim()
    .refine((value) => !value.includes("\u0000"))
    .refine(
      (value) =>
        !/(?:^|\n)(?:[^\S\n]*\n){3}/.test(
          value.replace(/\r\n?|[\u2028\u2029]/g, "\n"),
        ),
      "Use at most two blank lines in a row.",
    )
    .refine((value) => {
      const length = Array.from(value).length;
      return length <= 2000;
    }),
});
const createSchema = contentSchema
  .extend({
    content: contentSchema.shape.content.default(""),
    clientId: z.uuid().optional(),
    // Preserve compatibility with callers that send an empty attachment list.
    attachmentIds: z.array(z.uuid()).max(0).optional(),
    gifToken: z.string().min(1).max(4096).optional(),
    voiceToken: z.string().min(1).max(4096).optional(),
    poll: pollDefinitionSchema.optional(),
    // Makes this a quote post: a new top-level post that embeds the quoted one.
    quotedPostId: z.uuid().optional(),
  })
  .refine(({ content, gifToken, poll, voiceToken }) => Boolean(content || gifToken || poll || voiceToken));
const cursorSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});
export async function findPost(id: string, viewerId: string | null = null) {
  const [post] = await db
    .select(postSelection(viewerId))
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(and(eq(posts.id, id), isNull(users.bannedAt)));
  if (!post) throw new AuthError(404, "post_not_found");
  return serializePost(post);
}
async function createPost({
  userId,
  input,
  parentId = null,
  quotedPostId = null,
}: {
  userId: string;
  input: z.infer<typeof createSchema>;
  parentId?: string | null;
  quotedPostId?: string | null;
}) {
  const selection = !input.gifToken
    ? null
    : input.gifToken === easterEggToken
      ? { gif: easterEggGif, expires: Infinity }
      : readGifSelection(input.gifToken, userId);
  const gif = selection?.gif ?? null;
  const voiceSelection = input.voiceToken ? readVoiceSelection(input.voiceToken, userId) : null;
  const voice = voiceSelection?.voice ?? null;
  const id = await db.transaction(async (tx) => {
    // Lock the staged upload against the cleanup worker. Only one post may claim it.
    const [pendingVoice] = voice ? await tx.select().from(mediaDeletions)
      .where(eq(mediaDeletions.key, voice.key)).for("update") : [];
    let parentAuthor: string | undefined;
    if (parentId) {
      const [parent] = await tx
        .select({ id: posts.id, authorId: posts.authorId })
        .from(posts)
        .where(and(eq(posts.id, parentId), visiblePostAuthor))
        .for("key share");
      if (!parent) throw new AuthError(404, "post_not_found");
      parentAuthor = parent.authorId;
    }
    let quotedAuthor: string | undefined;
    // A retried quote may outlive its original; then only the saved copy can answer.
    let quotedGone = false;
    if (quotedPostId) {
      const [quoted] = await tx
        .select({ id: posts.id, authorId: posts.authorId })
        .from(posts)
        .where(and(eq(posts.id, quotedPostId), visiblePostAuthor))
        .for("key share");
      if (quoted) quotedAuthor = quoted.authorId;
      else quotedGone = true;
    }
    // An expired selection can confirm an earlier successful write by client ID.
    const expired = Boolean((selection && selection.expires < Date.now()) ||
      (voiceSelection && (voiceSelection.expires < Date.now() || !pendingVoice || pendingVoice.availableAt.getTime() <= Date.now())));
    const [saved] = expired || quotedGone
      ? []
      : await tx
          .insert(posts)
          .values({
            id: input.clientId,
            authorId: userId,
            content: input.content,
            gif,
            voice,
            poll: input.poll,
            parentId,
            quotedPostId,
            isQuote: quotedPostId !== null,
          })
          .onConflictDoNothing({ target: posts.id })
          .returning({ id: posts.id });
    if (saved) {
      if (voice) await tx.delete(mediaDeletions).where(eq(mediaDeletions.key, voice.key));
      await syncMentions(tx, saved.id, userId, input.content);
      await syncPostTopics(tx, saved.id, input.content);
      await publishLivePost(tx, {
        id: saved.id,
        parentId,
        authorId: userId,
        topics: extractTopics(input.content),
      });
      await publishLiveChange(tx, await affectedPostIds(tx, saved.id));
      if (parentAuthor)
        await recordNotification(tx, {
          recipientId: parentAuthor,
          actorId: userId,
          kind: "reply",
          postId: saved.id,
          subject: saved.id,
        });
      if (quotedAuthor && quotedAuthor !== userId) {
        // Someone tagged in their own quote already gets a mention notification.
        const [mentioned] = await tx
          .select({ userId: postMentions.userId })
          .from(postMentions)
          .where(and(eq(postMentions.postId, saved.id), eq(postMentions.userId, quotedAuthor)))
          .limit(1);
        if (!mentioned)
          await recordNotification(tx, {
            recipientId: quotedAuthor,
            actorId: userId,
            kind: "quote",
            postId: saved.id,
            subject: saved.id,
          });
      }
      return saved.id;
    }
    if (!input.clientId) {
      if (quotedGone) throw new AuthError(404, "post_not_found");
      if (expired) throw new AuthError(400, voice ? "invalid_voice_selection" : "invalid_gif_selection");
      throw new Error("Post ID collision");
    }
    const [existing] = await tx
      .select({
        id: posts.id,
        authorId: posts.authorId,
        parentId: posts.parentId,
        quotedPostId: posts.quotedPostId,
        isQuote: posts.isQuote,
        content: posts.content,
        gif: posts.gif,
        voice: posts.voice,
        poll: posts.poll,
      })
      .from(posts)
      .where(eq(posts.id, input.clientId));
    if (!existing && quotedGone) throw new AuthError(404, "post_not_found");
    const savedPoll = existing?.poll;
    if (
      !existing ||
      existing.authorId !== userId ||
      existing.parentId !== parentId ||
      // A quote whose original was deleted since keeps its flag but loses the link.
      existing.isQuote !== (quotedPostId !== null) ||
      (existing.quotedPostId !== null && existing.quotedPostId !== quotedPostId) ||
      existing.content !== input.content ||
      existing.gif?.url !== gif?.url ||
      existing.voice?.key !== voice?.key ||
      savedPoll?.title !== input.poll?.title ||
      savedPoll?.anonymous !== input.poll?.anonymous ||
      !isDeepStrictEqual(savedPoll?.options, input.poll?.options)
    )
      throw expired
        ? new AuthError(400, voice ? "invalid_voice_selection" : "invalid_gif_selection")
        : new AuthError(409, "post_id_conflict");
    return existing.id;
  });
  return findPost(id, userId);
}
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
// For each reply in `page`, the posts above it, root first.
async function loadAncestors(
  page: { id: string; parentId: string | null }[],
  viewerId: string | null,
) {
  const replyIds = page.filter((row) => row.parentId).map((row) => row.id);
  const result = new Map<string, ReturnType<typeof serializePost>[]>();
  if (!replyIds.length) return result;
  const chains = await db.execute<{ origin: string; id: string }>(sql`
    with recursive chain as (
      select id as origin, parent_id as id, 1 as depth
      from posts where id in (${sql.join(
        replyIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}) and parent_id is not null
      union all
      select c.origin, p.parent_id, c.depth + 1
      from chain c join posts p on p.id = c.id
      where p.parent_id is not null and c.depth < 100
    )
    select origin, id from chain order by origin, depth desc
  `);
  const ancestorRows = await db
    .select(postSelection(viewerId))
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(and(isNull(users.bannedAt), inArray(posts.id, [...new Set(chains.rows.map((row) => row.id))])));
  const byId = new Map(ancestorRows.map((row) => [row.id, serializePost(row)]));
  for (const { origin, id } of chains.rows) {
    const found = byId.get(id);
    if (found) result.set(origin, [...(result.get(origin) ?? []), found]);
  }
  return result;
}
const listPosts: import("express").RequestHandler = async (req, res) => {
  const parentId =
    typeof req.params.id === "string" ? req.params.id : undefined;
  if (parentId) await findPost(parentId);
  const viewerId = await readViewerId(req);
  const topic =
    !parentId && req.query.topic !== undefined
      ? parseTopicName(req.query.topic)
      : undefined;
  const search =
    !parentId && req.query.q !== undefined
      ? readSearchQuery(req.query.q)
      : undefined;
  const filters = parentId ? undefined : readPostFilters(req.query);
  const textSearch = search?.usable ? search : undefined;
  const searching = textSearch !== undefined || filters?.active === true;
  const oldestFirst = searching && filters?.sort === "oldest";
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
  if (search && !search.usable && !searching) {
    res.json({
      repostedBy: {},
      posts: [],
      nextCursor: null,
      serverNow: new Date().toISOString(),
    });
    return;
  }
  if (!parentId && !topic && !searching) {
    const feed = await homeFeed(viewerId, cursor && { createdAt: cursor.createdAt, id: cursor.id }, 20);
    res.json({ ...feed, serverNow: new Date().toISOString() });
    return;
  }
  const rows = await db
    .select(postSelection(viewerId))
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(
      and(
        isNull(users.bannedAt),
        parentId ? eq(posts.parentId, parentId) : undefined,
        textSearch ? postMatchesSql(textSearch) : undefined,
        ...(filters && searching ? postFilterConditions(filters) : []),
        topic
          ? inArray(
              posts.id,
              db
                .select({ id: postTopics.postId })
                .from(postTopics)
                .where(eq(postTopics.topic, topic)),
            )
          : undefined,
        cursor
          ? or(
              (oldestFirst ? gt : lt)(posts.createdAt, new Date(cursor.createdAt)),
              and(
                eq(posts.createdAt, new Date(cursor.createdAt)),
                (oldestFirst ? gt : lt)(posts.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(
      ...(oldestFirst
        ? [asc(posts.createdAt), asc(posts.id)]
        : [desc(posts.createdAt), desc(posts.id)]),
    )
    .limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1);
  // A topic lists replies next to posts; send the chain above each reply so
  // clients can show it in context instead of as a stray post.
  const ancestors = topic || searching ? await loadAncestors(page, viewerId) : undefined;
  res.json({
    repostedBy: {},
    posts: (
      await attachSelfReplies(
        page.map((row) => serializePost(row)),
        viewerId,
      )
    ).map((post) =>
      ancestors ? { ...post, ancestors: ancestors.get(post.id) ?? [] } : post,
    ),
    nextCursor:
      rows.length > 20 && last
        ? Buffer.from(
            JSON.stringify({
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            }),
          ).toString("base64url")
        : null,
    serverNow: new Date().toISOString(),
  });
};
router.get("/", listPosts);
router.get("/poll-results", async (req, res) => {
  const parsed = z.strictObject({
    ids: z.string().max(50 * 37).transform((value) => value.split(","))
      .pipe(z.array(z.uuid()).min(1).max(50)),
  }).safeParse(req.query);
  if (!parsed.success) throw new AuthError(400, "invalid_post_id");

  const viewerId = await readViewerId(req);
  const results = await db
    .select({ id: posts.id, poll: pollSelection(viewerId) })
    .from(posts)
    .where(and(inArray(posts.id, parsed.data.ids), visiblePostAuthor, sql`${posts.poll} is not null`));
  res.json({ viewerId, results });
});
router.get("/states", async (req, res) => {
  const parsed = z.strictObject({
    ids: z.string().max(50 * 37).transform((value) => value.split(","))
      .pipe(z.array(z.uuid()).min(1).max(50)),
  }).safeParse(req.query);
  if (!parsed.success) throw new AuthError(400, "invalid_post_id");
  const viewerId = await readViewerId(req);
  const rows = await db
    .select({ ...postSelection(viewerId), bannedAt: users.bannedAt })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(inArray(posts.id, parsed.data.ids));
  res.json({
    viewerId,
    posts: rows.flatMap(({ bannedAt, ...row }) => bannedAt ? [] : [serializePost(row)]),
    hiddenIds: rows.filter((row) => row.bannedAt).map((row) => row.id),
  });
});
router.post("/", async (req, res) => {
  const user = await requireUser(req);
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new AuthError(400, "invalid_content");
  res.status(201).json({
    post: await createPost({
      userId: user.id,
      input: parsed.data,
      quotedPostId: parsed.data.quotedPostId ?? null,
    }),
    serverNow: new Date().toISOString(),
  });
});
router.use("/:id", (req, _res, next) => {
  if (!z.uuid().safeParse(req.params.id).success)
    throw new AuthError(400, "invalid_post_id");
  next();
});
router.get("/:id", async (req, res) => {
  res.json({
    post: await findPost(req.params.id, await readViewerId(req)),
    serverNow: new Date().toISOString(),
  });
});
async function postContent(id: string) {
  const [post] = await db
    .select({ content: posts.content })
    .from(posts)
    .where(and(eq(posts.id, id), visiblePostAuthor));
  if (!post) throw new AuthError(404, "post_not_found");
  return post.content;
}
router.get("/:id/link-previews", async (req, res) => {
  const offset = req.query.offset ?? "0";
  if (typeof offset !== "string" || !/^\d{1,4}$/.test(offset))
    throw new AuthError(400, "invalid_cursor");
  const content = await postContent(req.params.id);
  res.json(await previewsForPost(content, Number(offset)));
});
const previewAssetHeaders = {
  "Cache-Control": "public, max-age=3600",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};
router.get("/:id/link-preview-image/:key", async (req, res) => {
  if (!/^[0-9a-f]{64}$/.test(req.params.key)) {
    res.sendStatus(404);
    return;
  }
  const content = await postContent(req.params.id);
  const image = await previewImageForPost(content, req.params.key);
  if (!image) {
    res.sendStatus(404);
    return;
  }
  res.set(previewAssetHeaders).type("image/webp").send(image);
});
router.get("/:id/link-preview-icon/:key", async (req, res) => {
  if (!/^[0-9a-f]{64}$/.test(req.params.key)) {
    res.sendStatus(404);
    return;
  }
  const icon = await previewIconForPost(await postContent(req.params.id), req.params.key);
  if (!icon) {
    res.sendStatus(404);
    return;
  }
  // A directly opened SVG has an opaque origin and cannot execute or fetch resources.
  res.set({
    ...previewAssetHeaders,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  }).type(icon.type).send(icon.body);
});
const THREAD_MAX_DEPTH = 12;
const THREAD_MAX_REPLIES = 300;
// Full conversation around a post: the chain above it (root first) and every
// nested reply below it (shallowest first, then oldest first), so clients can
// render a collapsible tree without one request per level.
router.get("/:id/thread", async (req, res) => {
  const id = req.params.id;
  const viewerId = await readViewerId(req);
  const post = await findPost(id, viewerId);
  const [ancestorRows, descendantRows] = await Promise.all([
    db.execute<{ id: string }>(sql`
      with recursive chain as (
        select id, parent_id, 0 as depth from posts where id = ${id}
        union all
        select p.id, p.parent_id, c.depth + 1
        from posts p join chain c on p.id = c.parent_id
        where c.depth < 100
      )
      select id from chain where depth > 0 order by depth desc
    `),
    db.execute<{ id: string }>(sql`
      with recursive tree as (
        select id, 1 as depth from posts where parent_id = ${id}
        union all
        select p.id, t.depth + 1
        from posts p join tree t on p.parent_id = t.id
        where t.depth < ${THREAD_MAX_DEPTH}
      )
      select t.id from tree t join posts p on p.id = t.id
      join users u on u.id = p.author_id and u.banned_at is null
      order by t.depth, p.created_at, p.id
      limit ${THREAD_MAX_REPLIES + 1}
    `),
  ]);
  const ancestorIds = ancestorRows.rows.map((row) => row.id);
  const truncated = descendantRows.rows.length > THREAD_MAX_REPLIES;
  const descendantIds = descendantRows.rows
    .slice(0, THREAD_MAX_REPLIES)
    .map((row) => row.id);
  const wanted = [...ancestorIds, ...descendantIds];
  const rows = wanted.length
    ? await db
        .select(postSelection(viewerId))
        .from(posts)
        .innerJoin(users, eq(users.id, posts.authorId))
        .where(and(inArray(posts.id, wanted), isNull(users.bannedAt)))
    : [];
  const byId = new Map(rows.map((row) => [row.id, serializePost(row)]));
  const pick = (ids: string[]) =>
    ids.flatMap((postId) => {
      const found = byId.get(postId);
      return found ? [found] : [];
    });
  res.json({
    post,
    ancestors: pick(ancestorIds),
    replies: pick(descendantIds),
    truncated,
    serverNow: new Date().toISOString(),
  });
});
// Edit history, newest version first (the current text is the first entry).
router.get("/:id/edits", async (req, res) => {
  const post = await findPost(req.params.id);
  const earlier = await db
    .select({ content: postEdits.content, at: postEdits.versionAt })
    .from(postEdits)
    .where(eq(postEdits.postId, post.id))
    .orderBy(desc(postEdits.versionAt));
  res.json({
    versions: [
      { content: post.content, at: post.editedAt ?? post.createdAt },
      ...earlier,
    ],
  });
});
router.get("/:id/replies", listPosts);
const pollOptionSchema = z.number().int().min(0).max(5);
router.put("/:id/poll/vote", async (req, res) => {
  const user = await requireUser(req);
  const parsed = z.strictObject({ optionIndex: pollOptionSchema }).safeParse(req.body);
  if (!parsed.success) throw new AuthError(400, "invalid_poll_option");
  const postId = req.params.id;
  const { optionIndex } = parsed.data;
  const poll = await db.transaction(async (tx) => {
    const [post] = await tx
      .select({ poll: posts.poll })
      .from(posts)
      .where(and(eq(posts.id, postId), visiblePostAuthor))
      .for("update");
    if (!post?.poll) throw new AuthError(404, "poll_not_found");
    if (optionIndex >= post.poll.options.length)
      throw new AuthError(400, "invalid_poll_option");

    await tx
      .insert(pollVotes)
      .values({ postId, userId: user.id, optionIndex })
      .onConflictDoUpdate({
        target: [pollVotes.postId, pollVotes.userId],
        set: { optionIndex },
      });

    await publishLiveChange(tx, [postId]);
    const [result] = await tx
      .select({ poll: pollSelection(user.id) })
      .from(posts)
      .where(eq(posts.id, postId));
    return result.poll;
  });
  res.json({ poll });
});
router.get("/:id/poll/voters", async (req, res) => {
  const parsed = z.strictObject({
    option: z.preprocess(
      (value) => typeof value === "string" ? [value] : value,
      z.array(z.string().regex(/^[0-5]$/).transform(Number)).min(1).max(6).optional(),
    ),
    cursor: z.uuid().optional(),
  }).safeParse(req.query);
  if (!parsed.success) throw new AuthError(400, "invalid_poll_option");
  const { option: selectedOptions, cursor } = parsed.data;
  const [post] = await db
    .select({ poll: posts.poll })
    .from(posts)
    .where(and(eq(posts.id, req.params.id), visiblePostAuthor));
  if (!post?.poll) throw new AuthError(404, "poll_not_found");
  if (post.poll.anonymous) throw new AuthError(403, "poll_is_anonymous");
  const { options } = post.poll;
  if (selectedOptions?.some((index) => index >= options.length))
    throw new AuthError(400, "invalid_poll_option");

  const rows = await db
    .select({ ...userSelection, optionIndex: pollVotes.optionIndex })
    .from(pollVotes)
    .innerJoin(users, eq(users.id, pollVotes.userId))
    .where(and(
      eq(pollVotes.postId, req.params.id),
      selectedOptions ? inArray(pollVotes.optionIndex, selectedOptions) : undefined,
      cursor ? gt(pollVotes.userId, cursor) : undefined,
    ))
    .orderBy(asc(pollVotes.userId))
    .limit(51);
  const page = rows.slice(0, 50);
  res.json({
    users: page.map(({ optionIndex, ...user }) => ({
      ...user,
      optionLabel: options[optionIndex],
    })),
    nextCursor: rows.length > 50 ? (page.at(-1)?.id ?? null) : null,
  });
});
router.get("/:id/activity", async (req, res) => {
  const query = z
    .object({
      type: z.enum(["likes", "reposts", "quotes"]),
      cursor: z.uuid().optional(),
    })
    .safeParse(req.query);
  if (!query.success) throw new AuthError(400, "invalid_activity_query");
  await findPost(req.params.id);
  const { type, cursor } = query.data;
  const rows =
    type === "quotes"
      ? await db
          .select({ ...userSelection, quoteId: posts.id })
          .from(posts)
          .innerJoin(users, eq(users.id, posts.authorId))
          .where(and(eq(posts.quotedPostId, req.params.id), isNull(users.bannedAt), cursor ? gt(posts.id, cursor) : undefined))
          .orderBy(asc(posts.id))
          .limit(51)
      : type === "likes"
        ? await db
            .select(userSelection)
            .from(postLikes)
            .innerJoin(users, eq(users.id, postLikes.userId))
            .where(and(eq(postLikes.postId, req.params.id), cursor ? gt(postLikes.userId, cursor) : undefined))
            .orderBy(asc(postLikes.userId))
            .limit(51)
        : await db
            .select(userSelection)
            .from(alias(postReposts, "r"))
            .innerJoin(users, eq(users.id, sql`r.user_id`))
            .where(
              and(
                sql`r.post_id = ${req.params.id}`,
                // Friends-only reposts are listed only to the reposter and their friends.
                repostVisibleSql(await readViewerId(req)),
                cursor ? sql`r.user_id > ${cursor}` : undefined,
              ),
            )
            .orderBy(sql`r.user_id`)
            .limit(51);
  const page = rows.slice(0, 50);
  // Quotes page by the quote's own id, the others by user id.
  const last = page.at(-1);
  const pageKey = last && "quoteId" in last ? (last.quoteId as string) : last?.id;
  res.json({
    users: page,
    nextCursor: rows.length > 50 ? (pageKey ?? null) : null,
  });
});
router.post("/:id/replies", async (req, res) => {
  const user = await requireUser(req);
  const parsed = createSchema.safeParse(req.body);
  // Quotes are top-level posts, never replies.
  if (!parsed.success || parsed.data.quotedPostId)
    throw new AuthError(400, "invalid_content");
  res.status(201).json({
    post: await createPost({
      userId: user.id,
      input: parsed.data,
      parentId: req.params.id,
    }),
    serverNow: new Date().toISOString(),
  });
});
async function setLike(req: Request, liked: boolean) {
  const user = await requireUser(req);
  const parsedId = z.uuid().safeParse(req.params.id);
  if (!parsedId.success) throw new AuthError(400, "invalid_post_id");
  const id = parsedId.data;
  return db.transaction(async (tx) => {
    // Serialize writes to this post, so retries and concurrent likes return a consistent count.
    const [post] = await tx
      .select({ id: posts.id, authorId: posts.authorId })
      .from(posts)
      .where(and(eq(posts.id, id), visiblePostAuthor))
      .for("update");
    if (!post) throw new AuthError(404, "post_not_found");
    if (liked) {
      const [inserted] = await tx
        .insert(postLikes)
        .values({ postId: id, userId: user.id })
        .onConflictDoNothing()
        .returning();
      if (inserted)
        await recordNotification(tx, {
          recipientId: post.authorId,
          actorId: user.id,
          kind: "like",
          postId: id,
          subject: id,
        });
    } else {
      await tx
        .delete(postLikes)
        .where(and(eq(postLikes.postId, id), eq(postLikes.userId, user.id)));
    }
    await publishLiveChange(tx, [id]);
    const [state] = await tx
      .select(reactionSelection(user.id))
      .from(posts)
      .where(eq(posts.id, id));
    return state;
  });
}
router.put("/:id/like", async (req, res) => {
  res.json(await setLike(req, true));
});
router.delete("/:id/like", async (req, res) => {
  res.json(await setLike(req, false));
});
const repostBodySchema = z.strictObject({
  audience: z.enum(["public", "friends"]).default("public"),
});
async function setRepost(req: Request, reposted: boolean) {
  const user = await requireUser(req);
  const parsedId = z.uuid().safeParse(req.params.id);
  if (!parsedId.success) throw new AuthError(400, "invalid_post_id");
  const id = parsedId.data;
  const body = repostBodySchema.safeParse(reposted ? (req.body ?? {}) : {});
  if (!body.success) throw new AuthError(400, "invalid_repost");
  const { audience } = body.data;
  return db.transaction(async (tx) => {
    const [post] = await tx
      .select({ id: posts.id, authorId: posts.authorId, parentId: posts.parentId })
      .from(posts)
      .where(and(eq(posts.id, id), visiblePostAuthor))
      .for("update");
    if (!post) throw new AuthError(404, "post_not_found");
    if (reposted) {
      // Reposting again with another audience switches the existing repost.
      await tx
        .insert(postReposts)
        .values({ postId: id, userId: user.id, audience })
        .onConflictDoUpdate({
          target: [postReposts.postId, postReposts.userId],
          set: { audience },
        });
      // A friends-only repost must not tell a stranger about it.
      const [{ friends }] = (
        await tx.execute<{ friends: boolean }>(
          sql`select ${mutualFollowSql(user.id, sql`${post.authorId}::uuid`)} as friends`,
        )
      ).rows;
      if (audience === "public" || friends)
        await recordNotification(tx, {
          recipientId: post.authorId,
          actorId: user.id,
          kind: "repost",
          postId: id,
          subject: id,
        });
      else
        await tx
          .delete(notifications)
          .where(
            and(
              eq(notifications.recipientId, post.authorId),
              eq(notifications.actorId, user.id),
              eq(notifications.kind, "repost"),
              eq(notifications.subject, id),
            ),
          );
    } else {
      await tx
        .delete(postReposts)
        .where(
          and(eq(postReposts.postId, id), eq(postReposts.userId, user.id)),
        );
    }
    await publishLiveChange(tx, [id]);
    if (reposted)
      await publishLivePost(tx, {
        id,
        parentId: post.parentId,
        authorId: user.id,
        topics: [],
        reposted: true,
      });
    const [state] = await tx
      .select(repostSelection(user.id))
      .from(posts)
      .where(eq(posts.id, id));
    return state;
  });
}
router.put("/:id/repost", async (req, res) => {
  res.json(await setRepost(req, true));
});
router.delete("/:id/repost", async (req, res) => {
  res.json(await setRepost(req, false));
});
router.patch("/:id", async (req, res) => {
  const user = await requireUser(req);
  const parsed = contentSchema.safeParse(req.body);
  if (!parsed.success) throw new AuthError(400, "invalid_content");
  const updated = await db.transaction(async (tx) => {
    // Acquire the row before evaluating the clock, including waits for other writers.
    const [existing] = await tx
      .select({
        authorId: posts.authorId,
        content: posts.content,
        gif: posts.gif,
        voice: posts.voice,
        poll: posts.poll,
        createdAt: posts.createdAt,
        editedAt: posts.editedAt,
      })
      .from(posts)
      .where(eq(posts.id, req.params.id))
      .for("update");
    if (!existing) throw new AuthError(404, "post_not_found");
    if (existing.authorId !== user.id)
      throw new AuthError(403, "not_post_author");
    if (!parsed.data.content && !existing.gif && !existing.poll && !existing.voice)
      throw new AuthError(400, "invalid_content");
    const [saved] = await tx
      .update(posts)
      .set({ content: parsed.data.content, editedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(posts.id, req.params.id),
          sql`clock_timestamp() < ${posts.createdAt} + interval '15 minutes'`,
        ),
      )
      .returning(postFields);
    if (!saved) throw new AuthError(409, "edit_window_expired");
    await syncPostTopics(tx, req.params.id, parsed.data.content);
    if (existing.content !== parsed.data.content)
      await tx.insert(postEdits).values({
        postId: req.params.id,
        content: existing.content,
        versionAt: existing.editedAt ?? existing.createdAt,
      });
    await syncMentions(tx, saved.id, user.id, parsed.data.content);
    await publishLiveChange(tx, await affectedPostIds(tx, saved.id));
    return saved;
  });
  res.json({
    post: await findPost(updated.id, user.id),
    serverNow: new Date().toISOString(),
  });
});
router.delete("/:id", async (req, res) => {
  const user = await requireUser(req);
  const deleted = await db.transaction((tx) => removePost(tx, req.params.id, eq(posts.authorId, user.id)));
  if (!deleted) {
    await findPost(req.params.id);
    throw new AuthError(403, "not_post_author");
  }
  if (deleted.voice) await flushMediaDeletions(deleted.voice.key);
  res.status(204).end();
});
export default router;
