import type { PoolClient } from "pg";
import { pool } from "./db/index.ts";

const RETENTION_LOCK = 7_001_070;
const dayMs = 24 * 60 * 60 * 1000;

export const retentionRules = [
  { name: "feed_events_client", sql: "delete from feed_events where origin = 'client' and created_at < now() - interval '180 days'" },
  { name: "feed_events_server", sql: "delete from feed_events where origin <> 'client' and created_at < now() - interval '365 days'" },
  { name: "reports", sql: "delete from reports where status <> 'open' and resolved_at < now() - interval '6 months' and escalated_at is null" },
  { name: "reports_escalated", sql: "delete from reports where status <> 'open' and escalated_at < now() - interval '12 months'" },
  { name: "moderation_appeals", sql: "delete from moderation_appeals where status <> 'open' and resolved_at < now() - interval '12 months'" },
  { name: "moderation_decisions", sql: `delete from moderation_decisions d where d.created_at < now() - interval '12 months'
    and not exists (select 1 from moderation_appeals a where a.decision_id = d.id and (a.status = 'open' or a.resolved_at >= now() - interval '12 months'))` },
  { name: "moderation_activity", sql: "delete from moderation_activity where created_at < now() - interval '12 months'" },
  { name: "deleted_accounts", sql: "delete from deleted_accounts where deleted_at < now() - interval '35 days'" },
  { name: "csam_incidents", sql: "delete from csam_incidents where not hold and created_at < now() - interval '12 months'" },
  { name: "contact_handled", sql: "delete from contact_messages where handled_at is not null and handled_at < now() - interval '3 months'" },
  { name: "contact_unhandled", sql: "delete from contact_messages where handled_at is null and created_at < now() - interval '12 months'" },
  { name: "auth_sessions", sql: "delete from auth_sessions where expires_at < now()" },
  { name: "oauth_transactions", sql: "delete from oauth_transactions where expires_at < now()" },
] as const;

export async function runRetention(client: Pick<PoolClient, "query"> = pool) {
  const removed: Record<string, number> = {};
  for (const rule of retentionRules) {
    const result = await client.query(rule.sql);
    removed[rule.name] = result.rowCount ?? 0;
  }
  return removed;
}

export function startRetention() {
  let running = false;
  async function sweep() {
    if (running) return;
    running = true;
    let lock: PoolClient | undefined;
    try {
      lock = await pool.connect();
      const { rows } = await lock.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [RETENTION_LOCK]);
      if (!rows[0]?.locked) return;
      const removed = await runRetention(lock);
      console.info({ event: "retention_sweep", removed });
    } catch {
      console.error({ event: "retention_sweep_unavailable" });
    } finally {
      lock?.release(true);
      running = false;
    }
  }
  void sweep();
  const timer = setInterval(() => void sweep(), dayMs);
  timer.unref();
  return () => clearInterval(timer);
}
