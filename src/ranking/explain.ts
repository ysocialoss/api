import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { feedCandidates, feedModels, feedRequests, posts } from "../db/schema.ts";
import { AuthError } from "../auth/provider.ts";
import { headNames, loadConfig, type FeedConfig, type Head } from "./config.ts";
import { featureNames, priorHeads, readHeads, type FeatureName, type HeadWeights } from "./model.ts";
import { loadControls, loadPostTopics } from "./feedback.ts";
import type { Controls } from "./controls.ts";

export const factorKinds = [
  "following", "social", "conversation", "affinity", "topic", "popular", "recent", "network", "format", "explore", "control",
] as const;
export type FactorKind = (typeof factorKinds)[number];
export type Strength = "low" | "medium" | "high";

const featureKind: Partial<Record<FeatureName, FactorKind>> = {
  in_network: "following",
  author_follows_viewer: "following",
  mutual: "following",
  social_likes: "social",
  social_reposts: "social",
  followee_replied: "conversation",
  affinity: "affinity",
  author_ctr: "affinity",
  reciprocity: "affinity",
  viewer_like_rate: "affinity",
  topic_affinity: "topic",
  popularity: "popular",
  velocity: "popular",
  open_rate: "popular",
  dwell_rate: "popular",
  age_decay: "recent",
  author_proximity: "network",
  has_media: "format",
  has_voice: "format",
  has_poll: "format",
  has_link: "format",
  text_len: "format",
  is_quote: "format",
};

export function factorStrengths(
  features: readonly number[],
  predictions: readonly number[],
  heads: Record<Head, HeadWeights>,
  config: FeedConfig,
) {
  const totals = new Map<FactorKind, number>();
  headNames.forEach((head, index) => {
    if (head === "negative") return;
    const importance = config.weights[head] * (predictions[index] ?? 0);
    for (const [name, weight] of Object.entries(heads[head].weights) as [FeatureName, number][]) {
      const kind = featureKind[name];
      const x = features[featureNames.indexOf(name)] ?? 0;
      if (!kind || weight <= 0 || x <= 0) continue;
      totals.set(kind, (totals.get(kind) ?? 0) + importance * weight * x);
    }
  });
  const ranked = [...totals.entries()].filter(([, total]) => total > 0).sort((a, b) => b[1] - a[1]);
  const top = ranked[0]?.[1] ?? 0;
  return ranked.slice(0, 4).map(([kind, total]): { kind: FactorKind; strength: Strength } => ({
    kind,
    strength: total >= top * 0.6 ? "high" : total >= top * 0.3 ? "medium" : "low",
  }));
}

function appliedControls(controls: Controls, authorId: string, topics: string[]) {
  const author = controls.authorMultiplier.get(authorId) ?? 1;
  return {
    author: author > 1.001 ? "more" as const : author < 0.999 ? "less" as const : null,
    topics: topics.flatMap((topic) => {
      const value = controls.topicMultiplier.get(topic);
      if (value === undefined || Math.abs(value - 1) < 0.001) return [];
      return [{ topic, direction: value > 1 ? "more" as const : "less" as const }];
    }),
    sliders: controls.sliders,
  };
}

export async function explain(viewerId: string, postId: string, requestId: string) {
  const [row] = await db.select({
    features: feedCandidates.features,
    predictions: feedCandidates.predictions,
    reason: feedCandidates.reason,
    explore: feedCandidates.explore,
    position: feedCandidates.position,
    modelId: feedRequests.modelId,
    surface: feedRequests.surface,
  }).from(feedCandidates)
    .innerJoin(feedRequests, eq(feedRequests.id, feedCandidates.requestId))
    .where(and(eq(feedCandidates.requestId, requestId), eq(feedCandidates.postId, postId), eq(feedRequests.userId, viewerId)))
    .limit(1);
  if (!row) throw new AuthError(404, "feed_explanation_unavailable");
  const { config } = await loadConfig();
  let heads = priorHeads;
  if (row.modelId) {
    const [model] = await db.select({ heads: feedModels.heads }).from(feedModels).where(eq(feedModels.id, row.modelId)).limit(1);
    heads = (model && readHeads(model.heads)) ?? priorHeads;
  }
  const factors = factorStrengths(row.features, row.predictions, heads, config);
  const [controls, topics, author] = await Promise.all([
    loadControls(viewerId, config),
    loadPostTopics([postId]),
    db.select({ authorId: posts.authorId }).from(posts).where(eq(posts.id, postId)).limit(1),
  ]);
  const applied = appliedControls(controls, author[0]?.authorId ?? "", topics.get(postId) ?? []);
  return {
    postId,
    requestId,
    surface: row.surface,
    position: row.position,
    reason: row.reason,
    explore: row.explore,
    factors: row.explore ? [{ kind: "explore" as const, strength: "high" as const }, ...factors.slice(0, 3)] : factors,
    controls: applied,
  };
}
