CREATE TABLE "feed_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"post_id" uuid,
	"author_id" uuid,
	"topic" text,
	"direction" smallint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone,
	CONSTRAINT "feed_feedback_kind_check" CHECK ("feed_feedback"."kind" in ('post', 'author', 'snooze', 'topic')),
	CONSTRAINT "feed_feedback_direction_check" CHECK ("feed_feedback"."direction" in (-1, 1) and ("feed_feedback"."kind" <> 'snooze' or "feed_feedback"."direction" = -1)),
	CONSTRAINT "feed_feedback_target_check" CHECK (case "feed_feedback"."kind"
    when 'post' then "feed_feedback"."post_id" is not null and "feed_feedback"."author_id" is null and "feed_feedback"."topic" is null
    when 'topic' then "feed_feedback"."topic" is not null and "feed_feedback"."post_id" is null and "feed_feedback"."author_id" is null
    else "feed_feedback"."author_id" is not null and "feed_feedback"."post_id" is null and "feed_feedback"."topic" is null end),
	CONSTRAINT "feed_feedback_topic_check" CHECK ("feed_feedback"."topic" is null or char_length("feed_feedback"."topic") between 1 and 32)
);
--> statement-breakpoint
ALTER TABLE "feed_requests" ADD COLUMN "prefs" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "feed_discovery" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "feed_freshness" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "feed_replies" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_feedback" ADD CONSTRAINT "feed_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_feedback" ADD CONSTRAINT "feed_feedback_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_feedback" ADD CONSTRAINT "feed_feedback_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_feedback_post_unique" ON "feed_feedback" USING btree ("user_id","post_id") WHERE "feed_feedback"."post_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_feedback_author_unique" ON "feed_feedback" USING btree ("user_id","kind","author_id") WHERE "feed_feedback"."author_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_feedback_topic_unique" ON "feed_feedback" USING btree ("user_id","topic") WHERE "feed_feedback"."topic" is not null;--> statement-breakpoint
CREATE INDEX "feed_feedback_post_idx" ON "feed_feedback" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "feed_feedback_author_idx" ON "feed_feedback" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "feed_feedback_expires_idx" ON "feed_feedback" USING btree ("user_id","expires_at");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_feed_discovery_check" CHECK ("users"."feed_discovery" between -2 and 2);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_feed_freshness_check" CHECK ("users"."feed_freshness" between -2 and 2);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_feed_replies_check" CHECK ("users"."feed_replies" between -2 and 2);