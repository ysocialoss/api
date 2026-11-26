import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { zipSync, strToU8 } from "fflate";
import { requireSessionUser } from "./auth/request.ts";
import { AuthError } from "./auth/provider.ts";
import { db } from "./db/index.ts";
import { users } from "./db/schema.ts";
import { avatarStorage, getAvatar } from "./storage/r2.ts";

const exportCooldownMs = 15 * 60_000;

type Row = Record<string, unknown>;

async function rows(query: ReturnType<typeof sql>) {
  return (await db.execute<Row>(query)).rows;
}

export async function collectExport(userId: string) {
  const id = sql`${userId}::uuid`;
  const [profile] = await rows(sql`
    select id, handle, display_name, bio, pronouns, colour, role, badges, approved_at, banned_at, ban_reason,
      avatar_key, banner_key, banner_crop, banner_external_url, navigation, muted_notification_kinds,
      hide_notification_content, dm_opted_out, notification_prompt_dismissed, identity_avatar_hidden,
      name_paints_disabled, name_paint_animations_disabled, feed_personalize, feed_choice_at,
      terms_version, terms_accepted_at, age_confirmed_at, changelog_seen_at, created_at, updated_at
    from users where id = ${id}`);
  if (!profile) throw new AuthError(404, "user_not_found");
  const files: Record<string, unknown> = {
    "profile.json": profile,
    "identity.json": await rows(sql`select issuer, subject, username, display_name, picture, profile_synced_at from auth_identities where user_id = ${id}`),
    "sessions.json": await rows(sql`select s.expires_at from auth_sessions s join auth_identities i on i.id = s.identity_id where i.user_id = ${id}`),
    "posts.json": await rows(sql`
      select p.id, p.parent_id, p.quoted_post_id, p.is_quote, p.content, p.gif, p.voice, p.image_ids, p.poll,
        p.created_at, p.edited_at, p.hidden_at,
        coalesce((select json_agg(json_build_object('content', e.content, 'version_at', e.version_at) order by e.version_at)
          from post_edits e where e.post_id = p.id), '[]') as edits,
        coalesce((select json_agg(t.topic) from post_topics t where t.post_id = p.id), '[]') as topics
      from posts p where p.author_id = ${id} order by p.created_at`),
    "connections.json": await rows(sql`select provider, external_id, username, display_name, profile_url, display_on_profile, created_at from connections where user_id = ${id}`),
    "github.json": await rows(sql`select github_id, login, contribution_count, display_on_profile, checked_at from github_connections where user_id = ${id}`),
    "domains.json": await rows(sql`select domain, verified_at, display_on_profile, created_at from user_domains where user_id = ${id}`),
    "social.json": {
      following: await rows(sql`select u.handle, f.created_at from user_follows f join users u on u.id = f.following_id where f.follower_id = ${id}`),
      followers: await rows(sql`select u.handle, f.created_at from user_follows f join users u on u.id = f.follower_id where f.following_id = ${id}`),
      blocked: await rows(sql`select u.handle, b.created_at from user_blocks b join users u on u.id = b.blocked_id where b.blocker_id = ${id}`),
      likes: await rows(sql`select post_id, created_at from post_likes where user_id = ${id}`),
      saves: await rows(sql`select post_id, created_at from post_saves where user_id = ${id}`),
      reposts: await rows(sql`select post_id, audience, created_at from post_reposts where user_id = ${id}`),
      pollVotes: await rows(sql`select post_id, option_index from poll_votes where user_id = ${id}`),
      mentionsOfYou: await rows(sql`select post_id from post_mentions where user_id = ${id}`),
      pinnedPost: await rows(sql`select post_id from profile_pins where user_id = ${id}`),
      paints: await rows(sql`select * from user_paints where user_id = ${id}`),
    },
    "notifications.json": await rows(sql`
      select n.kind, n.post_id, n.created_at, n.read_at, u.handle as actor_handle
      from notifications n join users u on u.id = n.actor_id where n.recipient_id = ${id} order by n.created_at`),
    "push_subscriptions.json": await rows(sql`select endpoint, muted_until, muted_forever from push_subscriptions where user_id = ${id}`),
    "feed_events.json": await rows(sql`
      select type, post_id, author_id, surface, position, request_id, session_id, seq, value, detail, client, origin, client_at, created_at
      from feed_events where user_id = ${id} order by id`),
    "reports_filed.json": await rows(sql`
      select id, target_type, target_handle, reason, details, legal_ground, status, resolution, resolved_at, created_at
      from reports where reporter_id = ${id} order by created_at`),
    "moderation_decisions.json": await rows(sql`
      select d.id, d.action, d.target_type, d.target_key, d.excerpt, d.ground_type, d.ground_ref, d.facts,
        d.automated_detection, d.automated_decision, d.reversed_at, d.created_at,
        a.text as appeal_text, a.status as appeal_status, a.staff_note as appeal_answer, a.resolved_at as appeal_resolved_at
      from moderation_decisions d left join moderation_appeals a on a.decision_id = d.id
      where d.user_id = ${id} order by d.created_at`),
    "dm_metadata.json": {
      note: "Direct messages are end-to-end encrypted. The server only holds ciphertext, so their content cannot be exported here. Only your devices hold the keys to read them.",
      devices: await rows(sql`select id, label, root, created_at, revoked_at from dm_devices where user_id = ${id}`),
      conversations: await rows(sql`
        select c.id, other.handle as with_handle, c.invite_status, c.last_message_at,
          (select count(*)::int from dm_messages m where m.conversation_id = c.id and m.sender_id = ${id}) as messages_sent
        from dm_conversations c
        join users other on other.id = case when c.first_user_id = ${id} then c.second_user_id else c.first_user_id end
        where ${id} in (c.first_user_id, c.second_user_id)`),
      messagesSent: await rows(sql`select id, conversation_id, created_at, edited_at, deleted_at, ciphertext from dm_messages where sender_id = ${id} order by created_at`),
    },
  };
  const media: Record<string, Uint8Array> = {};
  for (const image of await rows(sql`select id, post_id, data from post_images where uploader_id = ${id} and post_id is not null`))
    media[`media/posts/${image.post_id}/${image.id}.avif`] = new Uint8Array(image.data as Buffer);
  const keys = new Set<string>();
  for (const key of [profile.avatar_key, profile.banner_key]) if (typeof key === "string") keys.add(key);
  for (const { key } of await rows(sql`select key from avatar_history where user_id = ${id}`)) keys.add(key as string);
  for (const { key } of await rows(sql`select voice->>'key' as key from posts where author_id = ${id} and voice is not null`))
    if (typeof key === "string") keys.add(key);
  const missing: string[] = [];
  if (avatarStorage)
    for (const key of keys) {
      try {
        media[`media/${key}`] = await getAvatar(key);
      } catch {
        missing.push(key);
      }
    }
  else missing.push(...keys);
  files["README.txt"] = [
    "ysocial data export (GDPR Art. 15 and 20)",
    `Created: ${new Date().toISOString()}`,
    "All JSON files are UTF-8. Timestamps are ISO 8601 in UTC.",
    "media/ holds your post images, avatars, banner and voice notes.",
    missing.length ? `These media files could not be read right now: ${missing.join(", ")}` : "",
  ].filter(Boolean).join("\n");
  return { files, media };
}

export function buildZip({ files, media }: Awaited<ReturnType<typeof collectExport>>) {
  const entries: Record<string, Uint8Array> = { ...media };
  for (const [name, value] of Object.entries(files))
    entries[name] = strToU8(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return zipSync(entries, { level: 6 });
}

const router = Router();

router.get("/export", async (req, res) => {
  const user = await requireSessionUser(req);
  const [claimed] = await db.update(users)
    .set({ lastExportAt: sql`now()` })
    .where(sql`${users.id} = ${user.id} and (${users.lastExportAt} is null or ${users.lastExportAt} < now() - ${`${exportCooldownMs} milliseconds`}::interval)`)
    .returning({ id: users.id });
  if (!claimed) throw new AuthError(429, "export_rate_limited");
  try {
    const archive = buildZip(await collectExport(user.id));
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="ysocial-${user.handle}-${new Date().toISOString().slice(0, 10)}.zip"`,
      "Cache-Control": "no-store",
    });
    res.send(Buffer.from(archive));
  } catch (error) {
    await db.update(users).set({ lastExportAt: null }).where(eq(users.id, user.id));
    throw error;
  }
});

export default router;
