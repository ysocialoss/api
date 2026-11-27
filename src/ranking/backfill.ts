import { sql } from "drizzle-orm";
import type { db } from "../db/index.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function backfillFeedEvents(tx: Transaction, userId: string) {
  const id = sql`${userId}::uuid`;
  const missing = (type: string) => sql`not exists (select 1 from feed_events e where e.user_id = ${id} and e.origin = 'backfill' and e.type = ${type})`;
  await tx.execute(sql`
    insert into feed_events (user_id, type, post_id, author_id, origin, created_at)
    select l.user_id, 'like', l.post_id, p.author_id, 'backfill', l.created_at
    from post_likes l join posts p on p.id = l.post_id
    where l.user_id = ${id} and l.user_id <> p.author_id and ${missing("like")}`);
  await tx.execute(sql`
    insert into feed_events (user_id, type, post_id, author_id, origin, created_at)
    select r.user_id, 'repost', r.post_id, p.author_id, 'backfill', r.created_at
    from post_reposts r join posts p on p.id = r.post_id
    where r.user_id = ${id} and r.user_id <> p.author_id and ${missing("repost")}`);
  await tx.execute(sql`
    insert into feed_events (user_id, type, post_id, author_id, origin, created_at)
    select s.user_id, 'save', s.post_id, p.author_id, 'backfill', s.created_at
    from post_saves s join posts p on p.id = s.post_id
    where s.user_id = ${id} and s.user_id <> p.author_id and ${missing("save")}`);
  await tx.execute(sql`
    insert into feed_events (user_id, type, post_id, author_id, origin, created_at)
    select r.author_id, 'reply', parent.id, parent.author_id, 'backfill', r.created_at
    from posts r join posts parent on parent.id = r.parent_id
    where r.author_id = ${id} and r.author_id <> parent.author_id and ${missing("reply")}`);
  await tx.execute(sql`
    insert into feed_events (user_id, type, post_id, author_id, origin, created_at)
    select q.author_id, 'quote', quoted.id, quoted.author_id, 'backfill', q.created_at
    from posts q join posts quoted on quoted.id = q.quoted_post_id
    where q.author_id = ${id} and q.is_quote and q.author_id <> quoted.author_id and ${missing("quote")}`);
  await tx.execute(sql`
    insert into feed_events (user_id, type, author_id, origin, created_at)
    select f.follower_id, 'follow', f.following_id, 'backfill', f.created_at
    from user_follows f
    where f.follower_id = ${id} and ${missing("follow")}`);
}
