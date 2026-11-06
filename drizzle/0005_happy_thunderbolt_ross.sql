ALTER TABLE "posts" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_parent_id_posts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posts_parent_idx" ON "posts" USING btree ("parent_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);