import { Router, type Response } from "express";
import { and, count, desc, asc, eq, gt, gte, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { requireStaff } from "./admin-access.ts";
import { db } from "./db/index.ts";
import { moderationActivity as activity } from "./db/schema.ts";

const handle = z.string().trim().toLowerCase().regex(/^(?:@?[a-z0-9_]{1,32})?$/);
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const filterQuery = z.object({
  q: z.string().trim().max(255).default(""),
  action: z.string().max(1000).default("")
    .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^[A-Za-z]{1,40}$/)).max(40)),
  actor: handle.default(""),
  target: handle.default(""),
  targetId: z.uuid().optional(),
  from: instant.optional(),
  to: instant.optional(),
  sort: z.enum(["newest", "oldest"]).default("newest"),
});
const listQuery = filterQuery.extend({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().refine((value) => [25, 50, 100].includes(value)).default(25),
});

function filters(input: z.infer<typeof filterQuery>): SQL | undefined {
  const term = input.q.replace(/^@/, "").toLowerCase();
  return and(
    term ? sql`strpos(lower(concat_ws(' ', ${activity.actorHandle}, ${activity.targetHandle}, ${activity.action}, ${activity.detail}, ${activity.targetId}::text)), ${term}) > 0` : undefined,
    input.action.length ? inArray(activity.action, input.action) : undefined,
    input.actor ? eq(sql`lower(${activity.actorHandle})`, input.actor.replace(/^@/, "")) : undefined,
    input.target ? eq(sql`lower(${activity.targetHandle})`, input.target.replace(/^@/, "")) : undefined,
    input.targetId ? eq(activity.targetId, input.targetId) : undefined,
    input.from ? gte(activity.createdAt, input.from) : undefined,
    input.to ? lte(activity.createdAt, input.to) : undefined,
  );
}
const order = (sort: "newest" | "oldest") =>
  sort === "newest" ? [desc(activity.createdAt), desc(activity.id)] : [asc(activity.createdAt), asc(activity.id)];

const router = Router();

router.get("/", async (req, res) => {
  await requireStaff(req);
  const input = listQuery.safeParse(req.query);
  if (!input.success) throw new AuthError(400, "invalid_activity_query");
  const { page, pageSize, sort } = input.data;
  const where = filters(input.data);
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(activity).where(where).orderBy(...order(sort)).limit(pageSize + 1).offset((page - 1) * pageSize),
    db.select({ total: count() }).from(activity).where(where),
  ]);
  res.json({ entries: rows.slice(0, pageSize), hasNextPage: rows.length > pageSize, total, pageSize });
});

router.get("/facets", async (req, res) => {
  await requireStaff(req);
  const [actions, actors, [totals], days] = await Promise.all([
    db.select({ action: activity.action, count: count() }).from(activity)
      .groupBy(activity.action).orderBy(desc(count()), asc(activity.action)),
    db.select({ id: activity.actorId, handle: sql<string>`(array_agg(${activity.actorHandle} order by ${activity.createdAt} desc))[1]`, count: count() })
      .from(activity).groupBy(activity.actorId).orderBy(desc(count())).limit(200),
    db.select({
      total: count(),
      last24h: sql<number>`count(*) filter (where ${activity.createdAt} >= now() - interval '1 day')`.mapWith(Number),
      last7d: sql<number>`count(*) filter (where ${activity.createdAt} >= now() - interval '7 days')`.mapWith(Number),
      last30d: sql<number>`count(*) filter (where ${activity.createdAt} >= now() - interval '30 days')`.mapWith(Number),
      first: sql<Date | null>`min(${activity.createdAt})`,
    }).from(activity),
    db.execute<{ day: string; count: string }>(sql`
      select to_char(d, 'YYYY-MM-DD') as day, count(a.id) as count
      from generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') d
      left join moderation_activity a on a.created_at >= d and a.created_at < d + interval '1 day'
      group by d order by d`),
  ]);
  res.json({
    actions, actors,
    totals: { ...totals, first: totals.first ? new Date(totals.first).toISOString() : null },
    byDay: days.rows.map((row) => ({ day: row.day, count: Number(row.count) })),
  });
});

// Spreadsheet apps run text starting with these as formulas; handles and details are user-controlled.
const csvCell = (value: unknown) => {
  let text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
};
const exportLimit = 100_000;
const exportBatch = 1000;
const exportColumns = ["id", "time", "action", "actor_id", "actor_handle", "target_id", "target_handle", "detail"] as const;
const flatten = (row: typeof activity.$inferSelect) => [
  row.id, row.createdAt, row.action, row.actorId, row.actorHandle, row.targetId, row.targetHandle, row.detail,
];

async function* exportRows(input: z.infer<typeof filterQuery>) {
  const where = filters(input);
  const newest = input.sort === "newest";
  let cursor: { createdAt: Date; id: string } | undefined;
  for (let sent = 0; sent < exportLimit;) {
    const after = cursor && (newest
      ? or(lt(activity.createdAt, cursor.createdAt), and(eq(activity.createdAt, cursor.createdAt), lt(activity.id, cursor.id)))
      : or(gt(activity.createdAt, cursor.createdAt), and(eq(activity.createdAt, cursor.createdAt), gt(activity.id, cursor.id))));
    const rows = await db.select().from(activity).where(and(where, after))
      .orderBy(...order(input.sort)).limit(Math.min(exportBatch, exportLimit - sent));
    if (!rows.length) return;
    yield* rows;
    sent += rows.length;
    cursor = rows.at(-1);
    if (rows.length < exportBatch) return;
  }
}

router.get("/export", async (req, res) => {
  await requireStaff(req);
  const format = z.enum(["csv", "json"]).default("csv").safeParse(req.query.format);
  const input = filterQuery.safeParse(req.query);
  if (!format.success || !input.success) throw new AuthError(400, "invalid_activity_query");
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
  res.status(200).set({
    "Content-Type": format.data === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="ysocial-activity-${stamp}.${format.data}"`,
    "X-Content-Type-Options": "nosniff",
  });
  await stream(res, format.data, input.data);
});

async function stream(res: Response, format: "csv" | "json", input: z.infer<typeof filterQuery>) {
  const write = (chunk: string) => res.write(chunk) || new Promise<void>((resolve) => res.once("drain", resolve));
  try {
    if (format === "csv") await write("\uFEFF" + exportColumns.join(",") + "\r\n");
    else await write("[");
    let first = true;
    for await (const row of exportRows(input)) {
      if (res.destroyed) return;
      if (format === "csv") await write(flatten(row).map(csvCell).join(",") + "\r\n");
      else {
        await write((first ? "\n" : ",\n") + JSON.stringify({
          id: row.id, time: row.createdAt, action: row.action, actorId: row.actorId, actorHandle: row.actorHandle,
          targetId: row.targetId, targetHandle: row.targetHandle, detail: row.detail,
        }));
        first = false;
      }
    }
    if (format === "json") await write("\n]\n");
    res.end();
  } catch (error) {
    // Headers are already sent; abort the connection so clients see a failed download, not a short file.
    console.error("Activity export failed", error);
    res.destroy();
  }
}

export default router;
