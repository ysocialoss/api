import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.ts";
import { feedCandidates, feedRequests, userBlocks } from "../db/schema.ts";
import { AuthError } from "../auth/provider.ts";
import { notBlockedSql } from "../blocks.ts";
import { repostVisibleSql } from "../post-data.ts";
import { loadAncestors } from "../post-ancestors.ts";
import { attachSelfReplies } from "../self-replies.ts";
import { loadPosts, loadUsers, type PostRecord, type RepostContexts } from "../feed-entries.ts";
import { loadConfig, type FeedConfig } from "./config.ts";
import { bumpCounter } from "./counters.ts";
import { computeFeatures, registerFeatureSet } from "./features.ts";
import { controlsSnapshot, factorsFor, type Controls } from "./controls.ts";
import { loadControls, loadPostTopics } from "./feedback.ts";
import { countSources, loadInventory } from "./inventory.ts";
import { featureVersion, loadModel, predict } from "./model.ts";
import { reasonFor, type Reason } from "./reasons.ts";
import { rerank } from "./rerank.ts";
import { value, type Scored } from "./value.ts";

export type FeedMode = "personal" | "public";
export type Placement = { requestId: string; position: number; reason: Reason };
export type RankedPage = {
  posts: object[];
  repostedBy: RepostContexts;
  nextCursor: string | null;
  requestId: string | null;
  placements: Record<string, Placement>;
  caughtUp: boolean;
  fallback: boolean;
};

const cursorSchema = z.strictObject({ r: z.uuid(), o: z.number().int().min(0).max(5000) });
const staleMs = 6 * 60 * 60 * 1000;

export function encodeCursor(requestId: string, offset: number) {
  return Buffer.from(JSON.stringify({ r: requestId, o: offset })).toString("base64url");
}

async function readCursor(value: unknown) {
  if (value === undefined) return null;
  try {
    if (typeof value !== "string" || value.length > 256) throw new Error();
    return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    await bumpCounter("cursor_rejected");
    throw new AuthError(400, "invalid_cursor");
  }
}

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("feed_timeout");
      controller.abort(error);
      reject(error);
    }, ms);
  });
  return Promise.race([run(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

function scoreAll(
  candidates: { postId: string; authorId: string; ageHours: number; sources: string[] }[],
  features: Map<string, number[]>,
  model: Awaited<ReturnType<typeof loadModel>>,
  config: FeedConfig,
  controls: Controls | null,
  topics: Map<string, string[]>,
) {
  const scored: Scored[] = [];
  for (const candidate of candidates) {
    const vector = features.get(candidate.postId);
    if (!vector) continue;
    const predictions = predict(model, vector);
    const factors = controls ? factorsFor(controls, config, candidate, topics.get(candidate.postId) ?? []) : undefined;
    scored.push({
      ...candidate,
      features: vector,
      predictions,
      score: value(predictions, vector, candidate.ageHours, config, factors),
      boost: factors && { author: factors.author, topic: factors.topic },
    });
  }
  return scored;
}

async function rank(options: { viewerId: string | null; mode: FeedMode; chainId: string; continuation: boolean; signal?: AbortSignal }) {
  const started = performance.now();
  const timings: Record<string, number> = {};
  let mark = started;
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = Math.round(now - mark);
    mark = now;
  };
  await registerFeatureSet();
  const [{ id: configId, config }, model] = await Promise.all([loadConfig(), loadModel()]);
  const controls = options.mode === "personal" && options.viewerId ? await loadControls(options.viewerId, config) : null;
  const repliesLevel = controls ? Math.min(4, Math.max(0, controls.sliders.replies + 2)) : 2;
  const candidates = await loadInventory({
    viewerId: options.viewerId,
    chainId: options.continuation ? options.chainId : null,
    windowHours: config.windowHours,
    wideWindowHours: config.wideWindowHours,
    minCandidates: config.minCandidates,
    maxCandidates: config.maxCandidates,
    controls: controls && {
      excludedPosts: controls.excludedPosts,
      snoozedAuthors: controls.snoozedAuthors,
      noReplies: config.controls.repliesFactor[repliesLevel] === 0,
    },
  });
  lap("inventory");
  options.signal?.throwIfAborted();
  const postIds = candidates.map((candidate) => candidate.postId);
  const [features, topics] = await Promise.all([
    computeFeatures(options.viewerId, postIds),
    controls ? loadPostTopics(postIds) : Promise.resolve(new Map<string, string[]>()),
  ]);
  lap("features");
  options.signal?.throwIfAborted();
  const scored = scoreAll(candidates, features, model, config, controls, topics);
  lap("score");
  const requestId = randomUUID();
  const placed = rerank(scored, config, requestId, config.storedCandidates);
  lap("rerank");
  options.signal?.throwIfAborted();
  await db.transaction(async (tx) => {
    await tx.insert(feedRequests).values({
      id: requestId,
      userId: options.mode === "personal" ? options.viewerId : null,
      mode: options.mode,
      surface: "for_you",
      chainId: options.chainId,
      continuation: options.continuation,
      modelId: model.id,
      configId,
      featureVersion,
      sourceCounts: countSources(candidates),
      candidateCount: candidates.length,
      latencyMs: 0,
      timings,
      prefs: controls ? controlsSnapshot(controls) : null,
    });
    if (placed.length)
      await tx.insert(feedCandidates).values(placed.map((item) => ({
        requestId,
        postId: item.postId,
        position: item.position,
        sources: item.sources,
        features: item.features,
        predictions: item.predictions,
        score: item.score,
        reason: reasonFor(item),
        explore: item.explore,
        propensity: item.propensity,
      })));
  });
  lap("write");
  return { requestId, stored: placed.length, candidateCount: candidates.length, started, timings, config };
}

let publicRanking: ReturnType<typeof rank> | null = null;

async function sharedPublicRank() {
  if (publicRanking) return { ranked: await publicRanking, owner: false };
  publicRanking = rank({ viewerId: null, mode: "public", chainId: randomUUID(), continuation: false })
    .finally(() => {
      publicRanking = null;
    });
  return { ranked: await publicRanking, owner: true };
}

async function finishTimings(requestId: string, started: number, timings: Record<string, number>, hydrateMs: number) {
  const all = { ...timings, hydrate: hydrateMs };
  await db.update(feedRequests).set({ timings: all, latencyMs: Math.round(performance.now() - started) })
    .where(eq(feedRequests.id, requestId));
}

async function blockedAuthors(viewerId: string | null, authorIds: string[]) {
  if (!viewerId || !authorIds.length) return new Set<string>();
  const rows = await db.select({ blocker: userBlocks.blockerId, blocked: userBlocks.blockedId }).from(userBlocks).where(sql`
    (${userBlocks.blockerId} = ${viewerId} and ${inArray(userBlocks.blockedId, authorIds)})
    or (${userBlocks.blockedId} = ${viewerId} and ${inArray(userBlocks.blockerId, authorIds)})`);
  return new Set(rows.map((row) => (row.blocker === viewerId ? row.blocked : row.blocker)));
}

async function repostContexts(viewerId: string, postIds: string[]): Promise<RepostContexts> {
  if (!postIds.length) return {};
  const { rows } = await db.execute<{ post_id: string; user_id: string; audience: "public" | "friends"; others: number }>(sql`
    select distinct on (r.post_id) r.post_id, r.user_id, r.audience, (count(*) over (partition by r.post_id) - 1)::int as others
    from post_reposts r join users u on u.id = r.user_id and u.banned_at is null
    where r.post_id = any(${`{${postIds.join(",")}}`}::uuid[])
      and r.user_id in (select following_id from user_follows where follower_id = ${viewerId}::uuid)
      and ${repostVisibleSql(viewerId)}
      and ${notBlockedSql(viewerId, sql`r.user_id`)}
    order by r.post_id, r.created_at desc`);
  const users = await loadUsers([...new Set(rows.map((row) => row.user_id))]);
  const result: RepostContexts = {};
  for (const row of rows) {
    const by = users.get(row.user_id);
    if (by) result[row.post_id] = { by, audience: row.audience, others: row.others };
  }
  return result;
}

async function hydrate(
  items: { postId: string; position: number; reason: Reason; sources: string[] }[],
  requestId: string,
  viewerId: string | null,
  mode: FeedMode,
) {
  const postsById = await loadPosts(items.map((item) => item.postId), viewerId);
  const blocked = mode === "public" ? await blockedAuthors(viewerId, [...new Set([...postsById.values()].map((post) => post.author.id))]) : new Set<string>();
  const list: PostRecord[] = [];
  const placements: Record<string, Placement> = {};
  for (const item of items) {
    const post = postsById.get(item.postId);
    if (!post || blocked.has(post.author.id) || (viewerId && post.author.id === viewerId)) continue;
    list.push(post);
    placements[post.id] = { requestId, position: item.position, reason: item.reason };
  }
  const reposted = mode === "personal" && viewerId
    ? await repostContexts(viewerId, items.filter((item) => item.reason === "network").map((item) => item.postId))
    : {};
  const [withReplies, ancestors] = await Promise.all([attachSelfReplies(list, viewerId), loadAncestors(list, viewerId)]);
  return {
    posts: withReplies.map((post) => (post.parentId ? { ...post, ancestors: ancestors.get(post.id) ?? [] } : post)),
    repostedBy: reposted,
    placements,
  };
}

async function serve(requestId: string, offset: number, pageSize: number, mode: FeedMode, signal: AbortSignal) {
  const rows = await db.select({
    postId: feedCandidates.postId,
    position: feedCandidates.position,
    reason: feedCandidates.reason,
    sources: feedCandidates.sources,
  }).from(feedCandidates)
    .where(and(eq(feedCandidates.requestId, requestId), gte(feedCandidates.position, offset)))
    .orderBy(asc(feedCandidates.position))
    .limit(pageSize);
  signal.throwIfAborted();
  if (mode === "personal" && rows.length)
    await db.update(feedCandidates)
      .set({ servedAt: sql`now()`, page: Math.floor(offset / pageSize) })
      .where(and(eq(feedCandidates.requestId, requestId), inArray(feedCandidates.postId, rows.map((row) => row.postId)), sql`${feedCandidates.servedAt} is null`));
  return rows.map((row) => ({ ...row, reason: row.reason as Reason }));
}

async function latestPublic(seconds: number) {
  if (seconds <= 0) return null;
  const [row] = await db.select({ id: feedRequests.id, candidateCount: feedRequests.candidateCount }).from(feedRequests)
    .where(sql`${feedRequests.mode} = 'public' and ${feedRequests.surface} = 'for_you' and not ${feedRequests.continuation}
      and ${feedRequests.createdAt} > now() - ${seconds} * interval '1 second'`)
    .orderBy(sql`${feedRequests.createdAt} desc`).limit(1);
  return row ?? null;
}

async function storedCount(requestId: string) {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(feedCandidates).where(eq(feedCandidates.requestId, requestId));
  return row?.count ?? 0;
}

async function rankedPage(viewerId: string | null, mode: FeedMode, rawCursor: unknown, signal: AbortSignal): Promise<RankedPage> {
  const cursor = await readCursor(rawCursor);
  const { config } = await loadConfig();
  const pageSize = config.pageSize;
  let requestId: string;
  let offset = 0;
  let fresh: Awaited<ReturnType<typeof rank>> | null = null;
  let ownsTimings = true;
  let candidateCount: number;
  if (cursor) {
    const [request] = await db.select().from(feedRequests).where(eq(feedRequests.id, cursor.r)).limit(1);
    const owned = request && request.surface === "for_you" &&
      (mode === "personal" ? request.mode === "personal" && request.userId === viewerId : request.mode === "public");
    if (!request || !owned) {
      await bumpCounter("cursor_rejected");
      throw new AuthError(400, "invalid_cursor");
    }
    const stale = Date.now() - request.createdAt.getTime() > staleMs;
    const stored = await storedCount(request.id);
    if (!stale && cursor.o < stored) {
      requestId = request.id;
      offset = cursor.o;
      candidateCount = request.candidateCount;
    } else if (mode === "personal" && (stale || request.candidateCount > stored)) {
      fresh = await rank({ viewerId, mode, chainId: request.chainId, continuation: true, signal });
      requestId = fresh.requestId;
      candidateCount = fresh.candidateCount;
    } else if (mode === "public" && stale) {
      const shared = await sharedPublicRank();
      fresh = shared.ranked;
      ownsTimings = shared.owner;
      requestId = fresh.requestId;
      candidateCount = fresh.candidateCount;
    } else {
      await bumpCounter("caught_up");
      return { posts: [], repostedBy: {}, nextCursor: null, requestId: request.id, placements: {}, caughtUp: true, fallback: false };
    }
  } else if (mode === "public") {
    const cachedRequest = await latestPublic(config.publicCacheSeconds);
    if (cachedRequest) {
      await bumpCounter("public_cache_hit");
      requestId = cachedRequest.id;
      candidateCount = cachedRequest.candidateCount;
    } else {
      await bumpCounter("public_cache_miss");
      const shared = await sharedPublicRank();
      fresh = shared.ranked;
      ownsTimings = shared.owner;
      requestId = fresh.requestId;
      candidateCount = fresh.candidateCount;
    }
  } else {
    fresh = await rank({ viewerId, mode, chainId: randomUUID(), continuation: false, signal });
    requestId = fresh.requestId;
    candidateCount = fresh.candidateCount;
  }
  const hydrateStarted = performance.now();
  const items = await serve(requestId, offset, pageSize, mode, signal);
  const page = await hydrate(items, requestId, viewerId, mode);
  if (fresh && ownsTimings) await finishTimings(requestId, fresh.started, fresh.timings, Math.round(performance.now() - hydrateStarted));
  const stored = fresh ? fresh.stored : await storedCount(requestId);
  const nextOffset = offset + items.length;
  const more = nextOffset < stored || (mode === "personal" && candidateCount > stored && items.length > 0);
  const caughtUp = items.length === 0;
  if (caughtUp) await bumpCounter("caught_up");
  return {
    ...page,
    nextCursor: more ? encodeCursor(requestId, nextOffset) : null,
    requestId,
    caughtUp,
    fallback: false,
  };
}

async function fallbackPage(viewerId: string | null): Promise<RankedPage> {
  const { rows } = await db.execute<{ id: string }>(sql`
    select p.id from posts p join users a on a.id = p.author_id and a.banned_at is null
    where p.parent_id is null and p.hidden_at is null and p.created_at > now() - interval '7 days'
      ${viewerId ? sql`and p.author_id <> ${viewerId}::uuid and ${notBlockedSql(viewerId, sql`p.author_id`)}` : sql``}
    order by p.created_at desc limit 20`);
  const postsById = await loadPosts(rows.map((row) => row.id), viewerId);
  const list = rows.flatMap((row) => postsById.get(row.id) ?? []);
  return {
    posts: await attachSelfReplies(list, viewerId),
    repostedBy: {},
    nextCursor: null,
    requestId: null,
    placements: {},
    caughtUp: false,
    fallback: true,
  };
}

export async function forYouPage(viewer: { id: string | null; personal: boolean }, rawCursor: unknown) {
  const mode: FeedMode = viewer.personal && viewer.id ? "personal" : "public";
  const { config } = await loadConfig();
  try {
    return await withTimeout((signal) => rankedPage(viewer.id, mode, rawCursor, signal), config.timeoutMs);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    const timedOut = error instanceof Error && error.message === "feed_timeout";
    await bumpCounter(timedOut ? "pipeline_fallback_chrono" : "pipeline_error");
    if (!timedOut) console.error({ event: "feed_pipeline_failed", error: error instanceof Error ? error.message : String(error) });
    return fallbackPage(viewer.id);
  }
}

export async function shadowFollowing(viewerId: string, list: PostRecord[], offset: number, chainId: string) {
  if (!list.length) return { requestId: null, placements: {} as Record<string, Placement> };
  const started = performance.now();
  await registerFeatureSet();
  const [{ id: configId, config }, model] = await Promise.all([loadConfig(), loadModel()]);
  const features = await computeFeatures(viewerId, list.map((post) => post.id));
  const requestId = randomUUID();
  const placements: Record<string, Placement> = {};
  const rows = list.flatMap((post, index) => {
    const vector = features.get(post.id);
    if (!vector) return [];
    const predictions = predict(model, vector);
    const ageHours = (Date.now() - new Date(post.createdAt).getTime()) / 3_600_000;
    const position = offset + index;
    const reason = reasonFor({ sources: ["following"], features: vector, explore: false });
    placements[post.id] = { requestId, position, reason };
    return [{
      requestId, postId: post.id, position, sources: ["following"], features: vector, predictions,
      score: value(predictions, vector, ageHours, config), reason, explore: false, propensity: 1,
      servedAt: new Date(), page: Math.floor(offset / config.pageSize),
    }];
  });
  await db.transaction(async (tx) => {
    await tx.insert(feedRequests).values({
      id: requestId, userId: viewerId, mode: "personal", surface: "following", chainId, continuation: offset > 0,
      modelId: model.id, configId, featureVersion, sourceCounts: { following: rows.length },
      candidateCount: rows.length, latencyMs: Math.round(performance.now() - started), timings: {},
    });
    if (rows.length) await tx.insert(feedCandidates).values(rows);
  });
  return { requestId, placements };
}
