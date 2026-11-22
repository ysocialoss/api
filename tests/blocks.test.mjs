import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("blocking hides content both ways and stops interactions", async (t) => {
  const connection = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_blocks_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  let database;
  let server;
  try {
    await connection.query(`CREATE DATABASE ${name}`);
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      NODE_ENV: "development",
      APP_ORIGIN: "http://localhost:3000",
      ADMIN_ORIGIN: "http://localhost:3200",
      SESSION_ENCRYPTION_KEY: "a".repeat(64),
    });
    database = await import("../src/db/index.ts");
    const { app } = await import("../src/app.ts");
    const { hash } = await import("../src/auth/secrets.ts");
    await migrate(database.db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });

    async function account(handle, role = "user") {
      const { rows: [user] } = await database.pool.query(
        "INSERT INTO users (handle, role, approved_at, bio) VALUES ($1, $2, now(), 'bad bio') RETURNING id",
        [handle, role],
      );
      const { rows: [identity] } = await database.pool.query(
        "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', $1, $2) RETURNING id",
        [handle, user.id],
      );
      const token = randomUUID();
      await database.pool.query(
        "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
        [hash(token), identity.id],
      );
      return { id: user.id, cookie: `session=${token}` };
    }
    const alice = await account("alice");
    const bob = await account("bob");
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (who, method, path, body) => fetch(base + path, {
      method,
      headers: { Cookie: who.cookie, Origin: "http://localhost:3000", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal((await call(alice, "PUT", "/api/profiles/bob/follow")).status, 200);
    assert.equal((await call(bob, "PUT", "/api/profiles/alice/follow")).status, 200);
    const { rows: [post] } = await database.pool.query(
      "INSERT INTO posts (author_id, content) VALUES ($1, 'From bob') RETURNING id", [bob.id],
    );
    const { rows: [mine] } = await database.pool.query(
      "INSERT INTO posts (author_id, content) VALUES ($1, 'From alice') RETURNING id", [alice.id],
    );

    assert.equal((await call(alice, "PUT", "/api/blocks/alice")).status, 409);
    assert.deepEqual(await (await call(alice, "PUT", "/api/blocks/bob")).json(), { blocking: true });
    const { rows: [follows] } = await database.pool.query("SELECT count(*)::int AS n FROM user_follows");
    assert.equal(follows.n, 0);
    const list = await (await call(alice, "GET", "/api/blocks")).json();
    assert.deepEqual(list.users.map(({ handle }) => handle), ["bob"]);

    assert.equal((await call(alice, "PUT", "/api/profiles/bob/follow")).status, 403);
    assert.equal((await call(bob, "PUT", "/api/profiles/alice/follow")).status, 403);
    assert.equal((await call(bob, "PUT", `/api/posts/${mine.id}/like`)).status, 403);
    assert.equal((await call(bob, "PUT", `/api/posts/${mine.id}/repost`, {})).status, 403);
    assert.equal((await call(bob, "POST", `/api/posts/${mine.id}/replies`, { clientId: crypto.randomUUID(), content: "hi" })).status, 403);

    const feed = await (await call(alice, "GET", "/api/posts")).json();
    assert.ok(!feed.posts.some(({ id }) => id === post.id));
    const otherFeed = await (await call(bob, "GET", "/api/posts")).json();
    assert.ok(!otherFeed.posts.some(({ id }) => id === mine.id));
    const profile = await (await call(alice, "GET", "/api/profiles/bob")).json();
    assert.equal(profile.blocking, true);
    assert.deepEqual(profile.posts, []);
    const theirs = await (await call(bob, "GET", "/api/profiles/alice")).json();
    assert.equal(theirs.blockedBy, true);

    assert.deepEqual(await (await call(alice, "DELETE", "/api/blocks/bob")).json(), { blocking: false });
    assert.equal((await call(bob, "PUT", `/api/posts/${mine.id}/like`)).status, 200);
    const { rows: [notes] } = await database.pool.query("SELECT count(*)::int AS n FROM notifications WHERE recipient_id = $1", [alice.id]);
    assert.equal(notes.n, 1);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await database?.pool.end();
    await connection.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await connection.end();
  }
});
