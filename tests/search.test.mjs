import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { config } from "dotenv";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("search queries are normalised into prefix tsqueries", async () => {
  const { parseSearchQuery } = await import("../src/search-text.ts");
  const cases = [
    ["hello", { term: "hello", usable: true, tsquery: "hello:*" }],
    ["  Hello   WORLD ", { term: "hello world", usable: true, tsquery: "hello & world:*" }],
    ["@Alice", { term: "alice", usable: true, tsquery: "alice:*" }],
    ["#Topic", { term: "topic", usable: true, tsquery: "topic:*" }],
    ["a", { term: "a", usable: false, tsquery: null }],
    ["", { term: "", usable: false, tsquery: null }],
    ["!!", { term: "!!", usable: false, tsquery: null }],
    ["it's & (a|b) !c <-> d:*", { term: "it's & (a|b) !c <-> d:*", usable: true, tsquery: "it & s & a & b & c & d:*" }],
    ["Größe", { term: "größe", usable: true, tsquery: "größe:*" }],
  ];
  for (const [raw, expected] of cases) {
    const { term, usable, tsquery } = parseSearchQuery(raw);
    assert.deepEqual({ term, usable, tsquery }, expected, JSON.stringify(raw));
  }
  assert.equal(parseSearchQuery("w ".repeat(40)).words.length, 8);
});

test("search finds users, topics and posts while hiding banned and unapproved accounts", async () => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_search_test_${randomUUID().replaceAll("-", "")}`;
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
    async function user(handle, displayName, { approved = true, banned = false } = {}) {
      const { rows: [row] } = await pool.query(
        `INSERT INTO users (handle, display_name, approved_at, banned_at)
         VALUES ($1, $2, ${approved ? "now()" : "null"}, ${banned ? "now()" : "null"}) RETURNING id`,
        [handle, displayName],
      );
      return row.id;
    }
    let tick = 0;
    async function post(authorId, content, { parentId = null, topics = [] } = {}) {
      const { rows: [row] } = await pool.query(
        `INSERT INTO posts (author_id, content, parent_id, created_at)
         VALUES ($1, $2, $3, now() - make_interval(secs => $4)) RETURNING id`,
        [authorId, content, parentId, 1000 - tick++],
      );
      for (const topic of topics)
        await pool.query("INSERT INTO post_topics (post_id, topic) VALUES ($1, $2)", [row.id, topic]);
      return row.id;
    }
    const alice = await user("alice", "Alice Anderson");
    const alicia = await user("alicia", "Alicia Keys");
    const bob = await user("bob_alice", "Bob");
    const carol = await user("carol", "Carol Alice");
    await user("alice_pending", "Pending", { approved: false });
    const banned = await user("alice_banned", "Banned", { banned: true });
    await pool.query("INSERT INTO user_follows (follower_id, following_id) VALUES ($1, $2), ($3, $2)", [bob, alicia, carol]);

    const root = await post(alice, "Gardening tips for spring", { topics: ["garden"] });
    const reply = await post(bob, "Tomatoes love the sun", { parentId: root });
    const gnomes = await post(alice, "Garden gnomes are underrated", { topics: ["garden", "gnomes"] });
    await post(carol, "Gardens of the world #gardening", { topics: ["gardening"] });
    await post(banned, "Garden spam from a banned account", { topics: ["garden"] });
    await post(alice, "Nothing relevant here");

    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    async function get(path, status = 200) {
      const response = await fetch(base + path);
      assert.equal(response.status, status, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "no-store");
      return response.json();
    }
    const q = (value) => encodeURIComponent(value);

    const preview = await get(`/api/search?q=${q("alic")}`);
    assert.deepEqual(preview.users.map((entry) => entry.handle), ["alicia", "alice", "carol"]);
    assert.equal(preview.moreUsers, true);
    assert.equal(preview.users[0].followerCount, 2);
    assert.deepEqual(Object.keys(preview.users[0]).sort(), ["avatarUrl", "bio", "displayName", "followerCount", "handle", "id", "paint"]);

    const exact = await get(`/api/search?q=${q("@Alice")}&type=users`);
    assert.deepEqual(
      exact.users.map((entry) => entry.handle),
      ["alice", "carol", "bob_alice"],
    );
    assert.equal(exact.nextCursor, null);

    const byName = await get(`/api/search?q=${q("Anderson")}&type=users`);
    assert.deepEqual(byName.users.map((entry) => entry.handle), ["alice"]);

    const topics = await get(`/api/search?q=${q("#garden")}&type=topics`);
    assert.deepEqual(topics.topics, [
      { name: "garden", count: 2 },
      { name: "gardening", count: 1 },
    ]);
    assert.deepEqual((await get(`/api/search?q=${q("den")}&type=topics`)).topics.map((entry) => entry.name), ["garden", "gardening"]);
    assert.deepEqual((await get(`/api/search?q=${q("garden gnomes")}&type=topics`)).topics, []);

    const short = await get(`/api/search?q=a`);
    assert.deepEqual(short, { users: [], topics: [], moreUsers: false, moreTopics: false });
    assert.deepEqual(await get(`/api/search`), short);

    await get(`/api/search?q=${q("x".repeat(101))}`, 400);
    await get(`/api/search?q=alice&type=posts`, 400);
    await get(`/api/search?q=alice&type=users&cursor=bogus`, 400);

    const page = await get(`/api/posts?q=${q("garden")}`);
    assert.deepEqual(page.posts.map((entry) => entry.content), [
      "Gardens of the world #gardening",
      "Garden gnomes are underrated",
      "Gardening tips for spring",
    ]);
    assert.equal(page.nextCursor, null);
    assert.deepEqual((await get(`/api/posts?q=${q("garden gnomes")}`)).posts.map((entry) => entry.content), [
      "Garden gnomes are underrated",
    ]);
    assert.deepEqual((await get(`/api/posts?q=${q("garden tips")}`)).posts, []);
    const phrase = await get(`/api/posts?q=${q("tips for spring")}`);
    assert.deepEqual(phrase.posts.map((entry) => entry.id), [root]);
    assert.deepEqual((await get(`/api/posts?q=${q("spring tips")}`)).posts.map((entry) => entry.id), [root]);
    assert.deepEqual((await get(`/api/posts?q=${q("spam")}`)).posts, []);

    const replies = await get(`/api/posts?q=${q("tomatoes")}`);
    assert.deepEqual(replies.posts.map((entry) => entry.id), [reply]);
    assert.deepEqual(replies.posts[0].ancestors.map((entry) => entry.id), [root]);

    const combined = await get(`/api/posts?q=${q("garden")}&topic=gnomes`);
    assert.deepEqual(combined.posts.map((entry) => entry.content), ["Garden gnomes are underrated"]);

    const contents = (page) => page.posts.map((entry) => entry.content);
    assert.deepEqual(contents(await get(`/api/posts?user=${q("@ALICE")}`)), [
      "Nothing relevant here",
      "Garden gnomes are underrated",
      "Gardening tips for spring",
    ]);
    assert.deepEqual(contents(await get(`/api/posts?q=garden&user=alice`)), [
      "Garden gnomes are underrated",
      "Gardening tips for spring",
    ]);
    assert.equal(contents(await get(`/api/posts?q=a&user=alice`)).length, 3);
    assert.deepEqual((await get(`/api/posts?user=nobody_here`)).posts, []);
    assert.deepEqual(contents(await get(`/api/posts?q=garden&sort=oldest`)), [
      "Gardening tips for spring",
      "Garden gnomes are underrated",
      "Gardens of the world #gardening",
    ]);
    const { rows: [{ at }] } = await pool.query("SELECT created_at AS at FROM posts WHERE id = $1", [gnomes]);
    const instant = at.toISOString();
    assert.deepEqual(contents(await get(`/api/posts?q=garden&from=${q(instant)}`)), [
      "Gardens of the world #gardening",
      "Garden gnomes are underrated",
    ]);
    assert.deepEqual(contents(await get(`/api/posts?q=garden&to=${q(instant)}`)), ["Gardening tips for spring"]);
    assert.deepEqual(contents(await get(`/api/posts?q=garden&from=${q(instant)}&to=${q(instant)}`)), []);
    for (const bad of ["from=yesterday", "to=2026-01-01", "user=a", "user=bad%20name", "sort=random"])
      await get(`/api/posts?q=garden&${bad}`, 400);

    assert.deepEqual((await get(`/api/posts?q=a`)).posts, []);
    assert.deepEqual((await get(`/api/posts?q=${q("(|&!:*)")}`)).posts, []);
    await get(`/api/posts?q=${q("x".repeat(101))}`, 400);

    await pool.query("UPDATE posts SET content = 'Edited to mention orchids' WHERE id = $1", [root]);
    assert.deepEqual((await get(`/api/posts?q=orchids`)).posts.map((entry) => entry.id), [root]);
    assert.deepEqual((await get(`/api/posts?q=${q("tips for spring")}`)).posts, []);

    await pool.query("UPDATE users SET banned_at = now() WHERE id = $1", [carol]);
    assert.deepEqual((await get(`/api/search?q=carol&type=users`)).users, []);
    assert.deepEqual((await get(`/api/posts?q=${q("gardens of the world")}`)).posts, []);
    assert.deepEqual((await get(`/api/search?q=gardening&type=topics`)).topics, []);

    const pager = await user("pager", "Pager");
    for (let index = 0; index < 25; index++) await post(pager, `pagination marker ${index}`);
    const firstPage = await get(`/api/posts?user=pager&sort=oldest`);
    assert.equal(firstPage.posts.length, 20);
    assert.ok(firstPage.nextCursor);
    const secondPage = await get(`/api/posts?user=pager&sort=oldest&cursor=${firstPage.nextCursor}`);
    assert.equal(secondPage.posts.length, 5);
    assert.equal(secondPage.nextCursor, null);
    assert.deepEqual(
      [...firstPage.posts, ...secondPage.posts].map((entry) => entry.content),
      Array.from({ length: 25 }, (_, index) => `pagination marker ${index}`),
    );

    for (let index = 0; index < 25; index++) await user(`many_${index}`, `Many ${index}`);
    const first = await get(`/api/search?q=many&type=users`);
    assert.equal(first.users.length, 20);
    assert.ok(first.nextCursor);
    const second = await get(`/api/search?q=many&type=users&cursor=${first.nextCursor}`);
    assert.equal(second.users.length, 5);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.users, ...second.users].map((entry) => entry.id)).size, 25);
  } finally {
    if (server) {
      server.closeAllConnections();
      server.close();
    }
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
