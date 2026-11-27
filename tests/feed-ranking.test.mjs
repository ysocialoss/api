import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("ranked feed: modes, paging, exclusions, shadow logging, fallback and admin stats", async (t) => {
  const connection = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_feed_ranking_test_${randomUUID().replaceAll("-", "")}`;
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
    const { featureNames } = await import("../src/ranking/model.ts");
    await migrate(database.db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
    const query = (text, values) => database.pool.query(text, values);
    await query(`INSERT INTO feed_config ("values") VALUES ($1)`, [JSON.stringify({ epsilon: 0, pageSize: 5, storedCandidates: 20, minCandidates: 0 })]);

    async function account(handle, { role = "user", personalize = true, chosen = true } = {}) {
      const { rows: [user] } = await query(
        "INSERT INTO users (handle, role, approved_at, feed_personalize, feed_choice_at) VALUES ($1, $2, now(), $3, CASE WHEN $4 THEN now() END) RETURNING id",
        [handle, role, personalize, chosen]);
      const { rows: [identity] } = await query(
        "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', $1, $2) RETURNING id", [handle, user.id]);
      const token = randomUUID();
      await query(
        "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
        [hash(token), identity.id]);
      return { id: user.id, handle, cookie: `session=${token}` };
    }
    const post = async (author, content, minutesAgo = 0) => (await query(
      "INSERT INTO posts (author_id, content, created_at) VALUES ($1, $2, now() - $3 * interval '1 minute') RETURNING id",
      [author.id, content, minutesAgo])).rows[0].id;

    const viewer = await account("viewer");
    const other = await account("other");
    const optout = await account("optout", { personalize: false });
    const admin = await account("boss", { role: "admin" });
    const moderator = await account("mod", { role: "moderator" });
    const authors = [];
    for (const handle of ["ann", "ben", "cat", "dan", "eve", "fay"]) authors.push(await account(handle));
    await query("INSERT INTO user_follows (follower_id, following_id) VALUES ($1, $2)", [viewer.id, authors[0].id]);
    const postIds = [];
    for (let index = 0; index < 30; index++) postIds.push(await post(authors[index % authors.length], `post ${index}`, index * 7));
    const mine = await post(viewer, "my own post");

    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (who, method, path, body, origin = "http://localhost:3000") => fetch(base + path, {
      method,
      headers: {
        ...(who ? { Cookie: who.cookie } : {}),
        Origin: origin,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = async (response, status = 200) => {
      assert.equal(response.status, status);
      return response.json();
    };
    const forYou = (who, cursor) => call(who, "GET", `/api/feed/for-you${cursor ? `?cursor=${cursor}` : ""}`);
    const authorOf = new Map();
    for (const [index, id] of postIds.entries()) authorOf.set(id, authors[index % authors.length].id);

    await t.test("personal pages are stored, spaced by author and continue on the same chain", async () => {
      const first = await json(await forYou(viewer));
      assert.ok(first.requestId);
      assert.equal(first.posts.length, 5);
      assert.equal(first.fallback, false);
      assert.ok(!first.posts.some((entry) => entry.id === mine));
      for (const entry of first.posts) {
        assert.equal(first.placements[entry.id].requestId, first.requestId);
        assert.ok(["following", "recent", "popular", "network", "conversation", "social", "nearby", "explore"].includes(first.placements[entry.id].reason));
      }
      const authorsInOrder = first.posts.map((entry) => entry.author.id);
      for (let index = 1; index < authorsInOrder.length; index++) assert.notEqual(authorsInOrder[index], authorsInOrder[index - 1]);
      const { rows: [request] } = await query("SELECT * FROM feed_requests WHERE id = $1", [first.requestId]);
      assert.equal(request.user_id, viewer.id);
      assert.equal(request.mode, "personal");
      assert.equal(request.candidate_count, 30);
      for (const key of ["inventory", "features", "score", "rerank", "write", "hydrate"]) assert.equal(typeof request.timings[key], "number");
      const { rows: candidates } = await query("SELECT * FROM feed_candidates WHERE request_id = $1 ORDER BY position", [first.requestId]);
      assert.equal(candidates.length, 20);
      assert.equal(candidates.filter((row) => row.served_at).length, 5);
      assert.equal(candidates[0].features.length, featureNames.length);
      assert.equal(candidates[0].predictions.length, 9);
      const { rows: [featureSet] } = await query("SELECT names FROM feed_feature_sets WHERE version = 1");
      assert.deepEqual(featureSet.names, featureNames);

      const seen = first.posts.map((entry) => entry.id);
      let cursor = first.nextCursor;
      const requests = new Set([first.requestId]);
      let caughtUp = false;
      for (let guard = 0; guard < 12 && cursor; guard++) {
        const page = await json(await forYou(viewer, cursor));
        seen.push(...page.posts.map((entry) => entry.id));
        requests.add(page.requestId);
        cursor = page.nextCursor;
        caughtUp = page.caughtUp;
      }
      assert.equal(new Set(seen).size, seen.length);
      assert.deepEqual(new Set(seen), new Set(postIds));
      assert.ok(requests.size >= 2);
      const { rows: chains } = await query("SELECT DISTINCT chain_id FROM feed_requests WHERE id = ANY($1::uuid[])", [[...requests].filter(Boolean)]);
      assert.equal(chains.length, 1);
      assert.ok(cursor === null || caughtUp);
    });

    await t.test("liked, blocked and hidden posts are excluded; foreign and broken cursors are rejected", async () => {
      const liked = postIds[0];
      const hidden = postIds[1];
      assert.equal((await call(viewer, "PUT", `/api/posts/${liked}/like`)).status, 200);
      await query("UPDATE posts SET hidden_at = now() WHERE id = $1", [hidden]);
      await query("INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)", [viewer.id, authors[2].id]);
      const ids = [];
      let cursor;
      let firstPage;
      for (let guard = 0; guard < 12; guard++) {
        const page = await json(await forYou(viewer, cursor));
        firstPage ??= page;
        ids.push(...page.posts.map((entry) => entry.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      assert.ok(!ids.includes(liked));
      assert.ok(!ids.includes(hidden));
      assert.ok(!ids.some((id) => authorOf.get(id) === authors[2].id));
      await query("DELETE FROM user_blocks WHERE blocker_id = $1", [viewer.id]);
      await query("UPDATE posts SET hidden_at = null WHERE id = $1", [hidden]);

      const foreign = await json(await forYou(other, firstPage.nextCursor ?? Buffer.from(JSON.stringify({ r: firstPage.requestId, o: 0 })).toString("base64url")), 400);
      assert.equal(foreign.error, "invalid_cursor");
      assert.equal((await json(await forYou(viewer, "not-a-cursor"), 400)).error, "invalid_cursor");
      const { rows: [counter] } = await query("SELECT sum(value)::int AS n FROM feed_counters WHERE name = 'cursor_rejected'");
      assert.ok(counter.n >= 2);
    });

    await t.test("opted-out users get 403, anonymous viewers share one public request", async () => {
      const refused = await json(await forYou(optout), 403);
      assert.equal(refused.error, "feed_personalization_required");
      const one = await json(await forYou(null));
      const two = await json(await forYou(null));
      assert.ok(one.requestId);
      assert.equal(one.requestId, two.requestId);
      assert.deepEqual(one.posts.map((entry) => entry.id), two.posts.map((entry) => entry.id));
      const { rows: [request] } = await query("SELECT user_id, mode FROM feed_requests WHERE id = $1", [one.requestId]);
      assert.equal(request.user_id, null);
      assert.equal(request.mode, "public");
      const { rows: [served] } = await query("SELECT count(*)::int AS n FROM feed_candidates WHERE request_id = $1 AND served_at IS NOT NULL", [one.requestId]);
      assert.equal(served.n, 0);
      const legacy = await json(await call(null, "GET", "/api/posts"));
      assert.equal(legacy.requestId, one.requestId);
      const { rows: [hits] } = await query("SELECT sum(value)::int AS n FROM feed_counters WHERE name = 'public_cache_hit'");
      assert.ok(hits.n >= 2);

      await query("INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)", [authors[1].id, other.id]);
      await query("UPDATE users SET feed_choice_at = null WHERE id = $1", [other.id]);
      const publicForOther = await json(await forYou(other));
      assert.equal(publicForOther.requestId, one.requestId);
      assert.ok(!publicForOther.posts.some((entry) => entry.author.id === authors[1].id));
      await query("UPDATE users SET feed_choice_at = now() WHERE id = $1", [other.id]);
      await query("DELETE FROM user_blocks WHERE blocker_id = $1", [authors[1].id]);
    });

    await t.test("Following is shadow-logged for opted-in users only, and events keep owned request ids", async () => {
      const page = await json(await call(viewer, "GET", "/api/feed/following"));
      assert.ok(page.requestId);
      assert.ok(page.posts.length > 0);
      for (const entry of page.posts) assert.equal(page.placements[entry.id].requestId, page.requestId);
      const { rows: [request] } = await query("SELECT surface, mode, user_id FROM feed_requests WHERE id = $1", [page.requestId]);
      assert.deepEqual(request, { surface: "following", mode: "personal", user_id: viewer.id });
      const { rows: served } = await query("SELECT position, served_at FROM feed_candidates WHERE request_id = $1 ORDER BY position", [page.requestId]);
      assert.equal(served.length, page.posts.length);
      assert.ok(served.every((row, index) => row.served_at && row.position === index));

      const before = (await query("SELECT count(*)::int AS n FROM feed_requests WHERE user_id = $1", [optout.id])).rows[0].n;
      const optoutPage = await json(await call(optout, "GET", "/api/feed/following"));
      assert.equal(optoutPage.requestId, null);
      assert.equal((await query("SELECT count(*)::int AS n FROM feed_requests WHERE user_id = $1", [optout.id])).rows[0].n, before);

      const ranked = await json(await forYou(viewer));
      const target = ranked.posts[0].id;
      const sent = await call(viewer, "POST", "/api/feed/events", {
        sessionId: randomUUID(),
        events: [{ type: "impression", postId: target, surface: "for_you", position: 0, requestId: ranked.requestId, seq: 1, at: new Date().toISOString() }],
      });
      assert.equal(sent.status, 204);
      const { rows: [event] } = await query("SELECT request_id FROM feed_events WHERE user_id = $1 AND type = 'impression' ORDER BY id DESC LIMIT 1", [viewer.id]);
      assert.equal(event.request_id, ranked.requestId);
    });

    await t.test("a failing pipeline serves the chronological fallback and counts it", async () => {
      await query("ALTER TABLE feed_candidates RENAME TO feed_candidates_moved");
      try {
        const page = await json(await forYou(viewer));
        assert.equal(page.fallback, true);
        assert.equal(page.requestId, null);
        assert.ok(page.posts.length > 0);
        assert.ok(!page.posts.some((entry) => entry.id === mine));
      } finally {
        await query("ALTER TABLE feed_candidates_moved RENAME TO feed_candidates");
      }
      const { rows: [errors] } = await query("SELECT sum(value)::int AS n FROM feed_counters WHERE name = 'pipeline_error'");
      assert.ok(errors.n >= 1);
    });

    await t.test("a timed out ranking serves the fallback and marks nothing as served", async () => {
      const startedAt = new Date();
      const lock = await database.pool.connect();
      try {
        await lock.query("BEGIN");
        await lock.query("LOCK TABLE feed_candidates IN SHARE MODE");
        const page = await json(await forYou(viewer));
        assert.equal(page.fallback, true);
        await lock.query("COMMIT");
      } finally {
        lock.release();
      }
      let late;
      for (let attempt = 0; attempt < 50 && !late; attempt++) {
        late = (await query("SELECT id FROM feed_requests WHERE user_id = $1 AND surface = 'for_you' AND created_at >= $2", [viewer.id, startedAt])).rows[0];
        if (!late) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(late);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const { rows: [served] } = await query("SELECT count(*)::int AS n FROM feed_candidates WHERE request_id = $1 AND served_at IS NOT NULL", [late.id]);
      assert.equal(served.n, 0);
      const { rows: [counter] } = await query("SELECT sum(value)::int AS n FROM feed_counters WHERE name = 'pipeline_fallback_chrono'");
      assert.ok(counter.n >= 1);
    });

    await t.test("admin feed stats and config", async () => {
      assert.equal((await call(viewer, "GET", "/api/admin/feed", undefined, "http://localhost:3200")).status, 403);
      const dashboard = await json(await call(moderator, "GET", "/api/admin/feed?days=7", undefined, "http://localhost:3200"));
      for (const key of ["adoption", "pipeline", "engagement", "position", "diversity", "training", "model", "volume"]) {
        assert.ok(dashboard[key], key);
        assert.equal(dashboard[key].error, undefined, key);
      }
      assert.equal(dashboard.days, 7);
      assert.equal(dashboard.adoption.optedOut, 1);
      assert.ok(dashboard.adoption.optedIn >= 9);
      assert.ok(dashboard.pipeline.requestsByDay.length === 7);
      assert.ok(dashboard.pipeline.latencyMs.p95 >= 0);
      assert.equal(dashboard.engagement.surfaces.find((row) => row.surface === "for_you")?.per100 ?? null, null);
      assert.equal(dashboard.position.enough, false);
      assert.equal(dashboard.training.heads.length, 9);
      assert.equal(dashboard.model.featureNames.length, featureNames.length);
      assert.equal(dashboard.model.config.epsilon, 0);

      const system = await json(await call(moderator, "GET", "/api/admin/system", undefined, "http://localhost:3200"));
      assert.equal(system.feed.optedOut, 1);
      assert.ok(system.feed.requests24h.personal >= 1);
      assert.ok(system.feed.errors24h >= 1);

      const current = await json(await call(moderator, "GET", "/api/admin/feed/config", undefined, "http://localhost:3200"));
      assert.equal(current.config.epsilon, 0);
      assert.deepEqual(Object.keys(current.defaults).sort(), Object.keys(current.config).sort());
      assert.equal((await call(admin, "PUT", "/api/admin/feed/config", { config: current.config }, "http://localhost:3200")).status, 404);
    });

    await t.test("reset and turning personalization off delete stored requests", async () => {
      assert.ok((await query("SELECT count(*)::int AS n FROM feed_requests WHERE user_id = $1", [viewer.id])).rows[0].n > 0);
      assert.equal((await call(viewer, "POST", "/api/feed/reset")).status, 200);
      assert.equal((await query("SELECT count(*)::int AS n FROM feed_requests WHERE user_id = $1", [viewer.id])).rows[0].n, 0);
      await json(await forYou(viewer));
      const off = await json(await call(viewer, "PATCH", "/api/feed/preferences", { personalize: false, source: "nav" }));
      assert.equal(off.personalize, false);
      assert.equal((await query("SELECT count(*)::int AS n FROM feed_requests WHERE user_id = $1", [viewer.id])).rows[0].n, 0);
      const on = await json(await call(viewer, "PATCH", "/api/feed/preferences", { personalize: true, source: "nav" }));
      assert.equal(on.personalize, true);
      assert.equal((await call(viewer, "POST", "/api/feed/choice-declined")).status, 204);
      const { rows } = await query("SELECT name, sum(value)::int AS n FROM feed_counters WHERE name LIKE 'choice_%' GROUP BY name ORDER BY name");
      assert.deepEqual(rows, [{ name: "choice_decline_nav", n: 2 }, { name: "choice_unlock_nav", n: 1 }]);
    });

    await t.test("deleting posts and accounts cascades into stored feed rows", async () => {
      const page = await json(await forYou(viewer));
      const removed = page.posts[0].id;
      await query("DELETE FROM posts WHERE id = $1", [removed]);
      assert.equal((await query("SELECT count(*)::int AS n FROM feed_candidates WHERE post_id = $1", [removed])).rows[0].n, 0);
      await query("DELETE FROM users WHERE id = $1", [viewer.id]);
      assert.equal((await query("SELECT count(*)::int AS n FROM feed_requests WHERE user_id = $1", [viewer.id])).rows[0].n, 0);
      assert.equal((await query("SELECT count(*)::int AS n FROM feed_candidates WHERE request_id = $1", [page.requestId])).rows[0].n, 0);
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
