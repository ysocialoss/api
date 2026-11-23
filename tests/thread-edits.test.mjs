import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { config } from "dotenv";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("thread view, edit history and friend likes", async () => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_thread_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  let pool, server;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      NODE_ENV: "test",
      ADMIN_ORIGIN: "http://localhost:3200",
      R2_ACCOUNT_ID: "a".repeat(32),
      R2_BUCKET: "thread-tests",
      R2_ACCESS_KEY_ID: "test",
      R2_SECRET_ACCESS_KEY: "test",
    });
    const { app } = await import("../src/app.ts");
    const database = await import("../src/db/index.ts");
    pool = database.pool;
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    const { env } = await import("../src/config.ts");
    const { hash } = await import("../src/auth/secrets.ts");
    async function signIn(handle, role = "user") {
      const { rows: [user] } = await pool.query(
        "INSERT INTO users (handle, approved_at, role) VALUES ($1, now(), $2) RETURNING id",
        [handle, role],
      );
      const { rows: [identity] } = await pool.query(
        "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', $1, $2) RETURNING id",
        [handle, user.id],
      );
      const token = randomUUID();
      await pool.query(
        "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
        [hash(token), identity.id],
      );
      return { id: user.id, token };
    }
    const author = await signIn("thread_author");
    const friend = await signIn("thread_friend");
    const stranger = await signIn("thread_stranger");
    const staff = await signIn("thread_admin", "admin");
    const moderator = await signIn("thread_moderator", "moderator");
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(user, path, method = "GET", body, origin = env.APP_ORIGIN) {
      return fetch(base + path, {
        method,
        headers: {
          Origin: origin,
          ...(user ? { Cookie: `session=${user.token}` } : {}),
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    async function json(user, path, method = "GET", body, status = 200) {
      const response = await request(user, path, method, body);
      assert.equal(response.status, status);
      return response.json();
    }
    const create = async (content, parentId) =>
      (
        await json(
          author,
          parentId ? `/api/posts/${parentId}/replies` : "/api/posts",
          "POST",
          { content },
          201,
        )
      ).post;

    // Thread: the chain above a post and everything nested below it.
    const root = await create("root");
    const a = await create("a", root.id);
    const b = await create("b", a.id);
    const c = await create("c", b.id);
    const other = await create("other", root.id);
    const thread = await json(null, `/api/posts/${b.id}/thread`);
    assert.deepEqual(thread.ancestors.map((p) => p.id), [root.id, a.id]);
    assert.deepEqual(thread.replies.map((p) => p.id), [c.id]);
    assert.equal(thread.truncated, false);
    const top = await json(null, `/api/posts/${root.id}/thread`);
    assert.equal(top.ancestors.length, 0);
    assert.deepEqual(
      new Set(top.replies.map((p) => p.id)),
      new Set([a.id, b.id, c.id, other.id]),
    );
    assert.equal(top.post.replies, 4);
    assert.equal((await request(null, `/api/posts/${randomUUID()}/thread`)).status, 404);

    // Edit history keeps every earlier version, newest first.
    assert.deepEqual(
      (await json(null, `/api/posts/${root.id}/edits`)).versions.map((v) => v.content),
      ["root"],
    );
    await json(author, `/api/posts/${root.id}`, "PATCH", { content: "root v2" });
    await json(author, `/api/posts/${root.id}`, "PATCH", { content: "root v2" });
    await json(author, `/api/posts/${root.id}`, "PATCH", { content: "root v3" });
    const { versions } = await json(null, `/api/posts/${root.id}/edits`);
    assert.deepEqual(versions.map((v) => v.content), ["root v3", "root v2", "root"]);

    await pool.query("UPDATE posts SET created_at = now() - interval '1 hour' WHERE id = $1", [b.id]);
    const adminPath = `/api/admin/posts/${b.id}`;
    const editAsStaff = (editor, content) => request(editor, adminPath, "PATCH", { content }, env.ADMIN_ORIGIN);
    assert.equal((await request(author, `/api/posts/${b.id}`, "PATCH", { content: "Too late" })).status, 409);
    assert.equal((await editAsStaff(moderator, "Denied")).status, 403);
    assert.equal((await request(staff, adminPath, "PATCH", { content: "Wrong origin" })).status, 403);
    assert.equal((await editAsStaff(staff, " ")).status, 400);
    assert.equal((await editAsStaff(staff, "x".repeat(2001))).status, 400);
    const adminText = "Edited reply #updated @thread_friend";
    assert.equal((await editAsStaff(staff, `  ${adminText}  `)).status, 204);
    assert.equal((await editAsStaff(staff, adminText)).status, 204);
    assert.deepEqual(
      (await json(null, `/api/posts/${b.id}/edits`)).versions.map((v) => v.content), [adminText, "b"],
    );
    assert.deepEqual((await pool.query("SELECT topic FROM post_topics WHERE post_id = $1", [b.id])).rows,
      [{ topic: "updated" }]);
    assert.deepEqual((await pool.query("SELECT user_id FROM post_mentions WHERE post_id = $1", [b.id])).rows,
      [{ user_id: friend.id }]);
    assert.equal((await pool.query("SELECT 1 FROM notifications WHERE post_id = $1 AND kind = 'mention'", [b.id])).rowCount, 0);
    assert.deepEqual((await pool.query(
      "SELECT actor_id, target_handle FROM moderation_activity WHERE action = 'editPostText' AND target_id = $1", [b.id],
    )).rows, [{ actor_id: staff.id, target_handle: "thread_author" }]);

    // Friends are mutual follows; only they show up under a post.
    const follow = (from, to) =>
      pool.query("INSERT INTO user_follows (follower_id, following_id) VALUES ($1, $2)", [from.id, to.id]);
    await follow(author, friend);
    await follow(friend, author);
    await follow(stranger, author); // one-way: not a friend
    for (const liker of [friend, stranger])
      await json(liker, `/api/posts/${root.id}/like`, "PUT");
    const seenByAuthor = (await json(author, `/api/posts/${root.id}`)).post;
    assert.equal(seenByAuthor.likes, 2);
    assert.equal(seenByAuthor.friendLikes, 1);
    assert.deepEqual(seenByAuthor.friendLikers.map((u) => u.handle), ["thread_friend"]);
    const seenAnonymously = (await json(null, `/api/posts/${root.id}`)).post;
    assert.equal(seenAnonymously.friendLikes, 0);
    assert.deepEqual(seenAnonymously.friendLikers, []);

    // Unknown API routes answer in JSON.
    const missing = await request(null, "/api/does-not-exist");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "route_not_found" });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
