import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { readViewerId, requireUser } from "./auth/request.ts";
import { env } from "./config.ts";
import { db } from "./db/index.ts";
import { users } from "./db/schema.ts";
import { releasesWithEntries, unreleasedEntries } from "./changelog-data.ts";

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
const pageSize = 10;

const viewerSeenAt = async (viewerId: string | null) => {
  if (!viewerId) return null;
  const [user] = await db.select({ seenAt: users.changelogSeenAt }).from(users).where(eq(users.id, viewerId));
  return user?.seenAt ?? null;
};
// Staging also shows what the next promote will ship.
const upcomingEntries = () => (env.CHANGELOG_SHOW_UNRELEASED ? unreleasedEntries() : Promise.resolve([]));

// The changelog is public, signed in or not. Pages are releases, newest first.
router.get("/", async (req, res) => {
  const before = z.iso.datetime().optional().safeParse(req.query.before);
  if (!before.success) throw new AuthError(400, "invalid_changelog_cursor");
  const [rows, upcoming] = await Promise.all([
    releasesWithEntries(before.data ? new Date(before.data) : undefined, pageSize + 1),
    before.data ? Promise.resolve([]) : upcomingEntries(),
  ]);
  const releases = rows.slice(0, pageSize);
  res.json({
    upcoming,
    releases,
    nextCursor: rows.length > pageSize ? releases.at(-1)?.createdAt.toISOString() ?? null : null,
  });
});

router.get("/unseen", async (req, res) => {
  const viewerId = await readViewerId(req);
  if (!viewerId) return void res.json({ unseen: false });
  const [[latest], upcoming, seenAt] = await Promise.all([
    releasesWithEntries(undefined, 1),
    upcomingEntries(),
    viewerSeenAt(viewerId),
  ]);
  const newest = [latest?.createdAt, ...upcoming.map((entry) => entry.createdAt)]
    .filter((date): date is Date => date instanceof Date)
    .reduce<Date | null>((max, date) => (!max || date > max ? date : max), null);
  res.json({ unseen: Boolean(newest && (!seenAt || seenAt < newest)) });
});

router.put("/seen", async (req, res) => {
  const user = await requireUser(req);
  await db.update(users).set({ changelogSeenAt: new Date() }).where(eq(users.id, user.id));
  res.sendStatus(204);
});

export default router;
