import { Router } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { env } from "./config.ts";
import { db } from "./db/index.ts";
import { userHandles, users } from "./db/schema.ts";
import { findPost } from "./posts.ts";
import { avatarDataUri, renderPostCard } from "./og/post-card.ts";
import { renderProfileCard } from "./og/profile-card.ts";
import {
  metaPage,
  postMeta,
  postSummary,
  profileMeta,
  profileSummary,
  type OgPost,
  type OgProfile,
} from "./og/text.ts";
import { getAvatar } from "./storage/r2.ts";
import { postCountSelection, publicProfileSelection, userSelection } from "./user-data.ts";

const router = Router();

const cache = new Map<string, { png: Buffer; at: number }>();
const cacheMs = 5 * 60_000;

router.use("/posts/:id", (req, _res, next) => {
  const id = req.params.id.replace(/\.png$/, "");
  if (!z.uuid().safeParse(id).success) throw new AuthError(404, "post_not_found");
  next();
});

const profileCache = new Map<string, { png: Buffer; at: number }>();
const handleSchema = z.string().regex(/^[a-z0-9_]{3,32}$/);

router.use("/profiles/:handle", (req, _res, next) => {
  const handle = req.params.handle.replace(/\.png$/, "").toLowerCase();
  if (!handleSchema.safeParse(handle).success) throw new AuthError(404, "profile_not_found");
  next();
});

async function findOgProfile(
  handle: string,
): Promise<OgProfile & { avatarUrl: string | null }> {
  const [profile] = await db
    .select({
      ...userSelection,
      bio: publicProfileSelection.bio,
      pronouns: publicProfileSelection.pronouns,
      followerCount: publicProfileSelection.followerCount,
      followingCount: publicProfileSelection.followingCount,
      postCount: postCountSelection,
    })
    .from(users)
    .where(
      and(
        isNull(users.bannedAt),
        eq(users.id, db.select({ id: userHandles.userId }).from(userHandles).where(eq(userHandles.handle, handle))),
      ),
    );
  if (!profile) throw new AuthError(404, "profile_not_found");
  return profile;
}

async function avatarFor(avatarUrl: string | null) {
  const key = /^\/api\/(avatars\/[a-f0-9-]{36}\.(?:avif|png))$/.exec(avatarUrl ?? "")?.[1];
  if (!key) return null;
  try {
    return await avatarDataUri(await getAvatar(key));
  } catch {
    return null;
  }
}

router.get("/posts/:id.png", async (req, res) => {
  const id = req.params.id;
  const post = await findPost(id);
  const hit = cache.get(id);
  let png = hit && Date.now() - hit.at < cacheMs ? hit.png : undefined;
  if (!png) {
    png = await renderPostCard(post, await avatarFor(post.author.avatarUrl));
    if (cache.size >= 300) cache.delete(cache.keys().next().value!);
    cache.set(id, { png, at: Date.now() });
  }
  res
    .set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    })
    .type("image/png")
    .send(png);
});

router.get("/posts/:id", async (req, res) => {
  const post: OgPost = await findPost(req.params.id);
  res
    .set("Cache-Control", "no-store")
    .type("html")
    .send(metaPage(postMeta(post, env.APP_ORIGIN), postSummary(post)));
});

router.get("/profiles/:handle.png", async (req, res) => {
  const handle = req.params.handle.toLowerCase();
  const hit = profileCache.get(handle);
  let png = hit && Date.now() - hit.at < cacheMs ? hit.png : undefined;
  if (!png) {
    const profile = await findOgProfile(handle);
    png = await renderProfileCard(profile, await avatarFor(profile.avatarUrl));
    if (profileCache.size >= 300) profileCache.delete(profileCache.keys().next().value!);
    profileCache.set(handle, { png, at: Date.now() });
  }
  res
    .set({
      "Cache-Control": "public, max-age=300, s-maxage=3600",
      "X-Content-Type-Options": "nosniff",
    })
    .type("image/png")
    .send(png);
});

router.get("/profiles/:handle", async (req, res) => {
  const profile = await findOgProfile(req.params.handle.toLowerCase());
  res
    .set("Cache-Control", "public, max-age=60")
    .type("html")
    .send(metaPage(profileMeta(profile, env.APP_ORIGIN), profileSummary(profile)));
});

export default router;
