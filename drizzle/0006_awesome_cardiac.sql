CREATE TABLE "post_reposts" (
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_reposts_post_id_user_id_pk" PRIMARY KEY("post_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "post_reposts" ADD CONSTRAINT "post_reposts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_reposts" ADD CONSTRAINT "post_reposts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_reposts_user_idx" ON "post_reposts" USING btree ("user_id","created_at" DESC NULLS LAST,"post_id" DESC NULLS LAST);