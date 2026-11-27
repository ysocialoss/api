import assert from "node:assert/strict";
import test from "node:test";
import { rerank, seededRandom } from "../src/ranking/rerank.ts";
import { featureIndex, featureNames, predict, priorModel } from "../src/ranking/model.ts";
import { value } from "../src/ranking/value.ts";
import { defaultConfig, mergeConfig } from "../src/ranking/config.ts";
import { reasonFor } from "../src/ranking/reasons.ts";

const vector = (overrides = {}) => {
  const features = featureNames.map(() => 0);
  for (const [name, number] of Object.entries(overrides)) features[featureIndex[name]] = number;
  return features;
};
const item = (postId, authorId, score) => ({ postId, authorId, score, ageHours: 1, sources: ["recent"], features: vector(), predictions: [] });
const rules = { epsilon: 0, exploreFrom: 3, authorGap: 1, authorMaxPer10: 2 };

test("rerank keeps score order but never repeats an author back to back or more than twice in ten", () => {
  const items = [
    item("a1", "a", 10), item("a2", "a", 9), item("a3", "a", 8), item("a4", "a", 7),
    item("b1", "b", 6), item("c1", "c", 5), item("d1", "d", 4), item("e1", "e", 3),
  ];
  const placed = rerank(items, rules, "seed", 8);
  assert.deepEqual(placed.map((entry) => entry.postId), ["a1", "b1", "a2", "c1", "d1", "e1", "a3", "a4"]);
  assert.deepEqual(placed.map((entry) => entry.position), placed.map((_, index) => index));
  assert.ok(placed.every((entry) => entry.explore === false && entry.propensity === 1));
});

test("rerank falls back to the best item when no author rule can be met", () => {
  const placed = rerank([item("x1", "x", 3), item("x2", "x", 2), item("x3", "x", 1)], rules, "seed", 3);
  assert.deepEqual(placed.map((entry) => entry.postId), ["x1", "x2", "x3"]);
});

test("exploration is seeded by the request id and logs propensity", () => {
  const items = Array.from({ length: 30 }, (_, index) => item(`p${index}`, `u${index}`, 30 - index));
  const explore = { ...rules, epsilon: 0.5 };
  const one = rerank(items, explore, "request-1", 20);
  const two = rerank(items, explore, "request-1", 20);
  assert.deepEqual(one.map((entry) => entry.postId), two.map((entry) => entry.postId));
  assert.deepEqual(one.slice(0, 3).map((entry) => entry.postId), ["p0", "p1", "p2"]);
  assert.ok(one.slice(0, 3).every((entry) => !entry.explore && entry.propensity === 1));
  const explored = one.filter((entry) => entry.explore);
  assert.ok(explored.length > 0);
  for (const entry of one.slice(3)) {
    assert.ok(entry.propensity > 0 && entry.propensity <= 1);
    if (!entry.explore) assert.equal(entry.propensity, 0.5);
  }
  const random = seededRandom("x");
  const values = Array.from({ length: 100 }, () => random());
  assert.ok(values.every((number) => number >= 0 && number < 1));
});

test("the prior model rewards affinity and social proof, and value prefers fresh unseen posts", () => {
  const plain = predict(priorModel, vector());
  const liked = predict(priorModel, vector({ affinity: 1, social_likes: 1, in_network: 1 }));
  assert.equal(plain.length, 9);
  assert.ok(plain.every((p) => p > 0 && p < 1));
  assert.ok(liked[3] > plain[3]);
  const fresh = value(plain, vector(), 1, defaultConfig);
  const old = value(plain, vector(), 96, defaultConfig);
  const seen = value(plain, vector({ seen_before: 1 }), 1, defaultConfig);
  assert.ok(fresh > old);
  assert.ok(old >= fresh * defaultConfig.freshnessFloor * 0.99);
  assert.ok(Math.abs(seen - fresh * defaultConfig.seenPenalty) < 1e-9);
  const following = value(predict(priorModel, vector({ in_network: 1 })), vector({ in_network: 1 }), 1, { ...defaultConfig, weights: { ...defaultConfig.weights, follow: 1000 } });
  const outside = value(predict(priorModel, vector()), vector(), 1, { ...defaultConfig, weights: { ...defaultConfig.weights, follow: 1000 } });
  assert.ok(outside > following);
});

test("config merges partial rows and falls back to defaults when invalid", () => {
  assert.equal(mergeConfig({ epsilon: 0 }).epsilon, 0);
  assert.equal(mergeConfig({ epsilon: 0 }).weights.like, defaultConfig.weights.like);
  assert.equal(mergeConfig({ weights: { like: 7 } }).weights.like, 7);
  assert.deepEqual(mergeConfig({ epsilon: 9 }), defaultConfig);
  assert.deepEqual(mergeConfig(null), defaultConfig);
});

test("reasons pick the strongest explanation", () => {
  assert.equal(reasonFor({ sources: ["recent"], features: vector(), explore: true }), "explore");
  assert.equal(reasonFor({ sources: ["followee_repost"], features: vector({ in_network: 1 }), explore: false }), "network");
  assert.equal(reasonFor({ sources: ["recent"], features: vector({ in_network: 1 }), explore: false }), "following");
  assert.equal(reasonFor({ sources: ["recent"], features: vector({ social_likes: 0.4 }), explore: false }), "social");
  assert.equal(reasonFor({ sources: ["popular"], features: vector(), explore: false }), "popular");
  assert.equal(reasonFor({ sources: ["recent"], features: vector(), explore: false }), "recent");
});

test("controls build author and topic multipliers and the value applies sliders", async () => {
  const { buildControls, factorsFor, neutralFactors } = await import("../src/ranking/controls.ts");
  const rows = [
    { kind: "post", direction: -1, post_id: "p1", author_id: "a", topic: null, post_topics: ["cats"] },
    { kind: "author", direction: 1, post_id: null, author_id: "b", topic: null, post_topics: null },
    { kind: "snooze", direction: -1, post_id: null, author_id: "c", topic: null, post_topics: null },
    { kind: "topic", direction: 1, post_id: null, author_id: null, topic: "dogs", post_topics: null },
    { kind: "topic", direction: 1, post_id: null, author_id: null, topic: "birds", post_topics: null },
    { kind: "topic", direction: -1, post_id: null, author_id: null, topic: "cats", post_topics: null },
  ];
  const controls = buildControls({ discovery: -2, freshness: 2, replies: 1 }, rows, defaultConfig);
  assert.deepEqual(controls.excludedPosts, ["p1"]);
  assert.deepEqual(controls.snoozedAuthors, ["c"]);
  assert.equal(controls.authorMultiplier.get("a"), 0.7);
  assert.equal(controls.authorMultiplier.get("b"), 1.3);
  assert.ok(Math.abs(controls.topicMultiplier.get("cats") - 0.24) < 1e-9);
  assert.deepEqual(controls.counts, { posts: 1, authors: 1, snoozes: 1, topics: 3 });
  const factors = factorsFor(controls, defaultConfig, { authorId: "b" }, ["dogs", "birds"]);
  assert.deepEqual({ ...factors, topic: Number(factors.topic.toFixed(2)) }, { halfLifeScale: 0.25, replies: 1.5, discovery: 0.3, author: 1.3, topic: 2.25 });
  assert.equal(factorsFor(controls, defaultConfig, { authorId: "x" }, ["cats", "cats", "cats"]).topic, 0.2);

  const predictions = predict(priorModel, vector({ in_network: 1 }));
  const plain = value(predictions, vector({ in_network: 1 }), 0, defaultConfig, neutralFactors);
  assert.equal(value(predictions, vector({ in_network: 1 }), 0, defaultConfig), plain);
  const outside = value(predictions, vector(), 0, defaultConfig, { ...neutralFactors, discovery: 0.3 });
  assert.ok(Math.abs(outside / value(predictions, vector(), 0, defaultConfig) - 0.3) < 1e-9);
  const reply = value(predictions, vector({ in_network: 1, is_reply: 1 }), 0, defaultConfig, { ...neutralFactors, replies: 2, author: 1.3 });
  assert.ok(Math.abs(reply / value(predictions, vector({ in_network: 1, is_reply: 1 }), 0, defaultConfig) - 2.6) < 1e-9);
  const slow = value(predictions, vector({ in_network: 1 }), 24, defaultConfig, { ...neutralFactors, halfLifeScale: 3 });
  const fast = value(predictions, vector({ in_network: 1 }), 24, defaultConfig, { ...neutralFactors, halfLifeScale: 0.25 });
  assert.ok(slow > fast);
  assert.equal(reasonFor({ sources: ["recent"], features: vector(), explore: false, boost: { author: 1, topic: 1.5 } }), "topic");
  assert.equal(reasonFor({ sources: ["recent"], features: vector(), explore: false, boost: { author: 1.3, topic: 1 } }), "control");
});

test("config merges partial controls and rejects out of range values", () => {
  const merged = mergeConfig({ controls: { topicLess: 0.5 } });
  assert.equal(merged.controls.topicLess, 0.5);
  assert.deepEqual(merged.controls.freshnessScale, defaultConfig.controls.freshnessScale);
  assert.equal(mergeConfig({ weights: { like: 3 } }).controls.snoozeDays, 30);
  assert.deepEqual(mergeConfig({ controls: { repliesFactor: [1, 2] } }), defaultConfig);
});

test("explanations rank factor kinds by their share of the value", async () => {
  const { factorStrengths } = await import("../src/ranking/explain.ts");
  const features = vector({ in_network: 1, affinity: 0.9, popularity: 0.1, age_decay: 0.5 });
  const factors = factorStrengths(features, predict(priorModel, features), priorModel.heads, defaultConfig);
  assert.ok(factors.length >= 2 && factors.length <= 4);
  assert.equal(factors[0].kind, "affinity");
  assert.equal(factors[0].strength, "high");
  assert.ok(factors.every((factor) => factor.kind !== "explore"));
});
