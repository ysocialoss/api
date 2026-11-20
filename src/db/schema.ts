import type { BannerCrop } from "../storage/banner-crop.ts";
import type { KlipyGif } from "../storage/klipy.ts";
import type { PollDefinition } from "../poll-schema.ts";
import type { ProfileBadge } from "../profile-badges.ts";
import type { Voice } from "../storage/voice-selection.ts";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  customType,
  boolean,
  pgEnum,
  integer,
  jsonb,
  index,
  unique,
  uniqueIndex,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["admin", "moderator", "og", "user"]);

export const moderationActivity = pgTable("moderation_activity", {
  id: uuid().defaultRandom().primaryKey(),
  actorId: uuid("actor_id").notNull(),
  actorHandle: text("actor_handle").notNull(),
  targetId: uuid("target_id").notNull(),
  targetHandle: text("target_handle").notNull(),
  action: text().notNull(),
  detail: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("moderation_activity_created_idx").on(table.createdAt.desc(), table.id.desc())]);

export const users = pgTable(
  "users",
  {
    id: uuid().defaultRandom().primaryKey(),
    role: userRole().notNull().default("user"),
    badges: jsonb().$type<ProfileBadge[]>().notNull().default([]),
    approvedAt: timestamp("approved_at", { withTimezone: true, precision: 3 }),
    bannedAt: timestamp("banned_at", { withTimezone: true, precision: 3 }),
    banReason: text("ban_reason"),
    sessionVersion: integer("session_version").notNull().default(0),
    handle: text().notNull().unique("users_handle_unique"),
    displayName: text("display_name").notNull().default(""),
    bio: text().notNull().default(""),
    pronouns: text().notNull().default(""),
    notificationPromptDismissed: boolean("notification_prompt_dismissed").notNull().default(false),
    dmGeneration: integer("dm_generation").notNull().default(1),
    hideNotificationContent: boolean("hide_notification_content").notNull().default(false),
    avatarKey: text("avatar_key"),
    identityAvatarHidden: boolean("identity_avatar_hidden").notNull().default(false),
    bannerKey: text("banner_key"),
    bannerCrop: jsonb("banner_crop").$type<BannerCrop>(),
    bannerExternalUrl: text("banner_external_url"),
    colour: text().notNull().default("#808080"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("users_waitlist_idx").on(table.createdAt, table.id).where(sql`${table.approvedAt} is null`),
    check("users_handle_check", sql`${table.handle} ~ '^[a-z0-9_]{3,32}$'`),
    check(
      "users_display_name_check",
      sql`char_length(${table.displayName}) <= 80`,
    ),
    check("users_bio_check", sql`char_length(${table.bio}) <= 2000`),
    check("users_colour_check", sql`${table.colour} ~ '^#[0-9A-Fa-f]{6}$'`),
  ],
);

export const userHandles = pgTable(
  "user_handles",
  {
    handle: text().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [index("user_handles_user_idx").on(table.userId)],
);

export const dmDevices = pgTable("dm_devices", {
  id: uuid().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  label: text().notNull(),
  encryptionKey: text("encryption_key").notNull(),
  signingKey: text("signing_key").notNull(),
  proof: text().notNull(),
  generation: integer().notNull().default(1),
  root: boolean().notNull().default(false),
  approvedBy: uuid("approved_by"),
  approval: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedBy: uuid("revoked_by"),
  revocation: text(),
}, (table) => [
  index("dm_devices_user_idx").on(table.userId),
  uniqueIndex("dm_devices_root_idx").on(table.userId, table.generation).where(sql`${table.root}`),
  check("dm_devices_approval_check", sql`(${table.approvedBy} is null) = (${table.approval} is null) and (not ${table.root} or ${table.approvedBy} is null)`),
  check("dm_devices_revocation_check", sql`(${table.revokedAt} is null) = (${table.revokedBy} is null) and (${table.revokedAt} is null) = (${table.revocation} is null)`),
]);

export const dmInviteStatus = pgEnum("dm_invite_status", ["pending", "accepted", "declined"]);

export const dmConversations = pgTable("dm_conversations", {
  id: uuid().defaultRandom().primaryKey(),
  firstUserId: uuid("first_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  secondUserId: uuid("second_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  invitedBy: uuid("invited_by"),
  inviteStatus: dmInviteStatus("invite_status").notNull().default("accepted"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  firstHiddenAt: timestamp("first_hidden_at", { withTimezone: true }),
  secondHiddenAt: timestamp("second_hidden_at", { withTimezone: true }),
}, (table) => [
  unique("dm_conversations_pair_unique").on(table.firstUserId, table.secondUserId),
  index("dm_conversations_second_user_idx").on(table.secondUserId),
  check("dm_conversations_pair_order", sql`${table.firstUserId} < ${table.secondUserId}`),
  check("dm_conversations_inviter_check", sql`
    (${table.invitedBy} is null and ${table.inviteStatus} = 'accepted') or
    (${table.invitedBy} is not null and ${table.invitedBy} in (${table.firstUserId}, ${table.secondUserId}))
  `),
]);

export const dmMessages = pgTable("dm_messages", {
  id: uuid().primaryKey(),
  conversationId: uuid("conversation_id").notNull().references(() => dmConversations.id, { onDelete: "cascade" }),
  senderId: uuid("sender_id").notNull(),
  senderDeviceId: uuid("sender_device_id").notNull(),
  version: integer().notNull(),
  iv: text().notNull(),
  ciphertext: text().notNull(),
  signature: text().notNull(),
  envelopes: jsonb().$type<Record<string, string>>().notNull(),
  sequence: bigint({ mode: "bigint" }).generatedAlwaysAsIdentity().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [unique("dm_messages_conversation_sequence_unique").on(table.conversationId, table.sequence)]);

export const dmReactions = pgTable("dm_reactions", {
  messageId: uuid("message_id").notNull().references(() => dmMessages.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  emoji: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.messageId, table.userId] })]);

export const oauthTransactions = pgTable("oauth_transactions", {
  state: text().primaryKey(),
  browserHash: text("browser_hash").notNull(),
  admin: boolean().notNull().default(false),
  verifier: text().notNull(),
  nonce: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: uuid().defaultRandom().primaryKey(),
    issuer: text().notNull(),
    subject: text().notNull(),
    userId: uuid("user_id")
      .unique()
      .references(() => users.id, { onDelete: "set null" }),
    username: text().notNull().default(""),
    displayName: text("display_name").notNull().default(""),
    picture: text(),
    profileSyncedAt: timestamp("profile_synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    sessionVersion: integer("session_version").notNull().default(0),
  },
  (table) => [
    unique("auth_identity_subject_unique").on(table.issuer, table.subject),
  ],
);

export const authSessions = pgTable("auth_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  identityId: uuid("identity_id")
    .notNull()
    .references(() => authIdentities.id, { onDelete: "cascade" }),
  encryptedTokens: text("encrypted_tokens").notNull(),
  sessionVersion: integer("session_version").notNull().default(0),
  refreshAfter: timestamp("refresh_after", { withTimezone: true }).notNull(),
  retryAfter: timestamp("retry_after", { withTimezone: true }),
  refreshFailures: integer("refresh_failures").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const posts = pgTable(
  "posts",
  {
    id: uuid().defaultRandom().primaryKey(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => posts.id, {
      onDelete: "cascade",
    }),
    // A quote is a top-level post that embeds another post. The embedded post
    // can later disappear (set null); isQuote tells that apart from "no quote".
    quotedPostId: uuid("quoted_post_id").references((): AnyPgColumn => posts.id, {
      onDelete: "set null",
    }),
    isQuote: boolean("is_quote").notNull().default(false),
    content: text().notNull(),
    gif: jsonb().$type<KlipyGif>(),
    voice: jsonb().$type<Voice>(),
    poll: jsonb().$type<PollDefinition>(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true, precision: 3 }),
    flaggedAt: timestamp("flagged_at", { withTimezone: true, precision: 3 }),
  },
  (table) => [
    index("posts_quoted_idx").on(table.quotedPostId).where(sql`${table.quotedPostId} IS NOT NULL`),
    check(
      "posts_quote_check",
      sql`(${table.isQuote} OR ${table.quotedPostId} IS NULL) AND (NOT ${table.isQuote} OR ${table.parentId} IS NULL)`,
    ),
    index("posts_parent_idx").on(
      table.parentId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index("posts_feed_idx").on(table.createdAt.desc(), table.id.desc()),
    index("posts_content_search_idx").using("gin", sql`to_tsvector('simple', ${table.content})`),
    check(
      "posts_content_check",
      sql`char_length(${table.content}) <= 2000 AND (${table.content} ~ '[^[:space:]]' OR (${table.content} = '' AND (${table.gif} IS NOT NULL OR ${table.poll} IS NOT NULL OR ${table.voice} IS NOT NULL)))`,
    ),
  ],
);

export const pollVotes = pgTable(
  "poll_votes",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    optionIndex: integer("option_index").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.userId] }),
    index("poll_votes_option_idx").on(table.postId, table.optionIndex, table.userId),
    index("poll_votes_user_idx").on(table.userId),
  ],
);

// Topics (#name) used by posts and replies. A topic exists while a post uses it;
// the primary key counts a topic once per post however often the text repeats it.
export const postTopics = pgTable(
  "post_topics",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    topic: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.topic] }),
    index("post_topics_topic_idx").on(table.topic, table.postId),
    check(
      "post_topics_topic_check",
      sql`char_length(${table.topic}) BETWEEN 1 AND 32`,
    ),
  ],
);

// Earlier versions of edited posts, saved when an edit replaces them.
export const postEdits = pgTable(
  "post_edits",
  {
    id: uuid().defaultRandom().primaryKey(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    content: text().notNull(),
    // When this version was written: the post's creation or its previous edit.
    versionAt: timestamp("version_at", { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [index("post_edits_post_idx").on(table.postId, table.versionAt.desc())],
);

export const postLikes = pgTable(
  "post_likes",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.userId] }),
    index("post_likes_user_idx").on(table.userId),
  ],
);

export const postReposts = pgTable(
  "post_reposts",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // "friends" reposts are seen only by the reposter and their mutual follows.
    audience: text().$type<"public" | "friends">().notNull().default("public"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.userId] }),
    index("post_reposts_user_idx").on(
      table.userId,
      table.createdAt.desc(),
      table.postId.desc(),
    ),
    index("post_reposts_post_idx").on(table.postId, table.createdAt.desc()),
    check(
      "post_reposts_audience_check",
      sql`${table.audience} IN ('public', 'friends')`,
    ),
  ],
);

export const userFollows = pgTable(
  "user_follows",
  {
    followerId: uuid("follower_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followingId: uuid("following_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.followerId, table.followingId] }),
    index("user_follows_following_idx").on(table.followingId),
    check(
      "user_follows_not_self",
      sql`${table.followerId} <> ${table.followingId}`,
    ),
  ],
);

// Durable outbox for replacements, removals, and unfinished uploads.
export const mediaDeletions = pgTable(
  "media_deletions",
  {
    key: text().primaryKey(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attempts: integer().notNull().default(0),
  },
  (table) => [index("media_deletions_due_idx").on(table.availableAt)],
);

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const voiceJobs = pgTable(
  "voice_jobs",
  {
    id: uuid().notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    input: bytea(),
    voice: jsonb().$type<Voice>(),
    error: text(),
    lease: uuid(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id] }),
    uniqueIndex("voice_jobs_user_pending_idx").on(table.userId).where(sql`${table.input} IS NOT NULL`),
    index("voice_jobs_due_idx").on(table.nextAttemptAt).where(sql`${table.input} IS NOT NULL`),
    index("voice_jobs_expiry_idx").on(table.expiresAt),
    check("voice_jobs_one_state", sql`num_nonnulls(${table.input}, ${table.voice}, ${table.error}) = 1`),
  ],
);

export const avatarHistory = pgTable(
  "avatar_history",
  {
    key: text().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("avatar_history_user_idx").on(table.userId, table.usedAt.desc()),
  ],
);

export const postMentions = pgTable("post_mentions", {
  postId: uuid("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  handle: text().notNull(),
}, (table) => [primaryKey({ columns: [table.postId, table.userId, table.handle] })]);

export const notificationKind = pgEnum("notification_kind", [
  "like",
  "repost",
  "reply",
  "follow",
  "mention",
  "quote",
  "dm_invite",
  "dm_message",
]);
export const notifications = pgTable(
  "notifications",
  {
    id: uuid().defaultRandom().primaryKey(),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: notificationKind().notNull(),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => dmConversations.id, { onDelete: "cascade" }),
    // Stable event identity also deduplicates an unlike/re-like or unfollow/re-follow.
    subject: text().notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("notifications_event_unique").on(
      table.recipientId,
      table.actorId,
      table.kind,
      table.subject,
    ),
    index("notifications_inbox_idx").on(
      table.recipientId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index("notifications_unread_idx")
      .on(table.recipientId)
      .where(sql`${table.readAt} is null`),
    index("notifications_conversation_idx").on(table.conversationId).where(sql`${table.conversationId} is not null`),
    check(
      "notifications_not_self",
      sql`${table.recipientId} <> ${table.actorId}`,
    ),
    check(
      "notifications_subject_check",
      sql`case
        when ${table.kind}::text in ('dm_invite', 'dm_message') then ${table.conversationId} is not null and ${table.postId} is null
        when ${table.kind} = 'follow' then ${table.conversationId} is null and ${table.postId} is null
        else ${table.conversationId} is null and ${table.postId} is not null
      end`,
    ),
  ],
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionHash: text("session_hash")
      .notNull()
      .references(() => authSessions.tokenHash, { onDelete: "cascade" }),
    endpoint: text().notNull().unique(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    mutedUntil: timestamp("muted_until", { withTimezone: true }),
    mutedForever: boolean("muted_forever").notNull().default(false),
  },
  (table) => [index("push_subscriptions_user_idx").on(table.userId)],
);

export const pushDeliveries = pgTable(
  "push_deliveries",
  {
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => pushSubscriptions.id, { onDelete: "cascade" }),
    attempts: integer().notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.notificationId, table.subscriptionId] }),
    index("push_deliveries_due_idx").on(table.availableAt),
  ],
);
