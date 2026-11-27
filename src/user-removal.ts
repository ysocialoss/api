import { eq, inArray, sql } from "drizzle-orm";
import type { db } from "./db/index.ts";
import { authIdentities, authSessions, avatarHistory, deletedAccounts, reports, users } from "./db/schema.ts";
import { providerPost } from "./auth/provider.ts";
import { decrypt } from "./auth/secrets.ts";
import { MAX_CHANGED_IDS, publishLiveChange } from "./live-events.ts";
import { queueDeletion } from "./storage/media-lifecycle.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function publishChanges(tx: Transaction, rows: { id: string }[]) {
  for (let offset = 0; offset < rows.length; offset += MAX_CHANGED_IDS) {
    await publishLiveChange(tx, rows.slice(offset, offset + MAX_CHANGED_IDS).map(({ id }) => id));
  }
}

export async function publishUserPostVisibility(tx: Transaction, userId: string) {
  const { rows } = await tx.execute<{ id: string }>(sql`
    with owned as (select id, parent_id, quoted_post_id from posts where author_id = ${userId}),
    affected(id) as (
      select id from owned
      union select parent_id from owned
      union select quoted_post_id from owned
      union select p.id from posts p join owned o on p.quoted_post_id = o.id
    )
    select id from affected where id is not null order by id
  `);
  await publishChanges(tx, rows);
}

export async function removeUser(tx: Transaction, user: {
  id: string;
  avatarKey: string | null;
  bannerKey: string | null;
}) {
  const { rows } = await tx.execute<{ id: string }>(sql`
    with recursive removed(id, parent_id, quoted_post_id) as (
      select id, parent_id, quoted_post_id from posts where author_id = ${user.id}
      union
      select p.id, p.parent_id, p.quoted_post_id from posts p
      join removed r on p.parent_id = r.id
    ), affected(id) as (
      select id from removed
      union select parent_id from removed
      union select quoted_post_id from removed
      union select p.id from posts p join removed r on p.quoted_post_id = r.id
      union select post_id from post_likes where user_id = ${user.id}
      union select post_id from post_reposts where user_id = ${user.id}
      union select post_id from poll_votes where user_id = ${user.id}
    )
    select id from affected where id is not null order by id
  `);
  const avatars = await tx.select({ key: avatarHistory.key }).from(avatarHistory).where(eq(avatarHistory.userId, user.id));
  const media = new Set([user.avatarKey, user.bannerKey, ...avatars.map(({ key }) => key)]);
  for (const key of media) if (key) await queueDeletion(tx, key);

  const identities = await tx.select({ id: authIdentities.id }).from(authIdentities).where(eq(authIdentities.userId, user.id));
  const sessions = identities.length
    ? await tx.delete(authSessions).where(inArray(authSessions.identityId, identities.map(({ id }) => id)))
      .returning({ encryptedTokens: authSessions.encryptedTokens })
    : [];
  await tx.update(reports).set({ reporterHandle: "" }).where(eq(reports.reporterId, user.id));
  await tx.insert(deletedAccounts).values({ userId: user.id }).onConflictDoNothing();
  // A fresh CNS callback can reactivate the identity. Older sessions stay invalid.
  await tx.update(authIdentities).set({
    userId: null, deletedAt: new Date(), username: "", displayName: "", picture: null,
    sessionVersion: sql`${authIdentities.sessionVersion} + 1`,
  }).where(eq(authIdentities.userId, user.id));
  await tx.delete(users).where(eq(users.id, user.id));

  await publishChanges(tx, rows);
  return { revokeTokens: sessions.map(({ encryptedTokens }) => encryptedTokens) };
}

export async function revokeProviderSessions(encrypted: string[]) {
  for (const value of encrypted) {
    let token: string | undefined;
    try {
      token = decrypt(value).access_token;
    } catch {
      continue;
    }
    if (!token) continue;
    try {
      await providerPost("/api/auth/logout", {}, token);
    } catch {
      console.warn({ event: "cns_logout_unavailable" });
    }
  }
}
