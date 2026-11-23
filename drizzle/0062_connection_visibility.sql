ALTER TABLE "connections" ADD COLUMN "display_on_profile" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "github_connections" ADD COLUMN "display_on_profile" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_domains" ADD COLUMN "display_on_profile" boolean DEFAULT true NOT NULL;