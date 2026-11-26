import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireAdminWrite, requireStaff } from "../admin-access.ts";
import { AuthError } from "../auth/provider.ts";
import { db } from "../db/index.ts";
import { csamIncidents, moderationActivity, postImageFlags } from "../db/schema.ts";
import { flushMediaDeletions, queueDeletion } from "../storage/media-lifecycle.ts";
import { avatarStorage, getAvatar } from "../storage/r2.ts";
import { recordIncident } from "./hash-match.ts";

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get("/incidents", async (req, res) => {
  const viewer = await requireStaff(req);
  if (viewer.role !== "admin") throw new AuthError(403, "admin_required");
  const incidents = await db.select({
    id: csamIncidents.id,
    userId: csamIncidents.userId,
    handle: csamIncidents.handle,
    surface: csamIncidents.surface,
    provider: csamIncidents.provider,
    matchId: csamIncidents.matchId,
    sha256: csamIncidents.sha256,
    mime: csamIncidents.mime,
    size: csamIncidents.size,
    ip: csamIncidents.ip,
    hold: csamIncidents.hold,
    reportedBkaAt: csamIncidents.reportedBkaAt,
    bkaRef: csamIncidents.bkaRef,
    reportedNcmecAt: csamIncidents.reportedNcmecAt,
    ncmecRef: csamIncidents.ncmecRef,
    note: csamIncidents.note,
    createdAt: csamIncidents.createdAt,
  }).from(csamIncidents).orderBy(desc(csamIncidents.createdAt)).limit(200);
  res.json({ incidents });
});

const reference = z.string().trim().min(1).max(200).refine((value) => !value.includes("\u0000"));
const incidentChange = z.strictObject({
  bkaRef: reference.optional(),
  ncmecRef: reference.optional(),
  hold: z.boolean().optional(),
  note: z.string().trim().max(2000).refine((value) => !value.includes("\u0000")).optional(),
});

router.patch("/incidents/:id", async (req, res) => {
  const viewer = await requireAdminWrite(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "incident_not_found");
  const input = incidentChange.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_incident_change");
  await db.transaction(async (tx) => {
    const [incident] = await tx.select().from(csamIncidents).where(eq(csamIncidents.id, id.data)).for("update");
    if (!incident) throw new AuthError(404, "incident_not_found");
    await tx.update(csamIncidents).set({
      ...(input.data.bkaRef ? { bkaRef: input.data.bkaRef, reportedBkaAt: incident.reportedBkaAt ?? new Date() } : {}),
      ...(input.data.ncmecRef ? { ncmecRef: input.data.ncmecRef, reportedNcmecAt: incident.reportedNcmecAt ?? new Date() } : {}),
      ...(input.data.hold === undefined ? {} : { hold: input.data.hold }),
      ...(input.data.note === undefined ? {} : { note: input.data.note || null }),
    }).where(eq(csamIncidents.id, incident.id));
    await tx.insert(moderationActivity).values({
      actorId: viewer.id, actorHandle: viewer.handle, targetId: incident.userId ?? incident.id,
      targetHandle: incident.handle, action: "updateSafetyIncident", detail: `Incident ${incident.id}`,
    });
  });
  res.sendStatus(204);
});

router.post("/flags/:id/suspected-csam", async (req, res) => {
  const viewer = await requireAdminWrite(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "flag_not_found");
  const [flag] = await db.select().from(postImageFlags).where(eq(postImageFlags.id, id.data));
  if (!flag) throw new AuthError(404, "flag_not_found");
  let bytes = flag.data;
  if (!bytes && flag.objectKey && avatarStorage) {
    try {
      bytes = Buffer.from(await getAvatar(flag.objectKey));
    } catch {
      bytes = null;
    }
  }
  const incident = await recordIncident({
    userId: flag.uploaderId,
    surface: "flag",
    provider: "staff_review",
    bytes: bytes ?? Buffer.alloc(0),
    mime: "image/avif",
  });
  await db.transaction(async (tx) => {
    await tx.delete(postImageFlags).where(eq(postImageFlags.id, flag.id));
    if (flag.objectKey) await queueDeletion(tx, flag.objectKey);
    await tx.insert(moderationActivity).values({
      actorId: viewer.id, actorHandle: viewer.handle, targetId: flag.uploaderId,
      targetHandle: "", action: "suspectedCsam", detail: `Incident ${incident}`,
    });
  });
  if (flag.objectKey) await flushMediaDeletions(flag.objectKey);
  res.status(201).json({ incident });
});

export default router;
