CREATE TABLE "csam_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"handle" text NOT NULL,
	"surface" text NOT NULL,
	"provider" text NOT NULL,
	"match_id" text,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"ip" text,
	"hold" boolean DEFAULT false NOT NULL,
	"reported_bka_at" timestamp (3) with time zone,
	"bka_ref" text,
	"reported_ncmec_at" timestamp (3) with time zone,
	"ncmec_ref" text,
	"note" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csam_incidents_surface_check" CHECK ("csam_incidents"."surface" in ('post_image', 'avatar', 'banner', 'flag'))
);
--> statement-breakpoint
CREATE TABLE "deleted_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"deleted_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_appeals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"staff_note" text,
	"resolved_by_id" uuid,
	"resolved_by_handle" text,
	"resolved_at" timestamp (3) with time zone,
	"seen_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_appeals_decision_unique" UNIQUE("decision_id"),
	CONSTRAINT "moderation_appeals_status_check" CHECK ("moderation_appeals"."status" in ('open', 'upheld', 'reversed')),
	CONSTRAINT "moderation_appeals_text_check" CHECK (char_length("moderation_appeals"."text") between 1 and 2000 and char_length("moderation_appeals"."staff_note") <= 2000),
	CONSTRAINT "moderation_appeals_resolution_check" CHECK (("moderation_appeals"."status" = 'open') = ("moderation_appeals"."resolved_at" is null))
);
--> statement-breakpoint
CREATE TABLE "moderation_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_key" uuid,
	"excerpt" text DEFAULT '' NOT NULL,
	"ground_type" text NOT NULL,
	"ground_ref" text NOT NULL,
	"facts" text NOT NULL,
	"automated_detection" boolean DEFAULT false NOT NULL,
	"automated_decision" boolean DEFAULT false NOT NULL,
	"report_id" uuid,
	"decided_by_id" uuid,
	"decided_by_handle" text,
	"seen_at" timestamp (3) with time zone,
	"reversed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_decisions_action_check" CHECK ("moderation_decisions"."action" in ('remove_post', 'hide_post', 'remove_media', 'edit_post', 'clear_profile', 'edit_profile', 'ban', 'remove_account', 'remove_message')),
	CONSTRAINT "moderation_decisions_target_check" CHECK ("moderation_decisions"."target_type" in ('post', 'user', 'message')),
	CONSTRAINT "moderation_decisions_ground_check" CHECK ("moderation_decisions"."ground_type" in ('illegal', 'terms') and char_length("moderation_decisions"."ground_ref") between 1 and 120),
	CONSTRAINT "moderation_decisions_text_check" CHECK (char_length("moderation_decisions"."facts") between 1 and 2000 and char_length("moderation_decisions"."excerpt") <= 300)
);
--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "channel" text DEFAULT 'in_app' NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "legal_ground" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "notifier_name" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "notifier_email" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "good_faith_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "status_token_hash" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "reporter_seen_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "escalated_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "escalation_authority" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "escalation_ref" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "feed_choice_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "age_confirmed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_export_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "moderation_appeals" ADD CONSTRAINT "moderation_appeals_decision_id_moderation_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."moderation_decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_appeals" ADD CONSTRAINT "moderation_appeals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_decisions" ADD CONSTRAINT "moderation_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_decisions" ADD CONSTRAINT "moderation_decisions_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "csam_incidents_created_idx" ON "csam_incidents" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "moderation_appeals_queue_idx" ON "moderation_appeals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "moderation_decisions_user_idx" ON "moderation_decisions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "reports_status_token_idx" ON "reports" USING btree ("status_token_hash") WHERE "reports"."status_token_hash" is not null;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_channel_check" CHECK ("reports"."channel" in ('in_app', 'public'));--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_notifier_check" CHECK (char_length("reports"."notifier_name") <= 120 and char_length("reports"."notifier_email") <= 254 and char_length("reports"."legal_ground") <= 120);--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_escalation_check" CHECK (char_length("reports"."escalation_authority") <= 120 and char_length("reports"."escalation_ref") <= 200);