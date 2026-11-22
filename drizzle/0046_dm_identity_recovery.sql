DROP INDEX "dm_devices_root_idx";--> statement-breakpoint
ALTER TABLE "dm_devices" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "dm_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "dm_devices_root_idx" ON "dm_devices" USING btree ("user_id","generation") WHERE "dm_devices"."root";