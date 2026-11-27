import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { berlinDate } from "./berlin-time.ts";
import { readViewerId } from "./auth/request.ts";
import { db } from "./db/index.ts";
import { users } from "./db/schema.ts";

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const anniversary = { year: 2026, month: 11, day: 17 };

const awarenessBranding = (month: number, day: number) => {
  if (month === 1 && day === 4) return "world-cancer-day";
  if (month === 3 && day === 22) return "earth-day";
  if (month === 1) return "black-history-month";
  if (month === 5) return "pride-month";
  return null;
};

export function activeCelebrations(at: Date) {
  const { year, month, day } = berlinDate(at);
  return {
    now: at.toISOString(),
    anniversary: year === anniversary.year && month === anniversary.month && day === anniversary.day,
    christmasSeason: month === 11 && day <= 24,
    christmasEve: month === 11 && day === 24,
    adventSeason: month === 11,
    giftSeason: month === 11 && day <= 26,
    eveStarSince: month >= 1 ? year : year - 1,
    branding: awarenessBranding(month, day),
  };
}

const HAT_LEFT_SHARE = 0.1;

const pickHatSide = () => (Math.random() < HAT_LEFT_SHARE ? "left" : "right");

async function hatSideOf(userId: string) {
  const [assigned] = await db
    .update(users)
    .set({ hatSide: pickHatSide() })
    .where(and(eq(users.id, userId), isNull(users.hatSide)))
    .returning({ hatSide: users.hatSide });
  if (assigned) return assigned.hatSide;
  const [existing] = await db.select({ hatSide: users.hatSide }).from(users).where(eq(users.id, userId));
  return existing?.hatSide ?? null;
}

router.get("/", async (req, res) => {
  const celebrations = activeCelebrations(new Date());
  const viewerId = celebrations.anniversary ? await readViewerId(req) : null;
  res.json({ ...celebrations, hatSide: viewerId ? await hatSideOf(viewerId) : null });
});

export default router;
