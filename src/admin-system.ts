import { Router } from "express";
import { monitorEventLoopDelay } from "node:perf_hooks";
import os from "node:os";
import { sql } from "drizzle-orm";
import { requireStaff } from "./admin-access.ts";
import { env } from "./config.ts";
import { db, pool } from "./db/index.ts";
import { isDraining, readHealthChecks } from "./health.ts";
import { liveStreamCount } from "./live-events.ts";

const startedAt = new Date(Date.now() - process.uptime() * 1000);
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();

const nsfwUrl = new URL(env.NSFW_CHECK_URL ?? (
  env.NODE_ENV === "production"
    ? "http://nsfw-api.nsfw-api.svc.cluster.local:8000"
    : "http://127.0.0.1:8000"
));

type Probe = { status: "ok" | "unavailable"; checkedAt: string; latencyMs: number };
let nsfwCache: { probe: Probe; expires: number } | undefined;
async function probeNsfw(): Promise<Probe> {
  if (nsfwCache && nsfwCache.expires > Date.now()) return nsfwCache.probe;
  const started = performance.now();
  let status: Probe["status"] = "unavailable";
  try {
    // Any HTTP answer means the scanner process is reachable.
    const response = await fetch(new URL("/", nsfwUrl), { signal: AbortSignal.timeout(2000), redirect: "manual" });
    await response.body?.cancel();
    status = response.status < 500 ? "ok" : "unavailable";
  } catch {
    // Unreachable scanners are reported as unavailable.
  }
  const probe = { status, checkedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - started) };
  nsfwCache = { probe, expires: Date.now() + 30_000 };
  return probe;
}

async function section<T>(load: () => Promise<T>): Promise<T | { error: true }> {
  try {
    return await load();
  } catch (error) {
    console.error("Admin system section failed", error);
    return { error: true };
  }
}

const rows = async <T>(query: ReturnType<typeof sql>) => (await db.execute(query)).rows as T[];
const num = (value: unknown) => Number(value ?? 0);

async function database() {
  const started = performance.now();
  const [server] = await rows<{
    version: string; size: string; started: Date; connections: string; max_connections: string;
    commits: string; rollbacks: string; blks_hit: string; blks_read: string; deadlocks: string;
  }>(sql`
    select version() as version,
      pg_database_size(current_database()) as size,
      pg_postmaster_start_time() as started,
      (select count(*) from pg_stat_activity where datname = current_database()) as connections,
      current_setting('max_connections') as max_connections,
      d.xact_commit as commits, d.xact_rollback as rollbacks,
      d.blks_hit, d.blks_read, d.deadlocks
    from pg_stat_database d where d.datname = current_database()`);
  const latencyMs = Math.round(performance.now() - started);
  const tables = await rows<{ name: string; rows: string; bytes: string }>(sql`
    select relname as name, n_live_tup as rows, pg_total_relation_size(relid) as bytes
    from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 12`);
  const [migrations] = await rows<{ count: string; last: string | null }>(sql`
    select count(*) as count, max(created_at) as last from drizzle.__drizzle_migrations`).catch(() => [undefined]);
  const reads = num(server.blks_hit) + num(server.blks_read);
  return {
    version: server.version.split(" ").slice(0, 2).join(" "),
    sizeBytes: num(server.size),
    startedAt: new Date(server.started).toISOString(),
    latencyMs,
    connections: { open: num(server.connections), max: num(server.max_connections) },
    pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: env.DATABASE_POOL_MAX },
    cacheHitRatio: reads ? num(server.blks_hit) / reads : null,
    transactions: { commits: num(server.commits), rollbacks: num(server.rollbacks) },
    deadlocks: num(server.deadlocks),
    migrations: migrations ? { applied: num(migrations.count) } : null,
    tables: tables.map((table) => ({ name: table.name, rows: num(table.rows), bytes: num(table.bytes) })),
  };
}

async function queues() {
  const [row] = await rows<Record<string, string>>(sql`
    select
      (select count(*) from media_deletions) as media_pending,
      (select count(*) from media_deletions where available_at <= now()) as media_due,
      (select count(*) from media_deletions where attempts > 0) as media_retrying,
      (select count(*) from voice_jobs where input is not null) as voice_pending,
      (select count(*) from voice_jobs where error is not null) as voice_failed,
      (select count(*) from github_contribution_jobs where run_at <= now()) as github_due,
      (select count(*) from push_deliveries) as push_pending,
      (select count(*) from push_deliveries where attempts > 0) as push_retrying,
      (select count(*) from push_subscriptions) as push_subscriptions`);
  return {
    mediaDeletions: { pending: num(row.media_pending), due: num(row.media_due), retrying: num(row.media_retrying) },
    voiceJobs: { pending: num(row.voice_pending), failed: num(row.voice_failed) },
    githubContributions: { due: num(row.github_due) },
    pushDeliveries: { pending: num(row.push_pending), retrying: num(row.push_retrying) },
    pushSubscriptions: num(row.push_subscriptions),
  };
}

const series = (table: "users" | "posts") => rows<{ day: string; count: string }>(sql`
  select to_char(d, 'YYYY-MM-DD') as day, count(t.id) as count
  from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d
  left join ${sql.raw(table)} t on t.created_at >= d and t.created_at < d + interval '1 day'
  group by d order by d`).then((result) => result.map((row) => ({ day: row.day, count: num(row.count) })));

async function community() {
  const [counts] = await rows<Record<string, string>>(sql`
    select
      count(*) as users,
      count(*) filter (where approved_at is null) as pending,
      count(*) filter (where banned_at is not null) as banned,
      count(*) filter (where role = 'admin') as admins,
      count(*) filter (where role = 'moderator') as moderators,
      count(*) filter (where role = 'og') as ogs,
      count(*) filter (where created_at >= now() - interval '7 days') as signups_7d,
      (select count(*) from posts) as posts,
      (select count(*) from posts where parent_id is null) as top_level,
      (select count(*) from posts where created_at >= now() - interval '7 days') as posts_7d,
      (select count(*) from auth_sessions where expires_at > now()) as sessions,
      (select count(*) from post_images) as images,
      (select count(*) from dm_conversations) as conversations
    from users`);
  const [signups, postSeries] = await Promise.all([series("users"), series("posts")]);
  return {
    users: {
      total: num(counts.users), pendingApproval: num(counts.pending), banned: num(counts.banned),
      admins: num(counts.admins), moderators: num(counts.moderators), ogs: num(counts.ogs), signups7d: num(counts.signups_7d),
    },
    posts: {
      total: num(counts.posts), topLevel: num(counts.top_level), replies: num(counts.posts) - num(counts.top_level),
      last7d: num(counts.posts_7d),
    },
    activeSessions: num(counts.sessions),
    images: num(counts.images),
    conversations: num(counts.conversations),
    signupsByDay: signups,
    postsByDay: postSeries,
  };
}

async function moderation() {
  const [row] = await rows<Record<string, string | null>>(sql`
    select
      (select count(*) from reports where status = 'open') as open_reports,
      (select min(created_at) from reports where status = 'open') as oldest_open,
      (select count(*) from reports where created_at >= now() - interval '7 days') as reports_7d,
      (select count(*) from reports where status <> 'open' and resolved_at >= now() - interval '7 days') as handled_7d,
      (select count(*) from post_image_flags where created_at >= now() - interval '7 days') as flags_7d,
      (select count(*) from moderation_activity where created_at >= now() - interval '1 day') as actions_24h,
      (select count(*) from moderation_activity where created_at >= now() - interval '7 days') as actions_7d,
      (select count(*) from users where approved_at is null) as waitlist`);
  const byReason = await rows<{ reason: string; count: string }>(sql`
    select reason, count(*) as count from reports where status = 'open' group by reason order by count(*) desc`);
  return {
    openReports: num(row.open_reports),
    oldestOpenReportAt: row.oldest_open ? new Date(row.oldest_open).toISOString() : null,
    reports7d: num(row.reports_7d),
    handled7d: num(row.handled_7d),
    imageFlags7d: num(row.flags_7d),
    actions24h: num(row.actions_24h),
    actions7d: num(row.actions_7d),
    waitlist: num(row.waitlist),
    openByReason: byReason.map((item) => ({ reason: item.reason, count: num(item.count) })),
  };
}

function runtime() {
  const memory = process.memoryUsage();
  const ms = (nanoseconds: number) => Math.round(nanoseconds / 1e4) / 100;
  const cores = os.availableParallelism();
  return {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    pid: process.pid,
    environment: env.NODE_ENV,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    draining: isDraining(),
    memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external },
    eventLoopMs: {
      mean: Number.isFinite(eventLoop.mean) ? ms(eventLoop.mean) : 0,
      p99: ms(eventLoop.percentile(99)),
      max: ms(eventLoop.max),
    },
    host: { cores, load: os.loadavg().map((value) => Math.round(value * 100) / 100), memoryTotal: os.totalmem(), memoryFree: os.freemem() },
    liveStreams: { open: liveStreamCount(), max: env.LIVE_MAX_STREAMS },
  };
}

const configured = () => ({
  mediaStorage: Boolean(env.R2),
  gifSearch: Boolean(env.KLIPY_API_KEY),
  webPush: Boolean(env.PUSH),
  github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  discord: Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET),
  twitch: Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET),
  steam: Boolean(env.STEAM_API_KEY),
  domainConnect: Boolean(env.DOMAIN_CONNECT_PRIVATE_KEY),
  adminOrigin: Boolean(env.ADMIN_ORIGIN),
  encryptedSessions: Boolean(env.SESSION_ENCRYPTION_KEY),
});

const router = Router();

router.get("/", async (req, res) => {
  await requireStaff(req);
  const [checks, nsfw, databaseInfo, queueInfo, communityInfo, moderationInfo] = await Promise.all([
    section(readHealthChecks),
    probeNsfw(),
    section(database),
    section(queues),
    section(community),
    section(moderation),
  ]);
  res.json({
    generatedAt: new Date().toISOString(),
    services: { ...(checks && !("error" in checks) ? checks : {}), nsfw },
    runtime: runtime(),
    configured: configured(),
    database: databaseInfo,
    queues: queueInfo,
    community: communityInfo,
    moderation: moderationInfo,
  });
});

export default router;
