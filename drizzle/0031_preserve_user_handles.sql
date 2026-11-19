CREATE TABLE "user_handles" (
	"handle" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_handles" ADD CONSTRAINT "user_handles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_handles_user_idx" ON "user_handles" USING btree ("user_id");
--> statement-breakpoint
-- Prevent writes between the backfill and installation of the trigger.
LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO "user_handles" ("handle", "user_id")
SELECT "handle", "id" FROM "users";
--> statement-breakpoint
-- A stored mention can recover a previous handle when it has exactly one known owner.
INSERT INTO "user_handles" ("handle", "user_id")
SELECT "handle", min("user_id"::text)::uuid
FROM "post_mentions"
GROUP BY "handle"
HAVING count(DISTINCT "user_id") = 1
ON CONFLICT ("handle") DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION "register_user_handle"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "user_handles" ("handle", "user_id")
  VALUES (NEW."handle", NEW."id")
  ON CONFLICT ("handle") DO UPDATE SET "user_id" = EXCLUDED."user_id"
    WHERE "user_handles"."user_id" = EXCLUDED."user_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Handle is already taken' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "register_user_handle"
AFTER INSERT OR UPDATE OF "handle" ON "users"
FOR EACH ROW EXECUTE FUNCTION "register_user_handle"();
