ALTER TABLE "dm_attachments" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dm_attachments" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "dm_attachments" ADD CONSTRAINT "dm_attachments_object_key_unique" UNIQUE("object_key");--> statement-breakpoint
ALTER TABLE "dm_attachments" ADD CONSTRAINT "dm_attachments_one_blob" CHECK (num_nonnulls("dm_attachments"."data", "dm_attachments"."object_key") = 1);--> statement-breakpoint
-- Every way a DM attachment disappears (unsent expiry, message erase, conversation or
-- account removal) queues its R2 object through the media deletion outbox.
CREATE FUNCTION queue_deleted_dm_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.object_key IS NOT NULL THEN
    INSERT INTO media_deletions (key) VALUES (OLD.object_key)
    ON CONFLICT (key) DO UPDATE SET available_at = now();
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER dm_attachments_object_cleanup AFTER DELETE ON dm_attachments
FOR EACH ROW EXECUTE FUNCTION queue_deleted_dm_attachment();
