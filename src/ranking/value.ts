import { headNames } from "./config.ts";
import type { FeedConfig } from "./config.ts";
import { featureIndex } from "./model.ts";

export type Scored = {
  postId: string;
  authorId: string;
  ageHours: number;
  sources: string[];
  features: number[];
  predictions: number[];
  score: number;
};

const head = Object.fromEntries(headNames.map((name, index) => [name, index])) as Record<(typeof headNames)[number], number>;

export function value(predictions: number[], features: number[], ageHours: number, config: FeedConfig) {
  const w = config.weights;
  const inNetwork = (features[featureIndex.in_network] ?? 0) >= 0.5;
  let total =
    w.dwell * predictions[head.dwell]! +
    w.click * predictions[head.click]! +
    w.profile * predictions[head.profile]! +
    w.like * predictions[head.like]! +
    w.comment * predictions[head.comment]! +
    w.share * predictions[head.share]! +
    w.save * predictions[head.save]! +
    (inNetwork ? 0 : w.follow * predictions[head.follow]!) -
    w.negative * predictions[head.negative]!;
  total = Math.max(total, 0.0001);
  const decay = Math.pow(0.5, Math.max(0, ageHours) / config.freshnessHalfLifeHours);
  total *= config.freshnessFloor + (1 - config.freshnessFloor) * decay;
  if ((features[featureIndex.seen_before] ?? 0) >= 0.5) total *= config.seenPenalty;
  return total;
}
