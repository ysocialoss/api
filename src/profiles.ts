import { readViewerId } from "./auth/request.ts";
import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import { posts, users } from "./db/schema.ts";
import { AuthError } from "./auth/provider.ts";
import { postSelection, serializePost } from "./post-data.ts";

const router = Router();
router.get("/:handle", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (
    !z
      .string()
      .regex(/^[a-z0-9_]{3,32}$/)
      .safeParse(req.params.handle).success
  ) {
    throw new AuthError(404, "profile_not_found");
  }
  const [profile] = await db
    .select({
      id: users.id,
      handle: users.handle,
      displayName: users.displayName,
      bio: users.bio,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.handle, req.params.handle));
  if (!profile) throw new AuthError(404, "profile_not_found");
  const recent = await db
    .select(postSelection(await readViewerId(req)))
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(eq(posts.authorId, profile.id))
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(20);
  res.json({
    profile,
    posts: recent.map(serializePost),
    serverNow: new Date().toISOString(),
  });
});
export default router;
