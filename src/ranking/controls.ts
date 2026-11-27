import type { FeedConfig } from "./config.ts";
import type { feedbackKinds } from "../db/schema.ts";

export type FeedbackKind = (typeof feedbackKinds)[number];
export type Sliders = { discovery: number; freshness: number; replies: number };
export type Controls = {
  sliders: Sliders;
  excludedPosts: string[];
  snoozedAuthors: string[];
  authorMultiplier: Map<string, number>;
  topicMultiplier: Map<string, number>;
  counts: { posts: number; authors: number; snoozes: number; topics: number };
};
export type Factors = { halfLifeScale: number; replies: number; discovery: number; author: number; topic: number };

export const neutralSliders: Sliders = { discovery: 0, freshness: 0, replies: 0 };
export const neutralFactors: Factors = { halfLifeScale: 1, replies: 1, discovery: 1, author: 1, topic: 1 };

const clamp = (value: number) => Math.min(3, Math.max(0.2, value));
const level = (value: number) => Math.min(4, Math.max(0, Math.round(value) + 2));

export function emptyControls(sliders: Sliders = neutralSliders): Controls {
  return {
    sliders,
    excludedPosts: [],
    snoozedAuthors: [],
    authorMultiplier: new Map(),
    topicMultiplier: new Map(),
    counts: { posts: 0, authors: 0, snoozes: 0, topics: 0 },
  };
}

export type ControlRow = {
  kind: FeedbackKind;
  direction: number;
  post_id: string | null;
  author_id: string | null;
  topic: string | null;
  post_topics: string[] | null;
};

export function buildControls(sliders: Sliders, rows: ControlRow[], config: FeedConfig): Controls {
  const controls = emptyControls(sliders);
  const c = config.controls;
  const scale = (map: Map<string, number>, key: string, factor: number) => map.set(key, (map.get(key) ?? 1) * factor);
  for (const row of rows) {
    const up = row.direction > 0;
    if (row.kind === "post") {
      controls.counts.posts += 1;
      if (!up && row.post_id) controls.excludedPosts.push(row.post_id);
      if (row.author_id) scale(controls.authorMultiplier, row.author_id, up ? c.interestedAuthor : c.notInterestedAuthor);
      for (const topic of row.post_topics ?? []) scale(controls.topicMultiplier, topic, up ? c.interestedTopic : c.notInterestedTopic);
    } else if (row.kind === "author" && row.author_id) {
      controls.counts.authors += 1;
      scale(controls.authorMultiplier, row.author_id, up ? c.interestedAuthor : c.notInterestedAuthor);
    } else if (row.kind === "snooze" && row.author_id) {
      controls.counts.snoozes += 1;
      controls.snoozedAuthors.push(row.author_id);
    } else if (row.kind === "topic" && row.topic) {
      controls.counts.topics += 1;
      scale(controls.topicMultiplier, row.topic, up ? c.topicMore : c.topicLess);
    }
  }
  for (const [key, value] of controls.authorMultiplier) controls.authorMultiplier.set(key, clamp(value));
  return controls;
}

export function factorsFor(
  controls: Controls,
  config: FeedConfig,
  candidate: { authorId: string },
  topics: readonly string[],
): Factors {
  const c = config.controls;
  let topic = 1;
  for (const name of topics) topic *= controls.topicMultiplier.get(name) ?? 1;
  return {
    halfLifeScale: c.freshnessScale[level(controls.sliders.freshness)]!,
    replies: c.repliesFactor[level(controls.sliders.replies)]!,
    discovery: c.discoveryFactor[level(controls.sliders.discovery)]!,
    author: controls.authorMultiplier.get(candidate.authorId) ?? 1,
    topic: clamp(topic),
  };
}

export function controlsSnapshot(controls: Controls) {
  return { sliders: controls.sliders, counts: controls.counts };
}
