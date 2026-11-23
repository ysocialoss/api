import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { env } from "./config.ts";
import { db } from "./db/index.ts";
import { connections, users } from "./db/schema.ts";

const CACHE_MS = 60_000;
const checked = new Map<string, { at: number; live: boolean }>();
let appToken: { value: string; expiresAt: number } | undefined;

const enabled = () => Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);

async function token(force = false) {
  if (!force && appToken && appToken.expiresAt > Date.now() + 60_000) return appToken.value;
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID ?? "",
      client_secret: env.TWITCH_CLIENT_SECRET ?? "",
      grant_type: "client_credentials",
    }),
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("twitch_token_failed");
  const data = z.object({ access_token: z.string().min(1), expires_in: z.number() }).parse(await response.json());
  appToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return appToken.value;
}

async function fetchLive(ids: string[], retry = true): Promise<Set<string>> {
  const url = new URL("https://api.twitch.tv/helix/streams");
  for (const id of ids) url.searchParams.append("user_id", id);
  url.searchParams.set("first", "100");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${await token(!retry)}`, "Client-Id": env.TWITCH_CLIENT_ID ?? "" },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 401 && retry) {
    appToken = undefined;
    return fetchLive(ids, false);
  }
  if (!response.ok) throw new Error("twitch_streams_failed");
  const data = z.object({ data: z.array(z.object({ user_id: z.string(), type: z.string() })) }).parse(await response.json());
  return new Set(data.data.filter((stream) => stream.type === "live").map((stream) => stream.user_id));
}

export async function liveTwitchStreams(handles: string[]) {
  if (!enabled() || handles.length === 0) return {} as Record<string, { login: string }>;
  const rows = await db
    .select({ handle: users.handle, externalId: connections.externalId, login: connections.username })
    .from(connections)
    .innerJoin(users, eq(users.id, connections.userId))
    .where(and(eq(connections.provider, "twitch"), eq(connections.displayOnProfile, true), inArray(users.handle, handles)));
  const stale = rows.filter((row) => {
    const hit = checked.get(row.externalId);
    return !hit || Date.now() - hit.at > CACHE_MS;
  });
  for (let offset = 0; offset < stale.length; offset += 100) {
    const batch = stale.slice(offset, offset + 100);
    try {
      const live = await fetchLive(batch.map((row) => row.externalId));
      for (const row of batch) checked.set(row.externalId, { at: Date.now(), live: live.has(row.externalId) });
    } catch {
      for (const row of batch) checked.set(row.externalId, { at: Date.now() - CACHE_MS + 10_000, live: checked.get(row.externalId)?.live ?? false });
    }
  }
  if (checked.size > 5000) checked.clear();
  const result: Record<string, { login: string }> = {};
  for (const row of rows) if (checked.get(row.externalId)?.live) result[row.handle] = { login: row.login };
  return result;
}
