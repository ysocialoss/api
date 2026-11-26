CREATE TABLE "advent_rewards" (
	"user_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"day" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advent_rewards_user_id_year_day_pk" PRIMARY KEY("user_id","year","day"),
	CONSTRAINT "advent_rewards_day_check" CHECK ("advent_rewards"."day" in (7, 14, 24))
);
--> statement-breakpoint
ALTER TABLE "advent_rewards" ADD CONSTRAINT "advent_rewards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;