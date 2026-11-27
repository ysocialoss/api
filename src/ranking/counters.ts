import { sql } from "drizzle-orm";
import { db } from "../db/index.ts";

export const counterNames = [
  "choice_unlock_nav", "choice_decline_nav", "pipeline_error", "pipeline_fallback_chrono", "caught_up",
  "public_cache_hit", "public_cache_miss", "cursor_rejected",
] as const;
export type CounterName = (typeof counterNames)[number];

export async function bumpCounter(name: CounterName, by = 1) {
  try {
    await db.execute(sql`
      insert into feed_counters (day, name, value) values ((now() at time zone 'utc')::date, ${name}, ${by})
      on conflict (day, name) do update set value = feed_counters.value + excluded.value`);
  } catch {
    console.error({ event: "feed_counter_unavailable", name });
  }
}
