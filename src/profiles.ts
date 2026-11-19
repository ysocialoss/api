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
import { posts, users, userFollows, userHandles } from "./db/schema.ts";
import { profileReposts } from "./feed-entries.ts";
import { AuthError } from "./auth/provider.ts";
import { postSelection, serializePost } from "./post-data.ts";
import { publicProfileSelection, userSelection } from "./user-data.ts";
import { reservedAdminHandle } from "./config.ts";
import { recordNotification } from "./notification-events.ts";

const router = Router();
const handleSchema = z.string().regex(/^[a-z0-9_]{3,32}$/);
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.get("/suggestions", async (req, res) => {
  // Not requireUser: that also demands an Origin header, which browsers do not
  // send on same-origin GETs.
  if (!(await readViewerId(req))) throw new AuthError(401, "sign_in_required");
  const query = z.string().regex(/^[a-z0-9_]{0,32}$/i).safeParse(req.query.q);
  if (!query.success) throw new AuthError(400, "invalid_handle");
  const term = query.data.toLowerCase();
  if (!term) {
    res.json({ users: [] });
    return;
  }
  const matches = await db.select(userSelection).from(users)
    .where(sql`strpos(${users.handle}, ${term}) > 0`)
    .orderBy(sql`case when ${users.handle} = ${term} then 0 when strpos(${users.handle}, ${term}) = 1 then 1 else 2 end`, users.handle)
    .limit(3);
  res.json({ users: matches });
});
router.patch("/me", async (req, res) => {
  const viewer = await requireUser(req);
  const input = z
    .strictObject({
      handle: handleSchema,
      displayName: z.string().trim().min(1).max(80),
      bio: z.string().max(160),
    })
    .partial()
    .refine((changes) => Object.keys(changes).length > 0)
    .safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_profile");
  if (input.data.handle && input.data.handle !== viewer.handle &&
    (input.data.handle === reservedAdminHandle || viewer.handle === reservedAdminHandle))
    throw new AuthError(409, "reserved_username");
  const [profile] = await db
    .update(users)
    .set({ ...input.data, updatedAt: new Date() })
    .where(eq(users.id, viewer.id))
    .returning({
      handle: users.handle,
      displayName: users.displayName,
      bio: users.bio,
    });
  if (!profile) throw new AuthError(404, "profile_not_found");
  res.json(profile);
});
router.get("/:handle/availability", async (req, res) => {
  const handle = handleSchema.safeParse(req.params.handle);
  if (!handle.success) throw new AuthError(400, "invalid_handle");
  const [existing] = await db
    .select({ id: userHandles.userId })
    .from(userHandles)
    .where(eq(userHandles.handle, handle.data))
    .limit(1);
  const available = existing
    ? existing.id === (await readViewerId(req))
    : handle.data !== reservedAdminHandle;
  res.json({ available });
});
router.get("/:handle", async (req, res) => {
  if (!handleSchema.safeParse(req.params.handle).success) {
    throw new AuthError(404, "profile_not_found");
  }
  const [profile] = await db
    .select({
      ...userSelection,
      ...publicProfileSelection,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, db.select({ id: userHandles.userId }).from(userHandles).where(eq(userHandles.handle, req.params.handle))));
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
  const { posts: reposts, repostedBy } = await profileReposts(profile, viewerId);
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
    // Plain reposts and the person's own quote posts, newest first.
    reposts,
    repostedBy,
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
      .where(eq(users.id, tx.select({ id: userHandles.userId }).from(userHandles).where(eq(userHandles.handle, handle.data))))
      .for("no key update");
    if (!target) throw new AuthError(404, "profile_not_found");
    if (target.id === viewer.id) throw new AuthError(400, "cannot_follow_self");
    if (follow) {
      const [inserted] = await tx
        .insert(userFollows)
        .values({ followerId: viewer.id, followingId: target.id })
        .onConflictDoNothing()
        .returning();
      if (inserted)
        await recordNotification(tx, {
          recipientId: target.id,
          actorId: viewer.id,
          kind: "follow",
          postId: null,
          subject: target.id,
        });
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
