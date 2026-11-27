import { sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { notBlockedSql } from "../blocks.ts";
import { repostVisibleSql } from "../post-data.ts";

export const sourceNames = ["recent", "followee_repost", "followee_reply", "followee_like", "popular"] as const;
export type Source = (typeof sourceNames)[number];
export type Candidate = { postId: string; authorId: string; ageHours: number; sources: Source[] };

type Row = { post_id: string; author_id: string; age_hours: string | number; sources: Source[] };

const popularity = sql`(
  (select count(*) from post_likes l where l.post_id = p.id)
  + 2 * (select count(*) from posts c where c.parent_id = p.id and c.hidden_at is null)
  + 3 * (select count(*) from post_reposts r where r.post_id = p.id and r.audience = 'public'))`;

export type InventoryControls = { excludedPosts: string[]; snoozedAuthors: string[]; noReplies: boolean };
const uuidArray = (ids: string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;

async function query(viewerId: string | null, chainId: string | null, hours: number, limit: number, controls: InventoryControls | null) {
  const window = sql`now() - ${hours} * interval '1 hour'`;
  const quota = (share: number) => Math.max(10, Math.ceil(limit * share));
  const follows = viewerId ? sql`(select following_id from user_follows where follower_id = ${viewerId}::uuid)` : null;
  const personalSources = follows
    ? sql`
      union all
      (select r.post_id as id, 'followee_repost' as source from post_reposts r
        where r.user_id in ${follows} and r.created_at > ${window} and ${repostVisibleSql(viewerId)}
        order by r.created_at desc limit ${quota(0.15)})
      union all
      (select p.id, 'followee_reply' from posts p
        where p.parent_id is not null and p.author_id in ${follows} and p.created_at > ${window} and p.hidden_at is null
          and not exists (select 1 from posts parent where parent.id = p.parent_id and parent.author_id = p.author_id)
        order by p.created_at desc limit ${quota(0.1)})
      union all
      (select l.post_id, 'followee_like' from post_likes l
        where l.user_id in ${follows} and l.created_at > ${window}
        order by l.created_at desc limit ${quota(0.15)})`
    : sql``;
  const viewerFilters = viewerId
    ? sql`
      and p.author_id <> ${viewerId}::uuid
      and ${notBlockedSql(viewerId, sql`p.author_id`)}
      and not exists (select 1 from post_likes l where l.post_id = p.id and l.user_id = ${viewerId}::uuid)
      and not exists (select 1 from post_reposts r where r.post_id = p.id and r.user_id = ${viewerId}::uuid)
      and not exists (select 1 from post_saves s where s.post_id = p.id and s.user_id = ${viewerId}::uuid)
      and not exists (select 1 from posts c where c.parent_id = p.id and c.author_id = ${viewerId}::uuid)
      and not exists (
        select 1 from feed_events e
        where e.user_id = ${viewerId}::uuid and e.post_id = p.id and e.type = 'impression'
          and e.created_at > now() - interval '24 hours'
          and not exists (
            select 1 from post_reposts r where r.post_id = p.id and r.user_id in ${follows!} and r.created_at > e.created_at)
          and not exists (
            select 1 from posts c where c.parent_id = p.id and c.author_id in ${follows!} and c.created_at > e.created_at))`
    : sql``;
  const controlFilters = viewerId && controls
    ? sql`
      ${controls.excludedPosts.length ? sql`and p.id <> all(${uuidArray(controls.excludedPosts)})` : sql``}
      ${controls.snoozedAuthors.length ? sql`and p.author_id <> all(${uuidArray(controls.snoozedAuthors)})` : sql``}
      ${controls.noReplies ? sql`and p.parent_id is null` : sql``}`
    : sql``;
  const chainFilter = chainId
    ? sql`and not exists (
        select 1 from feed_candidates fc join feed_requests fr on fr.id = fc.request_id
        where fr.chain_id = ${chainId}::uuid and fc.post_id = p.id and fc.served_at is not null)`
    : sql``;
  const { rows } = await db.execute<Row>(sql`
    with src as (
      (select p.id, 'recent' as source from posts p
        where p.parent_id is null and p.created_at > ${window} and p.hidden_at is null
        order by p.created_at desc limit ${limit})
      union all
      (select p.id, 'popular' from posts p
        where p.parent_id is null and p.created_at > now() - interval '72 hours' and p.hidden_at is null
        order by ${popularity} desc, p.created_at desc limit ${quota(0.15)})
      ${personalSources}
    )
    select p.id as post_id, p.author_id, extract(epoch from (now() - p.created_at)) / 3600 as age_hours,
      array_agg(distinct s.source) as sources
    from src s
    join posts p on p.id = s.id
    join users a on a.id = p.author_id and a.banned_at is null
    where p.hidden_at is null
      ${viewerFilters}
      ${controlFilters}
      ${chainFilter}
    group by p.id, p.author_id, p.created_at
    order by bool_or(s.source <> 'recent') desc, p.created_at desc
    limit ${limit}
  `);
  return rows.map((row): Candidate => ({
    postId: row.post_id,
    authorId: row.author_id,
    ageHours: Number(row.age_hours),
    sources: row.sources,
  }));
}

export async function loadInventory(options: {
  viewerId: string | null;
  chainId: string | null;
  windowHours: number;
  wideWindowHours: number;
  minCandidates: number;
  maxCandidates: number;
  controls?: InventoryControls | null;
}) {
  const controls = options.controls ?? null;
  const first = await query(options.viewerId, options.chainId, options.windowHours, options.maxCandidates, controls);
  if (first.length >= options.minCandidates || options.wideWindowHours <= options.windowHours) return first;
  return query(options.viewerId, options.chainId, options.wideWindowHours, options.maxCandidates, controls);
}

export function countSources(candidates: { sources: string[] }[]) {
  const counts: Record<string, number> = Object.fromEntries(sourceNames.map((name) => [name, 0]));
  for (const candidate of candidates) for (const source of candidate.sources) counts[source] = (counts[source] ?? 0) + 1;
  return counts;
}
