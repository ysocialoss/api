import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { config } from "dotenv";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("post activity lists all participants, validates queries, and reflects removals", async () => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_activity_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  let pool, server;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      NODE_ENV: "test",
      R2_ACCOUNT_ID: "a".repeat(32),
      R2_BUCKET: "activity-tests",
      R2_ACCESS_KEY_ID: "test",
      R2_SECRET_ACCESS_KEY: "test",
    });
    const { app } = await import("../src/app.ts");
    const database = await import("../src/db/index.ts");
    pool = database.pool;
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    const { rows: people } = await pool.query(
      `INSERT INTO users (handle, display_name, avatar_key, approved_at)
       SELECT 'person_' || n, 'Person ' || n,
         CASE WHEN n = 1 THEN 'avatars/test.webp' ELSE NULL END, now()
       FROM generate_series(1, 56) n RETURNING id, handle, display_name`,
    );
    const {
      rows: [post],
    } = await pool.query(
      "INSERT INTO posts (author_id, content) VALUES ($1, 'Activity test') RETURNING id",
      [people[0].id],
    );
    const {
      rows: [otherPost],
    } = await pool.query(
      "INSERT INTO posts (author_id, content) VALUES ($1, 'Unrelated') RETURNING id",
      [people[0].id],
    );
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/api/posts`;
    async function get(id, query) {
      const response = await fetch(`${base}/${id}/activity?${query}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      return response.json();
    }
    for (const type of ["likes", "reposts"]) {
      assert.deepEqual(await get(post.id, `type=${type}`), {
        users: [],
        nextCursor: null,
      });
      const table = type === "likes" ? "post_likes" : "post_reposts";
      await pool.query(
        `INSERT INTO ${table} (post_id, user_id) SELECT $1, id FROM users`,
        [post.id],
      );
      const first = await get(post.id, `type=${type}`);
      assert.equal(first.users.length, 50);
      assert.equal(first.nextCursor, first.users.at(-1).id);
      const second = await get(
        post.id,
        `type=${type}&cursor=${first.nextCursor}`,
      );
      assert.equal(second.users.length, 6);
      assert.equal(second.nextCursor, null);
      const all = [...first.users, ...second.users];
      assert.deepEqual(
        all.map((user) => user.id),
        people.map((user) => user.id).sort(),
      );
      assert.deepEqual(
        all.find((user) => user.id === people[0].id),
        {
          id: people[0].id,
          handle: people[0].handle,
          displayName: people[0].display_name,
          avatarUrl: "/api/avatars/test.webp",
          paint: null,
          eveStar: null,
        },
      );
      assert.deepEqual(await get(otherPost.id, `type=${type}`), {
        users: [],
        nextCursor: null,
      });
      await pool.query(
        `DELETE FROM ${table} WHERE post_id = $1 AND user_id = $2`,
        [post.id, people[0].id],
      );
      const refreshed = await get(post.id, `type=${type}`);
      const rest = await get(
        post.id,
        `type=${type}&cursor=${refreshed.nextCursor}`,
      );
      assert.equal(
        [...refreshed.users, ...rest.users].some(
          (user) => user.id === people[0].id,
        ),
        false,
      );
    }
    for (const query of [
      "",
      "type=comments",
      "type=likes&cursor=bad",
      "type=likes&type=reposts",
    ]) {
      assert.equal(
        (await fetch(`${base}/${post.id}/activity?${query}`)).status,
        400,
      );
    }
    assert.equal((await fetch(`${base}/bad/activity?type=likes`)).status, 400);
    assert.equal(
      (await fetch(`${base}/${randomUUID()}/activity?type=likes`)).status,
      404,
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
