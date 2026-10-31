import { sql } from "drizzle-orm";
import {
  check,
  integer,
  unique,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid().defaultRandom().primaryKey(),
    handle: text().notNull().unique("users_handle_unique"),
    displayName: text("display_name").notNull().default(""),
    bio: text().notNull().default(""),
    colour: text().notNull().default("#808080"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("users_handle_check", sql`${table.handle} ~ '^[a-z0-9_]{3,32}$'`),
    check(
      "users_display_name_check",
      sql`char_length(${table.displayName}) <= 80`,
    ),
    check("users_bio_check", sql`char_length(${table.bio}) <= 2000`),
    check("users_colour_check", sql`${table.colour} ~ '^#[0-9A-Fa-f]{6}$'`),
  ],
);

export const oauthTransactions = pgTable("oauth_transactions", {
  state: text().primaryKey(),
  browserHash: text("browser_hash").notNull(),
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
  refreshAfter: timestamp("refresh_after", { withTimezone: true }).notNull(),
  retryAfter: timestamp("retry_after", { withTimezone: true }),
  refreshFailures: integer("refresh_failures").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
