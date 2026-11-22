CREATE TYPE "public"."report_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."report_target_type" AS ENUM('post', 'user', 'message');--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid,
	"reporter_handle" text NOT NULL,
	"target_type" "report_target_type" NOT NULL,
	"target_key" uuid NOT NULL,
	"target_user_id" uuid,
	"target_handle" text NOT NULL,
	"conversation_id" uuid,
	"reason" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"resolution" text,
	"note" text,
	"resolved_by_id" uuid,
	"resolved_by_handle" text,
	"resolved_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_reason_check" CHECK ("reports"."reason" in ('spam', 'harassment', 'hate', 'violence', 'sexual', 'self_harm', 'misinformation', 'impersonation', 'illegal', 'other')),
	CONSTRAINT "reports_details_check" CHECK (char_length("reports"."details") <= 1000),
	CONSTRAINT "reports_note_check" CHECK (char_length("reports"."note") <= 1000),
	CONSTRAINT "reports_conversation_check" CHECK (("reports"."target_type" = 'message') = ("reports"."conversation_id" is not null)),
	CONSTRAINT "reports_resolution_check" CHECK (("reports"."status" = 'open') = ("reports"."resolved_at" is null))
);
--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reports_queue_idx" ON "reports" USING btree ("status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reports_target_idx" ON "reports" USING btree ("target_type","target_key","status");--> statement-breakpoint
CREATE INDEX "reports_target_user_idx" ON "reports" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "reports_reporter_idx" ON "reports" USING btree ("reporter_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "reports_open_unique" ON "reports" USING btree ("reporter_id","target_type","target_key") WHERE "reports"."status" = 'open';