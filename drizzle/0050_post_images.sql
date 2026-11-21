CREATE TABLE "post_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploader_id" uuid NOT NULL,
	"post_id" uuid,
	"data" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posts" DROP CONSTRAINT "posts_content_check";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "image_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "post_images" ADD CONSTRAINT "post_images_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_images" ADD CONSTRAINT "post_images_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_images_post_idx" ON "post_images" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_images_draft_uploader_idx" ON "post_images" USING btree ("uploader_id") WHERE "post_images"."post_id" IS NULL;--> statement-breakpoint
CREATE INDEX "post_images_draft_expiry_idx" ON "post_images" USING btree ("expires_at") WHERE "post_images"."post_id" IS NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_content_check" CHECK (char_length("posts"."content") <= 2000 AND ("posts"."content" ~ '[^[:space:]]' OR ("posts"."content" = '' AND ("posts"."gif" IS NOT NULL OR "posts"."poll" IS NOT NULL OR "posts"."voice" IS NOT NULL OR cardinality("posts"."image_ids") > 0))));