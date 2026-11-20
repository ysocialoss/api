CREATE TABLE "dm_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_user_id" uuid NOT NULL,
	"second_user_id" uuid NOT NULL,
	"last_message_at" timestamp with time zone,
	CONSTRAINT "dm_conversations_pair_unique" UNIQUE("first_user_id","second_user_id"),
	CONSTRAINT "dm_conversations_pair_order" CHECK ("dm_conversations"."first_user_id" < "dm_conversations"."second_user_id")
);
--> statement-breakpoint
CREATE TABLE "dm_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"encryption_key" text NOT NULL,
	"signing_key" text NOT NULL,
	"proof" text NOT NULL,
	"root" boolean DEFAULT false NOT NULL,
	"approved_by" uuid,
	"approval" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revocation" text,
	CONSTRAINT "dm_devices_approval_check" CHECK (("dm_devices"."approved_by" is null) = ("dm_devices"."approval" is null) and (not "dm_devices"."root" or "dm_devices"."approved_by" is null)),
	CONSTRAINT "dm_devices_revocation_check" CHECK (("dm_devices"."revoked_at" is null) = ("dm_devices"."revoked_by" is null) and ("dm_devices"."revoked_at" is null) = ("dm_devices"."revocation" is null))
);
--> statement-breakpoint
CREATE TABLE "dm_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"sender_device_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"iv" text NOT NULL,
	"ciphertext" text NOT NULL,
	"signature" text NOT NULL,
	"envelopes" jsonb NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "dm_messages_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_messages_conversation_sequence_unique" UNIQUE("conversation_id","sequence")
);
--> statement-breakpoint
ALTER TABLE "dm_conversations" ADD CONSTRAINT "dm_conversations_first_user_id_users_id_fk" FOREIGN KEY ("first_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_conversations" ADD CONSTRAINT "dm_conversations_second_user_id_users_id_fk" FOREIGN KEY ("second_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_devices" ADD CONSTRAINT "dm_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_conversation_id_dm_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."dm_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dm_conversations_second_user_idx" ON "dm_conversations" USING btree ("second_user_id");--> statement-breakpoint
CREATE INDEX "dm_devices_user_idx" ON "dm_devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dm_devices_root_idx" ON "dm_devices" USING btree ("user_id") WHERE "dm_devices"."root";