import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("feed controls: feedback, snoozes, topics, sliders, explanations and reset", async (t) => {
  const connection = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_feed_controls_test_${randomUUID().replaceAll("-", "")}`;
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
    const { runRetention } = await import("../src/retention.ts");
    await migrate(database.db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
    const query = (text, values) => database.pool.query(text, values);
    await query(`INSERT INTO feed_config ("values") VALUES ($1)`, [JSON.stringify({ epsilon: 0, pageSize: 50, storedCandidates: 100, minCandidates: 0, authorMaxPer10: 10 })]);

    async function account(handle, { role = "user", personalize = true } = {}) {
      const { rows: [user] } = await query(
        "INSERT INTO users (handle, role, approved_at, feed_personalize, feed_choice_at) VALUES ($1, $2, now(), $3, now()) RETURNING id",
        [handle, role, personalize]);
      const { rows: [identity] } = await query(
        "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', $1, $2) RETURNING id", [handle, user.id]);
      const token = randomUUID();
      await query(
        "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
        [hash(token), identity.id]);
      return { id: user.id, handle, cookie: `session=${token}` };
    }
    async function post(author, content, { minutesAgo = 0, parentId = null, topics = [] } = {}) {
      const { rows: [row] } = await query(
        "INSERT INTO posts (author_id, content, parent_id, created_at) VALUES ($1, $2, $3, now() - $4 * interval '1 minute') RETURNING id",
        [author.id, content, parentId, minutesAgo]);
      for (const topic of topics) await query("INSERT INTO post_topics (post_id, topic) VALUES ($1, $2)", [row.id, topic]);
      return row.id;
    }

    const viewer = await account("viewer");
    const other = await account("other");
    const optout = await account("optout", { personalize: false });
    const moderator = await account("mod", { role: "moderator" });
    const [ann, ben, cat, dan] = [await account("ann"), await account("ben"), await account("cat"), await account("dan")];
    await query("INSERT INTO user_follows (follower_id, following_id) VALUES ($1, $2)", [viewer.id, ann.id]);
    const annCats = await post(ann, "ann #cats", { minutesAgo: 10, topics: ["cats"] });
    const annPlain = await post(ann, "ann plain", { minutesAgo: 20 });
    const benPlain = await post(ben, "ben plain", { minutesAgo: 30 });
    const benOld = await post(ben, "ben old", { minutesAgo: 60 * 40 });
    const catCats = await post(cat, "cat #cats", { minutesAgo: 40, topics: ["cats"] });
    const catDogs = await post(cat, "cat #dogs", { minutesAgo: 50, topics: ["dogs"] });
    const danPlain = await post(dan, "dan plain", { minutesAgo: 15 });
    const annReply = await post(ann, "ann replies", { minutesAgo: 5, parentId: danPlain });
    const mine = await post(viewer, "my post");

    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (who, method, path, body, origin = "http://localhost:3000", headers = {}) => fetch(base + path, {
      method,
      headers: {
        ...(who ? { Cookie: who.cookie } : {}),
        Origin: origin,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = async (response, status = 200) => {
      assert.equal(response.status, status);
      return status === 204 ? null : response.json();
    };
    const feedback = (who, body, headers) => call(who, "POST", "/api/feed/feedback", body, undefined, headers);
    async function ranked(who = viewer) {
      const page = await json(await call(who, "GET", "/api/feed/for-you"));
      const { rows } = await query("SELECT post_id, score FROM feed_candidates WHERE request_id = $1", [page.requestId]);
      return { page, ids: page.posts.map((entry) => entry.id), scores: new Map(rows.map((row) => [row.post_id, row.score])) };
    }
    const ratio = (after, before, id) => after.scores.get(id) / before.scores.get(id);
    const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.03, `${message}: ${actual} vs ${expected}`);

    const baseline = await ranked();
    await t.test("the baseline includes replies by followees and no control reasons", async () => {
      assert.ok(baseline.ids.includes(annReply));
      assert.ok(!baseline.ids.includes(mine));
      const { rows: [request] } = await query("SELECT prefs FROM feed_requests WHERE id = $1", [baseline.page.requestId]);
      assert.deepEqual(request.prefs.sliders, { discovery: 0, freshness: 0, replies: 0 });
    });

    await t.test("not interested hides the post, lowers its author and topics, and records a less event", async () => {
      const created = await json(await feedback(viewer, { kind: "post", postId: annCats, direction: -1 }, { "X-Feed-Context": `for_you 0 ${baseline.page.requestId}` }), 201);
      assert.ok(created.expiresAt);
      const after = await ranked();
      assert.ok(!after.ids.includes(annCats));
      near(ratio(after, baseline, annPlain), 0.7, "author");
      near(ratio(after, baseline, catCats), 0.8, "topic");
      near(ratio(after, baseline, benPlain), 1, "unrelated");
      const { rows } = await query("SELECT type, post_id, author_id, request_id FROM feed_events WHERE user_id = $1 AND type = 'less'", [viewer.id]);
      assert.deepEqual(rows, [{ type: "less", post_id: annCats, author_id: ann.id, request_id: baseline.page.requestId }]);

      const flipped = await json(await feedback(viewer, { kind: "post", postId: annCats, direction: 1 }), 201);
      assert.equal(flipped.id, created.id);
      const interested = await ranked();
      assert.ok(interested.ids.includes(annCats));
      near(ratio(interested, baseline, annPlain), 1.3, "interested author");
      assert.equal(interested.page.placements[catCats].reason, "topic");
      assert.equal((await call(viewer, "DELETE", `/api/feed/feedback/${created.id}`)).status, 204);
      assert.equal((await call(viewer, "DELETE", `/api/feed/feedback/${created.id}`)).status, 404);
      near(ratio(await ranked(), baseline, annPlain), 1, "removed");
    });

    await t.test("snoozing removes the author until it expires", async () => {
      const snooze = await json(await feedback(viewer, { kind: "snooze", authorId: ben.id }), 201);
      const days = (new Date(snooze.expiresAt).getTime() - Date.now()) / 86_400_000;
      assert.ok(days > 29.9 && days <= 30);
      const after = await ranked();
      assert.ok(!after.ids.includes(benPlain) && !after.ids.includes(benOld));
      const listed = await json(await call(viewer, "GET", "/api/feed/feedback"));
      assert.equal(listed.snoozed.length, 1);
      assert.equal(listed.snoozed[0].user.handle, "ben");
      await query("UPDATE feed_feedback SET expires_at = now() - interval '1 minute' WHERE id = $1", [snooze.id]);
      assert.ok((await ranked()).ids.includes(benPlain));
      assert.equal((await json(await call(viewer, "GET", "/api/feed/feedback"))).snoozed.length, 0);
      assert.equal((await runRetention(database.pool)).feed_feedback_expired, 1);
    });

    await t.test("topic choices raise and lower matching posts", async () => {
      await json(await feedback(viewer, { kind: "topic", topic: "#Dogs", direction: 1 }), 201);
      await json(await feedback(viewer, { kind: "topic", topic: "cats", direction: -1 }), 201);
      const after = await ranked();
      near(ratio(after, baseline, catDogs), 1.5, "more");
      near(ratio(after, baseline, annCats), 0.3, "less");
      const { rows } = await query("SELECT type, detail FROM feed_events WHERE user_id = $1 AND type LIKE 'topic_%' ORDER BY id", [viewer.id]);
      assert.deepEqual(rows, [{ type: "topic_more", detail: "dogs" }, { type: "topic_less", detail: "cats" }]);
      const listed = await json(await call(viewer, "GET", "/api/feed/feedback"));
      assert.deepEqual(listed.topics.map((entry) => [entry.topic, entry.direction]).sort(), [["cats", -1], ["dogs", 1]]);
      assert.equal((await json(await call(viewer, "DELETE", "/api/feed/feedback?kind=topic"))).removed, 2);
    });

    await t.test("sliders change replies, discovery and freshness and are logged on the request", async () => {
      const replies = await json(await call(viewer, "PATCH", "/api/feed/preferences", { replies: -2 }));
      assert.equal(replies.replies, -2);
      assert.equal(replies.personalize, true);
      assert.ok(!(await ranked()).ids.includes(annReply));
      await json(await call(viewer, "PATCH", "/api/feed/preferences", { replies: 0, discovery: -2 }));
      const narrow = await ranked();
      near(ratio(narrow, baseline, annPlain), 1, "in network");
      near(ratio(narrow, baseline, benPlain), 0.3, "out of network");
      await json(await call(viewer, "PATCH", "/api/feed/preferences", { discovery: 0, freshness: 2 }));
      const fresh = await ranked();
      near(ratio(fresh, baseline, benOld), (0.3 + 0.7 * 0.5 ** (40 / 6)) / (0.3 + 0.7 * 0.5 ** (40 / 24)), "old post");
      assert.ok(ratio(fresh, baseline, benPlain) > 0.9);
      const { rows: [request] } = await query("SELECT prefs FROM feed_requests WHERE id = $1", [fresh.page.requestId]);
      assert.deepEqual(request.prefs.sliders, { discovery: 0, freshness: 2, replies: 0 });
      const preferences = await json(await call(viewer, "GET", "/api/feed/preferences"));
      assert.deepEqual(preferences, { personalize: true, chosen: true, discovery: 0, freshness: 2, replies: 0 });
      await json(await call(viewer, "PATCH", "/api/feed/preferences", { freshness: 0 }));
    });

    await t.test("invalid feedback and preferences are refused", async () => {
      assert.equal((await json(await feedback(viewer, { kind: "post", postId: mine, direction: -1 }), 400)).error, "invalid_feed_feedback");
      assert.equal((await json(await feedback(viewer, { kind: "post", postId: randomUUID(), direction: -1 }), 404)).error, "post_not_found");
      assert.equal((await json(await feedback(viewer, { kind: "snooze", authorId: viewer.id }), 400)).error, "invalid_feed_feedback");
      assert.equal((await json(await feedback(viewer, { kind: "topic", topic: "no spaces", direction: 1 }), 400)).error, "invalid_feed_feedback");
      assert.equal((await json(await feedback(viewer, { kind: "post", postId: annPlain, direction: 2 }), 400)).error, "invalid_feed_feedback");
      assert.equal((await json(await call(viewer, "PATCH", "/api/feed/preferences", { discovery: 3 }), 400)).error, "invalid_feed_preferences");
      assert.equal((await json(await call(viewer, "PATCH", "/api/feed/preferences", {}), 400)).error, "invalid_feed_preferences");
      assert.equal((await call(null, "POST", "/api/feed/feedback", { kind: "snooze", authorId: ben.id })).status, 401);
      assert.equal((await call(viewer, "DELETE", "/api/feed/feedback?kind=nope")).status, 400);
    });

    await t.test("why explains served posts of the viewer's own requests only", async () => {
      const page = (await ranked()).page;
      const postId = page.posts[0].id;
      const why = await json(await call(viewer, "GET", `/api/feed/why/${postId}?request=${page.requestId}`));
      assert.equal(why.postId, postId);
      assert.ok(why.factors.length > 0 && why.factors.length <= 4);
      assert.ok(why.factors.every((factor) => ["low", "medium", "high"].includes(factor.strength)));
      assert.deepEqual(why.controls.sliders, { discovery: 0, freshness: 0, replies: 0 });
      assert.equal((await json(await call(other, "GET", `/api/feed/why/${postId}?request=${page.requestId}`), 404)).error, "feed_explanation_unavailable");
      assert.equal((await call(viewer, "GET", `/api/feed/why/${postId}?request=nope`)).status, 404);
      assert.equal((await call(viewer, "GET", `/api/feed/why/${mine}?request=${page.requestId}`)).status, 404);
    });

    await t.test("opted-out users can store controls without events", async () => {
      await json(await feedback(optout, { kind: "snooze", authorId: ann.id }), 201);
      const { rows } = await query("SELECT count(*)::int AS n FROM feed_events WHERE user_id = $1", [optout.id]);
      assert.equal(rows[0].n, 0);
    });

    await t.test("the admin dashboard summarizes controls", async () => {
      await json(await feedback(other, { kind: "post", postId: danPlain, direction: -1 }), 201);
      const dashboard = await json(await call(moderator, "GET", "/api/admin/feed?days=7", undefined, "http://localhost:3200"));
      const controls = dashboard.controls;
      assert.equal(controls.error, undefined);
      assert.equal(controls.enough, true);
      assert.equal(controls.actionsByDay.length, 7);
      assert.ok(controls.actionsByDay.at(-1).less >= 2);
      assert.equal(controls.active.notInterested, 1);
      assert.equal(controls.active.snoozes, 1);
      assert.equal(controls.usersWithControls, null);
      assert.equal(controls.sliders.length, 3);
      assert.equal(controls.sliders[0].levels.reduce((sum, level) => sum + level.users, 0), controls.optedIn);
      assert.deepEqual(controls.topTopics, []);
      assert.ok(dashboard.volume.tables.some((table) => table.name === "feed_feedback"));
    });

    await t.test("reset clears feedback and sliders; deleting a target cascades", async () => {
      await json(await feedback(viewer, { kind: "snooze", authorId: dan.id }), 201);
      await json(await feedback(viewer, { kind: "author", authorId: cat.id, direction: 1 }), 201);
      await json(await call(viewer, "PATCH", "/api/feed/preferences", { discovery: 1 }));
      await json(await call(viewer, "POST", "/api/feed/reset"));
      assert.equal((await query("SELECT count(*)::int AS n FROM feed_feedback WHERE user_id = $1", [viewer.id])).rows[0].n, 0);
      assert.equal((await query("SELECT feed_discovery FROM users WHERE id = $1", [viewer.id])).rows[0].feed_discovery, 0);
      await json(await feedback(other, { kind: "snooze", authorId: dan.id }), 201);
      await query("DELETE FROM users WHERE id = $1", [dan.id]);
      assert.equal((await query("SELECT count(*)::int AS n FROM feed_feedback WHERE user_id = $1", [other.id])).rows[0].n, 0);
      await query("DELETE FROM users WHERE id = $1", [optout.id]);
      assert.equal((await query("SELECT count(*)::int AS n FROM feed_feedback")).rows[0].n, 0);
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
