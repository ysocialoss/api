CREATE TABLE "feed_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feed_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"post_id" uuid,
	"author_id" uuid,
	"surface" text,
	"position" smallint,
	"request_id" uuid,
	"session_id" uuid,
	"seq" integer,
	"value" integer,
	"detail" text,
	"client" text,
	"origin" text NOT NULL,
	"client_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_events_type_check" CHECK ("feed_events"."type" in ('impression', 'dwell', 'open', 'detail_dwell', 'expand', 'spoiler', 'media_open', 'link_open', 'profile_open', 'voice_play', 'share', 'topic_open', 'like', 'unlike', 'reply', 'quote', 'repost', 'unrepost', 'save', 'unsave', 'poll_vote', 'follow', 'unfollow', 'block', 'report', 'more', 'less', 'snooze', 'topic_more', 'topic_less')),
	CONSTRAINT "feed_events_surface_check" CHECK ("feed_events"."surface" is null or "feed_events"."surface" in ('for_you', 'following', 'latest', 'thread', 'profile', 'topic', 'search', 'saved', 'other')),
	CONSTRAINT "feed_events_client_check" CHECK ("feed_events"."client" is null or "feed_events"."client" in ('mobile', 'desktop')),
	CONSTRAINT "feed_events_origin_check" CHECK ("feed_events"."origin" in ('client', 'server', 'backfill')),
	CONSTRAINT "feed_events_detail_check" CHECK ("feed_events"."detail" is null or char_length("feed_events"."detail") <= 253),
	CONSTRAINT "feed_events_session_check" CHECK (("feed_events"."session_id" is null) = ("feed_events"."seq" is null))
);
--> statement-breakpoint
ALTER TABLE "post_likes" ADD COLUMN "created_at" timestamp (3) with time zone;--> statement-breakpoint
UPDATE "post_likes" SET "created_at" = coalesce((
	SELECT min(n."created_at") FROM "notifications" n
	WHERE n."kind" = 'like' AND n."actor_id" = "post_likes"."user_id" AND n."subject" = "post_likes"."post_id"::text
), (SELECT p."created_at" FROM "posts" p WHERE p."id" = "post_likes"."post_id"), now());--> statement-breakpoint
ALTER TABLE "post_likes" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "post_likes" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "feed_personalize" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_events" ADD CONSTRAINT "feed_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_events" ADD CONSTRAINT "feed_events_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_events" ADD CONSTRAINT "feed_events_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feed_events_user_idx" ON "feed_events" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "feed_events_post_idx" ON "feed_events" USING btree ("post_id","type");--> statement-breakpoint
CREATE INDEX "feed_events_author_idx" ON "feed_events" USING btree ("author_id") WHERE "feed_events"."author_id" is not null;--> statement-breakpoint
CREATE INDEX "feed_events_created_idx" ON "feed_events" USING brin ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_events_session_seq_idx" ON "feed_events" USING btree ("session_id","seq") WHERE "feed_events"."session_id" is not null;--> statement-breakpoint
CREATE INDEX "posts_author_idx" ON "posts" USING btree ("author_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
INSERT INTO "feed_events" ("user_id", "type", "post_id", "author_id", "origin", "created_at")
SELECT l."user_id", 'like', l."post_id", p."author_id", 'backfill', l."created_at"
FROM "post_likes" l JOIN "posts" p ON p."id" = l."post_id"
WHERE l."user_id" <> p."author_id"
	AND NOT EXISTS (SELECT 1 FROM "feed_events" WHERE "origin" = 'backfill' AND "type" = 'like');--> statement-breakpoint
INSERT INTO "feed_events" ("user_id", "type", "post_id", "author_id", "origin", "created_at")
SELECT r."user_id", 'repost', r."post_id", p."author_id", 'backfill', r."created_at"
FROM "post_reposts" r JOIN "posts" p ON p."id" = r."post_id"
WHERE r."user_id" <> p."author_id"
	AND NOT EXISTS (SELECT 1 FROM "feed_events" WHERE "origin" = 'backfill' AND "type" = 'repost');--> statement-breakpoint
INSERT INTO "feed_events" ("user_id", "type", "post_id", "author_id", "origin", "created_at")
SELECT s."user_id", 'save', s."post_id", p."author_id", 'backfill', s."created_at"
FROM "post_saves" s JOIN "posts" p ON p."id" = s."post_id"
WHERE s."user_id" <> p."author_id"
	AND NOT EXISTS (SELECT 1 FROM "feed_events" WHERE "origin" = 'backfill' AND "type" = 'save');--> statement-breakpoint
INSERT INTO "feed_events" ("user_id", "type", "post_id", "author_id", "origin", "created_at")
SELECT r."author_id", 'reply', parent."id", parent."author_id", 'backfill', r."created_at"
FROM "posts" r JOIN "posts" parent ON parent."id" = r."parent_id"
WHERE r."author_id" <> parent."author_id"
	AND NOT EXISTS (SELECT 1 FROM "feed_events" WHERE "origin" = 'backfill' AND "type" = 'reply');--> statement-breakpoint
INSERT INTO "feed_events" ("user_id", "type", "post_id", "author_id", "origin", "created_at")
SELECT q."author_id", 'quote', quoted."id", quoted."author_id", 'backfill', q."created_at"
FROM "posts" q JOIN "posts" quoted ON quoted."id" = q."quoted_post_id"
WHERE q."is_quote" AND q."author_id" <> quoted."author_id"
	AND NOT EXISTS (SELECT 1 FROM "feed_events" WHERE "origin" = 'backfill' AND "type" = 'quote');--> statement-breakpoint
INSERT INTO "feed_events" ("user_id", "type", "author_id", "origin", "created_at")
SELECT f."follower_id", 'follow', f."following_id", 'backfill', f."created_at"
FROM "user_follows" f
WHERE NOT EXISTS (SELECT 1 FROM "feed_events" WHERE "origin" = 'backfill' AND "type" = 'follow');
