import { Router } from "express";
import { and, asc, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { requireStaff, requireStaffWrite } from "./admin-access.ts";
import { AuthError } from "./auth/provider.ts";
import { db } from "./db/index.ts";
import { dmConversations, dmMessages, moderationActivity, posts, reports, users } from "./db/schema.ts";
import { eraseDmMessage } from "./dm-removal.ts";
import { publishAccountChange, publishWaitlistChange } from "./live-events.ts";
import { removePost } from "./post-removal.ts";
import { reportReasons } from "./reports.ts";
import { clearProfileMedia, flushMediaDeletions } from "./storage/media-lifecycle.ts";
import { publishUserPostVisibility } from "./user-removal.ts";

const router = Router();
const pageSize = 25;

export async function openReportCount() {
  const since = new Date(Date.now() - 86_400_000);
  const [row] = await db.select({
    total: count(),
    today: sql<number>`count(*) filter (where ${reports.createdAt} >= ${since.toISOString()})`.mapWith(Number),
  }).from(reports).where(eq(reports.status, "open"));
  return row;
}

const targetReportCount = sql<number>`(select count(*)::int from reports same_target
  where same_target.target_type = reports.target_type and same_target.target_key = reports.target_key
  and same_target.status = 'open')`;
const reportFields = {
  id: reports.id,
  reporterId: reports.reporterId,
  reporterHandle: reports.reporterHandle,
  targetType: reports.targetType,
  targetKey: reports.targetKey,
  targetUserId: reports.targetUserId,
  targetHandle: reports.targetHandle,
  reason: reports.reason,
  details: reports.details,
  snapshot: reports.snapshot,
  status: reports.status,
  resolution: reports.resolution,
  note: reports.note,
  resolvedByHandle: reports.resolvedByHandle,
  resolvedAt: reports.resolvedAt,
  createdAt: reports.createdAt,
  openOnTarget: targetReportCount,
};

function canRemoveReportedContent(viewer: Pick<typeof users.$inferSelect, "id" | "role">,
  report: Pick<typeof reports.$inferSelect, "targetType" | "reporterId" | "status">) {
  return report.status === "open" && (viewer.role === "admin" ? report.targetType !== "user"
    : report.targetType === "post" && report.reporterId !== null && report.reporterId !== viewer.id);
}

const listQuery = z.object({
  status: z.enum(["open", "resolved", "dismissed", "all"]).default("open"),
  type: z.enum(["all", "post", "user", "message"]).default("all"),
  reason: z.enum(["all", ...reportReasons]).default("all"),
  sort: z.enum(["newest", "oldest", "most_reported"]).default("newest"),
  targetUserId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
});

router.get("/", async (req, res) => {
  const viewer = await requireStaff(req);
  const input = listQuery.safeParse(req.query);
  if (!input.success) throw new AuthError(400, "invalid_report_query");
  const { status, type, reason, sort, targetUserId, page } = input.data;
  const order = sort === "oldest" ? [asc(reports.createdAt), asc(reports.id)]
    : sort === "most_reported" ? [desc(targetReportCount), desc(reports.createdAt), desc(reports.id)]
    : [desc(reports.createdAt), desc(reports.id)];
  const rows = await db.select(reportFields).from(reports)
    .where(and(
      status === "all" ? undefined : eq(reports.status, status),
      type === "all" ? undefined : eq(reports.targetType, type),
      reason === "all" ? undefined : eq(reports.reason, reason),
      targetUserId ? eq(reports.targetUserId, targetUserId) : undefined,
    ))
    .orderBy(...order)
    .limit(pageSize + 1).offset((page - 1) * pageSize);
  res.json({
    reports: rows.slice(0, pageSize),
    hasNextPage: rows.length > pageSize,
    canResolve: true,
    canAct: viewer.role === "admin",
  });
});

router.get("/summary", async (req, res) => {
  await requireStaff(req);
  const open = await openReportCount();
  res.json({ open: open.total });
});

async function targetState(report: { targetType: string; targetKey: string; targetUserId: string | null; conversationId: string | null }) {
  const [owner] = report.targetUserId
    ? await db.select({ id: users.id, handle: users.handle, role: users.role, bannedAt: users.bannedAt, banReason: users.banReason })
      .from(users).where(eq(users.id, report.targetUserId))
    : [];
  const [history] = report.targetUserId
    ? await db.select({
      total: count(),
      actioned: sql<number>`count(*) filter (where ${reports.status} = 'resolved')`.mapWith(Number),
    }).from(reports).where(eq(reports.targetUserId, report.targetUserId))
    : [{ total: 0, actioned: 0 }];
  let exists = false;
  if (report.targetType === "post") {
    exists = (await db.select({ id: posts.id }).from(posts).where(eq(posts.id, report.targetKey))).length > 0;
  } else if (report.targetType === "user") {
    exists = Boolean(owner);
  } else if (report.conversationId) {
    exists = (await db.select({ id: dmMessages.id }).from(dmMessages).where(and(
      eq(dmMessages.id, report.targetKey), eq(dmMessages.conversationId, report.conversationId), isNull(dmMessages.deletedAt),
    ))).length > 0;
  }
  return {
    exists,
    owner: owner ? { ...owner, bannedAt: owner.bannedAt?.toISOString() ?? null } : null,
    ownerReports: history,
  };
}

router.get("/:id", async (req, res) => {
  const viewer = await requireStaff(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "report_not_found");
  const [report] = await db.select({ ...reportFields, conversationId: reports.conversationId })
    .from(reports).where(eq(reports.id, id.data));
  if (!report) throw new AuthError(404, "report_not_found");
  const related = await db.select({
    id: reports.id, reporterHandle: reports.reporterHandle, reporterId: reports.reporterId,
    reason: reports.reason, details: reports.details, status: reports.status, createdAt: reports.createdAt,
  }).from(reports).where(and(
    eq(reports.targetType, report.targetType), eq(reports.targetKey, report.targetKey), ne(reports.id, report.id),
  )).orderBy(desc(reports.createdAt)).limit(50);
  const state = await targetState(report);
  const { conversationId: _conversationId, ...visible } = report;
  res.json({
    ...visible,
    related,
    target: state,
    canResolve: true,
    canAct: viewer.role === "admin",
    canRemoveContent: state.exists && canRemoveReportedContent(viewer, report),
    canBan: viewer.role === "admin" && Boolean(state.owner) && state.owner?.id !== viewer.id && !state.owner?.bannedAt,
  });
});

const profileParts = ["bio", "avatar", "banner", "name"] as const;
const resolution = z.strictObject({
  decision: z.enum(["resolve", "dismiss"]),
  note: z.string().trim().max(1000).refine((value) => !value.includes("\u0000")).default(""),
  removeContent: z.boolean().default(false),
  clearProfile: z.array(z.enum(profileParts)).max(profileParts.length).default([]),
  ban: z.strictObject({ reason: z.string().trim().min(1).max(280).refine((value) => !value.includes("\u0000")) }).optional(),
});

router.post("/:id/resolve", async (req, res) => {
  const viewer = await requireStaffWrite(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "report_not_found");
  const input = resolution.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_report_resolution");
  const change = input.data;
  const accountAction = change.clearProfile.length > 0 || Boolean(change.ban);
  if (change.decision === "dismiss" && (change.removeContent || accountAction)) throw new AuthError(400, "invalid_report_resolution");
  if (accountAction && viewer.role !== "admin") throw new AuthError(403, "admin_required");

  const mediaKeys = await db.transaction(async (tx) => {
    const [selected] = await tx.select({ id: reports.id, targetType: reports.targetType, targetKey: reports.targetKey })
      .from(reports).where(eq(reports.id, id.data));
    if (!selected) throw new AuthError(404, "report_not_found");
    const openTarget = and(eq(reports.targetType, selected.targetType), eq(reports.targetKey, selected.targetKey), eq(reports.status, "open"));
    // Resolution closes every open report for the target. Lock them in the same order for every selected report.
    const openReports = await tx.select().from(reports).where(openTarget).orderBy(reports.id).for("update");
    const report = openReports.find((row) => row.id === selected.id);
    if (!report) throw new AuthError(409, "report_closed");
    if (change.clearProfile.length && report.targetType !== "user") throw new AuthError(400, "invalid_report_resolution");
    if (change.removeContent && report.targetType === "user") throw new AuthError(400, "invalid_report_resolution");

    const lockIds = [...new Set([viewer.id, ...(report.targetUserId ? [report.targetUserId] : [])])];
    const locked = await tx.select({
      id: users.id, role: users.role, handle: users.handle, bannedAt: users.bannedAt, approvedAt: users.approvedAt,
      avatarKey: users.avatarKey, bannerKey: users.bannerKey,
    }).from(users).where(inArray(users.id, lockIds)).orderBy(users.id).for("update");
    const actor = locked.find((user) => user.id === viewer.id);
    if (!actor?.approvedAt || actor.bannedAt || (actor.role !== "admin" && actor.role !== "moderator"))
      throw new AuthError(403, "staff_required");
    if (accountAction && actor.role !== "admin") throw new AuthError(403, "admin_required");
    if (change.removeContent && !canRemoveReportedContent(actor, report))
      throw new AuthError(403, report.targetType === "post" ? "independent_post_report_required" : "admin_required");
    const owner = locked.find((user) => user.id === report.targetUserId);

    const actions: string[] = [];
    const keys: string[] = [];
    const log = (action: string, targetId: string, detail: string | null = null) => tx.insert(moderationActivity).values({
      actorId: actor.id, actorHandle: actor.handle, targetId, targetHandle: report.targetHandle, action, detail,
    });

    if (change.removeContent && report.targetType === "post") {
      const removed = await removePost(tx, report.targetKey, { keepReplies: actor.role === "moderator" });
      if (removed) {
        if (removed.voice) keys.push(removed.voice.key);
        actions.push("removed content");
        await log("removePost", report.targetKey, `Report ${report.id}`);
      }
    }
    if (change.removeContent && report.targetType === "message" && report.conversationId) {
      const [conversation] = await tx.select().from(dmConversations).where(eq(dmConversations.id, report.conversationId));
      if (conversation && await eraseDmMessage(tx, conversation.id, report.targetKey,
        [conversation.firstUserId, conversation.secondUserId])) {
        actions.push("removed message");
        await log("removeMessage", report.targetUserId ?? report.targetKey, `Report ${report.id}`);
      }
    }
    if (change.clearProfile.length) {
      if (!owner) throw new AuthError(404, "user_not_found");
      for (const part of change.clearProfile) {
        if (part === "avatar" || part === "banner") await clearProfileMedia(tx, owner, part);
        else await tx.update(users).set({ ...(part === "bio" ? { bio: "" } : { displayName: "" }), updatedAt: new Date() })
          .where(eq(users.id, owner.id));
        await log({ bio: "clearBio", avatar: "clearAvatar", banner: "clearBanner", name: "clearName" }[part], owner.id);
      }
      actions.push(`cleared ${change.clearProfile.join(", ")}`);
    }
    if (change.ban) {
      if (!owner) throw new AuthError(404, "user_not_found");
      if (owner.id === actor.id) throw new AuthError(409, "protected_account");
      if (!owner.bannedAt) {
        await tx.update(users).set({ bannedAt: new Date(), banReason: change.ban.reason }).where(eq(users.id, owner.id));
        await log("banUser", owner.id, change.ban.reason);
        await publishAccountChange(tx, owner.id);
        await publishUserPostVisibility(tx, owner.id);
        if (!owner.approvedAt) await publishWaitlistChange(tx);
        actions.push("banned user");
      }
    }

    const summary = change.decision === "dismiss" ? "dismissed" : actions.length ? actions.join("; ") : "resolved without action";
    const closed = await tx.update(reports).set({
      status: change.decision === "dismiss" ? "dismissed" : "resolved",
      resolution: summary,
      note: change.note || null,
      resolvedById: actor.id,
      resolvedByHandle: actor.handle,
      resolvedAt: new Date(),
    }).where(openTarget).returning({ id: reports.id });
    await log(change.decision === "dismiss" ? "dismissReport" : "resolveReport", report.targetUserId ?? report.targetKey,
      `${closed.length} report${closed.length === 1 ? "" : "s"}: ${summary}${change.note ? ` (${change.note})` : ""}`);
    return keys;
  });
  for (const key of mediaKeys) await flushMediaDeletions(key);
  res.sendStatus(204);
});

router.post("/:id/reopen", async (req, res) => {
  const viewer = await requireStaffWrite(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "report_not_found");
  await db.transaction(async (tx) => {
    const [report] = await tx.select().from(reports).where(eq(reports.id, id.data)).for("update");
    if (!report) throw new AuthError(404, "report_not_found");
    if (report.status === "open") return;
    const [existing] = await tx.select({ id: reports.id }).from(reports).where(and(
      eq(reports.targetType, report.targetType), eq(reports.targetKey, report.targetKey), eq(reports.status, "open"),
      report.reporterId ? eq(reports.reporterId, report.reporterId) : sql`false`,
    ));
    if (existing) throw new AuthError(409, "report_already_open");
    await tx.update(reports).set({
      status: "open", resolution: null, note: null, resolvedById: null, resolvedByHandle: null, resolvedAt: null,
    }).where(eq(reports.id, report.id));
    await tx.insert(moderationActivity).values({
      actorId: viewer.id, actorHandle: viewer.handle, targetId: report.targetUserId ?? report.targetKey,
      targetHandle: report.targetHandle, action: "reopenReport", detail: `Report ${report.id}`,
    });
  });
  res.sendStatus(204);
});

export default router;
