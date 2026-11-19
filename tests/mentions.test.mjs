import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { config } from "dotenv";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("mentions resolve, notify, edit, and deduplicate through the API", async () => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_replies_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  let pool, server;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      NODE_ENV: "test",
      R2_ACCOUNT_ID: "a".repeat(32),
      R2_BUCKET: "reply-tests",
      R2_ACCESS_KEY_ID: "test",
      R2_SECRET_ACCESS_KEY: "test",
    });
    const { app } = await import("../src/app.ts");
    const database = await import("../src/db/index.ts");
    pool = database.pool;
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    const { env } = await import("../src/config.ts");
    const { hash } = await import("../src/auth/secrets.ts");
    const { rows: [user] } = await pool.query(
      "INSERT INTO users (handle) VALUES ('reply_author') RETURNING id",
    );
    const { rows: [identity] } = await pool.query(
      "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', 'reply-author', $1) RETURNING id",
      [user.id],
    );
    const token = randomUUID();
    await pool.query(
      "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
      [hash(token), identity.id],
    );
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const availability = await fetch(base + "/api/profiles/whz/availability");
    assert.equal(availability.status, 200);
    assert.deepEqual(await availability.json(), { available: false });
    async function request(path, method = "GET", body) {
      return fetch(base + path, {
        method,
        headers: {
          Origin: env.APP_ORIGIN,
          Cookie: `session=${token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    async function get(path) {
      const response = await request(path);
      assert.equal(response.status, 200);
      return response.json();
    }
    const { rows: [target] } = await pool.query("INSERT INTO users (handle) VALUES ('tag_target') RETURNING id");
    await pool.query("INSERT INTO users (handle) VALUES ('tag_tom'), ('tag_tina'), ('other_tag'), ('tag_tim')");
    const anonymous = await fetch(base + '/api/profiles/suggestions?q=tag', { headers: { Origin: env.APP_ORIGIN } });
    assert.equal(anonymous.status, 401);
    // Browsers send no Origin header on same-origin GETs.
    const browserGet = await fetch(base + '/api/profiles/suggestions?q=tag', { headers: { Cookie: `session=${token}` } });
    assert.equal(browserGet.status, 200);
    const suggestions = await get('/api/profiles/suggestions?q=TAG_T');
    assert.equal(suggestions.users.length, 3);
    assert.deepEqual(suggestions.users.map((user) => user.handle), ['tag_target', 'tag_tim', 'tag_tina']);
    assert.deepEqual((await get('/api/profiles/suggestions?q=tag_target')).users.map((user) => user.handle), ['tag_target']);
    assert.deepEqual((await get('/api/profiles/suggestions?q=not_present')).users, []);
    assert.deepEqual((await get('/api/profiles/suggestions?q=')).users, []);
    assert.equal((await request('/api/profiles/suggestions?q=bad%25')).status, 400);
    const id = randomUUID();
    const content = "Hello @TAG_TARGET, @tag_target! @missing_user email@tag_target /@tag_target @tag_target_extra";
    for (let i = 0; i < 2; i++) {
      const response = await request('/api/posts', 'POST', { content, clientId: id, attachmentIds: [] });
      assert.equal(response.status, 201);
      const { post } = await response.json();
      assert.deepEqual(post.mentions, [{ id: target.id, handle: 'tag_target', username: 'tag_target' }]);
    }
    const events = () => pool.query("SELECT * FROM notifications WHERE kind = 'mention' AND post_id = $1", [id]);
    assert.equal((await events()).rows.length, 1);
    let response = await request('/api/posts/' + id, 'PATCH', { content: 'Removed the tag' });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).post.mentions, []);
    response = await request('/api/posts/' + id, 'PATCH', { content: '@tag_target @reply_author' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).post.mentions.length, 2);
    assert.equal((await events()).rows.length, 1);
    const reply = await request('/api/posts/' + id + '/replies', 'POST', { content: '@tag_target', attachmentIds: [] });
    assert.equal(reply.status, 201);
    assert.equal((await reply.json()).post.mentions[0].id, target.id);
    const { mentionHandles } = await import('../src/mentions.ts');
    assert.deepEqual(mentionHandles('(@TAG_TARGET) @tag_target email@tag_target https://x/@tag_target @' + 'a'.repeat(33) + ' é@tag_target'), ['tag_target']);
    // Run the actual migration backfill against an old post, twice to prove it is repeatable.
    const { rows: [old] } = await pool.query("INSERT INTO posts (author_id, content, created_at) VALUES ($1, '@TAG_TARGET and email@tag_target', now() - interval '30 days') RETURNING id", [user.id]);
    const { readFile } = await import('node:fs/promises');
    const migration = await readFile(new URL('../drizzle/0017_post_mentions.sql', import.meta.url), 'utf8');
    const backfill = migration.slice(migration.indexOf('-- Resolve existing'));
    await pool.query(backfill);
    await pool.query(backfill);
    assert.deepEqual((await get('/api/posts/' + old.id)).post.mentions, [{ id: target.id, handle: 'tag_target', username: 'tag_target' }]);
    await pool.query("UPDATE users SET handle = 'renamed_target' WHERE id = $1", [target.id]);
    assert.equal((await get('/api/posts/' + old.id)).post.mentions[0].handle, 'renamed_target');
    const editedAlias = await request('/api/posts/' + id, 'PATCH', { content: 'Still tagging @tag_target' });
    assert.equal(editedAlias.status, 200);
    assert.deepEqual((await editedAlias.json()).post.mentions, [{ id: target.id, handle: 'renamed_target', username: 'tag_target' }]);
    const newAlias = await request('/api/posts/' + id + '/replies', 'POST', { content: '@tag_target and @renamed_target', attachmentIds: [] });
    assert.equal(newAlias.status, 201);
    const tagged = (await newAlias.json()).post.mentions;
    assert.deepEqual(tagged.map((mention) => mention.username).sort(), ['renamed_target', 'tag_target']);
    assert.ok(tagged.every((mention) => mention.id === target.id && mention.handle === 'renamed_target'));
    const aliasProfile = await get('/api/profiles/tag_target');
    assert.equal(aliasProfile.profile.id, target.id);
    assert.equal((await get('/api/profiles/tag_target/availability')).available, false);
    assert.equal((await request('/api/profiles/tag_target/follow', 'PUT')).status, 200);

    await request('/api/posts/' + id, 'DELETE');
    assert.equal((await pool.query('SELECT * FROM post_mentions WHERE post_id = $1', [id])).rows.length, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
