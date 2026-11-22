import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("accounts delete themselves after confirming the handle, and post counts are real", async () => {
  const connection = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_account_deletion_test_${randomUUID().replaceAll("-", "")}`;
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
        "INSERT INTO users (handle, role, approved_at) VALUES ($1, $2, now()) RETURNING id",
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
    const boss = await account("boss", "admin");
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (who, method, path, body, origin = "http://localhost:3000") => fetch(base + path, {
      method,
      headers: { Cookie: who.cookie, Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

    const { rows: [first] } = await database.pool.query(
      "INSERT INTO posts (author_id, content) VALUES ($1, 'one') RETURNING id", [alice.id]);
    await database.pool.query("INSERT INTO posts (author_id, content) VALUES ($1, 'two')", [alice.id]);
    await database.pool.query(
      "INSERT INTO posts (author_id, parent_id, content) VALUES ($1, $2, 'a reply')", [alice.id, first.id]);
    const card = await (await call(bob, "GET", "/api/profiles/alice/card")).json();
    assert.equal(card.profile.postCount, 2);
    const profile = await (await call(bob, "GET", "/api/profiles/alice")).json();
    assert.equal(profile.profile.postCount, 2);

    assert.equal((await call(alice, "DELETE", "/api/profiles/me", {})).status, 400);
    assert.equal((await call(alice, "DELETE", "/api/profiles/me", { handle: "bob" })).status, 400);
    assert.equal((await call(alice, "DELETE", "/api/profiles/me", { handle: "alice" }, "https://evil.invalid")).status, 403);
    assert.equal((await database.pool.query("SELECT 1 FROM users WHERE id = $1", [alice.id])).rowCount, 1);
    assert.equal((await call(boss, "DELETE", "/api/profiles/me", { handle: "boss" })).status, 409);

    assert.equal((await call(alice, "DELETE", "/api/profiles/me", { handle: "alice" })).status, 204);
    assert.equal((await database.pool.query("SELECT 1 FROM users WHERE id = $1", [alice.id])).rowCount, 0);
    assert.equal((await database.pool.query("SELECT 1 FROM posts WHERE author_id = $1", [alice.id])).rowCount, 0);
    assert.equal((await call(alice, "DELETE", "/api/profiles/me", { handle: "alice" })).status, 401);
    assert.equal((await call(bob, "GET", "/api/profiles/alice")).status, 404);
    assert.equal((await database.pool.query("SELECT 1 FROM users WHERE id = $1", [bob.id])).rowCount, 1);
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
