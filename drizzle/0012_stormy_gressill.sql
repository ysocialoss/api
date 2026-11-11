CREATE TABLE "media_deletions" (
	"key" text PRIMARY KEY NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "media_deletions_due_idx" ON "media_deletions" USING btree ("available_at");