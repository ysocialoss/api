CREATE TYPE "public"."changelog_category" AS ENUM('new', 'improved', 'fixed', 'removed', 'technical');--> statement-breakpoint
CREATE TABLE "changelog_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app" text NOT NULL,
	"category" "changelog_category" NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"release_id" uuid,
	"published_at" timestamp (3) with time zone,
	"author_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "changelog_entries_title_check" CHECK (char_length("changelog_entries"."title") between 1 and 120),
	CONSTRAINT "changelog_entries_body_check" CHECK (char_length("changelog_entries"."body") <= 4000)
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app" text NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "releases_app_tag_unique" UNIQUE("app","tag")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "changelog_seen_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "changelog_entries" ADD CONSTRAINT "changelog_entries_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changelog_entries" ADD CONSTRAINT "changelog_entries_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "changelog_entries_unreleased_idx" ON "changelog_entries" USING btree ("app","created_at") WHERE "changelog_entries"."release_id" is null;--> statement-breakpoint
CREATE INDEX "changelog_entries_published_idx" ON "changelog_entries" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "releases_created_idx" ON "releases" USING btree ("created_at");