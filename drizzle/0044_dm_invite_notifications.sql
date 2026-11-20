CREATE TYPE "public"."dm_invite_status" AS ENUM('pending', 'accepted', 'declined');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'dm_invite';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'dm_message';--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_subject_check";--> statement-breakpoint
ALTER TABLE "dm_conversations" ADD COLUMN "invited_by" uuid;--> statement-breakpoint
ALTER TABLE "dm_conversations" ADD COLUMN "invite_status" "dm_invite_status" DEFAULT 'accepted' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_conversation_id_dm_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."dm_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_conversation_idx" ON "notifications" USING btree ("conversation_id") WHERE "notifications"."conversation_id" is not null;--> statement-breakpoint
ALTER TABLE "dm_conversations" ADD CONSTRAINT "dm_conversations_inviter_check" CHECK (
    ("dm_conversations"."invited_by" is null and "dm_conversations"."invite_status" = 'accepted') or
    ("dm_conversations"."invited_by" is not null and "dm_conversations"."invited_by" in ("dm_conversations"."first_user_id", "dm_conversations"."second_user_id"))
  );--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_subject_check" CHECK (case
        when "notifications"."kind"::text in ('dm_invite', 'dm_message') then "notifications"."conversation_id" is not null and "notifications"."post_id" is null
        when "notifications"."kind" = 'follow' then "notifications"."conversation_id" is null and "notifications"."post_id" is null
        else "notifications"."conversation_id" is null and "notifications"."post_id" is not null
      end);