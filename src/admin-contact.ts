import { Router } from "express";
import { asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAdminWrite, requireStaff } from "./admin-access.ts";
import { AuthError } from "./auth/provider.ts";
import { db } from "./db/index.ts";
import { contactMessages } from "./db/schema.ts";

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

export async function openContactCount() {
  const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(contactMessages).where(isNull(contactMessages.handledAt));
  return row.total;
}

router.get("/", async (req, res) => {
  const viewer = await requireStaff(req);
  if (viewer.role !== "admin") throw new AuthError(403, "admin_required");
  const messages = await db.select({
    id: contactMessages.id,
    name: contactMessages.name,
    email: contactMessages.email,
    message: contactMessages.message,
    handledAt: contactMessages.handledAt,
    handledByHandle: contactMessages.handledByHandle,
    createdAt: contactMessages.createdAt,
  }).from(contactMessages)
    .orderBy(sql`${contactMessages.handledAt} is not null`, asc(contactMessages.handledAt), desc(contactMessages.createdAt))
    .limit(200);
  res.json({ messages });
});

const change = z.strictObject({ handled: z.boolean() });

router.patch("/:id", async (req, res) => {
  const viewer = await requireAdminWrite(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "contact_message_not_found");
  const input = change.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_contact_change");
  const updated = await db.update(contactMessages)
    .set(input.data.handled ? { handledAt: new Date(), handledByHandle: viewer.handle } : { handledAt: null, handledByHandle: null })
    .where(eq(contactMessages.id, id.data))
    .returning({ id: contactMessages.id });
  if (!updated.length) throw new AuthError(404, "contact_message_not_found");
  res.sendStatus(204);
});

router.delete("/:id", async (req, res) => {
  await requireAdminWrite(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "contact_message_not_found");
  const removed = await db.delete(contactMessages).where(eq(contactMessages.id, id.data)).returning({ id: contactMessages.id });
  if (!removed.length) throw new AuthError(404, "contact_message_not_found");
  res.sendStatus(204);
});

export default router;
