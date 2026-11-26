ALTER TABLE "post_images" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "post_images" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "post_images" ADD CONSTRAINT "post_images_object_key_unique" UNIQUE("object_key");--> statement-breakpoint
ALTER TABLE "post_images" ADD CONSTRAINT "post_images_one_image" CHECK (num_nonnulls("post_images"."data", "post_images"."object_key") = 1);--> statement-breakpoint
-- Every way a post image disappears (draft expiry, post or account removal, moderation)
-- queues its R2 object through the media deletion outbox.
CREATE FUNCTION queue_deleted_post_image() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.object_key IS NOT NULL THEN
    INSERT INTO media_deletions (key) VALUES (OLD.object_key)
    ON CONFLICT (key) DO UPDATE SET available_at = now();
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER post_images_object_cleanup AFTER DELETE ON post_images
FOR EACH ROW EXECUTE FUNCTION queue_deleted_post_image();
