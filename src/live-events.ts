import { sql } from "drizzle-orm";
import pg from "pg";
import type { Response } from "express";
import { env } from "./config.ts";
import { db } from "./db/index.ts";

const CHANNELS = { live_posts: "post", live_changes: "change" } as const;
export const MAX_CHANGED_IDS = 100;
const HEARTBEAT_MS = 20_000;
const MAX_BUFFERED_BYTES = 64 * 1024;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type LivePost = {
  id: string;
  parentId: string | null;
  authorId: string;
  topics: string[];
  reposted?: boolean;
};

export type LiveAudience = "feed" | "waitlist" | { approvalFor: string } | { feedFor: string };
const isFeedAudience = (audience: LiveAudience) =>
  audience === "feed" || (typeof audience === "object" && "feedFor" in audience);
const streams = new Map<Response, LiveAudience>();

function write(stream: Response, frame: string) {
  if (stream.writableLength > MAX_BUFFERED_BYTES) {
    stream.destroy();
    return;
  }
  stream.write(frame);
}

function broadcast(frame: string, includes: (audience: LiveAudience) => boolean = () => true) {
  for (const [stream, audience] of streams) if (includes(audience)) write(stream, frame);
}

export function canOpenLiveStream() {
  return streams.size < env.LIVE_MAX_STREAMS;
}

export function openLiveStream(stream: Response, audience: LiveAudience = "feed") {
  streams.set(stream, audience);
  stream.on("close", () => streams.delete(stream));
}

export function closeLiveStreams() {
  for (const stream of streams.keys()) stream.end();
  streams.clear();
}

export async function publishLivePost(tx: Transaction, post: LivePost) {
  await tx.execute(
    sql`select pg_notify('live_posts', ${JSON.stringify(post)})`,
  );
}

export async function publishLiveChange(tx: Transaction, ids: string[]) {
  const unique = [...new Set(ids)].slice(0, MAX_CHANGED_IDS);
  if (!unique.length) return;
  await tx.execute(
    sql`select pg_notify('live_changes', ${JSON.stringify({ ids: unique })})`,
  );
}

export async function publishWaitlistChange(tx: Transaction, approvedUserId = "") {
  await tx.execute(sql`select pg_notify('live_waitlist', ${approvedUserId})`);
}

export async function publishAccountChange(tx: Transaction, userId: string) {
  await tx.execute(sql`select pg_notify('live_account', ${userId})`);
}

export async function affectedPostIds(tx: Transaction, id: string) {
  const { rows } = await tx.execute<{ id: string }>(sql`
    with recursive chain as (
      select id, parent_id, 0 as depth from posts where id = ${id}::uuid
      union all
      select p.id, p.parent_id, c.depth + 1
      from posts p join chain c on p.id = c.parent_id
      where c.depth < 50
    )
    select id from chain
    union
    select quoted_post_id from posts where id = ${id}::uuid and quoted_post_id is not null
    union
    (select id from posts where quoted_post_id = ${id}::uuid limit 20)
  `);
  return rows.map((row) => row.id);
}

export function startLiveEvents(dm?: {
  receive(payload: string): void;
  disconnect(userId: string): void;
  setListening(ready: boolean): void;
}) {
  let stopped = false;
  let connectedBefore = false;
  let client: pg.Client | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let delay = 500;
  const heartbeat = setInterval(() => broadcast(": ping\n\n"), HEARTBEAT_MS);
  heartbeat.unref();

  function retry() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, delay);
    retryTimer.unref();
    delay = Math.min(delay * 2, 10_000);
  }

  async function connect() {
    const next = new pg.Client({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
    client = next;
    let lost = false;
    const lose = () => {
      if (lost) return;
      lost = true;
      if (client === next) dm?.setListening(false);
      if (client === next) client = undefined;
      next.end().catch(() => {});
      retry();
    };
    next.on("notification", (message) => {
      if (message.channel === "live_waitlist") {
        broadcast("event: waitlist\ndata: {}\n\n", (audience) => audience === "waitlist");
        if (message.payload) {
          broadcast("event: approval\ndata: {}\n\n",
            (audience) => typeof audience === "object" && "approvalFor" in audience && audience.approvalFor === message.payload);
        }
        return;
      }
      if (message.channel === "live_dm") {
        if (message.payload) dm?.receive(message.payload);
        return;
      }
      if (message.channel === "live_account") {
        if (message.payload) dm?.disconnect(message.payload);
        broadcast("event: account\ndata: {}\n\n", (audience) =>
          typeof audience === "object" && (("feedFor" in audience ? audience.feedFor : audience.approvalFor) === message.payload));
        return;
      }
      const event = CHANNELS[message.channel as keyof typeof CHANNELS];
      if (event && message.payload)
        broadcast(`event: ${event}\ndata: ${message.payload}\n\n`, isFeedAudience);
    });
    next.on("error", lose);
    next.on("end", lose);
    try {
      await next.connect();
      for (const channel of Object.keys(CHANNELS))
        await next.query(`listen ${channel}`);
      await next.query("listen live_waitlist");
      await next.query("listen live_account");
      if (dm) await next.query("listen live_dm");
      if (!stopped && !lost) dm?.setListening(true);
      delay = 500;
      broadcast("event: resync\ndata: {}\n\n", (audience) => connectedBefore || !isFeedAudience(audience));
      connectedBefore = true;
      if (stopped) lose();
    } catch {
      lose();
    }
  }

  void connect();
  return () => {
    stopped = true;
    dm?.setListening(false);
    clearInterval(heartbeat);
    clearTimeout(retryTimer);
    closeLiveStreams();
    void client?.end().catch(() => {});
  };
}
