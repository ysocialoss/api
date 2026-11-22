import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { postLikes, postReposts, posts, users } from "./db/schema.ts";
import { avatarUrlSelection, paintJson, type UserPaint, userSelection } from "./user-data.ts";
import type { PollDefinition } from "./poll-schema.ts";

const previewAvatarUrl = avatarUrlSelection(alias(users, "u"));
const previewPaint = paintJson(sql`u.paint_id`);

type PostUser = { id: string; handle: string; displayName: string; avatarUrl: string | null; paint: UserPaint | null };

export const visiblePostAuthor = sql`exists (
  select 1 from users visible_author
  where visible_author.id = ${posts.authorId} and visible_author.banned_at is null
)`;

export const postFields = {
  id: posts.id,
  parentId: posts.parentId,
  content: posts.content,
  gif: posts.gif,
  voice: posts.voice,
  imageIds: posts.imageIds,
  createdAt: posts.createdAt,
  editedAt: posts.editedAt,
};
export function reactionSelection(viewerId: string | null) {
  return {
    likes: sql<number>`(select count(*)::int from ${postLikes} where ${postLikes.postId} = ${posts.id})`,
    liked:
      viewerId === null
        ? sql<boolean>`false`
        : sql<boolean>`exists(select 1 from ${postLikes} where ${postLikes.postId} = ${posts.id} and ${postLikes.userId} = ${viewerId})`,
  };
}
// "Friends" are mutual follows. True when the viewer and the user in `other`
// follow each other.
export const mutualFollowSql = (viewerId: string, other: ReturnType<typeof sql>) => sql`(
  exists (select 1 from user_follows mf_a where mf_a.follower_id = ${viewerId} and mf_a.following_id = ${other})
  and exists (select 1 from user_follows mf_b where mf_b.follower_id = ${other} and mf_b.following_id = ${viewerId}))`;
// Whether the viewer may see this repost row (alias `r`): public ones, their own,
// and friends-only ones from people they follow mutually.
export function repostVisibleSql(viewerId: string | null) {
  return viewerId === null
    ? sql`r.audience = 'public'`
    : sql`(r.audience = 'public' or r.user_id = ${viewerId} or ${mutualFollowSql(viewerId, sql`r.user_id`)})`;
}
export function repostSelection(viewerId: string | null) {
  return {
    // Only public reposts are counted, so a friends-only repost never shows up as a number.
    reposts: sql<number>`(select count(*)::int from ${postReposts} where ${postReposts.postId} = ${posts.id} and ${postReposts.audience} = 'public')`,
    reposted:
      viewerId === null
        ? sql<boolean>`false`
        : sql<boolean>`exists(select 1 from ${postReposts} where ${postReposts.postId} = ${posts.id} and ${postReposts.userId} = ${viewerId})`,
    repostAudience:
      viewerId === null
        ? sql<"public" | "friends" | null>`null`
        : sql<"public" | "friends" | null>`(select ${postReposts.audience} from ${postReposts} where ${postReposts.postId} = ${posts.id} and ${postReposts.userId} = ${viewerId})`,
  };
}
export type QuotedPost = {
  id: string;
  content: string;
  gif: { url: string; title: string } | null;
  imageIds: string[];
  createdAt: string;
  editedAt: string | null;
  parentId: string | null;
  pollTitle: string | null;
  isQuote: boolean;
  mentions: { id: string; handle: string; username: string }[];
  author: PostUser;
};
export type PostQuote = { state: "available"; post: QuotedPost } | { state: "unavailable" };
export const quoteSelection = {
  quotes: sql<number>`(select count(*)::int from posts q join users u on u.id = q.author_id
    where q.quoted_post_id = ${posts.id} and u.banned_at is null)`,
  // The embedded post, one level deep. Null for posts that are not quotes.
  quote: sql<PostQuote | null>`case when ${posts.isQuote} then (
    coalesce((
      select jsonb_build_object('state', 'available', 'post', jsonb_build_object(
        'id', q.id, 'content', q.content, 'gif', q.gif, 'imageIds', q.image_ids,
        'createdAt', q.created_at, 'editedAt', q.edited_at, 'parentId', q.parent_id,
        'pollTitle', q.poll->>'title', 'isQuote', q.is_quote,
        'mentions', (select coalesce(jsonb_agg(jsonb_build_object('id', mu.id, 'handle', mu.handle, 'username', qm.handle)), '[]'::jsonb)
          from post_mentions qm join users mu on mu.id = qm.user_id where qm.post_id = q.id),
        'author', jsonb_build_object('id', u.id, 'handle', u.handle, 'displayName', u.display_name,
          'avatarUrl', ${previewAvatarUrl}, 'paint', ${previewPaint})
      ))
      from posts q join users u on u.id = q.author_id where q.id = ${posts.quotedPostId} and u.banned_at is null
    ), jsonb_build_object('state', 'unavailable'))
  ) end`,
  // Who a reply answers, so a reply shown outside its thread still has context.
  replyTo: sql<{ id: string; handle: string; displayName: string; paint: UserPaint | null } | null>`(
    select jsonb_build_object('id', pp.id, 'handle', pu.handle, 'displayName', pu.display_name,
      'paint', ${paintJson(sql`pu.paint_id`)})
    from posts pp join users pu on pu.id = pp.author_id where pp.id = ${posts.parentId}
  )`,
};
type PollResult = Omit<PollDefinition, "options"> & {
  allowRevote: true;
  options: { label: string; votes: number }[];
  selectedOption: number | null;
};

export function pollSelection(viewerId: string | null) {
  const selectedOption = viewerId === null ? sql`null` : sql`(
    select option_index from poll_votes where post_id = ${posts.id} and user_id = ${viewerId}
  )`;
  return sql<PollResult | null>`case when ${posts.poll} is not null then
    ${posts.poll} || jsonb_build_object('allowRevote', true, 'selectedOption', ${selectedOption}, 'options', (
      select jsonb_agg(jsonb_build_object(
        'label', option.label, 'votes', coalesce(tally.votes, 0)
      ) order by option.position)
      from jsonb_array_elements_text(${posts.poll}->'options') with ordinality as option(label, position)
      left join (
        select option_index, count(*)::int as votes
        from poll_votes where post_id = ${posts.id} group by option_index
      ) tally on tally.option_index = option.position - 1
    ))
  end`;
}
// "Friends" are mutual follows. Friends who liked a post are surfaced under it.
const friendLikeFilter = (viewerId: string) => sql`
  pl.post_id = ${posts.id}
  and exists (select 1 from user_follows a where a.follower_id = ${viewerId} and a.following_id = pl.user_id)
  and exists (select 1 from user_follows b where b.follower_id = pl.user_id and b.following_id = ${viewerId})`;
export function friendLikeSelection(viewerId: string | null) {
  return {
    friendLikes:
      viewerId === null
        ? sql<number>`0`
        : sql<number>`(select count(*)::int from post_likes pl where ${friendLikeFilter(viewerId)})`,
    friendLikers:
      viewerId === null
        ? sql<PostUser[]>`'[]'::json`
        : sql<PostUser[]>`(
            select coalesce(json_agg(t), '[]'::json) from (
              select u.id, u.handle, u.display_name as "displayName",
                ${previewAvatarUrl} as "avatarUrl", ${previewPaint} as "paint"
              from post_likes pl join users u on u.id = pl.user_id
              where ${friendLikeFilter(viewerId)}
              order by u.handle
              limit 4
            ) t
          )`,
  };
}
export const postSelection = (viewerId: string | null) => ({
  ...reactionSelection(viewerId),
  ...friendLikeSelection(viewerId),
  ...repostSelection(viewerId),
  ...quoteSelection,
  ...postFields,
  poll: pollSelection(viewerId),
  mentions: sql<{ id: string; handle: string; username: string }[]>`(
    select coalesce(json_agg(json_build_object('id', u.id, 'handle', u.handle, 'username', m.handle)), '[]'::json)
    from post_mentions m join users u on u.id = m.user_id where m.post_id = ${posts.id}
  )`,
  topics: sql<string[]>`coalesce((select array_agg(pt.topic order by pt.topic) from post_topics pt where pt.post_id = ${posts.id}), '{}')`,
  replies: sql<number>`(
    with recursive descendants(id) as (
      select reply.id from posts reply
      where reply.parent_id = ${posts}.${sql.identifier(posts.id.name)}
      union all
      select reply.id from posts reply
      join descendants on reply.parent_id = descendants.id
    )
    select count(*)::int from descendants d join posts p on p.id = d.id
    join users u on u.id = p.author_id where u.banned_at is null
  )`,
  author: userSelection,
});
type PostRow = { createdAt: Date };
export function serializePost<T extends PostRow>(post: T) {
  return {
    ...post,
    editExpiresAt: new Date(
      post.createdAt.getTime() + 15 * 60000,
    ).toISOString(),
  };
}
