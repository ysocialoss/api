import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import { changelogApps, changelogCategory, changelogEntries, releases } from "./db/schema.ts";

export const changelogEntryInput = z.strictObject({
  app: z.enum(changelogApps),
  category: z.enum(changelogCategory.enumValues),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().max(4000).default(""),
});

export const entryFields = {
  id: changelogEntries.id,
  app: changelogEntries.app,
  category: changelogEntries.category,
  title: changelogEntries.title,
  body: changelogEntries.body,
  publishedAt: changelogEntries.publishedAt,
  createdAt: changelogEntries.createdAt,
  releaseId: releases.id,
  releaseTag: releases.tag,
};

export const unreleasedEntries = (app?: (typeof changelogApps)[number]) =>
  db.select(entryFields).from(changelogEntries)
    .leftJoin(releases, eq(releases.id, changelogEntries.releaseId))
    .where(and(isNull(changelogEntries.releaseId), app ? eq(changelogEntries.app, app) : undefined))
    .orderBy(desc(changelogEntries.createdAt), desc(changelogEntries.id));

export const releasedEntries = (before: Date | undefined, limit: number) =>
  db.select(entryFields).from(changelogEntries)
    .innerJoin(releases, eq(releases.id, changelogEntries.releaseId))
    .where(before ? lt(changelogEntries.publishedAt, before) : undefined)
    .orderBy(desc(changelogEntries.publishedAt), desc(changelogEntries.id))
    .limit(limit);

const categoryOrder = ["new", "improved", "fixed", "removed", "technical"];

// Releases newest first, each with its entries. Releases without entries are skipped.
export async function releasesWithEntries(before: Date | undefined, limit: number) {
  const rows = await db.selectDistinct({ id: releases.id, app: releases.app, tag: releases.tag, createdAt: releases.createdAt })
    .from(releases)
    .innerJoin(changelogEntries, eq(changelogEntries.releaseId, releases.id))
    .where(before ? lt(releases.createdAt, before) : undefined)
    .orderBy(desc(releases.createdAt), desc(releases.id))
    .limit(limit);
  if (rows.length === 0) return [];
  const entries = await db.select(entryFields).from(changelogEntries)
    .innerJoin(releases, eq(releases.id, changelogEntries.releaseId))
    .where(inArray(changelogEntries.releaseId, rows.map((row) => row.id)))
    .orderBy(asc(changelogEntries.createdAt));
  return rows.map((release) => ({
    ...release,
    entries: entries.filter((entry) => entry.releaseId === release.id)
      .sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category)),
  }));
}
