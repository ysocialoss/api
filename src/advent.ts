import { Router } from "express";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { requireApprovedUser, requireUser } from "./auth/request.ts";
import { db } from "./db/index.ts";
import { adventDoors, adventRewards } from "./db/schema.ts";

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const HOUR = 3_600_000;
export const EVE_DAY = 24;
export const rewardDays = [1, 7, 14, EVE_DAY];

export function doorIsOpenable(year: number, day: number, at: Date) {
  const start = Date.UTC(year, 11, day) - 14 * HOUR;
  const end = Date.UTC(year, 11, day + 1) + 12 * HOUR;
  return at.getTime() >= start && at.getTime() < end;
}

const yearSchema = z.coerce.number().int().min(2000).max(9999);
const daySchema = z.coerce.number().int().min(1).max(24);

const openedDays = async (userId: string, year: number) =>
  (await db
    .select({ day: adventDoors.day })
    .from(adventDoors)
    .where(and(eq(adventDoors.userId, userId), eq(adventDoors.year, year)))
    .orderBy(asc(adventDoors.day))).map((row) => row.day);

const rewardsOf = (userId: string) =>
  db
    .select({
      year: adventRewards.year,
      day: adventRewards.day,
      enabled: adventRewards.enabled,
      doorsOpened: adventRewards.doorsOpened,
    })
    .from(adventRewards)
    .where(eq(adventRewards.userId, userId))
    .orderBy(asc(adventRewards.year), asc(adventRewards.day));

router.get("/rewards", async (req, res) => {
  const user = await requireApprovedUser(req);
  res.json({ rewards: await rewardsOf(user.id) });
});

router.put("/rewards/:year/:day", async (req, res) => {
  const user = await requireUser(req);
  const year = yearSchema.safeParse(req.params.year);
  const day = daySchema.safeParse(req.params.day);
  const body = z.strictObject({ enabled: z.boolean() }).safeParse(req.body);
  if (!year.success || !day.success || !body.success || !rewardDays.includes(day.data)) {
    throw new AuthError(400, "invalid_advent_door");
  }
  const updated = await db
    .update(adventRewards)
    .set({ enabled: body.data.enabled })
    .where(and(eq(adventRewards.userId, user.id), eq(adventRewards.year, year.data), eq(adventRewards.day, day.data)))
    .returning({ day: adventRewards.day });
  if (updated.length === 0) throw new AuthError(404, "advent_reward_not_found");
  res.json({ rewards: await rewardsOf(user.id) });
});

router.get("/:year", async (req, res) => {
  const user = await requireApprovedUser(req);
  const year = yearSchema.safeParse(req.params.year);
  if (!year.success) throw new AuthError(400, "invalid_advent_door");
  res.json({ year: year.data, opened: await openedDays(user.id, year.data) });
});

router.post("/:year/:day", async (req, res) => {
  const user = await requireUser(req);
  const year = yearSchema.safeParse(req.params.year);
  const day = daySchema.safeParse(req.params.day);
  if (!year.success || !day.success) throw new AuthError(400, "invalid_advent_door");
  if (!doorIsOpenable(year.data, day.data, new Date())) throw new AuthError(409, "advent_door_closed");
  await db.transaction(async (tx) => {
    await tx
      .insert(adventDoors)
      .values({ userId: user.id, year: year.data, day: day.data })
      .onConflictDoNothing();
    if (day.data === EVE_DAY) {
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(adventDoors)
        .where(and(eq(adventDoors.userId, user.id), eq(adventDoors.year, year.data), lt(adventDoors.day, EVE_DAY)));
      await tx
        .insert(adventRewards)
        .values({ userId: user.id, year: year.data, day: EVE_DAY, enabled: true, doorsOpened: count })
        .onConflictDoNothing();
    } else if (rewardDays.includes(day.data)) {
      await tx
        .insert(adventRewards)
        .values({ userId: user.id, year: year.data, day: day.data })
        .onConflictDoNothing();
    }
  });
  res.json({ year: year.data, opened: await openedDays(user.id, year.data) });
});

export default router;
