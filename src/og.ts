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
import { PngCache } from "./og/png-cache.ts";
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

const cacheMs = 5 * 60_000;
const cache = new PngCache(300, 32 * 1024 * 1024, cacheMs);

router.use("/posts/:id", (req, _res, next) => {
  const id = req.params.id.replace(/\.png$/, "");
  if (!z.uuid().safeParse(id).success) throw new AuthError(404, "post_not_found");
  next();
});

const profileCache = new PngCache(300, 32 * 1024 * 1024, cacheMs);
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
  let png = cache.get(id);
  if (!png) {
    png = await renderPostCard(post, await avatarFor(post.author.avatarUrl));
    cache.set(id, png);
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
  let png = profileCache.get(handle);
  if (!png) {
    const profile = await findOgProfile(handle);
    png = await renderProfileCard(profile, await avatarFor(profile.avatarUrl));
    profileCache.set(handle, png);
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
