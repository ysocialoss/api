CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid,
	"username" text DEFAULT '' NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"picture" text,
	"profile_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "auth_identities_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "auth_identity_subject_unique" UNIQUE("issuer","subject")
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"identity_id" uuid NOT NULL,
	"encrypted_tokens" text NOT NULL,
	"refresh_after" timestamp with time zone NOT NULL,
	"retry_after" timestamp with time zone,
	"refresh_failures" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_transactions" (
	"state" text PRIMARY KEY NOT NULL,
	"browser_hash" text NOT NULL,
	"verifier" text NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_identity_id_auth_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE cascade ON UPDATE no action;
