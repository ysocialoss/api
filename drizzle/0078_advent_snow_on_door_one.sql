ALTER TABLE "advent_rewards" DROP CONSTRAINT "advent_rewards_day_check";--> statement-breakpoint
UPDATE "advent_rewards" SET "day" = 1 WHERE "day" = 24;--> statement-breakpoint
ALTER TABLE "advent_rewards" ADD CONSTRAINT "advent_rewards_day_check" CHECK ("advent_rewards"."day" in (1, 7, 14, 24));
