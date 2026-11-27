import type { BannerCrop } from "../storage/banner-crop.ts";
import type { KlipyGif } from "../storage/klipy.ts";
import type { PollDefinition } from "../poll-schema.ts";
import type { ProfileBadge } from "../profile-badges.ts";
import type { Voice } from "../storage/voice-selection.ts";
import type { PaintDefinition } from "../paint-schema.ts";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  customType,
  boolean,
  doublePrecision,
  pgEnum,
  integer,
  jsonb,
  index,
  unique,
  uniqueIndex,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["admin", "moderator", "og", "user"]);

export const notificationKind = pgEnum("notification_kind", [
  "like",
  "repost",
  "reply",
  "follow",
  "mention",
  "quote",
  "dm_invite",
  "dm_message",
  "friends_repost",
  "friend",
]);
export const moderationActivity = pgTable("moderation_activity", {
  id: uuid().defaultRandom().primaryKey(),
  actorId: uuid("actor_id").notNull(),
  actorHandle: text("actor_handle").notNull(),
  targetId: uuid("target_id").notNull(),
  targetHandle: text("target_handle").notNull(),
  action: text().notNull(),
  detail: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("moderation_activity_created_idx").on(table.createdAt.desc(), table.id.desc()),
  index("moderation_activity_action_idx").on(table.action, table.createdAt.desc()),
  index("moderation_activity_actor_idx").on(table.actorId, table.createdAt.desc()),
  index("moderation_activity_target_idx").on(table.targetId, table.createdAt.desc()),
]);

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
    dmOptedOut: boolean("dm_opted_out").notNull().default(false),
    hideNotificationContent: boolean("hide_notification_content").notNull().default(false),
    mutedNotificationKinds: text("muted_notification_kinds").$type<(typeof notificationKind.enumValues)[number]>().array().notNull().default(sql`'{}'::text[]`),
    navigation: text().array(),
    avatarKey: text("avatar_key"),
    identityAvatarHidden: boolean("identity_avatar_hidden").notNull().default(false),
    paintId: uuid("paint_id").references((): AnyPgColumn => paints.id, { onDelete: "set null" }),
    namePaintsDisabled: boolean("name_paints_disabled").notNull().default(false),
    namePaintAnimationsDisabled: boolean("name_paint_animations_disabled").notNull().default(false),
    bannerKey: text("banner_key"),
    bannerCrop: jsonb("banner_crop").$type<BannerCrop>(),
    bannerExternalUrl: text("banner_external_url"),
    colour: text().notNull().default("#808080"),
    changelogSeenAt: timestamp("changelog_seen_at", { withTimezone: true, precision: 3 }),
    feedPersonalize: boolean("feed_personalize").notNull().default(true),
    feedChoiceAt: timestamp("feed_choice_at", { withTimezone: true, precision: 3 }),
    termsVersion: text("terms_version"),
    termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true, precision: 3 }),
    ageConfirmedAt: timestamp("age_confirmed_at", { withTimezone: true, precision: 3 }),
    lastExportAt: timestamp("last_export_at", { withTimezone: true, precision: 3 }),
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

export const dmPollVotes = pgTable("dm_poll_votes", {
  messageId: uuid("message_id").notNull().references(() => dmMessages.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  option: integer().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.messageId, table.userId] }), check("dm_poll_votes_option_check", sql`${table.option} between 0 and 9`)]);

const dmBlob = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const dmAttachments = pgTable("dm_attachments", {
  id: uuid().primaryKey(),
  conversationId: uuid("conversation_id").notNull().references(() => dmConversations.id, { onDelete: "cascade" }),
  uploaderId: uuid("uploader_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").references(() => dmMessages.id, { onDelete: "cascade" }),
  objectKey: text("object_key").notNull().unique(),
  size: integer().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("dm_attachments_message_idx").on(table.messageId),
]);

export const oauthTransactions = pgTable("oauth_transactions", {
  state: text().primaryKey(),
  browserHash: text("browser_hash").notNull(),
  admin: boolean().notNull().default(false),
  verifier: text().notNull(),
  nonce: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const githubLinkAttempts = pgTable("github_link_attempts", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  stateHash: text("state_hash").notNull(),
  sessionHash: text("session_hash").notNull(),
  verifier: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const connectionProviders = ["discord", "twitch", "steam", "spotify", "apple_music"] as const;

export const connectionLinkAttempts = pgTable("connection_link_attempts", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text().notNull(),
  stateHash: text("state_hash").notNull(),
  sessionHash: text("session_hash").notNull(),
  verifier: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.provider] }),
]);

export const connections = pgTable("connections", {
  id: uuid().defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text().notNull(),
  externalId: text("external_id").notNull(),
  username: text().notNull(),
  displayName: text("display_name").notNull(),
  profileUrl: text("profile_url").notNull(),
  displayOnProfile: boolean("display_on_profile").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("connections_user_provider_unique").on(table.userId, table.provider),
  unique("connections_provider_external_unique").on(table.provider, table.externalId),
  check("connections_provider_check", sql`${table.provider} in ('discord', 'twitch', 'steam', 'spotify', 'apple_music')`),
]);

export const userDomains = pgTable("user_domains", {
  id: uuid().defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  domain: text().notNull(),
  token: text().notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  displayOnProfile: boolean("display_on_profile").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("user_domains_user_domain_unique").on(table.userId, table.domain),
  uniqueIndex("user_domains_verified_domain_idx").on(table.domain).where(sql`${table.verifiedAt} is not null`),
  index("user_domains_user_idx").on(table.userId),
  check("user_domains_domain_check", sql`${table.domain} ~ '^[a-z0-9.-]{3,253}$'`),
]);

export const githubConnections = pgTable("github_connections", {
  id: uuid().defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  githubId: text("github_id").notNull().unique(),
  login: text().notNull(),
  contributionCount: integer("contribution_count"),
  displayOnProfile: boolean("display_on_profile").notNull().default(true),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }),
}, (table) => [
  check("github_contribution_count_check", sql`${table.contributionCount} >= 0`),
  index("github_connections_attempted_idx").on(table.attemptedAt),
]);

export const githubContributionJobs = pgTable("github_contribution_jobs", {
  connectionId: uuid("connection_id").primaryKey()
    .references(() => githubConnections.id, { onDelete: "cascade" }),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
  lease: uuid(),
}, (table) => [
  index("github_contribution_jobs_due_idx").on(table.runAt, table.connectionId),
]);

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
    imageIds: uuid("image_ids").array().notNull().default(sql`'{}'::uuid[]`),
    poll: jsonb().$type<PollDefinition>(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true, precision: 3 }),
    flaggedAt: timestamp("flagged_at", { withTimezone: true, precision: 3 }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true, precision: 3 }),
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
    index("posts_author_idx").on(table.authorId, table.createdAt.desc(), table.id.desc()),
    index("posts_content_search_idx").using("gin", sql`to_tsvector('simple', ${table.content})`),
    check(
      "posts_content_check",
      sql`char_length(${table.content}) <= 2000 AND (${table.content} ~ '[^[:space:]]' OR (${table.content} = '' AND (${table.gif} IS NOT NULL OR ${table.poll} IS NOT NULL OR ${table.voice} IS NOT NULL OR cardinality(${table.imageIds}) > 0)))`,
    ),
  ],
);

export const postImages = pgTable("post_images", {
  id: uuid().defaultRandom().primaryKey(),
  uploaderId: uuid("uploader_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }),
  // Legacy rows and deployments without R2 keep bytes here; everything else lives in R2.
  data: dmBlob(),
  objectKey: text("object_key").unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  check("post_images_one_image", sql`num_nonnulls(${table.data}, ${table.objectKey}) = 1`),
  index("post_images_post_idx").on(table.postId),
  index("post_images_draft_uploader_idx").on(table.uploaderId).where(sql`${table.postId} IS NULL`),
  index("post_images_draft_expiry_idx").on(table.expiresAt).where(sql`${table.postId} IS NULL`),
]);

export const postImageFlags = pgTable("post_image_flags", {
  id: uuid().defaultRandom().primaryKey(),
  uploaderId: uuid("uploader_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  filename: text(),
  confidence: doublePrecision(),
  data: dmBlob(),
  objectKey: text("object_key").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("post_image_flags_created_idx").on(table.createdAt.desc(), table.id.desc()),
  index("post_image_flags_uploader_idx").on(table.uploaderId),
  check("post_image_flags_one_image", sql`num_nonnulls(${table.data}, ${table.objectKey}) = 1`),
]);

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
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.userId] }),
    index("post_likes_user_idx").on(table.userId),
  ],
);

export const postSaves = pgTable(
  "post_saves",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.userId] }),
    index("post_saves_user_idx").on(table.userId, table.createdAt.desc(), table.postId.desc()),
  ],
);

export const profilePins = pgTable("profile_pins", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  postId: uuid("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
        when ${table.kind}::text in ('follow', 'friend') then ${table.conversationId} is null and ${table.postId} is null
        else ${table.conversationId} is null and ${table.postId} is not null
      end`,
    ),
  ],
);

export const userBlocks = pgTable(
  "user_blocks",
  {
    blockerId: uuid("blocker_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    blockedId: uuid("blocked_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.blockerId, table.blockedId] }),
    index("user_blocks_blocked_idx").on(table.blockedId, table.blockerId),
    check("user_blocks_not_self", sql`${table.blockerId} <> ${table.blockedId}`),
  ],
);

export const reportTargetType = pgEnum("report_target_type", ["post", "user", "message"]);
export const reportStatus = pgEnum("report_status", ["open", "resolved", "dismissed"]);

export type ReportSnapshot =
  | {
      type: "post";
      kind: "Post" | "Reply" | "Quote";
      authorHandle: string;
      authorName: string;
      content: string;
      parentId: string | null;
      quotedPostId: string | null;
      gifUrl: string | null;
      imageIds: string[];
      hasVoice: boolean;
      pollTitle: string | null;
      createdAt: string;
    }
  | {
      type: "user";
      handle: string;
      displayName: string;
      bio: string;
      pronouns: string;
      avatarUrl: string | null;
      bannerUrl: string | null;
    }
  | {
      type: "message";
      peerHandle: string;
      messages: { id: string; senderId: string; senderHandle: string; text: string; createdAt: string; reported: boolean }[];
    };

export const reports = pgTable("reports", {
  id: uuid().defaultRandom().primaryKey(),
  reporterId: uuid("reporter_id").references(() => users.id, { onDelete: "set null" }),
  reporterHandle: text("reporter_handle").notNull(),
  targetType: reportTargetType("target_type").notNull(),
  targetKey: uuid("target_key").notNull(),
  targetUserId: uuid("target_user_id").references(() => users.id, { onDelete: "set null" }),
  targetHandle: text("target_handle").notNull(),
  conversationId: uuid("conversation_id"),
  reason: text().notNull(),
  details: text().notNull().default(""),
  snapshot: jsonb().$type<ReportSnapshot>().notNull(),
  status: reportStatus().notNull().default("open"),
  resolution: text(),
  note: text(),
  resolvedById: uuid("resolved_by_id"),
  resolvedByHandle: text("resolved_by_handle"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true, precision: 3 }),
  channel: text().$type<"in_app" | "public">().notNull().default("in_app"),
  legalGround: text("legal_ground"),
  notifierName: text("notifier_name"),
  notifierEmail: text("notifier_email"),
  goodFaithAt: timestamp("good_faith_at", { withTimezone: true, precision: 3 }),
  statusTokenHash: text("status_token_hash"),
  reporterSeenAt: timestamp("reporter_seen_at", { withTimezone: true, precision: 3 }),
  escalatedAt: timestamp("escalated_at", { withTimezone: true, precision: 3 }),
  escalationAuthority: text("escalation_authority"),
  escalationRef: text("escalation_ref"),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, (table) => [
  index("reports_queue_idx").on(table.status, table.createdAt.desc(), table.id.desc()),
  index("reports_target_idx").on(table.targetType, table.targetKey, table.status),
  index("reports_target_user_idx").on(table.targetUserId),
  index("reports_reporter_idx").on(table.reporterId, table.createdAt.desc()),
  uniqueIndex("reports_open_unique").on(table.reporterId, table.targetType, table.targetKey)
    .where(sql`${table.status} = 'open'`),
  check("reports_reason_check", sql`${table.reason} in ('spam', 'harassment', 'hate', 'violence', 'sexual', 'self_harm', 'misinformation', 'impersonation', 'ai_generated', 'illegal', 'other')`),
  check("reports_details_check", sql`char_length(${table.details}) <= 1000`),
  check("reports_note_check", sql`char_length(${table.note}) <= 1000`),
  check("reports_conversation_check", sql`(${table.targetType} = 'message') = (${table.conversationId} is not null)`),
  check("reports_resolution_check", sql`(${table.status} = 'open') = (${table.resolvedAt} is null)`),
  check("reports_channel_check", sql`${table.channel} in ('in_app', 'public')`),
  check("reports_notifier_check", sql`char_length(${table.notifierName}) <= 120 and char_length(${table.notifierEmail}) <= 254 and char_length(${table.legalGround}) <= 120`),
  check("reports_escalation_check", sql`char_length(${table.escalationAuthority}) <= 120 and char_length(${table.escalationRef}) <= 200`),
  uniqueIndex("reports_status_token_idx").on(table.statusTokenHash).where(sql`${table.statusTokenHash} is not null`),
]);

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

export const paints = pgTable("paints", {
  id: uuid().defaultRandom().primaryKey(),
  name: text().notNull().unique("paints_name_unique"),
  definition: jsonb().$type<PaintDefinition>().notNull(),
  isFree: boolean("is_free").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userPaints = pgTable("user_paints", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  paintId: uuid("paint_id").notNull().references(() => paints.id, { onDelete: "cascade" }),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.userId, table.paintId] }), index("user_paints_paint_idx").on(table.paintId)]);

export const changelogApps = ["api", "web", "web-admin", "android", "mobile"] as const;
export const changelogCategory = pgEnum("changelog_category", ["new", "improved", "fixed", "removed", "technical"]);

export const releases = pgTable("releases", {
  id: uuid().defaultRandom().primaryKey(),
  app: text().$type<(typeof changelogApps)[number]>().notNull(),
  tag: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, (table) => [
  unique("releases_app_tag_unique").on(table.app, table.tag),
  index("releases_created_idx").on(table.createdAt),
]);

export const changelogEntries = pgTable("changelog_entries", {
  id: uuid().defaultRandom().primaryKey(),
  app: text().$type<(typeof changelogApps)[number]>().notNull(),
  category: changelogCategory().notNull(),
  title: text().notNull(),
  body: text().notNull().default(""),
  releaseId: uuid("release_id").references(() => releases.id, { onDelete: "restrict" }),
  publishedAt: timestamp("published_at", { withTimezone: true, precision: 3 }),
  authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, (table) => [
  index("changelog_entries_unreleased_idx").on(table.app, table.createdAt).where(sql`${table.releaseId} is null`),
  index("changelog_entries_published_idx").on(table.publishedAt),
  check("changelog_entries_title_check", sql`char_length(${table.title}) between 1 and 120`),
  check("changelog_entries_body_check", sql`char_length(${table.body}) <= 4000`),
]);

export const feedClientEventTypes = [
  "impression", "dwell", "open", "detail_dwell", "expand", "spoiler", "media_open",
  "link_open", "profile_open", "voice_play", "share", "topic_open",
] as const;
export const feedServerEventTypes = [
  "like", "unlike", "reply", "quote", "repost", "unrepost", "save", "unsave", "poll_vote",
  "follow", "unfollow", "block", "report", "more", "less", "snooze", "topic_more", "topic_less",
] as const;
export const feedEventTypes = [...feedClientEventTypes, ...feedServerEventTypes] as const;
export const feedSurfaces = ["for_you", "following", "latest", "thread", "profile", "topic", "search", "saved", "other"] as const;
const sqlList = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(", "));

export const feedEvents = pgTable("feed_events", {
  id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text().$type<(typeof feedEventTypes)[number]>().notNull(),
  postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }),
  authorId: uuid("author_id").references(() => users.id, { onDelete: "cascade" }),
  surface: text().$type<(typeof feedSurfaces)[number]>(),
  position: smallint(),
  requestId: uuid("request_id"),
  sessionId: uuid("session_id"),
  seq: integer(),
  value: integer(),
  detail: text(),
  client: text().$type<"mobile" | "desktop">(),
  origin: text().$type<"client" | "server" | "backfill">().notNull(),
  clientAt: timestamp("client_at", { withTimezone: true, precision: 3 }),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, (table) => [
  index("feed_events_user_idx").on(table.userId, table.createdAt.desc()),
  index("feed_events_post_idx").on(table.postId, table.type),
  index("feed_events_author_idx").on(table.authorId).where(sql`${table.authorId} is not null`),
  index("feed_events_created_idx").using("brin", table.createdAt),
  uniqueIndex("feed_events_session_seq_idx").on(table.sessionId, table.seq).where(sql`${table.sessionId} is not null`),
  check("feed_events_type_check", sql`${table.type} in (${sqlList(feedEventTypes)})`),
  check("feed_events_surface_check", sql`${table.surface} is null or ${table.surface} in (${sqlList(feedSurfaces)})`),
  check("feed_events_client_check", sql`${table.client} is null or ${table.client} in ('mobile', 'desktop')`),
  check("feed_events_origin_check", sql`${table.origin} in ('client', 'server', 'backfill')`),
  check("feed_events_detail_check", sql`${table.detail} is null or char_length(${table.detail}) <= 253`),
  check("feed_events_session_check", sql`(${table.sessionId} is null) = (${table.seq} is null)`),
]);

export const deletedAccounts = pgTable("deleted_accounts", {
  userId: uuid("user_id").primaryKey(),
  deletedAt: timestamp("deleted_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
});

export const moderationActions = [
  "remove_post", "hide_post", "remove_media", "edit_post", "clear_profile", "edit_profile", "ban", "remove_account", "remove_message",
] as const;

export const moderationDecisions = pgTable("moderation_decisions", {
  id: uuid().defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  action: text().$type<(typeof moderationActions)[number]>().notNull(),
  targetType: text("target_type").$type<"post" | "user" | "message">().notNull(),
  targetKey: uuid("target_key"),
  excerpt: text().notNull().default(""),
  groundType: text("ground_type").$type<"illegal" | "terms">().notNull(),
  groundRef: text("ground_ref").notNull(),
  facts: text().notNull(),
  automatedDetection: boolean("automated_detection").notNull().default(false),
  automatedDecision: boolean("automated_decision").notNull().default(false),
  reportId: uuid("report_id").references(() => reports.id, { onDelete: "set null" }),
  decidedById: uuid("decided_by_id"),
  decidedByHandle: text("decided_by_handle"),
  seenAt: timestamp("seen_at", { withTimezone: true, precision: 3 }),
  reversedAt: timestamp("reversed_at", { withTimezone: true, precision: 3 }),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, (table) => [
  index("moderation_decisions_user_idx").on(table.userId, table.createdAt.desc()),
  check("moderation_decisions_action_check", sql`${table.action} in (${sql.raw(moderationActions.map((value) => `'${value}'`).join(", "))})`),
  check("moderation_decisions_target_check", sql`${table.targetType} in ('post', 'user', 'message')`),
  check("moderation_decisions_ground_check", sql`${table.groundType} in ('illegal', 'terms') and char_length(${table.groundRef}) between 1 and 120`),
  check("moderation_decisions_text_check", sql`char_length(${table.facts}) between 1 and 2000 and char_length(${table.excerpt}) <= 300`),
]);

export const moderationAppeals = pgTable("moderation_appeals", {
  id: uuid().defaultRandom().primaryKey(),
  decisionId: uuid("decision_id").notNull().unique("moderation_appeals_decision_unique").references(() => moderationDecisions.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  text: text().notNull(),
  status: text().$type<"open" | "upheld" | "reversed">().notNull().default("open"),
  staffNote: text("staff_note"),
  resolvedById: uuid("resolved_by_id"),
  resolvedByHandle: text("resolved_by_handle"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true, precision: 3 }),
  seenAt: timestamp("seen_at", { withTimezone: true, precision: 3 }),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, (table) => [
  index("moderation_appeals_queue_idx").on(table.status, table.createdAt),
  check("moderation_appeals_status_check", sql`${table.status} in ('open', 'upheld', 'reversed')`),
  check("moderation_appeals_text_check", sql`char_length(${table.text}) between 1 and 2000 and char_length(${table.staffNote}) <= 2000`),
  check("moderation_appeals_resolution_check", sql`(${table.status} = 'open') = (${table.resolvedAt} is null)`),
]);

export const csamIncidents = pgTable("csam_incidents", {
  id: uuid().defaultRandom().primaryKey(),
  userId: uuid("user_id"),
  handle: text().notNull(),
  surface: text().$type<"post_image" | "avatar" | "banner" | "flag">().notNull(),
  provider: text().notNull(),
  matchId: text("match_id"),
  sha256: text().notNull(),
  mime: text().notNull(),
  size: integer().notNull(),
  ip: text(),
  hold: boolean().notNull().default(false),
  reportedBkaAt: timestamp("reported_bka_at", { withTimezone: true, precision: 3 }),
  bkaRef: text("bka_ref"),
  reportedNcmecAt: timestamp("reported_ncmec_at", { withTimezone: true, precision: 3 }),
  ncmecRef: text("ncmec_ref"),
  note: text(),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, (table) => [
  index("csam_incidents_created_idx").on(table.createdAt.desc()),
  check("csam_incidents_surface_check", sql`${table.surface} in ('post_image', 'avatar', 'banner', 'flag')`),
]);

export const adventDoors = pgTable("advent_doors", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  year: integer().notNull(),
  day: integer().notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.year, table.day] }),
  check("advent_doors_day_check", sql`${table.day} between 1 and 24`),
]);

export const adventRewards = pgTable("advent_rewards", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  year: integer().notNull(),
  day: integer().notNull(),
  enabled: boolean().notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.year, table.day] }),
  check("advent_rewards_day_check", sql`${table.day} in (1, 7, 14, 24)`),
]);

export const contactMessages = pgTable("contact_messages", {
  id: uuid().defaultRandom().primaryKey(),
  name: text(),
  email: text(),
  message: text().notNull(),
  handledAt: timestamp("handled_at", { withTimezone: true, precision: 3 }),
  handledByHandle: text("handled_by_handle"),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, (table) => [
  index("contact_messages_queue_idx").on(table.handledAt, table.createdAt),
  check("contact_messages_text_check", sql`char_length(${table.message}) between 10 and 2000 and char_length(${table.name}) <= 100 and char_length(${table.email}) <= 254`),
]);
