import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("admin activity filters, facets, exports, and system status", async (t) => {
  const connection = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_activity_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  let database;
  let server;
  try {
    await connection.query(`CREATE DATABASE ${name}`);
    Object.assign(process.env, {
      DATABASE_URL: url.href, NODE_ENV: "development",
      ADMIN_ORIGIN: "http://localhost:3200", SESSION_ENCRYPTION_KEY: "a".repeat(64),
    });
    database = await import("../src/db/index.ts");
    const { app } = await import("../src/app.ts");
    const { hash } = await import("../src/auth/secrets.ts");
    await migrate(database.db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
    const query = (text, values) => database.pool.query(text, values);
    const { rows: [staff] } = await query("INSERT INTO users (handle, role, approved_at) VALUES ('mod_one', 'moderator', now()) RETURNING id");
    const { rows: [identity] } = await query("INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', 'a', $1) RETURNING id", [staff.id]);
    const token = randomUUID();
    await query("INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')", [hash(token), identity.id]);
    const targetId = randomUUID();
    const insert = (actor, action, target, detail, at) => query(
      "INSERT INTO moderation_activity (actor_id, actor_handle, target_id, target_handle, action, detail, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [staff.id, actor, targetId, target, action, detail, at]);
    await insert("mod_one", "banUser", "spammer", "=HYPERLINK(\"http://x\")", "2026-01-03T10:00:00Z");
    await insert("mod_one", "changeBio", "alice", 'says "hi", ok', "2026-01-02T10:00:00Z");
    await insert("other_mod", "removePost", "bob", null, "2026-01-01T10:00:00Z");
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/api/admin`;
    const headers = { Cookie: `session=${token}` };
    const get = (path) => fetch(base + path, { headers });

    assert.equal((await fetch(base + "/activity")).status, 401);
    let body = await (await get("/activity")).json();
    assert.equal(body.total, 3);
    assert.deepEqual(body.entries.map((entry) => entry.action), ["banUser", "changeBio", "removePost"]);
    body = await (await get("/activity?sort=oldest&pageSize=25")).json();
    assert.equal(body.entries[0].action, "removePost");
    body = await (await get("/activity?action=changeBio,removePost")).json();
    assert.equal(body.total, 2);
    body = await (await get("/activity?q=SPAMMER")).json();
    assert.equal(body.total, 1);
    body = await (await get("/activity?actor=@other_mod")).json();
    assert.equal(body.total, 1);
    body = await (await get("/activity?from=2026-01-02T00:00:00Z&to=2026-01-02T23:59:59Z")).json();
    assert.deepEqual(body.entries.map((entry) => entry.action), ["changeBio"]);
    body = await (await get("/activity?pageSize=25&page=2")).json();
    assert.equal(body.entries.length, 0);
    assert.equal((await get("/activity?pageSize=7")).status, 400);
    assert.equal((await get("/activity?action=bad-action!")).status, 400);
    assert.equal((await get("/activity?from=yesterday")).status, 400);

    const facets = await (await get("/activity/facets")).json();
    assert.equal(facets.totals.total, 3);
    assert.equal(facets.actions.length, 3);
    assert.equal(facets.byDay.length, 30);
    assert.deepEqual(facets.actors.map((actor) => actor.count), [3]);

    const csv = await get("/activity/export?actor=mod_one");
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type"), /text\/csv/);
    assert.match(csv.headers.get("content-disposition"), /attachment; filename="ysocial-activity-.*\.csv"/);
    const bytes = Buffer.from(await csv.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM for spreadsheet apps");
    const text = bytes.toString("utf8").slice(1);
    assert.ok(text.startsWith("id,time,action,"));
    assert.ok(text.includes("'=HYPERLINK(\"\"http://x\"\")"), "formula cells are neutralised");
    assert.ok(text.includes('"says ""hi"", ok"'));
    assert.equal(text.trim().split("\r\n").length, 3);
    const json = await (await get("/activity/export?format=json&q=bob")).json();
    assert.equal(json.length, 1);
    assert.equal(json[0].targetHandle, "bob");
    assert.equal((await get("/activity/export?format=xml")).status, 400);

    const system = await get("/system");
    assert.equal(system.status, 200);
    const status = await system.json();
    assert.equal(status.database.tables.length > 0, true);
    assert.equal(status.community.users.total, 1);
    assert.equal(status.community.signupsByDay.length, 14);
    assert.equal(status.moderation.actions24h, 0);
    assert.equal(status.services.database.status, "ok");
    assert.equal(typeof status.runtime.uptimeSeconds, "number");
  } finally {
    server?.close();
    await database?.pool.end();
    await connection.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await connection.end();
  }
});
