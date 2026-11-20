CREATE TABLE "github_contribution_jobs" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease" uuid
);
--> statement-breakpoint
ALTER TABLE "github_contribution_jobs" ADD CONSTRAINT "github_contribution_jobs_connection_id_github_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_contribution_jobs_due_idx" ON "github_contribution_jobs" USING btree ("run_at","connection_id");
--> statement-breakpoint
CREATE FUNCTION "enqueue_github_contribution_job"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "public"."github_contribution_jobs" ("connection_id") VALUES (NEW."id");
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "github_connections_enqueue_contributions"
AFTER INSERT ON "github_connections" FOR EACH ROW
EXECUTE FUNCTION "enqueue_github_contribution_job"();
--> statement-breakpoint
INSERT INTO "github_contribution_jobs" ("connection_id", "run_at")
SELECT "id", coalesce(greatest("checked_at" + interval '24 hours', "attempted_at" + interval '10 minutes'), now())
FROM "github_connections"
ON CONFLICT ("connection_id") DO NOTHING;
