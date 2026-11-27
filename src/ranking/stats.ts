import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.ts";
import { defaultConfig, headNames, loadConfig } from "./config.ts";
import { featureIndex, featureNames, featureVersion, priorHeads } from "./model.ts";

export const minUsers = 5;
export const minViewers = minUsers;

const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const rate = (part: unknown, whole: unknown) => (num(whole) > 0 ? num(part) / num(whole) : null);
async function rows<T extends Record<string, unknown>>(query: SQL) {
  return (await db.execute<T>(query)).rows;
}

const inNetworkIndex = featureIndex.in_network + 1;
const days = (range: number) => sql`generate_series(date_trunc('day', now()) - (${range - 1} * interval '1 day'), date_trunc('day', now()), interval '1 day')`;
const since = (range: number) => sql`(date_trunc('day', now()) - (${range - 1} * interval '1 day'))`;
const shareTypes = sql.raw(`('repost', 'quote', 'share')`);

async function adoption(range: number) {
  const [totals] = await rows<Record<string, string>>(sql`
    select
      count(*) filter (where feed_choice_at is not null and feed_personalize) as opted_in,
      count(*) filter (where feed_choice_at is not null and not feed_personalize) as opted_out,
      count(*) filter (where feed_choice_at is null and approved_at is not null and banned_at is null) as undecided,
      (select count(distinct u) from (
        select author_id as u from posts where created_at > now() - interval '7 days'
        union select user_id from post_likes where created_at > now() - interval '7 days') a) as active_7d,
      (select count(distinct u) from (
        select author_id as u from posts where created_at > now() - interval '7 days'
        union select user_id from post_likes where created_at > now() - interval '7 days') a
        join users x on x.id = a.u where x.feed_choice_at is not null and x.feed_personalize) as active_opted_in_7d
    from users where banned_at is null`);
  const choices = await rows<{ day: string; opted_in: string; opted_out: string }>(sql`
    select to_char(d, 'YYYY-MM-DD') as day,
      count(u.id) filter (where u.feed_personalize) as opted_in,
      count(u.id) filter (where not u.feed_personalize) as opted_out
    from ${days(range)} d
    left join users u on u.feed_choice_at >= d and u.feed_choice_at < d + interval '1 day'
    group by d order by d`);
  const [counters] = await rows<Record<string, string>>(sql`
    select
      coalesce(sum(value) filter (where name = 'choice_unlock_nav'), 0) as unlocks,
      coalesce(sum(value) filter (where name = 'choice_decline_nav'), 0) as declines
    from feed_counters where day >= ${since(range)}::date`);
  const [home] = await rows<Record<string, string>>(sql`
    select count(*) filter (where mode = 'personal') as personal, count(*) filter (where mode = 'public') as public
    from feed_requests where surface = 'for_you' and not continuation and created_at >= ${since(range)}`);
  return {
    optedIn: num(totals?.opted_in),
    optedOut: num(totals?.opted_out),
    undecided: num(totals?.undecided),
    activeUsers7d: num(totals?.active_7d),
    activeOptedIn7d: num(totals?.active_opted_in_7d),
    choicesByDay: choices.map((row) => ({ day: row.day, optedIn: num(row.opted_in), optedOut: num(row.opted_out) })),
    unlocksFromNav: num(counters?.unlocks),
    declinesFromNav: num(counters?.declines),
    homeRequests: { personal: num(home?.personal), public: num(home?.public) },
  };
}

async function pipeline(range: number) {
  const byDay = await rows<{ day: string; personal: string; public: string; following: string }>(sql`
    select to_char(d, 'YYYY-MM-DD') as day,
      count(r.id) filter (where r.surface = 'for_you' and r.mode = 'personal') as personal,
      count(r.id) filter (where r.surface = 'for_you' and r.mode = 'public') as public,
      count(r.id) filter (where r.surface = 'following') as following
    from ${days(range)} d
    left join feed_requests r on r.created_at >= d and r.created_at < d + interval '1 day'
    group by d order by d`);
  const [latency] = await rows<Record<string, string | null>>(sql`
    select
      percentile_cont(0.5) within group (order by latency_ms) as p50,
      percentile_cont(0.95) within group (order by latency_ms) as p95,
      percentile_cont(0.99) within group (order by latency_ms) as p99,
      percentile_cont(0.5) within group (order by candidate_count) as candidates_p50,
      min(candidate_count) as candidates_min,
      count(*) as requests,
      count(*) filter (where continuation) as continuations
    from feed_requests where surface = 'for_you' and created_at >= ${since(range)}`);
  const stages = await rows<{ stage: string; p50: string; p95: string }>(sql`
    select t.key as stage,
      percentile_cont(0.5) within group (order by t.value::numeric) as p50,
      percentile_cont(0.95) within group (order by t.value::numeric) as p95
    from feed_requests r cross join lateral jsonb_each_text(r.timings) t
    where r.surface = 'for_you' and r.created_at >= ${since(range)}
    group by t.key order by min(array_position(array['inventory', 'features', 'score', 'rerank', 'write', 'hydrate'], t.key))`);
  const sources = await rows<{ source: string; count: string }>(sql`
    select s.key as source, sum(s.value::int) as count
    from feed_requests r cross join lateral jsonb_each_text(r.source_counts) s
    where r.surface = 'for_you' and r.created_at >= ${since(range)}
    group by s.key order by sum(s.value::int) desc`);
  const counters = await rows<{ day: string; errors: string; fallbacks: string; caught_up: string; rejected: string; hits: string; misses: string }>(sql`
    select to_char(d, 'YYYY-MM-DD') as day,
      coalesce(sum(c.value) filter (where c.name = 'pipeline_error'), 0) as errors,
      coalesce(sum(c.value) filter (where c.name = 'pipeline_fallback_chrono'), 0) as fallbacks,
      coalesce(sum(c.value) filter (where c.name = 'caught_up'), 0) as caught_up,
      coalesce(sum(c.value) filter (where c.name = 'cursor_rejected'), 0) as rejected,
      coalesce(sum(c.value) filter (where c.name = 'public_cache_hit'), 0) as hits,
      coalesce(sum(c.value) filter (where c.name = 'public_cache_miss'), 0) as misses
    from ${days(range)} d left join feed_counters c on c.day = d::date
    group by d order by d`);
  const sum = (key: keyof (typeof counters)[number]) => counters.reduce((total, row) => total + num(row[key]), 0);
  const requests = num(latency?.requests);
  return {
    requestsByDay: byDay.map((row) => ({ day: row.day, personal: num(row.personal), public: num(row.public), following: num(row.following) })),
    latencyMs: latency?.p50 === null || latency?.p50 === undefined ? null : { p50: num(latency.p50), p95: num(latency.p95), p99: num(latency.p99) },
    stages: stages.map((row) => ({ stage: row.stage, p50: num(row.p50), p95: num(row.p95) })),
    candidates: requests ? { p50: num(latency?.candidates_p50), min: num(latency?.candidates_min) } : null,
    sources: sources.map((row) => ({ source: row.source, count: num(row.count) })),
    continuationRate: rate(latency?.continuations, requests),
    caughtUp: sum("caught_up"),
    cursorRejected: sum("rejected"),
    publicCache: { hits: sum("hits"), misses: sum("misses") },
    problemsByDay: counters.map((row) => ({ day: row.day, errors: num(row.errors), fallbacks: num(row.fallbacks) })),
  };
}

async function engagement(range: number) {
  const surfaces = await rows<Record<string, string>>(sql`
    select surface,
      count(distinct user_id) as viewers,
      count(*) filter (where type = 'impression') as impressions,
      count(*) filter (where type = 'open') as opens,
      count(*) filter (where type = 'dwell' and value >= 3000) as dwells,
      count(*) filter (where type = 'like') as likes,
      count(*) filter (where type = 'reply') as replies,
      count(*) filter (where type in ${shareTypes}) as shares,
      count(*) filter (where type = 'profile_open') as profiles
    from feed_events
    where surface in ('for_you', 'following') and created_at >= ${since(range)} and origin <> 'backfill'
    group by surface order by surface`);
  const daily = await rows<{ day: string; surface: string; viewers: string; impressions: string; actions: string }>(sql`
    select to_char(d, 'YYYY-MM-DD') as day, s.surface,
      count(distinct e.user_id) as viewers,
      count(e.id) filter (where e.type = 'impression') as impressions,
      count(e.id) filter (where e.type in ('like', 'reply', 'repost', 'quote', 'share', 'open')) as actions
    from ${days(range)} d cross join (values ('for_you'), ('following')) s(surface)
    left join feed_events e on e.surface = s.surface and e.created_at >= d and e.created_at < d + interval '1 day' and e.origin <> 'backfill'
    group by d, s.surface order by d`);
  const per100 = (part: unknown, impressions: unknown) => {
    const value = rate(part, impressions);
    return value === null ? null : Math.round(value * 1000) / 10;
  };
  return {
    surfaces: surfaces.map((row) => {
      const enough = num(row.viewers) >= minUsers;
      return {
        surface: row.surface,
        viewers: enough ? num(row.viewers) : null,
        impressions: enough ? num(row.impressions) : null,
        per100: enough
          ? {
            opens: per100(row.opens, row.impressions),
            dwells: per100(row.dwells, row.impressions),
            likes: per100(row.likes, row.impressions),
            replies: per100(row.replies, row.impressions),
            shares: per100(row.shares, row.impressions),
            profiles: per100(row.profiles, row.impressions),
          }
          : null,
      };
    }),
    dailyActionsPer100: Object.values(daily.reduce<Record<string, { day: string; forYou: number | null; following: number | null }>>((acc, row) => {
      const entry = acc[row.day] ?? { day: row.day, forYou: null, following: null };
      const value = num(row.viewers) >= minUsers ? per100(row.actions, row.impressions) : null;
      if (row.surface === "for_you") entry.forYou = value;
      else entry.following = value;
      acc[row.day] = entry;
      return acc;
    }, {})),
  };
}

async function position(range: number) {
  const [viewers] = await rows<{ viewers: string }>(sql`
    select count(distinct user_id) as viewers from feed_events
    where surface = 'for_you' and type = 'impression' and created_at >= ${since(range)}`);
  if (num(viewers?.viewers) < minUsers) return { enough: false, byPosition: [], explore: null };
  const byPosition = await rows<{ position: number; impressions: string; opens: string; likes: string }>(sql`
    select position,
      count(*) filter (where type = 'impression') as impressions,
      count(*) filter (where type = 'open') as opens,
      count(*) filter (where type = 'like') as likes
    from feed_events
    where surface = 'for_you' and position is not null and position < 20 and created_at >= ${since(range)}
    group by position order by position`);
  const explore = await rows<{ explore: boolean; served: string; impressions: string; engaged: string }>(sql`
    select c.explore,
      count(*) as served,
      count(*) filter (where exists (
        select 1 from feed_events e where e.request_id = c.request_id and e.post_id = c.post_id and e.type = 'impression')) as impressions,
      count(*) filter (where exists (
        select 1 from feed_events e where e.request_id = c.request_id and e.post_id = c.post_id
          and e.type in ('open', 'like', 'reply', 'repost', 'quote', 'share', 'profile_open'))) as engaged
    from feed_candidates c join feed_requests r on r.id = c.request_id
    where r.surface = 'for_you' and r.mode = 'personal' and c.served_at is not null and r.created_at >= ${since(range)}
    group by c.explore`);
  const pick = (flag: boolean) => {
    const row = explore.find((entry) => entry.explore === flag);
    return { served: num(row?.served), impressions: num(row?.impressions), engagementRate: rate(row?.engaged, row?.impressions) };
  };
  return {
    enough: true,
    byPosition: byPosition.map((row) => ({
      position: row.position,
      impressions: num(row.impressions),
      openRate: rate(row.opens, row.impressions),
      likeRate: rate(row.likes, row.impressions),
    })),
    explore: { explored: pick(true), ranked: pick(false) },
  };
}

async function diversity(range: number) {
  const [served] = await rows<Record<string, string | null>>(sql`
    with pages as (
      select c.request_id, c.page, count(distinct p.author_id) as authors
      from feed_candidates c join feed_requests r on r.id = c.request_id join posts p on p.id = c.post_id
      where r.surface = 'for_you' and r.mode = 'personal' and c.served_at is not null and r.created_at >= ${since(range)}
      group by c.request_id, c.page
    )
    select
      (select avg(authors) from pages) as authors_per_page,
      (select count(distinct r.user_id) from feed_requests r where r.surface = 'for_you' and r.mode = 'personal' and r.created_at >= ${since(range)}) as viewers,
      (select avg((c.features[${inNetworkIndex}] >= 0.5)::int) from feed_candidates c join feed_requests r on r.id = c.request_id
        where r.surface = 'for_you' and r.mode = 'personal' and c.served_at is not null and r.created_at >= ${since(range)}) as in_network`);
  const [authors] = await rows<{ top5: string | null; total: string; viewers: string }>(sql`
    with counts as (
      select author_id, count(*) as n from feed_events
      where surface = 'for_you' and type = 'impression' and author_id is not null and created_at >= ${since(range)}
      group by author_id
    )
    select (select sum(n) from (select n from counts order by n desc limit 5) t) as top5,
      (select coalesce(sum(n), 0) from counts) as total,
      (select count(distinct user_id) from feed_events where surface = 'for_you' and type = 'impression' and created_at >= ${since(range)}) as viewers`);
  const [coverage] = await rows<{ recent: string; recent_shown: string; older: string; older_never: string }>(sql`
    with shown as (
      select distinct c.post_id from feed_candidates c join feed_requests r on r.id = c.request_id
      where r.surface = 'for_you' and (c.served_at is not null or (r.mode = 'public' and c.position < 20))
    )
    select
      count(*) filter (where p.created_at > now() - interval '72 hours') as recent,
      count(*) filter (where p.created_at > now() - interval '72 hours' and p.id in (select post_id from shown)) as recent_shown,
      count(*) filter (where p.created_at <= now() - interval '72 hours' and p.created_at >= ${since(range)}) as older,
      count(*) filter (where p.created_at <= now() - interval '72 hours' and p.created_at >= ${since(range)} and p.id not in (select post_id from shown)) as older_never
    from posts p where p.parent_id is null and p.hidden_at is null`);
  const top = await rows<Record<string, unknown>>(sql`
    select p.id, p.content, p.gif, p.voice ->> 'url' as voice_url, p.image_ids, p.created_at, u.handle,
      count(*) as impressions, count(distinct e.user_id) as viewers
    from feed_events e join posts p on p.id = e.post_id join users u on u.id = p.author_id
    where e.surface = 'for_you' and e.type = 'impression' and e.created_at >= ${since(range)}
      and p.hidden_at is null and u.banned_at is null
    group by p.id, u.handle
    having count(distinct e.user_id) >= ${minViewers}
    order by count(*) desc limit 10`);
  const enoughViewers = num(served?.viewers) >= minUsers;
  const enoughImpressionViewers = num(authors?.viewers) >= minUsers;
  return {
    authorsPerPage: enoughViewers && served?.authors_per_page !== null ? num(served?.authors_per_page) : null,
    inNetworkShare: enoughViewers && served?.in_network !== null ? num(served?.in_network) : null,
    top5AuthorShare: enoughImpressionViewers ? rate(authors?.top5, authors?.total) : null,
    recentCoverage: rate(coverage?.recent_shown, coverage?.recent),
    neverShownShare: rate(coverage?.older_never, coverage?.older),
    topPosts: top.map((row) => ({
      id: String(row.id),
      handle: String(row.handle),
      content: String(row.content).slice(0, 280),
      gif: (row.gif ?? null) as { url: string; title?: string } | null,
      voiceUrl: (row.voice_url as string | null) ?? null,
      imageIds: (row.image_ids as string[] | null) ?? [],
      createdAt: new Date(row.created_at as string).toISOString(),
      impressions: num(row.impressions),
      viewers: num(row.viewers),
    })),
  };
}

const minimums: Record<(typeof headNames)[number], number> = {
  dwell: 300, click: 200, profile: 100, like: 150, comment: 80, share: 80, save: 50, follow: 30, negative: 30,
};
const headFilters: Record<(typeof headNames)[number], SQL> = {
  dwell: sql`e.type = 'dwell' and e.value >= 3000`,
  click: sql`(e.type in ('open', 'expand', 'spoiler', 'media_open', 'link_open') or (e.type = 'voice_play' and e.value >= 3000))`,
  profile: sql`e.type = 'profile_open'`,
  like: sql`e.type = 'like'`,
  comment: sql`e.type = 'reply'`,
  share: sql`e.type in ('repost', 'quote', 'share')`,
  save: sql`e.type = 'save'`,
  follow: sql`e.type = 'follow'`,
  negative: sql`e.type in ('less', 'snooze', 'topic_less', 'block', 'report')`,
};

async function training() {
  const [start] = await rows<{ started: string | null; examples: string }>(sql`
    select (select min(created_at) from feed_requests) as started,
      (select count(*) from feed_events e where e.type = 'impression' and e.request_id is not null
        and e.created_at < now() - interval '24 hours') as examples`);
  if (!start?.started) return { since: null, examples: 0, heads: headNames.map((head) => ({ head, positives: 0, minimum: minimums[head], perDay: 0, etaDays: null })) };
  const selects = headNames.map((head) => sql`
    select ${head}::text as head,
      count(*) filter (where ${headFilters[head]}) as positives,
      count(*) filter (where ${headFilters[head]} and e.created_at > now() - interval '7 days') as recent
    from feed_events e
    where e.created_at >= ${start.started}::timestamptz and e.origin <> 'backfill'
      and (e.request_id is not null or e.type in ('follow', 'block', 'report', 'less', 'snooze', 'topic_less'))`);
  const counts = await rows<{ head: string; positives: string; recent: string }>(sql.join(selects, sql` union all `));
  const startedAt = new Date(start.started);
  const windowDays = Math.max(1, Math.min(7, (Date.now() - startedAt.getTime()) / 86_400_000));
  return {
    since: startedAt.toISOString(),
    examples: num(start.examples),
    heads: headNames.map((head) => {
      const row = counts.find((entry) => entry.head === head);
      const positives = num(row?.positives);
      const perDay = num(row?.recent) / windowDays;
      const missing = Math.max(0, minimums[head] - positives);
      return { head, positives, minimum: minimums[head], perDay: Math.round(perDay * 10) / 10, etaDays: missing === 0 ? 0 : perDay > 0 ? Math.ceil(missing / perDay) : null };
    }),
  };
}

async function model() {
  const { id, config } = await loadConfig();
  const [active] = await rows<{ id: string; activated_at: string | null; feature_version: number; metrics: unknown }>(sql`
    select id, activated_at, feature_version, metrics from feed_models where status = 'active' limit 1`);
  const history = await rows<{ id: string; created_at: string; handle: string | null; values: unknown }>(sql`
    select c.id, c.created_at, u.handle, c.values from feed_config c left join users u on u.id = c.created_by
    order by c.created_at desc limit 20`);
  return {
    active: active ? { id: active.id, activatedAt: active.activated_at && new Date(active.activated_at).toISOString(), featureVersion: active.feature_version } : null,
    featureVersion,
    featureNames: [...featureNames],
    prior: Object.fromEntries(headNames.map((head) => [head, { bias: priorHeads[head].bias, weights: priorHeads[head].weights }])),
    configId: id,
    config,
    defaults: defaultConfig,
    history: history.map((row) => ({ id: row.id, createdAt: new Date(row.created_at).toISOString(), handle: row.handle, values: row.values })),
  };
}

async function volume() {
  const tables = await rows<{ name: string; rows: string; bytes: string; oldest: string | null }>(sql`
    select 'feed_events' as name, (select count(*) from feed_events) as rows, pg_total_relation_size('feed_events') as bytes,
      (select min(created_at) from feed_events) as oldest
    union all
    select 'feed_requests', (select count(*) from feed_requests), pg_total_relation_size('feed_requests'),
      (select min(created_at) from feed_requests)
    union all
    select 'feed_candidates', (select count(*) from feed_candidates), pg_total_relation_size('feed_candidates'),
      (select min(r.created_at) from feed_candidates c join feed_requests r on r.id = c.request_id)
    union all
    select 'feed_counters', (select count(*) from feed_counters), pg_total_relation_size('feed_counters'),
      (select min(day)::timestamptz from feed_counters)
    union all
    select 'feed_feedback', (select count(*) from feed_feedback), pg_total_relation_size('feed_feedback'),
      (select min(created_at) from feed_feedback)`);
  const [due] = await rows<Record<string, string>>(sql`
    select
      (select count(*) from feed_events where origin = 'client' and created_at < now() - interval '180 days') as events_client,
      (select count(*) from feed_events where origin <> 'client' and created_at < now() - interval '365 days') as events_server,
      (select count(*) from feed_requests where mode = 'personal' and created_at < now() - interval '180 days') as requests_personal,
      (select count(*) from feed_requests where mode = 'public' and created_at < now() - interval '2 days') as requests_public,
      (select count(*) from feed_candidates c join feed_requests r on r.id = c.request_id
        where c.served_at is null and r.created_at < now() - interval '14 days') as candidates_unserved,
      (select count(*) from feed_feedback where expires_at < now()) as feedback_expired`);
  return {
    tables: tables.map((row) => ({ name: row.name, rows: num(row.rows), bytes: num(row.bytes), oldest: row.oldest && new Date(row.oldest).toISOString() })),
    retentionDue: [
      { rule: "Client events older than 180 days", rows: num(due?.events_client) },
      { rule: "Server events older than 365 days", rows: num(due?.events_server) },
      { rule: "Personal feed requests older than 180 days", rows: num(due?.requests_personal) },
      { rule: "Public feed requests older than 2 days", rows: num(due?.requests_public) },
      { rule: "Unserved candidates older than 14 days", rows: num(due?.candidates_unserved) },
      { rule: "Expired feed feedback", rows: num(due?.feedback_expired) },
    ],
  };
}

const controlTypes = sql.raw(`('more', 'less', 'snooze', 'topic_more', 'topic_less')`);

async function controls(range: number) {
  const [users] = await rows<Record<string, string>>(sql`
    select
      (select count(*) from users where banned_at is null and feed_choice_at is not null and feed_personalize) as opted_in,
      (select count(distinct user_id) from feed_events where type in ${controlTypes} and created_at >= ${since(range)}) as acted,
      (select count(distinct user_id) from feed_feedback where expires_at is null or expires_at > now()) as holders,
      (select count(*) from users where banned_at is null and (feed_discovery <> 0 or feed_freshness <> 0 or feed_replies <> 0)) as tuned`);
  const holders = num(users?.holders);
  const optedIn = num(users?.opted_in);
  const [active] = await rows<Record<string, string>>(sql`
    select
      count(*) filter (where kind = 'post' and direction < 0) as not_interested,
      count(*) filter (where kind = 'post' and direction > 0) as interested,
      count(*) filter (where kind = 'snooze') as snoozes,
      count(*) filter (where kind = 'author') as authors,
      count(*) filter (where kind = 'topic' and direction > 0) as topics_more,
      count(*) filter (where kind = 'topic' and direction < 0) as topics_less
    from feed_feedback where expires_at is null or expires_at > now()`);
  const daily = await rows<Record<string, string>>(sql`
    select to_char(d, 'YYYY-MM-DD') as day,
      count(e.id) filter (where e.type in ('less', 'snooze')) as less,
      count(e.id) filter (where e.type = 'more') as more,
      count(e.id) filter (where e.type in ('topic_more', 'topic_less')) as topic
    from ${days(range)} d
    left join feed_events e on e.type in ${controlTypes} and e.created_at >= d and e.created_at < d + interval '1 day'
    group by d order by d`);
  const sliders = await rows<{ slider: string; level: number; users: string }>(sql`
    select s.slider, s.level, count(*) as users from users u
    cross join lateral (values ('discovery', u.feed_discovery), ('freshness', u.feed_freshness), ('replies', u.feed_replies)) as s(slider, level)
    where u.banned_at is null and u.feed_choice_at is not null and u.feed_personalize
    group by s.slider, s.level`);
  const topics = await rows<{ topic: string; direction: number; users: string }>(sql`
    select topic, direction, count(distinct user_id) as users from feed_feedback
    where kind = 'topic' group by topic, direction having count(distinct user_id) >= ${minUsers}
    order by count(distinct user_id) desc, topic limit 10`);
  const enough = optedIn >= minUsers;
  const levels = [-2, -1, 0, 1, 2];
  return {
    enough,
    optedIn,
    usersActed: enough ? num(users?.acted) : null,
    usersWithControls: holders >= minUsers ? holders : null,
    usersTuned: enough ? num(users?.tuned) : null,
    active: {
      notInterested: num(active?.not_interested),
      interested: num(active?.interested),
      snoozes: num(active?.snoozes),
      authors: num(active?.authors),
      topicsMore: num(active?.topics_more),
      topicsLess: num(active?.topics_less),
    },
    actionsByDay: daily.map((row) => ({ day: row.day!, less: num(row.less), more: num(row.more), topic: num(row.topic) })),
    sliders: enough
      ? (["discovery", "freshness", "replies"] as const).map((slider) => ({
        slider,
        levels: levels.map((level) => ({
          level,
          users: num(sliders.find((row) => row.slider === slider && Number(row.level) === level)?.users),
        })),
      }))
      : [],
    topTopics: topics.map((row) => ({ topic: row.topic, direction: Number(row.direction) > 0 ? "more" as const : "less" as const, users: num(row.users) })),
  };
}

async function guarded<T>(load: () => Promise<T>): Promise<T | { error: true }> {
  try {
    return await load();
  } catch (error) {
    console.error({ event: "admin_feed_section_failed", error: error instanceof Error ? error.message : String(error) });
    return { error: true };
  }
}

export async function feedDashboard(range: number) {
  const [adoptionInfo, pipelineInfo, engagementInfo, positionInfo, diversityInfo, trainingInfo, modelInfo, volumeInfo, controlsInfo] = await Promise.all([
    guarded(() => adoption(range)),
    guarded(() => pipeline(range)),
    guarded(() => engagement(range)),
    guarded(() => position(range)),
    guarded(() => diversity(range)),
    guarded(training),
    guarded(model),
    guarded(volume),
    guarded(() => controls(range)),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    days: range,
    thresholds: { minUsers, minViewers },
    adoption: adoptionInfo,
    pipeline: pipelineInfo,
    engagement: engagementInfo,
    position: positionInfo,
    diversity: diversityInfo,
    training: trainingInfo,
    model: modelInfo,
    volume: volumeInfo,
    controls: controlsInfo,
  };
}

export async function feedHealth() {
  const [row] = await rows<Record<string, string | null>>(sql`
    select
      (select count(*) from users where banned_at is null and feed_choice_at is not null and feed_personalize) as opted_in,
      (select count(*) from users where banned_at is null and feed_choice_at is not null and not feed_personalize) as opted_out,
      (select count(*) from users where banned_at is null and approved_at is not null and feed_choice_at is null) as undecided,
      (select count(*) from feed_requests where surface = 'for_you' and mode = 'personal' and created_at > now() - interval '24 hours') as personal_24h,
      (select count(*) from feed_requests where surface = 'for_you' and mode = 'public' and created_at > now() - interval '24 hours') as public_24h,
      (select count(*) from feed_requests where surface = 'following' and created_at > now() - interval '24 hours') as following_24h,
      (select percentile_cont(0.5) within group (order by latency_ms) from feed_requests where surface = 'for_you' and created_at > now() - interval '24 hours') as p50,
      (select percentile_cont(0.95) within group (order by latency_ms) from feed_requests where surface = 'for_you' and created_at > now() - interval '24 hours') as p95,
      (select coalesce(sum(value), 0) from feed_counters where name = 'pipeline_error' and day >= (now() - interval '1 day')::date) as errors,
      (select coalesce(sum(value), 0) from feed_counters where name = 'pipeline_fallback_chrono' and day >= (now() - interval '1 day')::date) as fallbacks,
      (select coalesce(sum(value), 0) from feed_counters where name = 'caught_up' and day >= (now() - interval '1 day')::date) as caught_up,
      (select coalesce(sum(value), 0) from feed_counters where name = 'public_cache_hit' and day >= (now() - interval '1 day')::date) as hits,
      (select coalesce(sum(value), 0) from feed_counters where name = 'public_cache_miss' and day >= (now() - interval '1 day')::date) as misses,
      (select coalesce(sum(value), 0) from feed_counters where name = 'choice_unlock_nav' and day >= (now() - interval '7 days')::date) as unlocks,
      (select coalesce(sum(value), 0) from feed_counters where name = 'choice_decline_nav' and day >= (now() - interval '7 days')::date) as declines,
      (select count(*) from feed_events where type in ${controlTypes} and created_at > now() - interval '7 days') as controls_7d`);
  return {
    optedIn: num(row?.opted_in),
    optedOut: num(row?.opted_out),
    undecided: num(row?.undecided),
    requests24h: { personal: num(row?.personal_24h), public: num(row?.public_24h), following: num(row?.following_24h) },
    latencyMs24h: row?.p50 === null || row?.p50 === undefined ? null : { p50: num(row.p50), p95: num(row.p95) },
    errors24h: num(row?.errors),
    fallbacks24h: num(row?.fallbacks),
    caughtUp24h: num(row?.caught_up),
    publicCache24h: { hits: num(row?.hits), misses: num(row?.misses) },
    navChoices7d: { unlocks: num(row?.unlocks), declines: num(row?.declines) },
    controlsUsed7d: num(row?.controls_7d),
  };
}
