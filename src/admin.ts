import { Router } from "express";
import { count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { requireOrigin, requireSessionUser } from "./auth/request.ts";
import { db } from "./db/index.ts";
import { posts, userRole, users } from "./db/schema.ts";
import { publicProfileSelection, userSelection } from "./user-data.ts";
import { clearProfileMedia } from "./storage/media-lifecycle.ts";

import { env, reservedAdminHandle } from "./config.ts";
import type { Request } from "express";

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

async function requireStaff(req: Request) {
  const user = await requireSessionUser(req);
  if (user.role !== "admin" && user.role !== "moderator")
    throw new AuthError(403, "staff_required");
  return user;
}

router.get("/session", async (req, res) => {
  await requireStaff(req);
  res.sendStatus(204);
});

const userFields = {
  id: users.id,
  name: users.displayName,
  handle: users.handle,
  joined: users.createdAt,
  role: users.role,
};
const postFields = {
  id: posts.id,
  author: users.handle,
  content: posts.content,
  kind: sql<"Post" | "Reply">`case when ${posts.parentId} is null then 'Post' else 'Reply' end`,
  time: posts.createdAt,
};
const formatUser = <User extends { handle: string }>(user: User) => ({ ...user, handle: `@${user.handle}` });
const userSearch = (term: string) =>
  term ? sql`strpos(lower(${users.handle} || ' ' || ${users.displayName}), ${term}) > 0` : undefined;

const formatPost = <Post extends { author: string }>(post: Post) => ({ ...post, author: `@${post.author}` });

router.get("/overview", async (req, res) => {
  await requireStaff(req);
  const query = z.string().trim().max(255).default("").safeParse(req.query.q);
  if (!query.success) throw new AuthError(400, "invalid_search");
  const term = query.data.toLowerCase();
  const since = new Date(Date.now() - 86_400_000);
  const [recentUsers, recentPosts, [userCounts], [postCounts]] = await Promise.all([
    db.select({ ...userFields, avatarUrl: userSelection.avatarUrl }).from(users)
      .where(userSearch(term))
      .orderBy(desc(users.createdAt), desc(users.id)).limit(50),
    db.select(postFields).from(posts).innerJoin(users, eq(posts.authorId, users.id))
      .where(term ? sql`strpos(lower(${users.handle} || ' ' || ${posts.content}), ${term}) > 0` : undefined)
      .orderBy(desc(posts.createdAt), desc(posts.id)).limit(50),
    db.select({
      total: count(),
      today: sql<number>`count(*) filter (where ${users.createdAt} >= ${since.toISOString()})`.mapWith(Number),
    }).from(users),
    db.select({
      total: count(),
      today: sql<number>`count(*) filter (where ${posts.createdAt} >= ${since.toISOString()})`.mapWith(Number),
    }).from(posts),
  ]);
  res.json({
    recentUsers: recentUsers.map(formatUser),
    recentPosts: recentPosts.map(formatPost),
    metrics: [
      { label: "Users", value: String(userCounts.total), detail: `${userCounts.today} in the last 24 hours` },
      { label: "Posts and replies", value: String(postCounts.total), detail: `${postCounts.today} in the last 24 hours` },
    ],
  });
});

router.get("/user/:id", async (req, res) => {
  await requireStaff(req);
  const { id } = req.params;
  if (!z.uuid().safeParse(id).success) throw new AuthError(404, "user_not_found");
  const [user] = await db.select({
    ...userFields,
    ...publicProfileSelection,
    avatarUrl: userSelection.avatarUrl,
    colour: users.colour,
    updatedAt: users.updatedAt,
  }).from(users).where(eq(users.id, id));
  if (!user) throw new AuthError(404, "user_not_found");
  res.json({ ...formatUser(user), kind: "user" });
});

router.get("/post/:id", async (req, res) => {
  await requireStaff(req);
  const { id } = req.params;
  if (!z.uuid().safeParse(id).success) throw new AuthError(404, "post_not_found");
  const [post] = await db.select(postFields).from(posts)
    .innerJoin(users, eq(posts.authorId, users.id)).where(eq(posts.id, id));
  if (!post) throw new AuthError(404, "post_not_found");
  res.json({ ...formatPost(post), kind: "post", type: post.kind });
});

const userListQuery = z.object({
  q: z.string().trim().max(255).default(""),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
});
const pageSize = 25;

router.get("/users", async (req, res) => {
  const viewer = await requireStaff(req);
  const query = userListQuery.safeParse(req.query);
  if (!query.success) throw new AuthError(400, "invalid_user_query");
  const { q, page } = query.data;
  const rows = await db.select({
    ...userFields,
    avatarUrl: userSelection.avatarUrl,
    bio: users.bio,
  }).from(users)
    .where(userSearch(q.replace(/^@/, "").toLowerCase()))
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(pageSize + 1).offset((page - 1) * pageSize);
  res.json({
    users: rows.slice(0, pageSize).map((user) => ({
      ...formatUser(user),
      canEditRole: viewer.role === "admin" && viewer.id !== user.id && user.handle !== reservedAdminHandle,
    })),
    hasNextPage: rows.length > pageSize,
    canEditProfiles: viewer.role === "admin",
  });
});

async function requireAdminWrite(req: Request) {
  const viewer = await requireStaff(req);
  if (!env.ADMIN_ORIGIN) throw new AuthError(503, "admin_login_not_configured");
  requireOrigin(req, env.ADMIN_ORIGIN);
  if (viewer.role !== "admin") throw new AuthError(403, "admin_required");
  return viewer;
}

const profileChange = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("clearBio") }),
  z.strictObject({ action: z.literal("clearAvatar") }),
  z.strictObject({ action: z.literal("clearBanner") }),
  z.strictObject({ action: z.literal("changeUsername"), value: z.string().regex(/^[a-z0-9_]{3,32}$/) }),
  z.strictObject({ action: z.literal("changeName"), value: z.string().trim().min(1).max(80) }),
]);

router.patch("/users/:id/profile", async (req, res) => {
  const viewer = await requireAdminWrite(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "user_not_found");
  const input = profileChange.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_profile_change");
  const change = input.data;
  const targetId = id.data.toLowerCase();

  const updated = await db.transaction(async (tx) => {
    const locked = await tx.select({
      id: users.id, handle: users.handle, role: users.role,
      avatarKey: users.avatarKey, bannerKey: users.bannerKey,
    }).from(users).where(inArray(users.id, [viewer.id, targetId])).orderBy(users.id).for("update");
    if (locked.find((user) => user.id === viewer.id)?.role !== "admin")
      throw new AuthError(403, "admin_required");
    const target = locked.find((user) => user.id === targetId);
    if (!target) throw new AuthError(404, "user_not_found");
    if (change.action === "clearAvatar" || change.action === "clearBanner") {
      await clearProfileMedia(tx, target, change.action === "clearAvatar" ? "avatar" : "banner");
    } else {
      if (change.action === "changeUsername" && (target.handle === reservedAdminHandle || change.value === reservedAdminHandle))
        throw new AuthError(409, "reserved_username");
      const fields = change.action === "changeUsername" ? { handle: change.value }
        : change.action === "changeName" ? { displayName: change.value } : { bio: "" };
      await tx.update(users).set({ ...fields, updatedAt: new Date() }).where(eq(users.id, target.id));
    }
    const [user] = await tx.select({
      ...userFields, avatarUrl: userSelection.avatarUrl, bio: users.bio,
    }).from(users).where(eq(users.id, target.id));
    return formatUser(user);
  });
  res.json({
    ...updated,
    canEditRole: viewer.id !== updated.id && updated.handle.slice(1) !== reservedAdminHandle,
  });
});

const roleUpdate = z.strictObject({
  ids: z.array(z.uuid()).min(1).max(pageSize),
  role: z.enum(userRole.enumValues),
});

router.patch("/users/roles", async (req, res) => {
  const viewer = await requireAdminWrite(req);
  const input = roleUpdate.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_role_update");
  const ids = [...new Set(input.data.ids.map((id) => id.toLowerCase()))];
  if (ids.includes(viewer.id)) throw new AuthError(409, "own_role_protected");

  const updated = await db.transaction(async (tx) => {
    // Lock the acting admin and all targets in ID order so role changes serialize.
    const locked = await tx.select(userFields).from(users)
      .where(inArray(users.id, [viewer.id, ...ids])).orderBy(users.id).for("update");
    const actor = locked.find((user) => user.id === viewer.id);
    if (actor?.role !== "admin") throw new AuthError(403, "admin_required");
    const targets = locked.filter((user) => user.id !== viewer.id);
    if (targets.length !== ids.length) throw new AuthError(404, "user_not_found");
    if (targets.some((user) => user.handle === reservedAdminHandle))
      throw new AuthError(409, "reserved_role_protected");
    return tx.update(users).set({ role: input.data.role })
      .where(inArray(users.id, ids)).returning({ id: users.id, role: users.role });
  });
  res.json({ users: updated });
});

export default router;
