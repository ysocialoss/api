import { readViewerId } from "./auth/request.ts";
import { Router } from "express";
import { and, desc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import { posts, postReposts, users } from "./db/schema.ts";
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
  const viewerId = await readViewerId(req);
  const recent = await db
    .select(postSelection(viewerId))
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(and(eq(posts.authorId, profile.id), isNull(posts.parentId)))
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(20);
  const replies = await db
    .select(postSelection(viewerId))
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(and(eq(posts.authorId, profile.id), isNotNull(posts.parentId)))
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(20);
  const reposts = await db
    .select(postSelection(viewerId))
    .from(postReposts)
    .innerJoin(posts, eq(posts.id, postReposts.postId))
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(eq(postReposts.userId, profile.id))
    .orderBy(desc(postReposts.createdAt), desc(postReposts.postId))
    .limit(20);
  const ancestry =
    replies.length === 0
      ? []
      : (
          await db.execute<{
            reply_id: string;
            ancestor_id: string;
            depth: number;
          }>(sql`
    WITH RECURSIVE thread AS (
      SELECT id AS reply_id, parent_id AS ancestor_id, 0 AS depth
      FROM posts WHERE id IN (${sql.join(
        replies.map((reply) => sql`${reply.id}::uuid`),
        sql`, `,
      )})
      UNION ALL
      SELECT thread.reply_id, parent.parent_id, thread.depth + 1
      FROM thread JOIN posts parent ON parent.id = thread.ancestor_id
      WHERE parent.parent_id IS NOT NULL
    )
    SELECT reply_id, ancestor_id, depth FROM thread ORDER BY depth DESC
  `)
        ).rows;
  const ancestorIds = [...new Set(ancestry.map((row) => row.ancestor_id))];
  const ancestors =
    ancestorIds.length === 0
      ? []
      : await db
          .select(postSelection(viewerId))
          .from(posts)
          .innerJoin(users, eq(users.id, posts.authorId))
          .where(inArray(posts.id, ancestorIds));
  const ancestorsById = new Map(
    ancestors.map((post) => [post.id, serializePost(post)]),
  );
  res.json({
    profile,
    posts: recent.map(serializePost),
    reposts: reposts.map(serializePost),
    replies: replies.map((post) => ({
      post: serializePost(post),
      thread: ancestry
        .filter((row) => row.reply_id === post.id)
        .flatMap((row) => {
          const ancestor = ancestorsById.get(row.ancestor_id);
          return ancestor ? [ancestor] : [];
        }),
    })),
    serverNow: new Date().toISOString(),
  });
});
export default router;
