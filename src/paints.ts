import { Router } from "express";
import { and, asc, eq, exists, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import { paints, userPaints, users } from "./db/schema.ts";
import { AuthError } from "./auth/provider.ts";
import { readViewerId, requireUser } from "./auth/request.ts";

// A paint is owned when it is free or was granted to the user.
function ownedBy(userId: string) {
  return or(
    eq(paints.isFree, true),
    exists(
      db
        .select({ one: sql`1` })
        .from(userPaints)
        .where(
          and(eq(userPaints.userId, userId), eq(userPaints.paintId, paints.id)),
        ),
    ),
  )!;
}

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// lists all available paints and if owned (only free paints for unauthenticated users)
router.get("/", async (req, res) => {
  const viewerId = await readViewerId(req);
  const rows = await db
    .select({
      id: paints.id,
      name: paints.name,
      definition: paints.definition,
      isFree: paints.isFree,
      owned: viewerId ? sql<boolean>`${ownedBy(viewerId)}` : paints.isFree,
    })
    .from(paints)
    .orderBy(asc(paints.sortOrder), asc(paints.name));
  res.json({ paints: rows });
});

// Set own paint
router.put("/me", async (req, res) => {
  const viewer = await requireUser(req);
  const input = z
    .strictObject({ paintId: z.uuid().nullable() })
    .safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_paint");
  const { paintId } = input.data;

  if (paintId !== null) {
    const [paint] = await db
      .select({ owned: sql<boolean>`${ownedBy(viewer.id)}` })
      .from(paints)
      .where(eq(paints.id, paintId))
      .limit(1);
    if (!paint) throw new AuthError(404, "paint_not_found");
    if (!paint.owned) throw new AuthError(403, "paint_not_owned");
  }

  const [updated] = await db
    .update(users)
    .set({ paintId, updatedAt: new Date() })
    .where(eq(users.id, viewer.id))
    .returning({ paintId: users.paintId });
  if (!updated) throw new AuthError(404, "profile_not_found");
  res.json(updated);
});

export default router;
