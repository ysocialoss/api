import { sql } from "drizzle-orm";
import { z } from "zod";
import type { db } from "./db/index.ts";

const change = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("conversation"), id: z.uuid(), roster: z.boolean() }),
  z.strictObject({ type: z.literal("devices") }),
  z.strictObject({ type: z.literal("notifications") }),
  z.strictObject({ type: z.literal("previews"), hidden: z.boolean() }),
]);
export const dmEvent = z.strictObject({ userId: z.uuid(), change });
type Change = z.infer<typeof change>;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function publishDmChange(tx: Transaction, userId: string, change: Change) {
  await tx.execute(sql`select pg_notify('live_dm', ${JSON.stringify({ userId, change })})`);
}

export async function publishDmDeviceChange(tx: Transaction, userId: string) {
  await publishDmChange(tx, userId, { type: "devices" });
  await tx.execute(sql`select pg_notify('live_dm', json_build_object(
    'userId', case when first_user_id = ${userId}::uuid then second_user_id else first_user_id end,
    'change', json_build_object('type', 'conversation', 'id', id, 'roster', true)
  )::text) from dm_conversations
    where (first_user_id = ${userId}::uuid or second_user_id = ${userId}::uuid) and invite_status in ('pending', 'accepted')`);
}
