import { sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { feedFeatureSets } from "../db/schema.ts";
import { featureIndex, featureNames, featureVersion, viewerFeatures, type FeatureName } from "./model.ts";

const nobody = "00000000-0000-0000-0000-000000000000";
const engaged = sql.raw(`('like', 'reply', 'quote', 'repost', 'save', 'open', 'profile_open', 'media_open', 'expand', 'voice_play')`);

type Row = { post_id: string } & Record<Exclude<FeatureName, "position">, string | number | boolean | null>;

let registered = false;

export async function registerFeatureSet() {
  if (registered) return;
  await db.insert(feedFeatureSets).values({ version: featureVersion, names: [...featureNames] }).onConflictDoNothing();
  registered = true;
}

export async function computeFeatures(viewerId: string | null, postIds: string[]) {
  const result = new Map<string, number[]>();
  if (!postIds.length) return result;
  const viewer = viewerId ?? nobody;
  const ids = sql`${`{${postIds.join(",")}}`}::uuid[]`;
  const { rows } = await db.execute<Row>(sql`
    with cand as (
      select p.* from posts p where p.id = any(${ids})
    ),
    follows as (select following_id as id from user_follows where follower_id = ${viewer}::uuid),
    followers as (select follower_id as id from user_follows where following_id = ${viewer}::uuid),
    viewer_events as (
      select author_id, post_id, type, value, created_at from feed_events
      where user_id = ${viewer}::uuid and created_at > now() - interval '30 days'
    ),
    viewer_rate as (
      select count(*) filter (where type = 'like') as likes, count(*) filter (where type = 'impression') as impressions
      from viewer_events
    ),
    author_stats as (
      select author_id,
        sum(exp(-extract(epoch from (now() - created_at)) / 604800)) filter (
          where type in ${engaged} and created_at > now() - interval '21 days') as affinity,
        count(*) filter (where type = 'open') as opens,
        count(*) filter (where type = 'impression') as impressions
      from viewer_events where author_id is not null group by author_id
    ),
    reciprocity as (
      select actor as author_id, count(*) as n from (
        select l.user_id as actor from post_likes l join posts mine on mine.id = l.post_id
        where mine.author_id = ${viewer}::uuid and l.created_at > now() - interval '21 days'
        union all
        select r.author_id from posts r join posts mine on mine.id = r.parent_id
        where mine.author_id = ${viewer}::uuid and r.created_at > now() - interval '21 days'
      ) x group by actor
    ),
    viewer_topics as (
      select pt.topic, count(*) as n from viewer_events ve join post_topics pt on pt.post_id = ve.post_id
      where ve.type in ${engaged} group by pt.topic
    ),
    proximity as (
      select author_id, count(distinct actor) as n from (
        select p.author_id, l.user_id as actor from post_likes l join posts p on p.id = l.post_id
        where l.user_id in (select id from follows) and l.created_at > now() - interval '30 days'
          and p.author_id in (select author_id from cand)
        union all
        select parent.author_id, r.author_id from posts r join posts parent on parent.id = r.parent_id
        where r.author_id in (select id from follows) and r.created_at > now() - interval '30 days'
          and parent.author_id in (select author_id from cand)
      ) x where actor <> author_id group by author_id
    ),
    post_stats as (
      select c.id,
        (select count(*) from post_likes l where l.post_id = c.id) as likes,
        (select count(*) from post_likes l where l.post_id = c.id and l.created_at > now() - interval '24 hours') as likes_24h,
        (select count(*) from posts r where r.parent_id = c.id and r.hidden_at is null) as replies,
        (select count(*) from posts r where r.parent_id = c.id and r.hidden_at is null and r.created_at > now() - interval '24 hours') as replies_24h,
        (select count(*) from post_reposts r where r.post_id = c.id and r.audience = 'public') as reposts,
        (select count(*) from post_reposts r where r.post_id = c.id and r.audience = 'public' and r.created_at > now() - interval '24 hours') as reposts_24h,
        (select count(*) from feed_events e where e.post_id = c.id and e.type = 'impression') as impressions,
        (select count(*) from feed_events e where e.post_id = c.id and e.type = 'open') as opens,
        (select count(*) from feed_events e where e.post_id = c.id and e.type = 'dwell' and e.value >= 3000) as dwells,
        (select count(*) from post_likes l where l.post_id = c.id and l.user_id in (select id from follows)) as social_likes,
        (select count(*) from post_reposts r where r.post_id = c.id and r.user_id in (select id from follows)) as social_reposts,
        (select count(*) from posts r where r.parent_id = c.id and r.author_id in (select id from follows) and r.hidden_at is null) as followee_replies
      from cand c
    )
    select c.id as post_id,
      exp(-extract(epoch from (now() - c.created_at)) / 86400) as age_decay,
      least(1, ln(1 + greatest(0, extract(epoch from (now() - c.created_at)) / 3600)) / ln(169)) as age_log,
      (c.parent_id is not null)::int as is_reply,
      c.is_quote::int as is_quote,
      (cardinality(c.image_ids) > 0 or c.gif is not null)::int as has_media,
      (c.voice is not null)::int as has_voice,
      (c.poll is not null)::int as has_poll,
      (c.content ~* 'https?://')::int as has_link,
      least(1, char_length(c.content) / 280.0) as text_len,
      (c.author_id in (select id from follows))::int as in_network,
      (c.author_id in (select id from followers))::int as author_follows_viewer,
      (c.author_id in (select id from follows) and c.author_id in (select id from followers))::int as mutual,
      1 - exp(-coalesce(a.affinity, 0) / 5) as affinity,
      least(1, 3 * (coalesce(a.opens, 0) + 1.0) / (coalesce(a.impressions, 0) + 10)) as author_ctr,
      1 - exp(-coalesce(rc.n, 0) / 5.0) as reciprocity,
      1 - exp(-s.social_likes / 2.0) as social_likes,
      1 - exp(-s.social_reposts / 1.5) as social_reposts,
      1 - exp(-s.followee_replies::float) as followee_replied,
      1 - exp(-(s.likes + 2 * s.replies + 3 * s.reposts) / 20.0) as popularity,
      1 - exp(-(s.likes_24h + 2 * s.replies_24h + 3 * s.reposts_24h) / 10.0) as velocity,
      least(1, 3 * (s.opens + 1.0) / (s.impressions + 10)) as open_rate,
      (s.dwells + 5.0) / (s.impressions + 10) as dwell_rate,
      1 - exp(-coalesce((select sum(vt.n) from post_topics pt join viewer_topics vt on vt.topic = pt.topic where pt.post_id = c.id), 0) / 5.0) as topic_affinity,
      1 - exp(-coalesce(px.n, 0) / 3.0) as author_proximity,
      least(1, 3 * (vr.likes + 1.0) / (vr.impressions + 20)) as viewer_like_rate,
      exists (select 1 from viewer_events ve where ve.post_id = c.id and ve.type = 'impression'
        and ve.created_at < now() - interval '24 hours' and ve.created_at > now() - interval '7 days')::int as seen_before
    from cand c
    join post_stats s on s.id = c.id
    cross join viewer_rate vr
    left join author_stats a on a.author_id = c.author_id
    left join reciprocity rc on rc.author_id = c.author_id
    left join proximity px on px.author_id = c.author_id
  `);
  const zeroed = viewerId ? [] : viewerFeatures.map((name) => featureIndex[name]);
  for (const row of rows) {
    const vector = featureNames.map((name) => {
      if (name === "position") return 0;
      const raw = Number(row[name] ?? 0);
      return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    });
    for (const index of zeroed) vector[index] = 0;
    result.set(row.post_id, vector);
  }
  return result;
}
