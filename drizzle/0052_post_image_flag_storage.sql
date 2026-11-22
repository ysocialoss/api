ALTER TABLE "post_image_flags" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "post_image_flags" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "post_image_flags" ADD CONSTRAINT "post_image_flags_object_key_unique" UNIQUE("object_key");--> statement-breakpoint
ALTER TABLE "post_image_flags" ADD CONSTRAINT "post_image_flags_one_image" CHECK (num_nonnulls("post_image_flags"."data", "post_image_flags"."object_key") = 1);
--> statement-breakpoint
CREATE FUNCTION queue_deleted_post_image_flag() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.object_key IS NOT NULL THEN
    INSERT INTO media_deletions (key) VALUES (OLD.object_key)
    ON CONFLICT (key) DO UPDATE SET available_at = now();
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER post_image_flags_cleanup AFTER DELETE ON post_image_flags
FOR EACH ROW EXECUTE FUNCTION queue_deleted_post_image_flag();
