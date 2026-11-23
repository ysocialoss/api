import { Router } from "express";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { requireAdminWrite, requireStaff } from "./admin-access.ts";
import adminActivity from "./admin-activity.ts";
import adminSystem from "./admin-system.ts";
import adminReports, { openReportCount } from "./admin-reports.ts";
import { db } from "./db/index.ts";
import { authIdentities, githubConnections, moderationActivity, pollVotes, postImageFlags, postImages, posts, userRole, users } from "./db/schema.ts";
import { githubProfileSelection, publicProfileSelection, userSelection } from "./user-data.ts";
import { clearProfileMedia, flushMediaDeletions, queueDeletion } from "./storage/media-lifecycle.ts";
import { affectedPostIds, publishAccountChange, publishLiveChange, publishWaitlistChange } from "./live-events.ts";
import { serveLiveStream } from "./live.ts";
import { removePost } from "./post-removal.ts";
import { editPost, postContentSchema } from "./post-edit.ts";
import { publishUserPostVisibility, removeUser } from "./user-removal.ts";
import { badgeDetails, badgeIcons, badgePresets } from "./profile-badges.ts";
import { pronounsSchema } from "./pronouns.ts";
import { imageFlagCutoff, maxPostImages, postImageUploadBody, processPostImage, sendPostImage } from "./post-images.ts";
import { getAvatar } from "./storage/r2.ts";
import { randomUUID } from "node:crypto";

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.use("/reports", adminReports);
router.use("/activity", adminActivity);
router.use("/system", adminSystem);

router.get("/session", async (req, res) => {
  await requireStaff(req);
  res.sendStatus(204);
});

router.get("/post-images/:id", async (req, res) => {
  await requireStaff(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "post_image_not_found");
  const [image] = await db.select({ data: postImages.data }).from(postImages)
    .where(and(eq(postImages.id, id.data), isNotNull(postImages.postId)));
  if (!image) throw new AuthError(404, "post_image_not_found");
  sendPostImage(res, image.data);
});

const userFields = {
  id: users.id,
  name: users.displayName,
  handle: users.handle,
  joined: users.createdAt,
  role: users.role,
  badges: users.badges,
  bannedAt: users.bannedAt,
  banReason: users.banReason,
};
const canModerateAccount = (viewer: { id: string; role: string }, target: { id: string }) =>
  viewer.role === "admin" && viewer.id !== target.id;
const postFields = {
  id: posts.id,
  authorId: users.id,
  author: users.handle,
  content: posts.content,
  gif: posts.gif,
  imageIds: posts.imageIds,
  voiceUrl: sql<string | null>`${posts.voice}->>'url'`,
  hasPoll: sql<boolean>`${posts.poll} is not null`,
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
  const [recentUsers, recentPosts, [userCounts], [postCounts], openReports] = await Promise.all([
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
    openReportCount(),
  ]);
  res.json({
    recentUsers: recentUsers.map(formatUser),
    recentPosts: recentPosts.map(formatPost),
    metrics: [
      { label: "Users", value: String(userCounts.total), detail: `${userCounts.today} in the last 24 hours` },
      { label: "Posts and replies", value: String(postCounts.total), detail: `${postCounts.today} in the last 24 hours` },
      { label: "Open reports", value: String(openReports.total), detail: `${openReports.today} in the last 24 hours` },
    ],
  });
});

router.get("/user/:id", async (req, res) => {
  const viewer = await requireStaff(req);
  const { id } = req.params;
  if (!z.uuid().safeParse(id).success) throw new AuthError(404, "user_not_found");
  const [user] = await db.select({
    ...userFields,
    ...publicProfileSelection,
    github: githubProfileSelection,
    avatarUrl: userSelection.avatarUrl,
    colour: users.colour,
    updatedAt: users.updatedAt,
  }).from(users).leftJoin(githubConnections, eq(githubConnections.userId, users.id)).where(eq(users.id, id));
  if (!user) throw new AuthError(404, "user_not_found");
  res.json({
    ...formatUser(user), kind: "user",
    canEditProfile: viewer.role === "admin",
    canEditBadges: viewer.role === "admin",
    canModerateAccount: canModerateAccount(viewer, user),
  });
});

router.get("/post/:id", async (req, res) => {
  const viewer = await requireStaff(req);
  const { id } = req.params;
  if (!z.uuid().safeParse(id).success) throw new AuthError(404, "post_not_found");
  const [post] = await db.select({
    ...postFields,
    parentId: posts.parentId,
    quotedPostId: posts.quotedPostId,
    pollTitle: sql<string | null>`${posts.poll}->>'title'`,
  }).from(posts)
    .innerJoin(users, eq(posts.authorId, users.id)).where(eq(posts.id, id));
  if (!post) throw new AuthError(404, "post_not_found");
  res.json({ ...formatPost(post), kind: "post", type: post.kind, canRemove: viewer.role === "admin" });
});

const userListQuery = z.object({
  q: z.string().trim().max(255).default(""),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
});
const pageSize = 25;

router.get("/flags", async (req, res) => {
  const viewer = await requireStaff(req);
  const input = userListQuery.pick({ page: true }).safeParse(req.query);
  if (!input.success) throw new AuthError(400, "invalid_flags_query");
  const rows = await db.select({
    id: postImageFlags.id,
    uploaderId: postImageFlags.uploaderId,
    handle: users.handle,
    filename: postImageFlags.filename,
    confidence: postImageFlags.confidence,
    createdAt: postImageFlags.createdAt,
  }).from(postImageFlags).innerJoin(users, eq(users.id, postImageFlags.uploaderId))
    .where(gt(postImageFlags.createdAt, imageFlagCutoff()))
    .orderBy(desc(postImageFlags.createdAt), desc(postImageFlags.id))
    .limit(pageSize + 1).offset((input.data.page - 1) * pageSize);
  res.json({ flags: rows.slice(0, pageSize), hasNextPage: rows.length > pageSize, canRemove: viewer.role === "admin" });
});

router.get("/flags/:id/image", async (req, res) => {
  await requireStaff(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "flag_not_found");
  const [flag] = await db.select({ data: postImageFlags.data, objectKey: postImageFlags.objectKey }).from(postImageFlags)
    .where(and(eq(postImageFlags.id, id.data), gt(postImageFlags.createdAt, imageFlagCutoff())));
  if (!flag) throw new AuthError(404, "flag_not_found");
  if (flag.data) return sendPostImage(res, flag.data);
  if (!flag.objectKey) throw new AuthError(404, "flag_not_found");
  sendPostImage(res, Buffer.from(await getAvatar(flag.objectKey)));
});

router.delete("/flags/:id", async (req, res) => {
  const viewer = await requireAdminWrite(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "flag_not_found");
  const objectKey = await db.transaction(async (tx) => {
    const [actor] = await tx.select({ role: users.role, handle: users.handle, bannedAt: users.bannedAt })
      .from(users).where(eq(users.id, viewer.id)).for("share");
    if (actor?.role !== "admin" || actor.bannedAt) throw new AuthError(403, "admin_required");
    const [flag] = await tx.delete(postImageFlags).where(eq(postImageFlags.id, id.data))
      .returning({ uploaderId: postImageFlags.uploaderId, objectKey: postImageFlags.objectKey, filename: postImageFlags.filename });
    if (!flag) return;
    const [uploader] = await tx.select({ handle: users.handle }).from(users).where(eq(users.id, flag.uploaderId));
    await tx.insert(moderationActivity).values({
      actorId: viewer.id, actorHandle: actor.handle, targetId: flag.uploaderId,
      targetHandle: uploader?.handle ?? "", action: "removeImageFlag", detail: flag.filename ?? id.data,
    });
    return flag.objectKey;
  });
  if (objectKey) await flushMediaDeletions(objectKey);
  res.sendStatus(204);
});

router.get("/waitlist", async (req, res) => {
  const viewer = await requireStaff(req);
  const input = userListQuery.safeParse(req.query);
  if (!input.success) throw new AuthError(400, "invalid_waitlist_query");
  const { q, page } = input.data;
  const rows = await db.select({ ...userFields, avatarUrl: userSelection.avatarUrl }).from(users)
    .where(and(isNull(users.approvedAt), isNull(users.bannedAt), userSearch(q.replace(/^@/, "").toLowerCase())))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(pageSize + 1).offset((page - 1) * pageSize);
  res.json({ users: rows.slice(0, pageSize).map(formatUser), hasNextPage: rows.length > pageSize, canApprove: viewer.role === "admin" });
});
router.get("/waitlist/live", async (req, res) => {
  await requireStaff(req);
  serveLiveStream(req, res, "waitlist");
});

const contentQuery = userListQuery.extend({
  type: z.enum(["all", "post", "reply"]).default("all"),
  author: z.string().trim().toLowerCase().regex(/^(?:@?[a-z0-9_]{3,32})?$/).default(""),
  authorId: z.uuid().optional(),
  period: z.enum(["all", "1d", "7d", "30d"]).default("all"),
  sort: z.enum(["newest", "oldest", "author_asc", "author_desc"]).default("newest"),
});
const contentOrder = {
  newest: [desc(posts.createdAt), desc(posts.id)],
  oldest: [asc(posts.createdAt), asc(posts.id)],
  author_asc: [asc(users.handle), desc(posts.createdAt), desc(posts.id)],
  author_desc: [desc(users.handle), desc(posts.createdAt), desc(posts.id)],
};
const contentPeriodDays = { "1d": 1, "7d": 7, "30d": 30 };

router.get("/posts", async (req, res) => {
  const viewer = await requireStaff(req);
  const input = contentQuery.safeParse(req.query);
  if (!input.success) throw new AuthError(400, "invalid_post_query");
  const { q, page, type, author, authorId, period, sort } = input.data;
  const term = q.replace(/^@/, "").toLowerCase();
  const since = period === "all" ? undefined : new Date(Date.now() - contentPeriodDays[period] * 86_400_000);
  const rows = await db.select(postFields).from(posts).innerJoin(users, eq(posts.authorId, users.id))
    .where(and(
      term ? sql`strpos(lower(${users.handle} || ' ' || ${posts.content}), ${term}) > 0` : undefined,
      type === "post" ? isNull(posts.parentId) : type === "reply" ? isNotNull(posts.parentId) : undefined,
      author ? eq(users.handle, author.replace(/^@/, "")) : undefined,
      authorId ? eq(posts.authorId, authorId) : undefined,
      since ? gte(posts.createdAt, since) : undefined,
    ))
    .orderBy(...contentOrder[sort])
    .limit(pageSize + 1).offset((page - 1) * pageSize);
  res.json({ posts: rows.slice(0, pageSize).map(formatPost), hasNextPage: rows.length > pageSize, canModerate: viewer.role === "admin" });
});

router.get("/users", async (req, res) => {
  const viewer = await requireStaff(req);
  const query = userListQuery.safeParse(req.query);
  if (!query.success) throw new AuthError(400, "invalid_user_query");
  const { q, page } = query.data;
  const rows = await db.select({
    ...userFields,
    avatarUrl: userSelection.avatarUrl,
    bio: users.bio,
    pronouns: users.pronouns,
    github: githubProfileSelection,
  }).from(users)
    .leftJoin(githubConnections, eq(githubConnections.userId, users.id))
    .where(userSearch(q.replace(/^@/, "").toLowerCase()))
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(pageSize + 1).offset((page - 1) * pageSize);
  res.json({
    users: rows.slice(0, pageSize).map((user) => ({
      ...formatUser(user),
      canEditRole: canModerateAccount(viewer, user),
      canModerateAccount: canModerateAccount(viewer, user),
    })),
    hasNextPage: rows.length > pageSize,
    canEditProfiles: viewer.role === "admin",
    canEditBadges: viewer.role === "admin",
  });
});

const accountAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("ban"), reason: z.string().trim().min(1).max(280).refine((value) => !value.includes("\u0000")) }),
  z.strictObject({ action: z.literal("unban") }),
  z.strictObject({ action: z.literal("remove") }),
]);

router.patch("/users/:id/account", async (req, res) => {
  const viewer = await requireAdminWrite(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "user_not_found");
  const input = accountAction.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_account_action");
  const { action } = input.data;
  const targetId = id.data.toLowerCase();
  if (targetId === viewer.id) throw new AuthError(409, "protected_account");
  await db.transaction(async (tx) => {
    // OAuth locks the provider identity before it locks the user profile.
    if (action === "remove") {
      await tx.select({ id: authIdentities.id }).from(authIdentities)
        .where(eq(authIdentities.userId, targetId)).for("update");
    }
    const locked = await tx.select({
      ...userFields, approvedAt: users.approvedAt,
      avatarKey: users.avatarKey, bannerKey: users.bannerKey,
    }).from(users).where(inArray(users.id, [viewer.id, targetId])).orderBy(users.id).for("update");
    const actor = locked.find((user) => user.id === viewer.id);
    if (actor?.role !== "admin" || actor.bannedAt) throw new AuthError(403, "admin_required");
    const target = locked.find((user) => user.id === targetId);
    if (!target) {
      if (action === "remove") return;
      throw new AuthError(404, "user_not_found");
    }
    if (!canModerateAccount(actor, target)) throw new AuthError(409, "protected_account");
    if (action === "remove") {
      await removeUser(tx, target);
    } else if (input.data.action === "ban" && !target.bannedAt) {
      await tx.update(users).set({
        bannedAt: new Date(), banReason: input.data.reason,
      }).where(eq(users.id, target.id));
    } else if (action === "unban" && target.bannedAt) {
      await tx.update(users).set({ bannedAt: null, banReason: null }).where(eq(users.id, target.id));
    } else {
      return;
    }
    await tx.insert(moderationActivity).values({
      actorId: actor.id, actorHandle: actor.handle, targetId: target.id, targetHandle: target.handle,
      action: action === "ban" ? "banUser" : action === "unban" ? "unbanUser" : "removeUser",
      detail: input.data.action === "ban" ? input.data.reason : null,
    });
    await publishAccountChange(tx, target.id);
    if (action !== "remove") await publishUserPostVisibility(tx, target.id);
    if (!target.approvedAt) await publishWaitlistChange(tx);
  });
  res.sendStatus(204);
});

router.post("/waitlist/:id/approve", async (req, res) => {
  const viewer = await requireAdminWrite(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "user_not_found");
  const targetId = id.data.toLowerCase();
  await db.transaction(async (tx) => {
    const locked = await tx.select({
      id: users.id, role: users.role, handle: users.handle, approvedAt: users.approvedAt, bannedAt: users.bannedAt,
    }).from(users).where(inArray(users.id, [viewer.id, targetId])).orderBy(users.id).for("update");
    const actor = locked.find((user) => user.id === viewer.id);
    if (actor?.role !== "admin" || actor.bannedAt) throw new AuthError(403, "admin_required");
    const target = locked.find((user) => user.id === targetId);
    if (!target) throw new AuthError(404, "user_not_found");
    if (target.bannedAt) throw new AuthError(409, "account_banned");
    if (target.approvedAt) return;
    const approvedAt = new Date();
    await tx.update(users).set({ approvedAt }).where(eq(users.id, target.id));
    await tx.insert(moderationActivity).values({
      actorId: actor.id, actorHandle: actor.handle, targetId: target.id, targetHandle: target.handle, action: "approveUser",
    });
    await publishWaitlistChange(tx, target.id);
  });
  res.sendStatus(204);
});

router.patch("/posts/:id", async (req, res) => {
  const viewer = await requireAdminWrite(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "post_not_found");
  const input = postContentSchema.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_content");

  await db.transaction(async (tx) => {
    const [actor] = await tx.select({ role: users.role, handle: users.handle, bannedAt: users.bannedAt })
      .from(users).where(eq(users.id, viewer.id)).for("share");
    if (actor?.role !== "admin" || actor.bannedAt) throw new AuthError(403, "admin_required");
    const { authorId, changed } = await editPost(tx, { id: id.data, content: input.data.content, editor: { kind: "admin" } });
    if (!changed) return;
    const [author] = await tx.select({ handle: users.handle }).from(users).where(eq(users.id, authorId));
    await tx.insert(moderationActivity).values({
      actorId: viewer.id, actorHandle: actor.handle, targetId: id.data,
      targetHandle: author?.handle ?? "", action: "editPostText",
    });
  });
  res.sendStatus(204);
});

router.delete("/posts/:id", async (req, res) => {
  const viewer = await requireAdminWrite(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "post_not_found");
  const removed = await db.transaction(async (tx) => {
    const [actor] = await tx.select({ role: users.role, handle: users.handle, bannedAt: users.bannedAt }).from(users)
      .where(eq(users.id, viewer.id)).for("share");
    if (actor?.role !== "admin" || actor.bannedAt) throw new AuthError(403, "admin_required");
    const deleted = await removePost(tx, id.data);
    if (!deleted) throw new AuthError(404, "post_not_found");
    const [author] = await tx.select({ handle: users.handle }).from(users)
      .where(eq(users.id, deleted.authorId));
    await tx.insert(moderationActivity).values({
      actorId: viewer.id, actorHandle: actor.handle,
      targetId: id.data, targetHandle: author?.handle ?? "",
      action: "removePost",
    });
    return deleted;
  });
  if (removed.voice) await flushMediaDeletions(removed.voice.key);
  res.sendStatus(204);
});

const postImageId = z.uuid().transform((id) => id.toLowerCase());
const postImageChange = z.object({ id: z.uuid(), imageId: postImageId.optional() });

// Omitting the image ID appends an image. Supplying it replaces that attachment.
router.post("/posts/:id/attachments/images{/:imageId}", async (req, res, next) => {
  res.locals.uploaderId = (await requireAdminWrite(req)).id;
  next();
}, postImageUploadBody, async (req, res) => {
  const input = postImageChange.safeParse(req.params);
  if (!input.success) throw new AuthError(404, "attachment_not_found");
  const { id, imageId } = input.data;
  const uploaderId: string = res.locals.uploaderId;
  await processPostImage(
    { body: req.body, uploaderId, filename: req.get("x-post-image-name") },
    (data) => db.transaction(async (tx) => {
      const [target] = await tx.select({ authorId: posts.authorId }).from(posts).where(eq(posts.id, id));
      if (!target) throw new AuthError(404, "post_not_found");
      // Lock users before the post, as account removal locks users before cascading to posts.
      const locked = await tx.select({ id: users.id, role: users.role, handle: users.handle, bannedAt: users.bannedAt })
        .from(users).where(inArray(users.id, [uploaderId, target.authorId])).orderBy(users.id).for("share");
      const actor = locked.find((user) => user.id === uploaderId);
      if (actor?.role !== "admin" || actor.bannedAt) throw new AuthError(403, "admin_required");
      const [post] = await tx.select({ authorId: posts.authorId, imageIds: posts.imageIds })
        .from(posts).where(and(eq(posts.id, id), eq(posts.authorId, target.authorId))).for("update");
      if (!post) throw new AuthError(404, "post_not_found");
      if (imageId && !post.imageIds.includes(imageId)) throw new AuthError(404, "attachment_not_found");
      if (!imageId && post.imageIds.length >= maxPostImages) throw new AuthError(409, "post_image_limit");

      // Published images follow the post author's visibility and account lifecycle.
      const [saved] = await tx.insert(postImages)
        .values({ postId: id, uploaderId: post.authorId, data, expiresAt: new Date() })
        .returning({ id: postImages.id });
      const imageIds = imageId
        ? post.imageIds.map((current) => current === imageId ? saved.id : current)
        : [...post.imageIds, saved.id];
      await tx.update(posts).set({ imageIds }).where(eq(posts.id, id));
      if (imageId) await tx.delete(postImages).where(and(eq(postImages.postId, id), eq(postImages.id, imageId)));
      await tx.insert(moderationActivity).values({
        actorId: uploaderId, actorHandle: actor.handle, targetId: id,
        targetHandle: locked.find((user) => user.id === post.authorId)?.handle ?? "",
        action: imageId ? "replaceImage" : "addImage",
      });
      await publishLiveChange(tx, await affectedPostIds(tx, id));
    }),
  );
  res.sendStatus(204);
});

router.delete("/posts/:id/attachments/:kind{/:imageId}", async (req, res) => {
  const viewer = await requireAdminWrite(req);
  const id = z.uuid().safeParse(req.params.id);
  const kind = z.enum(["gif", "voice", "images", "all"]).safeParse(req.params.kind);
  const image = postImageId.optional().safeParse(req.params.imageId);
  if (!id.success || !kind.success || !image.success || (image.data && kind.data !== "images"))
    throw new AuthError(404, "attachment_not_found");
  const attachmentKind = kind.data;
  const imageId = image.data;

  const voiceKey = await db.transaction(async (tx) => {
    const [actor] = await tx.select({ role: users.role, handle: users.handle, bannedAt: users.bannedAt }).from(users)
      .where(eq(users.id, viewer.id)).for("share");
    if (actor?.role !== "admin" || actor.bannedAt) throw new AuthError(403, "admin_required");
    const [post] = await tx.select({
      authorId: posts.authorId,
      gif: posts.gif,
      voice: posts.voice,
      imageIds: posts.imageIds,
      hasPoll: sql<boolean>`${posts.poll} is not null`,
      hasText: sql<boolean>`${posts.content} ~ '[^[:space:]]'`,
    }).from(posts).where(eq(posts.id, id.data)).for("update");
    if (!post) throw new AuthError(404, "post_not_found");
    const clearAll = attachmentKind === "all";
    const removeGif = clearAll || attachmentKind === "gif";
    const removeVoice = clearAll || attachmentKind === "voice";
    const removeImages = clearAll || attachmentKind === "images";
    const remainingImages = !removeImages ? post.imageIds : imageId ? post.imageIds.filter((id) => id !== imageId) : [];
    const hasAttachment = (removeGif && post.gif) || (removeVoice && post.voice) ||
      remainingImages.length < post.imageIds.length || (clearAll && post.hasPoll);
    if (!hasAttachment) return;
    const keepsAttachment = (!clearAll && post.hasPoll) || (!removeGif && post.gif) ||
      (!removeVoice && post.voice) || remainingImages.length > 0;
    if (!post.hasText && !keepsAttachment)
      throw new AuthError(409, "attachment_required");

    const fields = {
      gif: removeGif ? null : undefined,
      voice: removeVoice ? null : undefined,
      imageIds: removeImages ? remainingImages : undefined,
      poll: clearAll ? null : undefined,
    };
    await tx.update(posts).set(fields).where(eq(posts.id, id.data));
    if (removeImages) await tx.delete(postImages)
      .where(and(eq(postImages.postId, id.data), imageId ? eq(postImages.id, imageId) : undefined));
    if (clearAll && post.hasPoll) await tx.delete(pollVotes).where(eq(pollVotes.postId, id.data));
    const key = removeVoice ? post.voice?.key : undefined;
    if (key) await queueDeletion(tx, key);
    const [author] = await tx.select({ handle: users.handle }).from(users).where(eq(users.id, post.authorId));
    await tx.insert(moderationActivity).values({
      actorId: viewer.id, actorHandle: actor.handle, targetId: id.data,
      targetHandle: author?.handle ?? "",
      action: imageId ? "removeImage" :
        { all: "clearAttachments", gif: "removeGif", voice: "removeVoice", images: "removeImages" }[attachmentKind],
    });
    await publishLiveChange(tx, await affectedPostIds(tx, id.data));
    return key;
  });
  if (voiceKey) await flushMediaDeletions(voiceKey);
  res.sendStatus(204);
});

const nameChange = z.strictObject({ action: z.literal("changeName"), value: z.string().trim().min(1).max(80) });
const bioChange = z.strictObject({ action: z.literal("changeBio"), value: z.string().trim().min(1).max(160) });
const profileChange = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("clearBio") }),
  z.strictObject({ action: z.literal("clearAvatar") }),
  z.strictObject({ action: z.literal("clearBanner") }),
  z.strictObject({ action: z.literal("changeUsername"), value: z.string().regex(/^[a-z0-9_]{3,32}$/) }),
  nameChange,
  bioChange,
  z.strictObject({ action: z.literal("changePronouns"), value: pronounsSchema }),
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
      id: users.id, handle: users.handle, role: users.role, bannedAt: users.bannedAt,
      avatarKey: users.avatarKey, bannerKey: users.bannerKey,
    }).from(users).where(inArray(users.id, [viewer.id, targetId])).orderBy(users.id).for("update");
    const actor = locked.find((user) => user.id === viewer.id);
    if (actor?.role !== "admin" || actor.bannedAt)
      throw new AuthError(403, "admin_required");
    const target = locked.find((user) => user.id === targetId);
    if (!target) throw new AuthError(404, "user_not_found");
    if (change.action === "clearAvatar" || change.action === "clearBanner") {
      await clearProfileMedia(tx, target, change.action === "clearAvatar" ? "avatar" : "banner");
    } else {
      const fields = change.action === "changeUsername" ? { handle: change.value }
        : change.action === "changeName" ? { displayName: change.value }
        : change.action === "changePronouns" ? { pronouns: change.value }
        : { bio: change.action === "changeBio" ? change.value : "" };
      await tx.update(users).set({ ...fields, updatedAt: new Date() }).where(eq(users.id, target.id));
    }
    const [user] = await tx.select({
      ...userFields, avatarUrl: userSelection.avatarUrl, bio: users.bio, pronouns: users.pronouns,
      github: githubProfileSelection,
    }).from(users).leftJoin(githubConnections, eq(githubConnections.userId, users.id)).where(eq(users.id, target.id));
    await tx.insert(moderationActivity).values({
      actorId: actor.id, actorHandle: actor.handle, targetId: target.id, targetHandle: target.handle,
      action: change.action, detail: change.action === "changeUsername" ? `@${target.handle} → @${user.handle}` : null,
    });
    return formatUser(user);
  });
  res.json({
    ...updated,
    canEditRole: canModerateAccount(viewer, updated),
    canModerateAccount: canModerateAccount(viewer, updated),
  });
});

const userIds = z.array(z.uuid()).min(1).max(pageSize);
const bulkProfileChange = z.discriminatedUnion("action", [
  nameChange.extend({ ids: userIds }),
  bioChange.extend({ ids: userIds }),
]);

router.patch("/users/profiles", async (req, res) => {
  const viewer = await requireAdminWrite(req);
  const input = bulkProfileChange.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_profile_change");
  const { action, value } = input.data;
  const ids = new Set(input.data.ids.map((id) => id.toLowerCase()));

  const updated = await db.transaction(async (tx) => {
    const locked = await tx.select({
      ...userFields, bio: users.bio,
    }).from(users).where(inArray(users.id, [...new Set([viewer.id, ...ids])]))
      .orderBy(users.id).for("update");
    const actor = locked.find((user) => user.id === viewer.id);
    if (actor?.role !== "admin" || actor.bannedAt) throw new AuthError(403, "admin_required");
    const targets = locked.filter((user) => ids.has(user.id));
    if (targets.length !== ids.size) throw new AuthError(404, "user_not_found");
    const changed = targets.filter((user) => (action === "changeName" ? user.name : user.bio) !== value);
    if (!changed.length) return [];
    const fields = action === "changeName" ? { displayName: value } : { bio: value };
    const saved = await tx.update(users).set({ ...fields, updatedAt: new Date() })
      .where(inArray(users.id, changed.map((user) => user.id)))
      .returning({ id: users.id, name: users.displayName, bio: users.bio });
    await tx.insert(moderationActivity).values(changed.map((user) => ({
      actorId: actor.id, actorHandle: actor.handle, targetId: user.id, targetHandle: user.handle, action,
    })));
    return saved;
  });
  res.json({ users: updated });
});

const roleUpdate = z.strictObject({
  ids: userIds,
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
    if (actor?.role !== "admin" || actor.bannedAt) throw new AuthError(403, "admin_required");
    const targets = locked.filter((user) => user.id !== viewer.id);
    if (targets.length !== ids.length) throw new AuthError(404, "user_not_found");
    const changed = targets.filter((user) => user.role !== input.data.role);
    if (changed.length) await tx.insert(moderationActivity).values(changed.map((user) => ({
      actorId: actor.id, actorHandle: actor.handle, targetId: user.id, targetHandle: user.handle,
      action: "changeRole", detail: `${user.role} → ${input.data.role}`,
    })));
    return tx.update(users).set({ role: input.data.role })
      .where(inArray(users.id, ids)).returning({ id: users.id, role: users.role });
  });
  res.json({ users: updated });
});

router.get("/badge-options", async (req, res) => {
  const viewer = await requireStaff(req);
  if (viewer.role !== "admin") throw new AuthError(403, "admin_required");
  res.json({ icons: badgeIcons, presets: badgePresets });
});

const badgeChange = z.discriminatedUnion("action", [
  badgeDetails.extend({ action: z.literal("add") }),
  z.strictObject({ action: z.literal("remove"), id: z.uuid() }),
]);
const maxProfileBadges = 10;

router.patch("/users/:id/badges", async (req, res) => {
  const viewer = await requireAdminWrite(req);
  const targetId = z.uuid().safeParse(req.params.id);
  if (!targetId.success) throw new AuthError(404, "user_not_found");
  const input = badgeChange.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_badge");
  const change = input.data;
  const id = targetId.data.toLowerCase();

  const badges = await db.transaction(async (tx) => {
    const locked = await tx.select(userFields).from(users)
      .where(inArray(users.id, [viewer.id, id])).orderBy(users.id).for("update");
    const actor = locked.find((user) => user.id === viewer.id);
    if (actor?.role !== "admin" || actor.bannedAt) throw new AuthError(403, "admin_required");
    const target = locked.find((user) => user.id === id);
    if (!target) throw new AuthError(404, "user_not_found");

    if (change.action === "add") {
      const { icon, tooltip } = change;
      if (target.badges.some((badge) => badge.icon === icon && badge.tooltip === tooltip)) return target.badges;
      if (target.badges.length >= maxProfileBadges) throw new AuthError(400, "badge_limit_reached");
      const updated = [...target.badges, { id: randomUUID(), icon, tooltip }];
      await tx.update(users).set({ badges: updated }).where(eq(users.id, id));
      await tx.insert(moderationActivity).values({
        actorId: actor.id, actorHandle: actor.handle, targetId: id, targetHandle: target.handle,
        action: "addBadge", detail: `${icon}: ${tooltip}`,
      });
      return updated;
    }

    const removed = target.badges.find((badge) => badge.id === change.id);
    if (!removed) return target.badges;
    const updated = target.badges.filter((badge) => badge.id !== removed.id);
    await tx.update(users).set({ badges: updated }).where(eq(users.id, id));
    await tx.insert(moderationActivity).values({
      actorId: actor.id, actorHandle: actor.handle, targetId: id, targetHandle: target.handle,
      action: "removeBadge", detail: `${removed.icon}: ${removed.tooltip}`,
    });
    return updated;
  });
  res.json({ badges });
});

export default router;
