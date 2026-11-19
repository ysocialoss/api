import { getTableName, sql, type SQLWrapper, type Table } from "drizzle-orm";
import { authIdentities, userFollows, users } from "./db/schema.ts";

type AvatarUserTable = Table & {
  id: { name: string };
  avatarKey: SQLWrapper;
  identityAvatarHidden: SQLWrapper;
};

export function avatarUrlSelection(user: AvatarUserTable) {
  // Preserve the outer table reference in Drizzle's single-table selections.
  return sql<string | null>`coalesce('/api/' || ${user.avatarKey}, case when not ${user.identityAvatarHidden} then (select ${authIdentities.picture} from ${authIdentities} where ${authIdentities.userId} = ${sql.identifier(getTableName(user))}.${sql.identifier(user.id.name)} and ${authIdentities.deletedAt} is null) end)`;
}

export const userSelection = {
  id: users.id,
  handle: users.handle,
  displayName: users.displayName,
  avatarUrl: avatarUrlSelection(users),
};

export const publicProfileSelection = {
  bio: users.bio,
  bannerCrop: users.bannerCrop,
  bannerUrl: sql<string | null>`case when ${users.bannerKey} is null then ${users.bannerExternalUrl} else '/api/' || ${users.bannerKey} end`,
  followerCount: sql<number>`(select count(*)::int from ${userFollows} where ${userFollows.followingId} = ${users.id})`,
  followingCount: sql<number>`(select count(*)::int from ${userFollows} where ${userFollows.followerId} = ${users.id})`,
};
