CREATE TABLE "paints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"is_free" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paints_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "user_paints" (
	"user_id" uuid NOT NULL,
	"paint_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_paints_user_id_paint_id_pk" PRIMARY KEY("user_id","paint_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "paint_id" uuid;--> statement-breakpoint
ALTER TABLE "user_paints" ADD CONSTRAINT "user_paints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_paints" ADD CONSTRAINT "user_paints_paint_id_paints_id_fk" FOREIGN KEY ("paint_id") REFERENCES "public"."paints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_paints_paint_idx" ON "user_paints" USING btree ("paint_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_paint_id_paints_id_fk" FOREIGN KEY ("paint_id") REFERENCES "public"."paints"("id") ON DELETE set null ON UPDATE no action;