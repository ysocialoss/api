import { readViewerId, requireUser } from "./auth/request.ts";
import { Router, type Request } from "express";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import { posts, postReposts, users, userFollows } from "./db/schema.ts";
import { AuthError } from "./auth/provider.ts";
import { postSelection, serializePost } from "./post-data.ts";
import { userSelection } from "./user-data.ts";

const router = Router();
const handleSchema = z.string().regex(/^[a-z0-9_]{3,32}$/);
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.get("/:handle", async (req, res) => {
  if (!handleSchema.safeParse(req.params.handle).success) {
    throw new AuthError(404, "profile_not_found");
  }
  const [profile] = await db
    .select({
      ...userSelection,
      bio: users.bio,
      createdAt: users.createdAt,
      followerCount: sql<number>`(select count(*)::int from ${userFollows} where ${userFollows.followingId} = ${users.id})`,
      followingCount: sql<number>`(select count(*)::int from ${userFollows} where ${userFollows.followerId} = ${users.id})`,
    })
    .from(users)
    .where(eq(users.handle, req.params.handle));
  if (!profile) throw new AuthError(404, "profile_not_found");
  const viewerId = await readViewerId(req);
  const relationships = viewerId
    ? await db
        .select({
          followerId: userFollows.followerId,
          followingId: userFollows.followingId,
        })
        .from(userFollows)
        .where(
          or(
            and(
              eq(userFollows.followerId, viewerId),
              eq(userFollows.followingId, profile.id),
            ),
            and(
              eq(userFollows.followerId, profile.id),
              eq(userFollows.followingId, viewerId),
            ),
          ),
        )
    : [];
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
    isFollowing: relationships.some(
      (relationship) => relationship.followerId === viewerId,
    ),
    isFollowedBy: relationships.some(
      (relationship) => relationship.followingId === viewerId,
    ),
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
async function setFollow(req: Request, follow: boolean) {
  const viewer = await requireUser(req);
  const handle = handleSchema.safeParse(req.params.handle);
  if (!handle.success) throw new AuthError(404, "profile_not_found");
  return db.transaction(async (tx) => {
    // Serialize updates for this profile so retries return a consistent count.
    const [target] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, handle.data))
      .for("no key update");
    if (!target) throw new AuthError(404, "profile_not_found");
    if (target.id === viewer.id) throw new AuthError(400, "cannot_follow_self");
    if (follow) {
      await tx
        .insert(userFollows)
        .values({ followerId: viewer.id, followingId: target.id })
        .onConflictDoNothing();
    } else {
      await tx
        .delete(userFollows)
        .where(
          and(
            eq(userFollows.followerId, viewer.id),
            eq(userFollows.followingId, target.id),
          ),
        );
    }
    const [count] = await tx
      .select({ followerCount: sql<number>`count(*)::int` })
      .from(userFollows)
      .where(eq(userFollows.followingId, target.id));
    const [followsViewer] = await tx
      .select({ followerId: userFollows.followerId })
      .from(userFollows)
      .where(
        and(
          eq(userFollows.followerId, target.id),
          eq(userFollows.followingId, viewer.id),
        ),
      )
      .limit(1);
    return {
      isFollowing: follow,
      isFollowedBy: !!followsViewer,
      followerCount: count.followerCount,
    };
  });
}
router.put("/:handle/follow", async (req, res) => {
  res.json(await setFollow(req, true));
});
router.delete("/:handle/follow", async (req, res) => {
  res.json(await setFollow(req, false));
});
export default router;
