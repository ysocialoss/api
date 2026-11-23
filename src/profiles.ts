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
import { authIdentities, connections, githubConnections, posts, profilePins, userDomains, users, userFollows, userHandles } from "./db/schema.ts";
import { publishAccountChange } from "./live-events.ts";
import { removeUser } from "./user-removal.ts";
import { profileReposts } from "./feed-entries.ts";
import { AuthError } from "./auth/provider.ts";
import { postSelection, serializePost } from "./post-data.ts";
import { banDetailsSelection, githubProfileSelection, postCountSelection, publicProfileSelection, userSelection } from "./user-data.ts";
import { recordNotification } from "./notification-events.ts";
import { blockState, notBlockedSql, requireNotBlocked } from "./blocks.ts";
import { badgeIconDirectory, isBadgeIcon } from "./profile-badges.ts";
import { generalPronounRecommendations, pronounRecommendations, pronounsLimit, pronounsSchema } from "./pronouns.ts";

const router = Router();
const handleSchema = z.string().regex(/^[a-z0-9_]{3,32}$/);
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.get("/pronouns/recommendations", (_req, res) => {
  res.json({
    languages: pronounRecommendations,
    general: generalPronounRecommendations,
    maxLength: pronounsLimit,
  });
});
router.get("/badge-icons/:icon", (req, res) => {
  const { icon } = req.params;
  if (!isBadgeIcon(icon)) throw new AuthError(404, "badge_icon_not_found");
  res.set({
    "Cache-Control": "public, max-age=86400",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  res.sendFile(icon + ".svg", { root: badgeIconDirectory });
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
      pronouns: pronounsSchema,
    })
    .partial()
    .refine((changes) => Object.keys(changes).length > 0)
    .safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_profile");
  const [profile] = await db
    .update(users)
    .set({ ...input.data, updatedAt: new Date() })
    .where(eq(users.id, viewer.id))
    .returning({
      handle: users.handle,
      displayName: users.displayName,
      bio: users.bio,
      pronouns: users.pronouns,
    });
  if (!profile) throw new AuthError(404, "profile_not_found");
  res.json(profile);
});
router.delete("/me", async (req, res) => {
  const viewer = await requireUser(req);
  const input = z.strictObject({ handle: handleSchema }).safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_confirmation");
  await db.transaction(async (tx) => {
    await tx.select({ id: authIdentities.id }).from(authIdentities)
      .where(eq(authIdentities.userId, viewer.id)).for("update");
    const [target] = await tx
      .select({
        id: users.id,
        handle: users.handle,
        role: users.role,
        avatarKey: users.avatarKey,
        bannerKey: users.bannerKey,
      })
      .from(users)
      .where(eq(users.id, viewer.id))
      .for("update");
    if (!target) return;
    if (target.handle !== input.data.handle) throw new AuthError(400, "invalid_confirmation");
    if (target.role === "admin") throw new AuthError(409, "protected_account");
    await removeUser(tx, target);
    await publishAccountChange(tx, target.id);
  });
  res.sendStatus(204);
});
router.get("/:handle/availability", async (req, res) => {
  const handle = handleSchema.safeParse(req.params.handle);
  if (!handle.success) throw new AuthError(400, "invalid_handle");
  const [existing] = await db
    .select({ id: userHandles.userId })
    .from(userHandles)
    .where(eq(userHandles.handle, handle.data))
    .limit(1);
  const available = !existing || existing.id === (await readViewerId(req));
  res.json({ available });
});
router.get("/:handle/card", async (req, res) => {
  const handle = handleSchema.safeParse(req.params.handle.toLowerCase());
  if (!handle.success) throw new AuthError(404, "profile_not_found");
  const [profile] = await db
    .select({
      ...userSelection,
      bio: users.bio,
      pronouns: users.pronouns,
      bannerCrop: users.bannerCrop,
      bannerUrl: sql<
        string | null
      >`case when ${users.bannerKey} is null then ${users.bannerExternalUrl} else '/api/' || ${users.bannerKey} end`,
      createdAt: users.createdAt,
      followerCount: sql<number>`(select count(*)::int from ${userFollows} where ${userFollows.followingId} = ${users.id})`,
      followingCount: sql<number>`(select count(*)::int from ${userFollows} where ${userFollows.followerId} = ${users.id})`,
      postCount: postCountSelection,
    })
    .from(users)
    .where(eq(users.handle, handle.data));
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
  res.json({
    profile,
    isFollowing: relationships.some((row) => row.followerId === viewerId),
    isFollowedBy: relationships.some((row) => row.followingId === viewerId),
    isSelf: viewerId === profile.id,
    signedIn: viewerId !== null,
  });
});
const connectionQuery = z.object({
  cursor: z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[0-9a-f-]{36}$/i).optional(),
});
const connectionPage = 50;

router.get("/:handle/:list", async (req, res, next) => {
  const list = z.enum(["followers", "following"]).safeParse(req.params.list);
  if (!list.success) return next();
  const handle = handleSchema.safeParse(req.params.handle.toLowerCase());
  const query = connectionQuery.safeParse(req.query);
  if (!handle.success) throw new AuthError(404, "profile_not_found");
  if (!query.success) throw new AuthError(400, "invalid_connection_query");
  const [profile] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.handle, handle.data), isNull(users.bannedAt)));
  if (!profile) throw new AuthError(404, "profile_not_found");
  const viewerId = await readViewerId(req);
  const followers = list.data === "followers";
  const [cursorTime, cursorId] = query.data.cursor?.split("|") ?? [];
  const other = followers ? userFollows.followerId : userFollows.followingId;
  const rows = await db.select({ ...userSelection, bio: users.bio, followedAt: userFollows.createdAt })
    .from(userFollows)
    .innerJoin(users, eq(users.id, other))
    .where(and(
      eq(followers ? userFollows.followingId : userFollows.followerId, profile.id),
      isNull(users.bannedAt),
      notBlockedSql(viewerId, other),
      cursorTime ? sql`(${userFollows.createdAt}, ${other}) < (${cursorTime}::timestamptz, ${cursorId}::uuid)` : undefined,
    ))
    .orderBy(desc(userFollows.createdAt), desc(other))
    .limit(connectionPage + 1);
  const page = rows.slice(0, connectionPage);
  const last = page.at(-1);
  const followed = viewerId && page.length
    ? new Set((await db.select({ id: userFollows.followingId }).from(userFollows).where(and(
      eq(userFollows.followerId, viewerId), inArray(userFollows.followingId, page.map(({ id }) => id)),
    ))).map(({ id }) => id))
    : new Set<string>();
  res.json({
    users: page.map(({ followedAt: _followedAt, ...user }) => ({
      ...user,
      isSelf: user.id === viewerId,
      isFollowing: followed.has(user.id),
    })),
    nextCursor: rows.length > connectionPage && last ? `${last.followedAt.toISOString()}|${last.id}` : null,
  });
});

router.get("/:handle", async (req, res) => {
  if (!handleSchema.safeParse(req.params.handle).success) {
    throw new AuthError(404, "profile_not_found");
  }
  const [profile] = await db
    .select({
      ...userSelection,
      ...publicProfileSelection,
      postCount: postCountSelection,
      isOg: sql<boolean>`${users.role} = 'og'`,
      badges: users.badges,
      github: githubProfileSelection,
      createdAt: users.createdAt,
      ...banDetailsSelection,
    })
    .from(users)
    .leftJoin(githubConnections, eq(githubConnections.userId, users.id))
    .where(eq(users.id, db.select({ id: userHandles.userId }).from(userHandles).where(eq(userHandles.handle, req.params.handle))));
  if (!profile) throw new AuthError(404, "profile_not_found");
  if (profile.banReason) {
    res.json({
      profile, isFollowing: false, isFollowedBy: false,
      posts: [], replies: [], reposts: [], repostedBy: {}, serverNow: new Date().toISOString(),
    });
    return;
  }
  const viewerId = await readViewerId(req);
  const linkedConnections = await db
    .select({
      provider: connections.provider,
      username: connections.username,
      displayName: connections.displayName,
      profileUrl: connections.profileUrl,
    })
    .from(connections)
    .where(eq(connections.userId, profile.id))
    .orderBy(connections.createdAt);
  const linkedDomains = await db
    .select({ domain: userDomains.domain })
    .from(userDomains)
    .where(and(eq(userDomains.userId, profile.id), isNotNull(userDomains.verifiedAt)))
    .orderBy(userDomains.verifiedAt, userDomains.domain);
  const blocks = await blockState(db, viewerId, profile.id);
  if (blocks.blocking || blocks.blockedBy) {
    res.json({
      profile, ...blocks, isFollowing: false, isFollowedBy: false,
      posts: [], replies: [], reposts: [], repostedBy: {}, serverNow: new Date().toISOString(),
    });
    return;
  }
  const [relationships, recent, replies, { posts: reposts, repostedBy }, [pinned]] = await Promise.all([
    viewerId
      ? db
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
      : Promise.resolve([]),
    db
      .select(postSelection(viewerId))
      .from(posts)
      .innerJoin(users, eq(users.id, posts.authorId))
      .where(and(eq(posts.authorId, profile.id), isNull(posts.parentId)))
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(20),
    db
      .select(postSelection(viewerId))
      .from(posts)
      .innerJoin(users, eq(users.id, posts.authorId))
      .where(and(eq(posts.authorId, profile.id), isNotNull(posts.parentId)))
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(20),
    profileReposts(profile, viewerId),
    db
      .select(postSelection(viewerId))
      .from(profilePins)
      .innerJoin(posts, eq(posts.id, profilePins.postId))
      .innerJoin(users, eq(users.id, posts.authorId))
      .where(eq(profilePins.userId, profile.id)),
  ]);
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
          .where(and(inArray(posts.id, ancestorIds), isNull(users.bannedAt)));
  const ancestorsById = new Map(
    ancestors.map((post) => [post.id, serializePost(post)]),
  );
  res.json({
    profile: { ...profile, connections: linkedConnections, domains: linkedDomains.map(({ domain }) => domain) },
    pinnedPost: pinned ? serializePost(pinned) : null,
    blocking: false,
    blockedBy: false,
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
    const [target] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, tx.select({ id: userHandles.userId }).from(userHandles).where(eq(userHandles.handle, handle.data))));
    if (!target) throw new AuthError(404, "profile_not_found");
    if (target.id === viewer.id) throw new AuthError(400, "cannot_follow_self");
    // Follow backs can arrive concurrently. Lock both accounts in the same order.
    await tx.select({ id: users.id }).from(users)
      .where(inArray(users.id, [viewer.id, target.id])).orderBy(users.id).for("no key update");
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
    if (follow) await requireNotBlocked(tx, viewer.id, target.id);
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
          kind: followsViewer ? "friend" : "follow",
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
