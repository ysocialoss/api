import { featureIndex } from "./model.ts";

export const reasonKinds = ["explore", "network", "following", "conversation", "social", "nearby", "popular", "recent"] as const;
export type Reason = (typeof reasonKinds)[number];

export function reasonFor(item: { sources: string[]; features: number[]; explore: boolean }): Reason {
  const feature = (name: keyof typeof featureIndex) => item.features[featureIndex[name]] ?? 0;
  if (item.explore) return "explore";
  if (item.sources.includes("followee_repost")) return "network";
  if (item.sources.includes("followee_reply") || feature("followee_replied") > 0) return "conversation";
  if (feature("in_network") >= 0.5) return "following";
  if (feature("social_likes") > 0) return "social";
  if (feature("author_proximity") >= 0.3) return "nearby";
  if (item.sources.includes("popular") || feature("popularity") >= 0.5) return "popular";
  return "recent";
}
