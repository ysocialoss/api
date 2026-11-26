CREATE TABLE "advent_doors" (
	"user_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"day" integer NOT NULL,
	"opened_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advent_doors_user_id_year_day_pk" PRIMARY KEY("user_id","year","day"),
	CONSTRAINT "advent_doors_day_check" CHECK ("advent_doors"."day" between 1 and 24)
);
--> statement-breakpoint
ALTER TABLE "advent_doors" ADD CONSTRAINT "advent_doors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;