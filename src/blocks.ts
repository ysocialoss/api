import { Router } from "express";
import { and, desc, eq, or, sql, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { requireSessionUser, requireUser } from "./auth/request.ts";
import { db } from "./db/index.ts";
import { notifications, userBlocks, userFollows, users } from "./db/schema.ts";
import { userSelection } from "./user-data.ts";

type Database = Pick<typeof db, "select">;

export function notBlockedSql(viewerId: string | null, authorId: SQLWrapper) {
  if (!viewerId) return undefined;
  return sql`not exists (
    select 1 from user_blocks ub
    where (ub.blocker_id = ${viewerId} and ub.blocked_id = ${authorId})
       or (ub.blocker_id = ${authorId} and ub.blocked_id = ${viewerId})
  )`;
}

export async function blockState(database: Database, viewerId: string | null, otherId: string) {
  if (!viewerId || viewerId === otherId) return { blocking: false, blockedBy: false };
  const rows = await database.select({ blockerId: userBlocks.blockerId }).from(userBlocks).where(or(
    and(eq(userBlocks.blockerId, viewerId), eq(userBlocks.blockedId, otherId)),
    and(eq(userBlocks.blockerId, otherId), eq(userBlocks.blockedId, viewerId)),
  ));
  return {
    blocking: rows.some(({ blockerId }) => blockerId === viewerId),
    blockedBy: rows.some(({ blockerId }) => blockerId === otherId),
  };
}

export async function requireNotBlocked(database: Database, viewerId: string, otherId: string | undefined | null) {
  if (!otherId) return;
  const state = await blockState(database, viewerId, otherId);
  if (state.blocking || state.blockedBy) throw new AuthError(403, "blocked");
}

export async function blockedUserIds(viewerId: string | null) {
  if (!viewerId) return new Set<string>();
  const rows = await db.select({ blockerId: userBlocks.blockerId, blockedId: userBlocks.blockedId }).from(userBlocks)
    .where(or(eq(userBlocks.blockerId, viewerId), eq(userBlocks.blockedId, viewerId)));
  return new Set(rows.map((row) => (row.blockerId === viewerId ? row.blockedId : row.blockerId)));
}

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get("/", async (req, res) => {
  const viewer = await requireSessionUser(req);
  const rows = await db.select({ ...userSelection, blockedAt: userBlocks.createdAt }).from(userBlocks)
    .innerJoin(users, eq(users.id, userBlocks.blockedId))
    .where(eq(userBlocks.blockerId, viewer.id))
    .orderBy(desc(userBlocks.createdAt))
    .limit(500);
  res.json({ users: rows });
});

const handleSchema = z.string().toLowerCase().regex(/^[a-z0-9_]{3,32}$/);

async function setBlock(req: Parameters<typeof requireUser>[0], blocked: boolean) {
  const viewer = await requireUser(req);
  const handle = handleSchema.safeParse(req.params.handle);
  if (!handle.success) throw new AuthError(404, "profile_not_found");
  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.handle, handle.data));
  if (!target) throw new AuthError(404, "profile_not_found");
  if (target.id === viewer.id) throw new AuthError(409, "cannot_block_self");
  await db.transaction(async (tx) => {
    if (!blocked) {
      await tx.delete(userBlocks).where(and(eq(userBlocks.blockerId, viewer.id), eq(userBlocks.blockedId, target.id)));
      return;
    }
    await tx.insert(userBlocks).values({ blockerId: viewer.id, blockedId: target.id }).onConflictDoNothing();
    await tx.delete(userFollows).where(or(
      and(eq(userFollows.followerId, viewer.id), eq(userFollows.followingId, target.id)),
      and(eq(userFollows.followerId, target.id), eq(userFollows.followingId, viewer.id)),
    ));
    await tx.delete(notifications).where(and(eq(notifications.recipientId, viewer.id), eq(notifications.actorId, target.id)));
  });
  return { blocking: blocked };
}

router.put("/:handle", async (req, res) => {
  res.json(await setBlock(req, true));
});
router.delete("/:handle", async (req, res) => {
  res.json(await setBlock(req, false));
});

export default router;
