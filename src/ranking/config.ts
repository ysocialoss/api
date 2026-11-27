import { desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.ts";
import { feedConfig } from "../db/schema.ts";

export const headNames = ["dwell", "click", "profile", "like", "comment", "share", "save", "follow", "negative"] as const;
export type Head = (typeof headNames)[number];

const weight = z.number().min(0).max(50);
export const configSchema = z.strictObject({
  weights: z.strictObject({
    dwell: weight,
    click: weight,
    profile: weight,
    like: weight,
    comment: weight,
    share: weight,
    save: weight,
    follow: weight,
    negative: weight,
  }),
  epsilon: z.number().min(0).max(0.5),
  exploreFrom: z.number().int().min(0).max(20),
  windowHours: z.number().int().min(12).max(336),
  wideWindowHours: z.number().int().min(24).max(720),
  minCandidates: z.number().int().min(0).max(600),
  maxCandidates: z.number().int().min(50).max(600),
  storedCandidates: z.number().int().min(20).max(200),
  pageSize: z.number().int().min(5).max(50),
  freshnessHalfLifeHours: z.number().min(1).max(168),
  freshnessFloor: z.number().min(0).max(1),
  seenPenalty: z.number().min(0).max(1),
  authorGap: z.number().int().min(1).max(5),
  authorMaxPer10: z.number().int().min(1).max(10),
  publicCacheSeconds: z.number().int().min(0).max(3600),
  timeoutMs: z.number().int().min(200).max(10_000),
});
export type FeedConfig = z.infer<typeof configSchema>;

export const defaultConfig: FeedConfig = {
  weights: { dwell: 0.5, click: 1, profile: 1, like: 2, comment: 4, share: 3, save: 3, follow: 5, negative: 20 },
  epsilon: 0.1,
  exploreFrom: 3,
  windowHours: 72,
  wideWindowHours: 168,
  minCandidates: 150,
  maxCandidates: 600,
  storedCandidates: 100,
  pageSize: 20,
  freshnessHalfLifeHours: 24,
  freshnessFloor: 0.3,
  seenPenalty: 0.3,
  authorGap: 1,
  authorMaxPer10: 2,
  publicCacheSeconds: 300,
  timeoutMs: 2000,
};

export function mergeConfig(values: unknown): FeedConfig {
  const base = typeof values === "object" && values !== null ? values as Record<string, unknown> : {};
  const weights = typeof base.weights === "object" && base.weights !== null ? base.weights : {};
  const merged = { ...defaultConfig, ...base, weights: { ...defaultConfig.weights, ...weights } };
  const parsed = configSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaultConfig;
}

type Loaded = { id: string | null; config: FeedConfig; at: number };
let cached: Loaded | null = null;

export async function loadConfig(): Promise<{ id: string | null; config: FeedConfig }> {
  if (cached && Date.now() - cached.at < 30_000) return cached;
  const [row] = await db.select({ id: feedConfig.id, values: feedConfig.values }).from(feedConfig)
    .orderBy(desc(feedConfig.createdAt)).limit(1);
  cached = { id: row?.id ?? null, config: row ? mergeConfig(row.values) : defaultConfig, at: Date.now() };
  return cached;
}

export function clearConfigCache() {
  cached = null;
}
