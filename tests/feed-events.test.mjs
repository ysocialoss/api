import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("feed activity is logged, gated by personalization, and the following feed is scoped", async (t) => {
  const connection = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_feed_events_test_${randomUUID().replaceAll("-", "")}`;
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
    const query = (text, values) => database.pool.query(text, values);

    async function account(handle, role = "user", chosen = true) {
      const { rows: [user] } = await query(
        "INSERT INTO users (handle, role, approved_at, feed_choice_at) VALUES ($1, $2, now(), CASE WHEN $3 THEN now() END) RETURNING id", [handle, role, chosen]);
      const { rows: [identity] } = await query(
        "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', $1, $2) RETURNING id",
        [handle, user.id]);
      const token = randomUUID();
      await query(
        "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
        [hash(token), identity.id]);
      return { id: user.id, handle, cookie: `session=${token}` };
    }
    const post = async (author, content = "hello", extra = {}) => (await query(
      "INSERT INTO posts (author_id, content, parent_id, created_at) VALUES ($1, $2, $3, coalesce($4, now())) RETURNING id",
      [author.id, content, extra.parentId ?? null, extra.createdAt ?? null])).rows[0].id;
    const events = async (userId, extraWhere = "") => (await query(
      `SELECT * FROM feed_events WHERE user_id = $1 AND origin <> 'backfill' ${extraWhere} ORDER BY id`, [userId])).rows;

    const alice = await account("alice");
    const bob = await account("bob");
    const carol = await account("carol");
    const dave = await account("dave");
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (who, method, path, body, headers = {}) => fetch(base + path, {
      method,
      headers: {
        Cookie: who.cookie,
        Origin: "http://localhost:3000",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sessionId = randomUUID();
    const at = () => new Date().toISOString();
    const batch = (list) => ({ sessionId, events: list });

    await t.test("client batches are validated, deduplicated and attributed on the server", async () => {
      const bobPost = await post(bob, "from bob");
      const ownPost = await post(alice, "mine");
      const requestId = randomUUID();
      const response = await call(alice, "POST", "/api/feed/events", batch([
        { type: "impression", postId: bobPost, surface: "latest", position: 0, requestId, seq: 1, value: 80, at: at() },
        { type: "dwell", postId: bobPost, surface: "latest", position: 0, seq: 2, value: 4200, at: at() },
        { type: "link_open", postId: bobPost, surface: "latest", seq: 3, detail: "example.com", at: at() },
        { type: "topic_open", surface: "latest", seq: 4, detail: "Music", at: at() },
        { type: "impression", postId: randomUUID(), surface: "latest", seq: 5, at: at() },
        { type: "impression", postId: ownPost, surface: "latest", seq: 6, at: at() },
      ]));
      assert.equal(response.status, 204);
      const logged = await events(alice.id);
      assert.deepEqual(logged.map((row) => row.type), ["impression", "dwell", "link_open", "topic_open"]);
      assert.equal(logged[0].author_id, bob.id);
      assert.equal(logged[0].request_id, requestId);
      assert.equal(logged[0].position, 0);
      assert.equal(logged[0].origin, "client");
      assert.equal(logged[0].client, "desktop");
      assert.equal(logged[1].value, 4200);
      assert.equal(logged[3].detail, "music");
      assert.equal(logged[3].post_id, null);

      assert.equal((await call(alice, "POST", "/api/feed/events", batch([
        { type: "impression", postId: bobPost, surface: "latest", seq: 1, at: at() },
      ]))).status, 204);
      assert.equal((await events(alice.id)).length, 4);

      const invalid = [
        batch([{ type: "like", postId: bobPost, surface: "latest", seq: 10, at: at() }]),
        batch([{ type: "impression", postId: "nope", surface: "latest", seq: 10, at: at() }]),
        batch([{ type: "impression", surface: "latest", seq: 10, at: at() }]),
        batch([{ type: "dwell", postId: bobPost, surface: "latest", seq: 10, at: at() }]),
        batch([{ type: "link_open", postId: bobPost, surface: "latest", seq: 10, detail: "https://x.test/a", at: at() }]),
        batch([{ type: "impression", postId: bobPost, surface: "latest", seq: 10, detail: "x", at: at() }]),
        batch([{ type: "impression", postId: bobPost, surface: "nowhere", seq: 10, at: at() }]),
        batch(Array.from({ length: 51 }, (_, i) => ({ type: "impression", postId: bobPost, surface: "latest", seq: 100 + i, at: at() }))),
        { sessionId, events: [] },
      ];
      for (const body of invalid) {
        const result = await call(alice, "POST", "/api/feed/events", body);
        assert.equal(result.status, 400);
        assert.equal((await result.json()).error, "invalid_feed_events");
      }
      assert.equal((await fetch(`${base}/api/feed/events`, {
        method: "POST",
        headers: { Cookie: alice.cookie, Origin: "https://evil.invalid", "Content-Type": "application/json" },
        body: JSON.stringify(batch([{ type: "impression", postId: bobPost, surface: "latest", seq: 20, at: at() }])),
      })).status, 403);
      assert.equal((await fetch(`${base}/api/feed/events`, {
        method: "POST",
        headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" },
        body: JSON.stringify(batch([{ type: "impression", postId: bobPost, surface: "latest", seq: 21, at: at() }])),
      })).status, 401);
    });

    await t.test("server actions log one event per real change, with the feed context header", async () => {
      const target = await post(carol, "like me");
      const requestId = randomUUID();
      const context = { "X-Feed-Context": `following 3 ${requestId}` };
      assert.equal((await call(dave, "PUT", `/api/posts/${target}/like`, undefined, context)).status, 200);
      assert.equal((await call(dave, "PUT", `/api/posts/${target}/like`)).status, 200);
      assert.equal((await call(dave, "DELETE", `/api/posts/${target}/like`)).status, 200);
      assert.equal((await call(dave, "DELETE", `/api/posts/${target}/like`)).status, 200);
      assert.equal((await call(dave, "PUT", `/api/posts/${target}/repost`, { audience: "public" })).status, 200);
      assert.equal((await call(dave, "PUT", `/api/posts/${target}/repost`, { audience: "friends" })).status, 200);
      assert.equal((await call(dave, "DELETE", `/api/posts/${target}/repost`)).status, 200);
      assert.equal((await call(dave, "PUT", `/api/posts/${target}/save`)).status, 200);
      assert.equal((await call(dave, "PUT", `/api/posts/${target}/save`)).status, 200);
      assert.equal((await call(dave, "DELETE", `/api/posts/${target}/save`)).status, 200);
      assert.equal((await call(dave, "POST", `/api/posts/${target}/replies`, { content: "a reply" }, { "X-Feed-Context": "thread - -" })).status, 201);
      assert.equal((await call(dave, "POST", "/api/posts", { content: "a quote", quotedPostId: target })).status, 201);
      assert.equal((await call(dave, "PUT", "/api/profiles/carol/follow")).status, 200);
      assert.equal((await call(dave, "PUT", "/api/profiles/carol/follow")).status, 200);
      assert.equal((await call(dave, "DELETE", "/api/profiles/carol/follow")).status, 200);
      assert.equal((await call(dave, "POST", "/api/reports", { target: { type: "post", id: target }, reason: "spam" })).status, 201);
      assert.equal((await call(dave, "PUT", "/api/blocks/carol")).status, 200);
      assert.equal((await call(dave, "PUT", "/api/blocks/carol")).status, 200);

      const logged = await events(dave.id);
      assert.deepEqual(logged.map((row) => row.type), [
        "like", "unlike", "repost", "unrepost", "save", "unsave", "reply", "quote", "follow", "unfollow", "report", "block",
      ]);
      assert.ok(logged.every((row) => row.author_id === carol.id && row.origin === "server"));
      assert.equal(logged[0].surface, "following");
      assert.equal(logged[0].position, 3);
      assert.equal(logged[0].request_id, requestId);
      assert.equal(logged[1].surface, null);
      assert.equal(logged[6].surface, "thread");
      assert.equal(logged[6].position, null);
      assert.equal(logged[6].post_id, target);
      assert.equal(logged[7].post_id, target);
      assert.equal(logged[8].post_id, null);
      assert.equal(logged[10].post_id, target);

      const own = await post(dave, "self");
      await call(dave, "PUT", `/api/posts/${own}/like`);
      await call(dave, "POST", `/api/posts/${own}/replies`, { content: "self reply" });
      assert.equal((await events(dave.id)).length, logged.length);

      const { rows: [poll] } = await query(
        `INSERT INTO posts (author_id, content, poll) VALUES ($1, 'vote', '{"title":"Pick","options":["a","b"],"anonymous":false}') RETURNING id`,
        [bob.id]);
      assert.equal((await call(alice, "PUT", `/api/posts/${poll.id}/poll/vote`, { optionIndex: 0 })).status, 200);
      assert.equal((await call(alice, "PUT", `/api/posts/${poll.id}/poll/vote`, { optionIndex: 1 })).status, 200);
      const votes = await events(alice.id, "AND type = 'poll_vote'");
      assert.equal(votes.length, 1);
      assert.equal(votes[0].value, null);
      assert.equal(votes[0].detail, null);
    });

    await t.test("turning personalization off stops all logging and reset clears it", async () => {
      const target = await post(bob, "quiet");
      assert.deepEqual(await (await call(carol, "GET", "/api/feed/preferences")).json(), { personalize: true, chosen: true });
      const me = await (await call(carol, "GET", "/auth/me")).json();
      assert.equal(me.user.feedPersonalize, true);
      const invalid = await call(carol, "PATCH", "/api/feed/preferences", { personalize: "no" });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error, "invalid_feed_preferences");
      await call(carol, "PUT", `/api/posts/${target}/save`);
      assert.equal((await events(carol.id)).length, 1);
      assert.deepEqual(await (await call(carol, "PATCH", "/api/feed/preferences", { personalize: false })).json(), { personalize: false, chosen: true, cleared: 1 });
      assert.equal((await query("SELECT 1 FROM feed_events WHERE user_id = $1", [carol.id])).rowCount, 0);
      await call(carol, "DELETE", `/api/posts/${target}/save`);

      assert.equal((await call(carol, "POST", "/api/feed/events", batch([
        { type: "impression", postId: target, surface: "latest", seq: 500, at: at() },
      ]))).status, 204);
      await call(carol, "PUT", `/api/posts/${target}/like`);
      await call(carol, "PUT", "/api/profiles/bob/follow");
      assert.equal((await events(carol.id)).length, 0);

      await call(carol, "PATCH", "/api/feed/preferences", { personalize: true });
      await call(carol, "PUT", `/api/posts/${target}/save`);
      assert.equal((await events(carol.id)).length, 1);
      const cleared = await (await call(carol, "POST", "/api/feed/reset")).json();
      assert.ok(cleared.cleared >= 1);
      assert.equal((await query("SELECT 1 FROM feed_events WHERE user_id = $1", [carol.id])).rowCount, 0);
    });

    await t.test("nothing is recorded before the user has made the feed choice", async () => {
      const ivan = await account("ivan", "user", false);
      const target = await post(bob, "undecided");
      assert.deepEqual(await (await call(ivan, "GET", "/api/feed/preferences")).json(), { personalize: true, chosen: false });
      assert.equal((await call(ivan, "POST", "/api/feed/events", batch([
        { type: "impression", postId: target, surface: "latest", seq: 900, at: at() },
      ]))).status, 204);
      await call(ivan, "PUT", `/api/posts/${target}/like`);
      assert.equal((await events(ivan.id)).length, 0);
      await query("INSERT INTO feed_events (user_id, type, post_id, author_id, origin) VALUES ($1, 'like', $2, $3, 'backfill')", [ivan.id, target, bob.id]);
      const kept = await (await call(ivan, "PATCH", "/api/feed/preferences", { personalize: false })).json();
      assert.deepEqual(kept, { personalize: false, chosen: true, cleared: 1 });
    });

    await t.test("the following feed shows followees, their reposts and the viewer, nothing else", async () => {
      const erin = await account("erin");
      const frank = await account("frank");
      const gina = await account("gina");
      const hank = await account("hank");
      await query("INSERT INTO user_follows (follower_id, following_id) VALUES ($1, $2), ($1, $3), ($1, $4)", [erin.id, frank.id, gina.id, hank.id]);
      const start = Date.now() - 60_000;
      const time = (offset) => new Date(start + offset * 1000).toISOString();
      const frankPost = await post(frank, "frank top", { createdAt: time(1) });
      const frankReply = await post(frank, "frank reply", { parentId: frankPost, createdAt: time(2) });
      const strangerPost = await post(alice, "stranger", { createdAt: time(3) });
      const reposted = await post(alice, "reposted by gina", { createdAt: time(4) });
      const ownPost = await post(erin, "mine", { createdAt: time(5) });
      const hankPost = await post(hank, "hank blocked", { createdAt: time(6) });
      const hiddenPost = await post(gina, "hidden", { createdAt: time(7) });
      await query("UPDATE posts SET hidden_at = now() WHERE id = $1", [hiddenPost]);
      await query("INSERT INTO post_reposts (post_id, user_id, created_at) VALUES ($1, $2, $3)", [reposted, gina.id, time(8)]);
      await query("INSERT INTO post_reposts (post_id, user_id, created_at) VALUES ($1, $2, $3)", [strangerPost, bob.id, time(9)]);
      await query("INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)", [hank.id, erin.id]);

      const ids = [];
      let cursor = null;
      let pages = 0;
      do {
        const response = await call(erin, "GET", `/api/feed/following${cursor ? `?cursor=${cursor}` : ""}`);
        assert.equal(response.status, 200);
        const page = await response.json();
        ids.push(...page.posts.map((item) => item.id));
        if (page.repostedBy[reposted]) assert.equal(page.repostedBy[reposted].by.handle, "gina");
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 5);
      assert.deepEqual(ids, [reposted, ownPost, frankPost]);
      assert.ok(!ids.includes(frankReply));
      assert.ok(!ids.includes(strangerPost));
      assert.ok(!ids.includes(hankPost));

      assert.equal((await fetch(`${base}/api/feed/following`)).status, 401);
      assert.equal((await call(erin, "GET", "/api/feed/following?cursor=bad")).status, 400);
    });

    await t.test("the migration backfill is idempotent and dates likes from notifications", async () => {
      const sql = await readFile(new URL("../drizzle/0074_feed_events.sql", import.meta.url), "utf8");
      const statements = sql.split("--> statement-breakpoint").map((part) => part.trim());
      const likeUpdate = statements.find((part) => part.startsWith('UPDATE "post_likes"'));
      const backfill = statements.filter((part) => part.startsWith('INSERT INTO "feed_events"'));
      assert.equal(backfill.length, 6);
      await query("DELETE FROM feed_events");
      const ivy = await account("ivy");
      const target = await post(alice, "old", { createdAt: "2026-01-01T00:00:00Z" });
      const plain = await post(alice, "older", { createdAt: "2025-06-01T00:00:00Z" });
      await query("INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2), ($3, $2)", [target, ivy.id, plain]);
      await query(
        "INSERT INTO notifications (recipient_id, actor_id, kind, post_id, subject, created_at) VALUES ($1, $2, 'like', $3, $4, '2026-02-01T00:00:00Z')",
        [alice.id, ivy.id, target, target]);
      await query(likeUpdate);
      const { rows: likes } = await query(
        "SELECT post_id, created_at FROM post_likes WHERE user_id = $1 ORDER BY created_at", [ivy.id]);
      assert.deepEqual(likes.map((row) => [row.post_id, row.created_at.toISOString()]), [
        [plain, "2025-06-01T00:00:00.000Z"],
        [target, "2026-02-01T00:00:00.000Z"],
      ]);
      for (const statement of backfill) await query(statement);
      const first = (await query("SELECT type, count(*)::int AS n FROM feed_events WHERE origin = 'backfill' GROUP BY type ORDER BY type")).rows;
      for (const statement of backfill) await query(statement);
      const second = (await query("SELECT type, count(*)::int AS n FROM feed_events WHERE origin = 'backfill' GROUP BY type ORDER BY type")).rows;
      assert.deepEqual(second, first);
      const types = new Set(first.map((row) => row.type));
      for (const type of ["like", "reply", "quote", "follow"]) assert.ok(types.has(type), type);
      const ivyLike = (await query(
        "SELECT created_at FROM feed_events WHERE origin = 'backfill' AND user_id = $1 AND post_id = $2", [ivy.id, target])).rows;
      assert.equal(ivyLike[0].created_at.toISOString(), "2026-02-01T00:00:00.000Z");
      assert.equal((await query(
        "SELECT 1 FROM feed_events WHERE origin = 'backfill' AND type = 'reply' AND user_id = author_id")).rowCount, 0);
    });

    await t.test("deleting an account removes its feed activity and events about its posts", async () => {
      const kim = await account("kim");
      const kimPost = await post(kim, "soon gone");
      await call(alice, "POST", "/api/feed/events", batch([
        { type: "impression", postId: kimPost, surface: "latest", seq: 900, at: at() },
      ]));
      await call(kim, "PUT", `/api/posts/${await post(bob, "liked by kim")}/like`);
      assert.ok((await query("SELECT 1 FROM feed_events WHERE user_id = $1 OR author_id = $1", [kim.id])).rowCount >= 2);
      assert.equal((await call(kim, "DELETE", "/api/profiles/me", { handle: "kim" })).status, 204);
      assert.equal((await query("SELECT 1 FROM feed_events WHERE user_id = $1 OR author_id = $1 OR post_id = $2", [kim.id, kimPost])).rowCount, 0);
    });
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
