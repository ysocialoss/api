ALTER TYPE "public"."notification_kind" ADD VALUE 'friends_repost';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'friend';--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_subject_check";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "muted_notification_kinds" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_subject_check" CHECK (case
        when "notifications"."kind"::text in ('dm_invite', 'dm_message') then "notifications"."conversation_id" is not null and "notifications"."post_id" is null
        when "notifications"."kind"::text in ('follow', 'friend') then "notifications"."conversation_id" is null and "notifications"."post_id" is null
        else "notifications"."conversation_id" is null and "notifications"."post_id" is not null
      end);