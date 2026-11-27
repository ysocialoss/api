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
