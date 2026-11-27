import { getTableName, type SQL, sql, type SQLWrapper, type Table } from "drizzle-orm";
import { adventRewards, authIdentities, githubConnections, paints, posts, userFollows, users } from "./db/schema.ts";
import type { PaintDefinition } from "./paint-schema.ts";

export const githubProfileSelection = {
  login: githubConnections.login,
  contributionCount: githubConnections.contributionCount,
};

type AvatarUserTable = Table & {
  id: { name: string };
  avatarKey: SQLWrapper;
  identityAvatarHidden: SQLWrapper;
};

export function avatarUrlSelection(user: AvatarUserTable) {
  // Preserve the outer table reference in Drizzle's single-table selections.
  return sql<string | null>`coalesce('/api/' || ${user.avatarKey}, case when not ${user.identityAvatarHidden} then (select ${authIdentities.picture} from ${authIdentities} where ${authIdentities.userId} = ${sql.identifier(getTableName(user))}.${sql.identifier(user.id.name)} and ${authIdentities.deletedAt} is null) end)`;
}

export type UserPaint = {
  id: string;
  name: string;
  definition: PaintDefinition;
};

export function paintJson(paintId: SQL) {
  const column = (name: string) => sql`p.${sql.identifier(name)}`;
  return sql<UserPaint | null>`(select jsonb_build_object('id', ${column(paints.id.name)}, 'name', ${column(paints.name.name)}, 'definition', ${column(paints.definition.name)}) from ${paints} p where ${column(paints.id.name)} = ${paintId})`;
}

export type EveStar = { year: number; doors: number };

export function eveStarJson(userId: SQL) {
  return sql<EveStar | null>`(select json_build_object('year', r.year, 'doors', r.doors_opened)
    from ${adventRewards} r
    where r.user_id = ${userId} and r.day = 24 and r.enabled and r.doors_opened is not null
      and now() < make_timestamptz(r.year + 1, 2, 1, 0, 0, 0, 'UTC')
    order by r.year desc limit 1)`;
}

export const userSelection = {
  id: users.id,
  handle: users.handle,
  displayName: users.displayName,
  avatarUrl: avatarUrlSelection(users),
  paint: paintJson(sql`${users}.${sql.identifier(users.paintId.name)}`),
  eveStar: eveStarJson(sql`${users}.${sql.identifier(users.id.name)}`),
};

export const banDetailsSelection = {
  bannedAt: users.bannedAt,
  banReason: sql<string | null>`case when ${users.bannedAt} is not null then coalesce(${users.banReason}, 'No reason provided.') end`,
  bannedBy: sql<string | null>`case when ${users.bannedAt} is not null then (
    select '@' || a.actor_handle from moderation_activity a
    where a.target_id = users.id and a.action = 'banUser'
    order by a.created_at desc, a.id desc limit 1
  ) end`,
  bannedByProfileHandle: sql<string | null>`case when ${users.bannedAt} is not null then (
    select actor.handle from moderation_activity a
    left join users actor on actor.id = a.actor_id
    where a.target_id = users.id and a.action = 'banUser'
    order by a.created_at desc, a.id desc limit 1
  ) end`,
};

export const postCountSelection = sql<number>`(select count(*)::int from ${posts} where ${posts.authorId} = ${sql.identifier(getTableName(users))}.${sql.identifier(users.id.name)} and ${posts.parentId} is null and ${posts.hiddenAt} is null)`;

export const publicProfileSelection = {
  bio: users.bio,
  pronouns: users.pronouns,
  bannerCrop: users.bannerCrop,
  bannerUrl: sql<string | null>`case when ${users.bannerKey} is null then ${users.bannerExternalUrl} else '/api/' || ${users.bannerKey} end`,
  followerCount: sql<number>`(select count(*)::int from ${userFollows} where ${userFollows.followingId} = ${users.id})`,
  followingCount: sql<number>`(select count(*)::int from ${userFollows} where ${userFollows.followerId} = ${users.id})`,
};

export const profileCosmeticsSelection = sql<{ year: number; day: number }[]>`coalesce((
  select json_agg(json_build_object('year', r.year, 'day', r.day) order by r.year, r.day)
  from ${adventRewards} r where r.user_id = ${users.id} and r.enabled
), '[]'::json)`;
