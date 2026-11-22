import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { cookie } from "./auth/request.ts";
import { readSession } from "./auth/session.ts";
import { env } from "./config.ts";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import { dmConversations } from "./db/schema.ts";
import { dmEvent, publishTyping } from "./dm-events.ts";

const clientFrame = z.strictObject({ type: z.literal("typing"), id: z.uuid() });
const TYPING_INTERVAL_MS = 2000;

const HEARTBEAT_MS = 20_000;
const SESSION_RECHECK_MS = 5 * 60_000;
const MAX_ACCOUNT_CONNECTIONS = 12;
const MAX_PENDING_UPGRADES = 100;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function attachDmSocket(server: Server) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const accounts = new Map<string, Set<WebSocket>>();
  const connections = new Map<WebSocket, { alive: boolean; expires: number; typingAt: number; typing: Map<string, string | null> }>();
  const upgrades = new Set<Duplex>();
  let listening = false;

  function reject(socket: Duplex, status: string) {
    if (!socket.destroyed) socket.end("HTTP/1.1 " + status + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  }

  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => socket.destroy());
    if (request.url !== "/api/dms/live" || request.headers.upgrade?.toLowerCase() !== "websocket")
      return reject(socket, "404 Not Found");
    if (request.headers.origin !== env.APP_ORIGIN) return reject(socket, "403 Forbidden");
    const token = cookie(request, "session");
    if (!token) return reject(socket, "401 Unauthorized");
    if (!listening || connections.size >= env.LIVE_MAX_STREAMS || upgrades.size >= MAX_PENDING_UPGRADES)
      return reject(socket, "503 Service Unavailable");

    upgrades.add(socket);
    const timeout = setTimeout(() => socket.destroy(), 5000);
    try {
      const session = await readSession(token);
      const user = session.kind === "authenticated" ? session.user : null;
      if (!user?.approvedAt || user.bannedAt) return reject(socket, "403 Forbidden");
      if (socket.destroyed) return;
      const account = accounts.get(user.id) ?? new Set<WebSocket>();
      if (!listening || connections.size >= env.LIVE_MAX_STREAMS || account.size >= MAX_ACCOUNT_CONNECTIONS)
        return reject(socket, "503 Service Unavailable");
      sockets.handleUpgrade(request, socket, head, (client) => {
        const state = { alive: true, expires: Date.now() + SESSION_RECHECK_MS, typingAt: 0, typing: new Map<string, string | null>() };
        connections.set(client, state);
        account.add(client);
        accounts.set(user.id, account);
        client.on("pong", () => { state.alive = true; });
        client.on("error", () => client.terminate());
        client.on("message", (data, isBinary) => {
          const frame = isBinary ? undefined : clientFrame.safeParse(safeJson(data.toString()));
          if (!frame?.success) return client.close(1008);
          const now = Date.now();
          if (now - state.typingAt < TYPING_INTERVAL_MS) return;
          state.typingAt = now;
          void typing(user.id, frame.data.id, state);
        });
        client.on("close", () => {
          connections.delete(client);
          account.delete(client);
          if (!account.size) accounts.delete(user.id);
        });
        client.send(JSON.stringify({ type: "ready" }));
      });
    } catch {
      reject(socket, "503 Service Unavailable");
    } finally {
      clearTimeout(timeout);
      upgrades.delete(socket);
    }
  }

  async function typing(userId: string, conversationId: string, state: { typing: Map<string, string | null> }) {
    try {
      let peerId = state.typing.get(conversationId);
      if (peerId === undefined) {
        const [conversation] = await db.select().from(dmConversations).where(and(
          eq(dmConversations.id, conversationId),
          or(eq(dmConversations.firstUserId, userId), eq(dmConversations.secondUserId, userId)),
          eq(dmConversations.inviteStatus, "accepted"),
        ));
        peerId = conversation ? (conversation.firstUserId === userId ? conversation.secondUserId : conversation.firstUserId) : null;
        if (state.typing.size < 64) state.typing.set(conversationId, peerId);
      }
      if (peerId) await publishTyping(db, peerId, conversationId, userId);
    } catch {}
  }

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [client, state] of connections) {
      if (!state.alive || client.bufferedAmount > 64 * 1024) client.terminate();
      else if (client.readyState === WebSocket.OPEN) {
        if (state.expires <= now) client.close(1000, "Reconnect");
        else {
          state.alive = false;
          client.ping();
        }
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  server.on("upgrade", upgrade);

  return {
    receive(payload: string) {
      try {
        const { userId, change } = dmEvent.parse(JSON.parse(payload));
        const frame = JSON.stringify(change);
        for (const client of accounts.get(userId) ?? []) {
          if (client.bufferedAmount > 64 * 1024) client.terminate();
          else if (client.readyState === WebSocket.OPEN) client.send(frame);
        }
      } catch {
        // Ignore malformed database events.
      }
    },
    disconnect(userId: string) {
      for (const client of accounts.get(userId) ?? []) client.terminate();
    },
    setListening(ready: boolean) {
      listening = ready;
      if (!ready) for (const client of connections.keys()) client.close(1013);
    },
    stop() {
      listening = false;
      clearInterval(heartbeat);
      server.off("upgrade", upgrade);
      for (const socket of upgrades) socket.destroy();
      for (const client of connections.keys()) client.terminate();
      sockets.close();
    },
  };
}
