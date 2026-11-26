import { Router } from "express";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { requireStaff, requireStaffWrite } from "./admin-access.ts";
import { AuthError } from "./auth/provider.ts";
import { requireOrigin, requireSessionUser } from "./auth/request.ts";
import { db } from "./db/index.ts";
import { moderationActivity, moderationAppeals, moderationDecisions, moderationActions, posts, reports, users } from "./db/schema.ts";
import { termsClauseIds } from "./legal.ts";
import { publishAccountChange, publishLiveChange } from "./live-events.ts";
import { publishUserPostVisibility } from "./user-removal.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const appealWindowMs = 183 * 24 * 60 * 60 * 1000;

const text = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine((value) => !value.includes("\u0000"));

export const groundSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("terms"), ref: z.enum(termsClauseIds), facts: text(1, 2000) }),
  z.strictObject({ type: z.literal("illegal"), ref: text(1, 120), facts: text(1, 2000) }),
]);
export type Ground = z.infer<typeof groundSchema>;

export function splitGround(body: unknown, required: boolean) {
  const { ground, ...rest } = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (ground === undefined) {
    if (required) throw new AuthError(400, "ground_required");
    return { ground: undefined, rest };
  }
  const parsed = groundSchema.safeParse(ground);
  if (!parsed.success) throw new AuthError(400, "invalid_ground");
  return { ground: parsed.data, rest };
}

export async function recordDecision(tx: Transaction, decision: {
  userId: string;
  action: (typeof moderationActions)[number];
  targetType: "post" | "user" | "message";
  targetKey?: string | null;
  excerpt?: string;
  ground: Ground;
  automatedDetection?: boolean;
  automatedDecision?: boolean;
  reportId?: string | null;
  decidedBy?: { id: string; handle: string } | null;
}) {
  const [saved] = await tx.insert(moderationDecisions).values({
    userId: decision.userId,
    action: decision.action,
    targetType: decision.targetType,
    targetKey: decision.targetKey ?? null,
    excerpt: (decision.excerpt ?? "").slice(0, 300),
    groundType: decision.ground.type,
    groundRef: decision.ground.ref,
    facts: decision.ground.facts,
    automatedDetection: decision.automatedDetection ?? false,
    automatedDecision: decision.automatedDecision ?? false,
    reportId: decision.reportId ?? null,
    decidedById: decision.decidedBy?.id ?? null,
    decidedByHandle: decision.decidedBy?.handle ?? null,
  }).returning({ id: moderationDecisions.id });
  await publishAccountChange(tx, decision.userId);
  return saved.id;
}

const decisionFields = {
  id: moderationDecisions.id,
  action: moderationDecisions.action,
  targetType: moderationDecisions.targetType,
  targetKey: moderationDecisions.targetKey,
  excerpt: moderationDecisions.excerpt,
  groundType: moderationDecisions.groundType,
  groundRef: moderationDecisions.groundRef,
  facts: moderationDecisions.facts,
  automatedDetection: moderationDecisions.automatedDetection,
  automatedDecision: moderationDecisions.automatedDecision,
  fromReport: sql<boolean>`moderation_decisions.report_id is not null`,
  seenAt: moderationDecisions.seenAt,
  reversedAt: moderationDecisions.reversedAt,
  createdAt: moderationDecisions.createdAt,
  appeal: sql<{ id: string; text: string; status: string; staffNote: string | null; resolvedAt: string | null; createdAt: string } | null>`(
    select json_build_object('id', a.id, 'text', a.text, 'status', a.status, 'staffNote', a.staff_note,
      'resolvedAt', a.resolved_at, 'createdAt', a.created_at, 'seenAt', a.seen_at)
    from moderation_appeals a where a.decision_id = moderation_decisions.id)`,
};

function withDeadline<T extends { createdAt: Date }>(decision: T) {
  const deadline = new Date(decision.createdAt.getTime() + appealWindowMs);
  return { ...decision, appealDeadline: deadline.toISOString(), canAppeal: Date.now() < deadline.getTime() };
}

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get("/notices", async (req, res) => {
  const user = await requireSessionUser(req);
  const decisions = await db.select(decisionFields).from(moderationDecisions)
    .where(eq(moderationDecisions.userId, user.id)).orderBy(desc(moderationDecisions.createdAt)).limit(100);
  const reportUpdates = await db.select({
    id: reports.id,
    targetType: reports.targetType,
    targetHandle: reports.targetHandle,
    reason: reports.reason,
    status: reports.status,
    actionTaken: sql<boolean>`${reports.status} = 'resolved' and ${reports.resolution} <> 'resolved without action'`,
    resolvedAt: reports.resolvedAt,
    seenAt: reports.reporterSeenAt,
    createdAt: reports.createdAt,
  }).from(reports).where(and(eq(reports.reporterId, user.id), ne(reports.status, "open")))
    .orderBy(desc(reports.resolvedAt)).limit(100);
  const unseen = decisions.filter((decision) => !decision.seenAt).length
    + decisions.filter((decision) => decision.appeal?.resolvedAt && !(decision.appeal as { seenAt?: string | null }).seenAt).length
    + reportUpdates.filter((update) => !update.seenAt).length;
  res.json({ decisions: decisions.map(withDeadline), reportUpdates, unseen });
});

router.post("/notices/seen", async (req, res) => {
  requireOrigin(req);
  const user = await requireSessionUser(req);
  await db.transaction(async (tx) => {
    await tx.update(moderationDecisions).set({ seenAt: sql`now()` })
      .where(and(eq(moderationDecisions.userId, user.id), isNull(moderationDecisions.seenAt)));
    await tx.update(moderationAppeals).set({ seenAt: sql`now()` })
      .where(and(eq(moderationAppeals.userId, user.id), isNull(moderationAppeals.seenAt), ne(moderationAppeals.status, "open")));
    await tx.update(reports).set({ reporterSeenAt: sql`now()` })
      .where(and(eq(reports.reporterId, user.id), isNull(reports.reporterSeenAt), ne(reports.status, "open")));
    await publishAccountChange(tx, user.id);
  });
  res.sendStatus(204);
});

router.get("/decisions/:id", async (req, res) => {
  const user = await requireSessionUser(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "decision_not_found");
  const [decision] = await db.select(decisionFields).from(moderationDecisions)
    .where(and(eq(moderationDecisions.id, id.data), eq(moderationDecisions.userId, user.id)));
  if (!decision) throw new AuthError(404, "decision_not_found");
  res.json(withDeadline(decision));
});

const appealInput = z.strictObject({ text: text(10, 2000) });
router.post("/decisions/:id/appeal", async (req, res) => {
  requireOrigin(req);
  const user = await requireSessionUser(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "decision_not_found");
  const input = appealInput.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_appeal");
  const appeal = await db.transaction(async (tx) => {
    const [decision] = await tx.select({ id: moderationDecisions.id, createdAt: moderationDecisions.createdAt, reversedAt: moderationDecisions.reversedAt })
      .from(moderationDecisions)
      .where(and(eq(moderationDecisions.id, id.data), eq(moderationDecisions.userId, user.id))).for("update");
    if (!decision) throw new AuthError(404, "decision_not_found");
    if (decision.reversedAt) throw new AuthError(409, "decision_reversed");
    if (Date.now() - decision.createdAt.getTime() > appealWindowMs) throw new AuthError(409, "appeal_window_closed");
    const [saved] = await tx.insert(moderationAppeals).values({ decisionId: decision.id, userId: user.id, text: input.data.text })
      .onConflictDoNothing().returning({ id: moderationAppeals.id, status: moderationAppeals.status, createdAt: moderationAppeals.createdAt });
    if (!saved) throw new AuthError(409, "already_appealed");
    return saved;
  });
  res.status(201).json(appeal);
});

export const userModeration = router;

const admin = Router();

const appealQueue = z.object({ status: z.enum(["open", "upheld", "reversed", "all"]).default("open") });
admin.get("/", async (req, res) => {
  await requireStaff(req);
  const query = appealQueue.safeParse(req.query);
  if (!query.success) throw new AuthError(400, "invalid_query");
  const rows = await db.select({
    id: moderationAppeals.id,
    text: moderationAppeals.text,
    status: moderationAppeals.status,
    staffNote: moderationAppeals.staffNote,
    resolvedByHandle: moderationAppeals.resolvedByHandle,
    resolvedAt: moderationAppeals.resolvedAt,
    createdAt: moderationAppeals.createdAt,
    userHandle: users.handle,
    decision: {
      id: moderationDecisions.id,
      action: moderationDecisions.action,
      targetType: moderationDecisions.targetType,
      targetKey: moderationDecisions.targetKey,
      excerpt: moderationDecisions.excerpt,
      groundType: moderationDecisions.groundType,
      groundRef: moderationDecisions.groundRef,
      facts: moderationDecisions.facts,
      decidedByHandle: moderationDecisions.decidedByHandle,
      decidedById: moderationDecisions.decidedById,
      automatedDecision: moderationDecisions.automatedDecision,
      createdAt: moderationDecisions.createdAt,
    },
  }).from(moderationAppeals)
    .innerJoin(moderationDecisions, eq(moderationDecisions.id, moderationAppeals.decisionId))
    .innerJoin(users, eq(users.id, moderationAppeals.userId))
    .where(query.data.status === "all" ? undefined : eq(moderationAppeals.status, query.data.status))
    .orderBy(moderationAppeals.createdAt).limit(200);
  res.json({ appeals: rows });
});

const appealResolution = z.strictObject({
  outcome: z.enum(["upheld", "reversed"]),
  note: text(1, 2000),
});
admin.post("/:id/resolve", async (req, res) => {
  const viewer = await requireStaffWrite(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "appeal_not_found");
  const input = appealResolution.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_appeal_resolution");
  await db.transaction(async (tx) => {
    const [appeal] = await tx.select().from(moderationAppeals).where(eq(moderationAppeals.id, id.data)).for("update");
    if (!appeal) throw new AuthError(404, "appeal_not_found");
    if (appeal.status !== "open") throw new AuthError(409, "appeal_closed");
    const [decision] = await tx.select().from(moderationDecisions).where(eq(moderationDecisions.id, appeal.decisionId)).for("update");
    if (!decision) throw new AuthError(404, "decision_not_found");
    if (decision.decidedById === viewer.id && viewer.role !== "admin")
      throw new AuthError(409, "independent_review_required");
    const [subject] = await tx.select({ id: users.id, handle: users.handle, role: users.role }).from(users)
      .where(eq(users.id, decision.userId)).for("update");
    if (input.data.outcome === "reversed") {
      if ((decision.action === "ban" || decision.action === "clear_profile" || decision.action === "edit_profile") && viewer.role !== "admin")
        throw new AuthError(403, "admin_required");
      if (decision.action === "hide_post" && decision.targetKey) {
        const restored = await tx.update(posts).set({ hiddenAt: null }).where(eq(posts.id, decision.targetKey)).returning({ id: posts.id });
        if (restored.length) await publishLiveChange(tx, [decision.targetKey]);
      }
      if (decision.action === "ban" && subject) {
        await tx.update(users).set({ bannedAt: null, banReason: null }).where(eq(users.id, subject.id));
        await publishUserPostVisibility(tx, subject.id);
      }
      await tx.update(moderationDecisions).set({ reversedAt: sql`now()` }).where(eq(moderationDecisions.id, decision.id));
    }
    await tx.update(moderationAppeals).set({
      status: input.data.outcome,
      staffNote: input.data.note,
      resolvedById: viewer.id,
      resolvedByHandle: viewer.handle,
      resolvedAt: new Date(),
    }).where(eq(moderationAppeals.id, appeal.id));
    await tx.insert(moderationActivity).values({
      actorId: viewer.id, actorHandle: viewer.handle, targetId: decision.userId, targetHandle: subject?.handle ?? "",
      action: input.data.outcome === "reversed" ? "reverseDecision" : "upholdDecision",
      detail: `Appeal ${appeal.id}: ${input.data.note}`,
    });
    if (subject) await publishAccountChange(tx, subject.id);
  });
  res.sendStatus(204);
});

export const adminAppeals = admin;

export async function openAppealCount() {
  const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(moderationAppeals).where(eq(moderationAppeals.status, "open"));
  return row.total;
}
