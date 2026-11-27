import type { Request } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.ts";
import { feedClientEventTypes, feedSurfaces, type feedServerEventTypes } from "../db/schema.ts";
import { AuthError } from "../auth/provider.ts";
import { isTopicName, normalizeTopic } from "../topics-text.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Surface = (typeof feedSurfaces)[number];
type ServerEventType = (typeof feedServerEventTypes)[number];

export type FeedContext = { surface: Surface; position: number | null; requestId: string | null };

const surfaceSchema = z.enum(feedSurfaces);
const domainPattern = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const durationTypes = new Set(["dwell", "detail_dwell", "voice_play"]);

export function readFeedContext(req: Pick<Request, "get">): FeedContext | null {
  const header = req.get("x-feed-context");
  if (!header || header.length > 96) return null;
  const [surface, position, requestId, ...rest] = header.trim().split(" ");
  if (rest.length) return null;
  const parsed = z.object({
    surface: surfaceSchema,
    position: z.union([z.literal("-"), z.string().regex(/^\d{1,4}$/)]).optional(),
    requestId: z.union([z.literal("-"), z.uuid()]).optional(),
  }).safeParse({ surface, position, requestId });
  if (!parsed.success) return null;
  return {
    surface: parsed.data.surface,
    position: parsed.data.position && parsed.data.position !== "-" ? Number(parsed.data.position) : null,
    requestId: parsed.data.requestId && parsed.data.requestId !== "-" ? parsed.data.requestId.toLowerCase() : null,
  };
}

export async function recordFeedEvent(tx: Transaction, event: {
  userId: string;
  type: ServerEventType;
  postId?: string | null;
  authorId?: string | null;
  context?: FeedContext | null;
  detail?: string | null;
}) {
  if (event.authorId && event.authorId === event.userId) return;
  await tx.execute(sql`
    insert into feed_events (user_id, type, post_id, author_id, surface, position, request_id, detail, origin)
    select u.id, ${event.type}, ${event.postId ?? null}::uuid, ${event.authorId ?? null}::uuid,
      ${event.context?.surface ?? null}, ${event.context?.position ?? null}::smallint,
      (select fr.id from feed_requests fr where fr.id = ${event.context?.requestId ?? null}::uuid and fr.user_id = u.id),
      ${event.detail ?? null}, 'server'
    from users u where u.id = ${event.userId}::uuid and u.feed_personalize and u.feed_choice_at is not null`);
}

const clientEventSchema = z.strictObject({
  type: z.enum(feedClientEventTypes),
  postId: z.uuid().transform((id) => id.toLowerCase()).optional(),
  surface: surfaceSchema,
  position: z.number().int().min(0).max(9999).optional(),
  requestId: z.uuid().transform((id) => id.toLowerCase()).optional(),
  seq: z.number().int().min(0).max(2_147_483_647),
  value: z.number().int().min(0).max(3_600_000).optional(),
  detail: z.string().max(253).optional(),
  at: z.iso.datetime({ offset: true }),
}).superRefine((event, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (!event.postId && event.type !== "topic_open") issue("post_required");
  if (event.type === "link_open") {
    if (!event.detail || !domainPattern.test(event.detail)) issue("domain_required");
  } else if (event.type === "topic_open") {
    if (!event.detail || !isTopicName(normalizeTopic(event.detail))) issue("topic_required");
  } else if (event.detail !== undefined) issue("unexpected_detail");
  if (durationTypes.has(event.type) && event.value === undefined) issue("duration_required");
});
export const clientBatchSchema = z.strictObject({
  sessionId: z.uuid().transform((id) => id.toLowerCase()),
  client: z.enum(["mobile", "desktop"]).optional(),
  events: z.array(clientEventSchema).min(1).max(50),
});

export function clientKind(req: Pick<Request, "get">): "mobile" | "desktop" {
  const hint = req.get("sec-ch-ua-mobile");
  if (hint) return hint.trim() === "?1" ? "mobile" : "desktop";
  return /Mobi|Android|iPhone|iPad/i.test(req.get("user-agent") ?? "") ? "mobile" : "desktop";
}

export async function ingestClientEvents(userId: string, body: unknown, client: "mobile" | "desktop") {
  const parsed = clientBatchSchema.safeParse(body);
  if (!parsed.success) throw new AuthError(400, "invalid_feed_events");
  const { sessionId, events } = parsed.data;
  const records = JSON.stringify(events.map((event) => ({
    type: event.type,
    post_id: event.postId ?? null,
    surface: event.surface,
    position: event.position ?? null,
    request_id: event.requestId ?? null,
    seq: event.seq,
    value: event.value ?? null,
    detail: event.type === "topic_open" && event.detail ? normalizeTopic(event.detail) : event.detail ?? null,
    at: event.at,
  })));
  const insert = () => db.execute(sql`
    insert into feed_events (user_id, type, post_id, author_id, surface, position, request_id, session_id, seq, value, detail, client, origin, client_at)
    select ${userId}::uuid, e.type, e.post_id, p.author_id, e.surface, e.position,
      case when exists (select 1 from feed_requests fr where fr.id = e.request_id and fr.user_id = ${userId}::uuid) then e.request_id end,
      ${sessionId}::uuid,
      e.seq, e.value, e.detail, ${client}, 'client',
      case when abs(extract(epoch from (e.at - now()))) <= 86400 then e.at end
    from jsonb_array_elements(${records}::jsonb) with ordinality as item(record, n)
    cross join lateral jsonb_to_record(item.record) as e(
      type text, post_id uuid, surface text, position smallint, request_id uuid, seq int, value int, detail text, at timestamptz
    )
    left join posts p on p.id = e.post_id
    where (e.post_id is null or p.id is not null)
      and (p.author_id is null or p.author_id <> ${userId}::uuid)
      and exists (select 1 from users u where u.id = ${userId}::uuid and u.feed_personalize and u.feed_choice_at is not null)
    order by item.n
    on conflict (session_id, seq) where session_id is not null do nothing`);
  try {
    await insert();
  } catch (error) {
    if ((error as { code?: string }).code !== "23503") throw error;
    await insert();
  }
}
