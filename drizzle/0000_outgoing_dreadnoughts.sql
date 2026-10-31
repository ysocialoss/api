CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"colour" text DEFAULT '#808080' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_handle_unique" UNIQUE("handle"),
	CONSTRAINT "users_handle_check" CHECK ("users"."handle" ~ '^[a-z0-9_]{3,32}$'),
	CONSTRAINT "users_display_name_check" CHECK (char_length("users"."display_name") <= 80),
	CONSTRAINT "users_bio_check" CHECK (char_length("users"."bio") <= 2000),
	CONSTRAINT "users_colour_check" CHECK ("users"."colour" ~ '^#[0-9A-Fa-f]{6}$')
);
