import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { config } from "dotenv";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("profile tabs page through older entries", async () => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_timeline_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  let pool, server;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    Object.assign(process.env, { DATABASE_URL: url.href, NODE_ENV: "test" });
    const { app } = await import("../src/app.ts");
    const database = await import("../src/db/index.ts");
    pool = database.pool;
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    const user = async (handle) =>
      (await pool.query(
        "INSERT INTO users (handle, display_name, approved_at) VALUES ($1, $1, now()) RETURNING id",
        [handle],
      )).rows[0].id;
    const author = await user("tl_author");
    const other = await user("tl_other");
    const { rows: [root] } = await pool.query(
      "INSERT INTO posts (author_id, content) VALUES ($1, 'root') RETURNING id",
      [other],
    );
    await pool.query(
      `INSERT INTO posts (author_id, content, created_at)
       SELECT $1, 'post ' || n, now() - (n || ' seconds')::interval FROM generate_series(1, 45) n`,
      [author],
    );
    await pool.query(
      `INSERT INTO posts (author_id, parent_id, content, created_at)
       SELECT $1, $2, 'reply ' || n, now() - (n || ' seconds')::interval FROM generate_series(1, 25) n`,
      [author, root.id],
    );
    await pool.query(
      `INSERT INTO posts (author_id, content, created_at)
       SELECT $1, 'theirs ' || n, now() - (n || ' minutes')::interval FROM generate_series(1, 25) n`,
      [other],
    );
    await pool.query(
      `INSERT INTO post_reposts (post_id, user_id, created_at)
       SELECT id, $1, created_at + interval '1 second' FROM posts WHERE author_id = $2 AND content LIKE 'theirs %'`,
      [author, other],
    );
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path, status = 200) => {
      const response = await fetch(base + path);
      assert.equal(response.status, status, await response.clone().text());
      return response.json();
    };
    const entry = (tab, item) => (tab === "replies" ? item.post.id : item.id);

    const profile = await get("/api/profiles/tl_author");
    assert.equal(profile.posts.length, 20);
    assert.equal(profile.replies.length, 20);
    assert.equal(profile.reposts.length, 20);
    assert.ok(profile.nextCursors.posts && profile.nextCursors.replies && profile.nextCursors.reposts);

    for (const [tab, total] of [["posts", 45], ["replies", 25], ["reposts", 25]]) {
      const seen = profile[tab].map((item) => entry(tab, item));
      let cursor = profile.nextCursors[tab];
      let pages = 1;
      while (cursor) {
        const page = await get(`/api/profiles/tl_author/timeline?tab=${tab}&cursor=${cursor}`);
        assert.ok(page[tab].length > 0 && page[tab].length <= 20);
        seen.push(...page[tab].map((item) => entry(tab, item)));
        cursor = page.nextCursor;
        pages++;
      }
      assert.equal(seen.length, total, tab);
      assert.equal(new Set(seen).size, total, `${tab} has no duplicates`);
      assert.equal(pages, Math.ceil(total / 20), tab);
    }

    const replies = await get("/api/profiles/tl_author/timeline?tab=replies");
    assert.equal(replies.replies[0].thread[0].id, root.id);
    const reposts = await get("/api/profiles/tl_author/timeline?tab=reposts");
    assert.equal(reposts.repostedBy[reposts.reposts[0].id].by.handle, "tl_author");

    await get("/api/profiles/tl_author/timeline?tab=nope", 400);
    await get("/api/profiles/tl_author/timeline?tab=posts&cursor=junk", 400);
    await get("/api/profiles/tl_missing/timeline?tab=posts", 404);
  } finally {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
