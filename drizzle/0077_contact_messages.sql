CREATE TABLE "contact_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text,
	"message" text NOT NULL,
	"handled_at" timestamp (3) with time zone,
	"handled_by_handle" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_messages_text_check" CHECK (char_length("contact_messages"."message") between 10 and 2000 and char_length("contact_messages"."name") <= 100 and char_length("contact_messages"."email") <= 254)
);
--> statement-breakpoint
CREATE INDEX "contact_messages_queue_idx" ON "contact_messages" USING btree ("handled_at","created_at");