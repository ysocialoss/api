import { Router } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { requireAdminWrite, requireStaff, requireStaffWrite } from "./admin-access.ts";
import { db } from "./db/index.ts";
import { changelogApps, changelogEntries, releases } from "./db/schema.ts";
import { changelogEntryInput, releasedEntries, unreleasedEntries } from "./changelog-data.ts";

const router = Router();

router.get("/", async (req, res) => {
  await requireStaff(req);
  const [unreleased, released] = await Promise.all([unreleasedEntries(), releasedEntries(undefined, 100)]);
  res.json({ unreleased, released });
});

router.get("/unreleased", async (req, res) => {
  await requireStaff(req);
  const app = z.enum(changelogApps).optional().safeParse(req.query.app);
  if (!app.success) throw new AuthError(400, "invalid_changelog_app");
  res.json({ entries: await unreleasedEntries(app.data) });
});

router.post("/", async (req, res) => {
  const viewer = await requireStaffWrite(req);
  const input = changelogEntryInput.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_changelog_entry");
  const [entry] = await db.insert(changelogEntries).values({ ...input.data, authorId: viewer.id })
    .returning({ id: changelogEntries.id });
  res.status(201).json(entry);
});

// Must be registered before "/:id" so "releases" is not read as an entry id.
// Called when an app is promoted to production: every unreleased entry for that app ships with it.
router.post("/releases", async (req, res) => {
  await requireAdminWrite(req);
  const input = z.strictObject({ app: z.enum(changelogApps), tag: z.string().trim().min(1).max(128) }).safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_release");
  const result = await db.transaction(async (tx) => {
    const [release] = await tx.insert(releases).values(input.data).onConflictDoNothing().returning({ id: releases.id });
    if (!release) throw new AuthError(409, "release_exists");
    const shipped = await tx.update(changelogEntries)
      .set({ releaseId: release.id, publishedAt: sql`now()` })
      .where(and(eq(changelogEntries.app, input.data.app), isNull(changelogEntries.releaseId)))
      .returning({ id: changelogEntries.id });
    return { id: release.id, entries: shipped.length };
  });
  res.status(201).json(result);
});

const entryId = (value: unknown) => {
  const id = z.uuid().safeParse(value);
  if (!id.success) throw new AuthError(404, "changelog_entry_not_found");
  return id.data;
};

// Released entries are history, so only unreleased ones can change.
router.patch("/:id", async (req, res) => {
  await requireStaffWrite(req);
  const id = entryId(req.params.id);
  const input = changelogEntryInput.partial().safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_changelog_entry");
  const [saved] = await db.update(changelogEntries).set({ ...input.data, updatedAt: new Date() })
    .where(and(eq(changelogEntries.id, id), isNull(changelogEntries.releaseId)))
    .returning({ id: changelogEntries.id });
  if (!saved) throw new AuthError(409, "changelog_entry_released");
  res.sendStatus(204);
});

router.delete("/:id", async (req, res) => {
  await requireStaffWrite(req);
  const id = entryId(req.params.id);
  const [deleted] = await db.delete(changelogEntries)
    .where(and(eq(changelogEntries.id, id), isNull(changelogEntries.releaseId)))
    .returning({ id: changelogEntries.id });
  if (!deleted) throw new AuthError(409, "changelog_entry_released");
  res.sendStatus(204);
});

export default router;
