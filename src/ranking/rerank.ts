import type { FeedConfig } from "./config.ts";
import type { Scored } from "./value.ts";

export type Placed = Scored & { position: number; explore: boolean; propensity: number };

export function seededRandom(seed: string) {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index++) state = Math.imul(state ^ seed.charCodeAt(index), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rules = Pick<FeedConfig, "epsilon" | "exploreFrom" | "authorGap" | "authorMaxPer10">;

export function rerank(items: Scored[], rules: Rules, seed: string, limit: number): Placed[] {
  const random = seededRandom(seed);
  const pool = [...items].sort((a, b) => b.score - a.score || (a.postId < b.postId ? -1 : 1));
  const placed: Placed[] = [];
  const allowed = (item: Scored) => {
    const recent = placed.slice(-rules.authorGap);
    if (recent.some((entry) => entry.authorId === item.authorId)) return false;
    const window = placed.slice(-9);
    return window.filter((entry) => entry.authorId === item.authorId).length < rules.authorMaxPer10;
  };
  while (pool.length && placed.length < limit) {
    const eligible = pool.map((item, index) => ({ item, index })).filter(({ item }) => allowed(item));
    const choices = eligible.length ? eligible : pool.map((item, index) => ({ item, index }));
    const position = placed.length;
    const canExplore = position >= rules.exploreFrom && rules.epsilon > 0 && choices.length > 1;
    let pick = choices[0]!;
    let explore = false;
    let propensity = 1;
    if (canExplore) {
      const lower = choices.slice(1);
      if (random() < rules.epsilon) {
        pick = lower[Math.floor(random() * lower.length)]!;
        explore = true;
        propensity = rules.epsilon / lower.length;
      } else propensity = 1 - rules.epsilon;
    }
    pool.splice(pick.index, 1);
    placed.push({ ...pick.item, position, explore, propensity });
  }
  return placed;
}
