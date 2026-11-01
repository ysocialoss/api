import {
  postFields,
  postSelection,
  serializePost,
  reactionSelection,
} from "./post-data.ts";
import { Router, type Request } from "express";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import { postLikes, posts, users } from "./db/schema.ts";
import { cookie, requireOrigin, readViewerId } from "./auth/request.ts";
import { readSession } from "./auth/session.ts";
import { AuthError } from "./auth/provider.ts";

const router = Router();
const contentSchema = z.strictObject({
  content: z
    .string()
    .trim()
    .refine((value) => !value.includes("\u0000"))
    .refine((value) => {
      const length = Array.from(value).length;
      return length > 0 && length <= 2000;
    }),
});
const cursorSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});
async function findPost(id: string, viewerId: string | null = null) {
  const [post] = await db
    .select(postSelection(viewerId))
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(eq(posts.id, id));
  if (!post) throw new AuthError(404, "post_not_found");
  return serializePost(post);
}
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.get("/", async (req, res) => {
  const viewerId = await readViewerId(req);
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (req.query.cursor !== undefined) {
    try {
      if (typeof req.query.cursor !== "string" || req.query.cursor.length > 512)
        throw new Error();
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(req.query.cursor, "base64url").toString("utf8")),
      );
    } catch {
      throw new AuthError(400, "invalid_cursor");
    }
  }
  const rows = await db
    .select(postSelection(viewerId))
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(
      cursor
        ? or(
            lt(posts.createdAt, new Date(cursor.createdAt)),
            and(
              eq(posts.createdAt, new Date(cursor.createdAt)),
              lt(posts.id, cursor.id),
            ),
          )
        : undefined,
    )
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1);
  res.json({
    posts: page.map(serializePost),
    nextCursor:
      rows.length > 20 && last
        ? Buffer.from(
            JSON.stringify({
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            }),
          ).toString("base64url")
        : null,
    serverNow: new Date().toISOString(),
  });
});
async function requireUser(req: Request) {
  requireOrigin(req);
  const session = await readSession(cookie(req, "session"));
  if (session.kind === "anonymous")
    throw new AuthError(401, "sign_in_required");
  if (!session.user) throw new AuthError(403, "onboarding_required");
  return session.user;
}
router.post("/", async (req, res) => {
  const user = await requireUser(req);
  const parsed = contentSchema.safeParse(req.body);
  if (!parsed.success) throw new AuthError(400, "invalid_content");
  const [post] = await db
    .insert(posts)
    .values({ authorId: user.id, content: parsed.data.content })
    .returning(postFields);
  res.status(201).json({
    post: serializePost({ ...post, author: user, likes: 0, liked: false }),
    serverNow: new Date().toISOString(),
  });
});
router.use("/:id", (req, _res, next) => {
  if (!z.uuid().safeParse(req.params.id).success)
    throw new AuthError(400, "invalid_post_id");
  next();
});
router.get("/:id", async (req, res) => {
  res.json({
    post: await findPost(req.params.id, await readViewerId(req)),
    serverNow: new Date().toISOString(),
  });
});
async function setLike(req: Request, liked: boolean) {
  const user = await requireUser(req);
  const parsedId = z.uuid().safeParse(req.params.id);
  if (!parsedId.success) throw new AuthError(400, "invalid_post_id");
  const id = parsedId.data;
  return db.transaction(async (tx) => {
    // Serialize writes to this post, so retries and concurrent likes return a consistent count.
    const [post] = await tx
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.id, id))
      .for("update");
    if (!post) throw new AuthError(404, "post_not_found");
    if (liked) {
      await tx
        .insert(postLikes)
        .values({ postId: id, userId: user.id })
        .onConflictDoNothing();
    } else {
      await tx
        .delete(postLikes)
        .where(and(eq(postLikes.postId, id), eq(postLikes.userId, user.id)));
    }
    const [state] = await tx
      .select(reactionSelection(user.id))
      .from(posts)
      .where(eq(posts.id, id));
    return state;
  });
}
router.put("/:id/like", async (req, res) => {
  res.json(await setLike(req, true));
});
router.delete("/:id/like", async (req, res) => {
  res.json(await setLike(req, false));
});
router.patch("/:id", async (req, res) => {
  const user = await requireUser(req);
  const parsed = contentSchema.safeParse(req.body);
  if (!parsed.success) throw new AuthError(400, "invalid_content");
  const updated = await db.transaction(async (tx) => {
    // Acquire the row before evaluating the clock, including waits for other writers.
    const [existing] = await tx
      .select({ authorId: posts.authorId })
      .from(posts)
      .where(eq(posts.id, req.params.id))
      .for("update");
    if (!existing) throw new AuthError(404, "post_not_found");
    if (existing.authorId !== user.id)
      throw new AuthError(403, "not_post_author");
    const [saved] = await tx
      .update(posts)
      .set({ content: parsed.data.content, editedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(posts.id, req.params.id),
          sql`clock_timestamp() < ${posts.createdAt} + interval '15 minutes'`,
        ),
      )
      .returning(postFields);
    if (!saved) throw new AuthError(409, "edit_window_expired");
    return saved;
  });
  res.json({
    post: await findPost(updated.id, user.id),
    serverNow: new Date().toISOString(),
  });
});
router.delete("/:id", async (req, res) => {
  const user = await requireUser(req);
  const [deleted] = await db
    .delete(posts)
    .where(and(eq(posts.id, req.params.id), eq(posts.authorId, user.id)))
    .returning({ id: posts.id });
  if (!deleted) {
    await findPost(req.params.id);
    throw new AuthError(403, "not_post_author");
  }
  res.status(204).end();
});
export default router;
