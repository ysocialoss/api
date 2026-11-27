import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { feedModels } from "../db/schema.ts";
import { headNames, type Head } from "./config.ts";

export const featureVersion = 1;
export const featureNames = [
  "age_decay", "age_log", "is_reply", "is_quote", "has_media", "has_voice", "has_poll", "has_link", "text_len",
  "in_network", "author_follows_viewer", "mutual",
  "affinity", "author_ctr", "reciprocity",
  "social_likes", "social_reposts", "followee_replied",
  "popularity", "velocity", "open_rate", "dwell_rate",
  "topic_affinity", "author_proximity", "viewer_like_rate", "seen_before", "position",
] as const;
export type FeatureName = (typeof featureNames)[number];
export const featureIndex = Object.fromEntries(featureNames.map((name, index) => [name, index])) as Record<FeatureName, number>;
export const viewerFeatures: readonly FeatureName[] = [
  "in_network", "author_follows_viewer", "mutual", "affinity", "author_ctr", "reciprocity",
  "social_likes", "social_reposts", "followee_replied", "topic_affinity", "author_proximity", "viewer_like_rate", "seen_before",
];

export type HeadWeights = { bias: number; weights: Partial<Record<FeatureName, number>>; source: "prior" | "trained" };
export type Model = { id: string | null; heads: Record<Head, HeadWeights> };

export const priorHeads: Record<Head, HeadWeights> = {
  dwell: { source: "prior", bias: -0.6, weights: { age_decay: 0.4, has_media: 0.5, has_voice: 0.3, text_len: 0.8, affinity: 0.8, in_network: 0.3, dwell_rate: 1.5, popularity: 0.4, seen_before: -0.8, position: -0.3 } },
  click: { source: "prior", bias: -2.2, weights: { has_media: 0.6, has_link: 0.4, has_poll: 0.3, text_len: 0.5, affinity: 1, author_ctr: 1.2, open_rate: 1.6, followee_replied: 0.6, popularity: 0.5, seen_before: -0.8, position: -0.4 } },
  profile: { source: "prior", bias: -3.6, weights: { in_network: -0.6, author_proximity: 0.9, popularity: 0.4, affinity: 0.3, author_follows_viewer: 0.6, position: -0.3 } },
  like: { source: "prior", bias: -2.6, weights: { age_decay: 0.6, affinity: 1.6, in_network: 0.7, mutual: 0.4, reciprocity: 0.8, social_likes: 1.1, popularity: 1.1, velocity: 0.7, viewer_like_rate: 1.8, topic_affinity: 0.6, seen_before: -1, position: -0.3 } },
  comment: { source: "prior", bias: -3.6, weights: { is_reply: 0.4, has_poll: -0.3, affinity: 1.4, mutual: 0.8, reciprocity: 1.1, followee_replied: 1.2, velocity: 0.6, topic_affinity: 0.5, seen_before: -0.8, position: -0.2 } },
  share: { source: "prior", bias: -4.4, weights: { has_media: 0.4, is_reply: -0.6, social_reposts: 1.4, popularity: 1, velocity: 0.8, affinity: 0.7, position: -0.2 } },
  save: { source: "prior", bias: -5, weights: { has_media: 0.4, has_link: 0.6, text_len: 0.6, popularity: 0.6, affinity: 0.4 } },
  follow: { source: "prior", bias: -5.2, weights: { in_network: -3, author_proximity: 1.4, author_follows_viewer: 1.2, popularity: 0.5, affinity: 0.6 } },
  negative: { source: "prior", bias: -6, weights: { in_network: -0.8, affinity: -1, author_proximity: -0.5, popularity: -0.4 } },
};
export const priorModel: Model = { id: null, heads: priorHeads };

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

export function predict(model: Model, features: ArrayLike<number>): number[] {
  return headNames.map((head) => {
    const { bias, weights } = model.heads[head];
    let total = bias;
    for (const [name, weight] of Object.entries(weights) as [FeatureName, number][])
      total += weight * (features[featureIndex[name]] ?? 0);
    return sigmoid(total);
  });
}

export function readHeads(value: unknown): Record<Head, HeadWeights> | null {
  if (typeof value !== "object" || value === null) return null;
  const heads = value as Record<string, unknown>;
  const result = {} as Record<Head, HeadWeights>;
  for (const head of headNames) {
    const entry = heads[head] as { bias?: unknown; weights?: unknown; source?: unknown } | undefined;
    if (!entry || typeof entry.bias !== "number" || typeof entry.weights !== "object" || entry.weights === null) {
      result[head] = priorHeads[head];
      continue;
    }
    const weights: Partial<Record<FeatureName, number>> = {};
    for (const [name, weight] of Object.entries(entry.weights))
      if (name in featureIndex && typeof weight === "number" && Number.isFinite(weight)) weights[name as FeatureName] = weight;
    result[head] = { bias: entry.bias, weights, source: entry.source === "trained" ? "trained" : "prior" };
  }
  return result;
}

let cachedModel: { model: Model; at: number } | null = null;

export async function loadModel(): Promise<Model> {
  if (cachedModel && Date.now() - cachedModel.at < 60_000) return cachedModel.model;
  const [row] = await db.select({ id: feedModels.id, heads: feedModels.heads, featureVersion: feedModels.featureVersion })
    .from(feedModels).where(eq(feedModels.status, "active")).limit(1);
  const heads = row && row.featureVersion === featureVersion ? readHeads(row.heads) : null;
  const model = heads && row ? { id: row.id, heads } : priorModel;
  cachedModel = { model, at: Date.now() };
  return model;
}
