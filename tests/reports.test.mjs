import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("users report posts, profiles and messages; staff resolve them", async (t) => {
  const connection = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_reports_test_${randomUUID().replaceAll("-", "")}`;
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
    const reporter = await account("reporter");
    const second = await account("second");
    const author = await account("author");
    const moderator = await account("moderator", "moderator");
    const admin = await account("admin", "admin");
    const { rows: [post] } = await database.pool.query(
      "INSERT INTO posts (author_id, content) VALUES ($1, 'Offensive') RETURNING id", [author.id],
    );
    const { rows: [conversation] } = await database.pool.query(
      "INSERT INTO dm_conversations (first_user_id, second_user_id) VALUES ($1, $2) RETURNING id",
      [reporter.id < author.id ? reporter.id : author.id, reporter.id < author.id ? author.id : reporter.id],
    );
    const messageIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of messageIds.entries()) {
      await database.pool.query(
        "INSERT INTO dm_messages (id, conversation_id, sender_id, sender_device_id, version, iv, ciphertext, signature, envelopes) VALUES ($1, $2, $3, $4, 1, 'iv', 'c', 's', '{}')",
        [id, conversation.id, index === 1 ? reporter.id : author.id, randomUUID()],
      );
    }

    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (who, path, body, origin = "http://localhost:3000") => fetch(base + path, {
      method: "POST",
      headers: { Cookie: who.cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const read = (who, path) => fetch(base + path, { headers: { Cookie: who.cookie } });

    const postReport = await send(reporter, "/api/reports", { reason: "hate", details: "Slur", target: { type: "post", id: post.id } });
    assert.equal(postReport.status, 201);
    assert.equal((await send(reporter, "/api/reports", { reason: "hate", target: { type: "post", id: post.id } })).status, 200);
    assert.equal((await send(second, "/api/reports", { reason: "spam", target: { type: "post", id: post.id } })).status, 201);
    assert.equal((await send(author, "/api/reports", { reason: "spam", target: { type: "post", id: post.id } })).status, 409);
    assert.equal((await send(reporter, "/api/reports", { reason: "nope", target: { type: "post", id: post.id } })).status, 400);
    assert.equal((await send(reporter, "/api/reports", { reason: "spam", target: { type: "post", id: post.id } }, "http://evil.test")).status, 403);
    assert.equal((await send(reporter, "/api/reports", { reason: "impersonation", target: { type: "user", id: author.id } })).status, 201);
    assert.equal((await send(reporter, "/api/reports", { reason: "harassment", target: { type: "user", id: reporter.id } })).status, 409);

    const messages = messageIds.map((id, index) => ({ id, text: `message ${index}` }));
    assert.equal((await send(reporter, "/api/reports", {
      reason: "harassment", target: { type: "message", conversationId: conversation.id, messageId: messageIds[1], messages: messages.slice(0, 2) },
    })).status, 409);
    assert.equal((await send(reporter, "/api/reports", {
      reason: "harassment", target: { type: "message", conversationId: conversation.id, messageId: messageIds[0], messages },
    })).status, 400);
    assert.equal((await send(second, "/api/reports", {
      reason: "harassment", target: { type: "message", conversationId: conversation.id, messageId: messageIds[2], messages },
    })).status, 404);
    assert.equal((await send(reporter, "/api/reports", {
      reason: "harassment", target: { type: "message", conversationId: conversation.id, messageId: messageIds[2], messages },
    })).status, 201);

    assert.equal((await read(reporter, "/api/admin/reports")).status, 403);
    const queue = await read(moderator, "/api/admin/reports?sort=most_reported");
    assert.equal(queue.status, 200);
    const { reports, canAct } = await queue.json();
    assert.equal(canAct, false);
    assert.equal(reports.length, 4);
    assert.equal(reports[0].openOnTarget, 2);
    const messageReport = reports.find((report) => report.targetType === "message");
    assert.deepEqual(messageReport.snapshot.messages.map(({ text, reported }) => [text, reported]),
      [["message 0", false], ["message 1", false], ["message 2", true]]);

    const detail = await (await read(moderator, `/api/admin/reports/${reports[0].id}`)).json();
    assert.equal(detail.related.length, 1);
    assert.equal(detail.target.exists, true);

    const adminOrigin = "http://localhost:3200";
    assert.equal((await send(moderator, `/api/admin/reports/${reports[0].id}/resolve`, { decision: "resolve", removeContent: true }, adminOrigin)).status, 403);
    assert.equal((await send(moderator, `/api/admin/reports/${reports[0].id}/resolve`, { decision: "dismiss" })).status, 403);
    const userReport = reports.find((report) => report.targetType === "user");
    assert.equal((await send(moderator, `/api/admin/reports/${userReport.id}/resolve`, { decision: "dismiss", note: "Satire" }, adminOrigin)).status, 204);
    assert.equal((await send(moderator, `/api/admin/reports/${userReport.id}/resolve`, { decision: "dismiss" }, adminOrigin)).status, 409);

    const postReportId = reports.find((report) => report.targetType === "post").id;
    assert.equal((await send(admin, `/api/admin/reports/${postReportId}/resolve`, {
      decision: "resolve", removeContent: true, ban: { reason: "Hate speech" },
    }, adminOrigin)).status, 204);
    const { rows: [removed] } = await database.pool.query("SELECT count(*)::int AS n FROM posts WHERE id = $1", [post.id]);
    assert.equal(removed.n, 0);
    const { rows: [banned] } = await database.pool.query("SELECT banned_at FROM users WHERE id = $1", [author.id]);
    assert.ok(banned.banned_at);
    const { rows: closed } = await database.pool.query("SELECT status, resolution FROM reports WHERE target_key = $1", [post.id]);
    assert.deepEqual(closed.map(({ status }) => status), ["resolved", "resolved"]);
    assert.match(closed[0].resolution, /removed content; banned user/);

    assert.equal((await send(admin, `/api/admin/reports/${messageReport.id}/resolve`, { decision: "resolve", removeContent: true }, adminOrigin)).status, 204);
    const { rows: [erased] } = await database.pool.query("SELECT deleted_at, ciphertext FROM dm_messages WHERE id = $1", [messageIds[2]]);
    assert.ok(erased.deleted_at);
    assert.equal(erased.ciphertext, "");

    assert.equal((await send(moderator, `/api/admin/reports/${userReport.id}/reopen`, {}, adminOrigin)).status, 204);
    const open = await (await read(moderator, "/api/admin/reports/summary")).json();
    assert.equal(open.open, 1);
    const { rows: activity } = await database.pool.query("SELECT action FROM moderation_activity ORDER BY created_at");
    for (const action of ["dismissReport", "removePost", "banUser", "resolveReport", "removeMessage", "reopenReport"])
      assert.ok(activity.some((row) => row.action === action), action);
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
