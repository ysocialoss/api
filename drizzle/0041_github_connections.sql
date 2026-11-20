CREATE TABLE "github_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"github_id" text NOT NULL,
	"login" text NOT NULL,
	"contribution_count" integer,
	"checked_at" timestamp with time zone,
	"attempted_at" timestamp with time zone,
	CONSTRAINT "github_connections_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "github_connections_github_id_unique" UNIQUE("github_id"),
	CONSTRAINT "github_contribution_count_check" CHECK ("github_connections"."contribution_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "github_link_attempts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"state_hash" text NOT NULL,
	"session_hash" text NOT NULL,
	"verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_link_attempts" ADD CONSTRAINT "github_link_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_connections_attempted_idx" ON "github_connections" USING btree ("attempted_at");