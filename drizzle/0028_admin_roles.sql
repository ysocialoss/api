CREATE TYPE "public"."user_role" AS ENUM('admin', 'moderator', 'og', 'user');--> statement-breakpoint
ALTER TABLE "oauth_transactions" ADD COLUMN "admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" "user_role" DEFAULT 'user' NOT NULL;