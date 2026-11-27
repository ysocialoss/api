import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { config } from "dotenv";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("post and reply flows", async (t) => {
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
      KLIPY_API_KEY: "reply-tests-key",
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
    await pool.query(`INSERT INTO feed_config ("values") VALUES ('{"publicCacheSeconds":0}')`);
    const { env } = await import("../src/config.ts");
    const { hash } = await import("../src/auth/secrets.ts");
    const { rows: [user] } = await pool.query(
      "INSERT INTO users (handle, approved_at) VALUES ('reply_author', now()) RETURNING id",
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
    async function request(path, method = "GET", body, sessionToken = token) {
      return fetch(base + path, {
        method,
        headers: {
          Origin: env.APP_ORIGIN,
          ...(sessionToken ? { Cookie: `session=${sessionToken}` } : {}),
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
    async function getPublic(path) {
      const response = await request(path, "GET", undefined, null);
      assert.equal(response.status, 200);
      return response.json();
    }
    async function create(parentId, clientId = randomUUID()) {
      const response = await request(
        parentId ? `/api/posts/${parentId}/replies` : "/api/posts",
        "POST",
        { content: "Reply count regression", clientId },
      );
      assert.equal(response.status, 201);
      return (await response.json()).post;
    }
    async function count(id, expected) {
      assert.equal((await get(`/api/posts/${id}`)).post.replies, expected);
    }

    await t.test("reply totals include every descendant and track subtree deletion", async () => {
      const root = await create();
      const unrelated = await create();
      await create(unrelated.id);
      await count(root.id, 0);
      const comment = await create(root.id);
      await count(root.id, 1);
      const replyId = randomUUID();
      const reply = await create(comment.id, replyId);
      await count(root.id, 2);
      await count(comment.id, 1);
      // Retrying the same write must not inflate any ancestor's total.
      assert.equal((await create(comment.id, replyId)).id, reply.id);
      await create(reply.id);
      const sibling = await create(root.id);
      await count(root.id, 4);
      await count(comment.id, 2);
      await count(reply.id, 1);
      await count(sibling.id, 0);
      await count(unrelated.id, 1);

      const feed = await getPublic("/api/posts");
      assert.equal(feed.posts.find((post) => post.id === root.id).replies, 4);
      const children = await get(`/api/posts/${root.id}/replies`);
      assert.deepEqual(new Set(children.posts.map((post) => post.id)), new Set([comment.id, sibling.id]));
      assert.equal(children.posts.find((post) => post.id === comment.id).replies, 2);
      const profile = await get("/api/profiles/reply_author");
      assert.equal(profile.posts.find((post) => post.id === root.id).replies, 4);
      assert.equal(profile.replies.find(({ post }) => post.id === reply.id).thread[0].replies, 4);

      assert.equal((await request(`/api/posts/${reply.id}`, "DELETE")).status, 204);
      await count(root.id, 2);
      await count(comment.id, 0);
      assert.equal((await request(`/api/posts/${comment.id}`, "DELETE")).status, 204);
      await count(root.id, 1);
      assert.equal((await request(`/api/posts/${sibling.id}`, "DELETE")).status, 204);
      await count(root.id, 0);
      await count(unrelated.id, 1);
    });

    await t.test("post content allows at most two consecutive blank lines", async () => {
      const allowed = "First\r\n \r\n\t\r\nLast";
      const created = await request("/api/posts", "POST", { content: allowed });
      assert.equal(created.status, 201);
      const { post } = await created.json();
      assert.equal(post.content, allowed);

      const content = "First\n\n \n\t\nLast";
      const path = `/api/posts/${post.id}`;
      for (const response of [
        await request("/api/posts", "POST", { content }),
        await request("/api/posts", "POST", { content, quotedPostId: post.id }),
        await request(`${path}/replies`, "POST", { content }),
        await request(path, "PATCH", { content }),
      ]) {
        assert.equal(response.status, 400);
      }
      assert.equal((await get(path)).post.content, allowed);
    });

    await t.test("posting, replying, and editing allow more than five links", async () => {
      const content = Array.from({ length: 8 }, (_, index) => `https://example.org/${index}`).join(" ");
      const clientId = randomUUID();

      const created = await request("/api/posts", "POST", { content, clientId });
      assert.equal(created.status, 201);
      const { post } = await created.json();
      assert.equal(post.id, clientId);
      assert.equal(post.content, content);
      const postPath = `/api/posts/${post.id}`;

      const replay = await request("/api/posts", "POST", { content, clientId });
      assert.equal(replay.status, 201);
      assert.equal((await replay.json()).post.id, clientId);
      const reply = await request(`${postPath}/replies`, "POST", { content });
      assert.equal(reply.status, 201);
      assert.equal((await reply.json()).post.content, content);
      const edit = await request(postPath, "PATCH", { content: `Edited: ${content}` });
      assert.equal(edit.status, 200);
      assert.equal((await get(postPath)).post.content, `Edited: ${content}`);
    });

    await t.test("KLIPY GIFs survive publishing, retries, and caption edits", async () => {
      const url = "https://static.klipy.com/test/wave.gif";
      const title = "Waving hello";
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input, options) => {
        const target = new URL(input);
        if (target.hostname !== "api.klipy.com") return originalFetch(input, options);
        assert.equal(target.pathname, `/api/v1/${env.KLIPY_API_KEY}/gifs/search`);
        assert.equal(target.searchParams.get("q"), "wave");
        return Promise.resolve(Response.json({
          result: true,
          data: { data: [{
            slug: "wave",
            title,
            type: "gif",
            file: { hd: { gif: { url } }, sm: { gif: { url } } },
          }] },
        }));
      };
      let gifToken;
      try {
        const response = await request("/api/banners/gifs/search", "POST", { query: "wave" });
        assert.equal(response.status, 200);
        gifToken = (await response.json()).items[0].token;
      } finally {
        globalThis.fetch = originalFetch;
      }

      const clientId = randomUUID();
      const send = (body) => request("/api/posts", "POST", body);
      assert.equal((await send({ content: " " })).status, 400);
      assert.equal((await send({ gifToken: `${gifToken}tampered` })).status, 400);
      const response = await send({ clientId, gifToken });
      assert.equal(response.status, 201);
      const { post } = await response.json();
      assert.equal(post.content, "");
      assert.deepEqual(post.gif, { url, title });
      assert.equal((await send({ clientId, gifToken })).status, 201);
      assert.equal((await send({ clientId, content: "Different post" })).status, 409);

      const [payload] = gifToken.split(".");
      const expired = Buffer.from(JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString()),
        expires: Date.now() - 1000,
      })).toString("base64url");
      const signature = createHmac("sha256", env.KLIPY_API_KEY).update(expired).digest("base64url");
      const expiredToken = `${expired}.${signature}`;
      assert.equal((await send({ clientId, gifToken: expiredToken })).status, 201);
      assert.equal((await send({ clientId: randomUUID(), gifToken: expiredToken })).status, 400);

      const path = `/api/posts/${post.id}`;
      const poll = { title: "Which greeting?", options: ["Wave", "High five"] };
      const reply = await request(`${path}/replies`, "POST", { content: " #hello ", gifToken, poll });
      assert.equal(reply.status, 201);
      const { post: child } = await reply.json();
      assert.equal(child.content, "#hello");
      assert.deepEqual(child.gif, post.gif);
      assert.equal(child.poll.title, poll.title);

      for (const content of ["Caption", ""]) {
        const edited = await request(path, "PATCH", { content });
        assert.equal(edited.status, 200);
        const result = (await edited.json()).post;
        assert.equal(result.content, content);
        assert.deepEqual(result.gif, post.gif);
      }
      const textOnly = await create();
      assert.equal(textOnly.gif, null);
      assert.equal((await request(`/api/posts/${textOnly.id}`, "PATCH", { content: "" })).status, 400);

      const feed = await getPublic("/api/posts");
      assert.deepEqual(feed.posts.find((row) => row.id === post.id).gif, post.gif);
      const thread = await get(`${path}/thread`);
      assert.deepEqual(thread.post.gif, post.gif);
      assert.deepEqual(thread.replies[0].gif, child.gif);
      assert.deepEqual(thread.replies[0].poll, child.poll);

      const gifPoll = await send({ gifToken, poll });
      assert.equal(gifPoll.status, 201);
      const { post: combined } = await gifPoll.json();
      assert.equal(combined.content, "");
      assert.deepEqual(combined.gif, post.gif);
      assert.equal(combined.poll.title, poll.title);
      assert.equal(combined.poll.anonymous, false);
    });

    await t.test("polls respect privacy and allow each account to change its vote", async () => {
      const poll = { title: "  Choose a color  ", options: [" Red ", "Blue"], anonymous: true };
      const send = (body) => request("/api/posts", "POST", body);
      for (const invalid of [
        { options: poll.options },
        { ...poll, title: "  " },
        { ...poll, options: ["One"] },
        { ...poll, options: ["Red", " red "] },
      ]) {
        assert.equal((await send({ content: "Caption", poll: invalid })).status, 400);
      }
      const clientId = randomUUID();
      const created = await send({ clientId, poll, content: "Caption" });
      assert.equal(created.status, 201);
      const { post } = await created.json();
      assert.deepEqual(post.poll, {
        title: "Choose a color",
        options: [{ label: "Red", votes: 0 }, { label: "Blue", votes: 0 }],
        anonymous: true,
        allowRevote: true,
        selectedOption: null,
      });
      assert.equal((await send({ clientId, poll, content: "Caption" })).status, 201);
      assert.equal((await send({
        clientId, content: "Caption", poll: { ...poll, anonymous: false },
      })).status, 409);
      const path = `/api/posts/${post.id}`;
      assert.equal((await request(path, "PATCH", { content: "" })).status, 200);
      const vote = (index, sessionToken) =>
        request(`${path}/poll/vote`, "PUT", { optionIndex: index }, sessionToken);
      assert.equal((await vote(0, null)).status, 401);
      assert.equal((await vote(2)).status, 400);
      const votes = await Promise.all([vote(0), vote(1)]);
      assert.deepEqual(votes.map(({ status }) => status), [200, 200]);
      const savedVote = (await get(path)).post.poll;
      assert.equal(savedVote.options.reduce((sum, option) => sum + option.votes, 0), 1);
      assert.equal(savedVote.allowRevote, true);
      assert.equal((await vote(savedVote.selectedOption)).status, 200);
      assert.equal((await request(`${path}/poll/voters?option=${savedVote.selectedOption}`)).status, 403);
      assert.equal((await request(`${path}/poll/voters?option=0&option=1`)).status, 403);
      assert.equal((await request(`${path}/poll/voters`)).status, 403);
      const visitor = await request(path, "GET", undefined, null);
      assert.deepEqual((await visitor.json()).post.poll, { ...savedVote, selectedOption: null });
      const batchPath = `/api/posts/poll-results?ids=${post.id},${randomUUID()}`;
      const batch = await get(batchPath);
      assert.deepEqual(batch, { viewerId: user.id, results: [{ id: post.id, poll: savedVote }] });
      const guestBatch = await request(batchPath, "GET", undefined, null);
      assert.deepEqual(await guestBatch.json(), {
        viewerId: null,
        results: [{ id: post.id, poll: { ...savedVote, selectedOption: null } }],
      });
      assert.equal((await request("/api/posts/poll-results?ids=invalid")).status, 400);
      const feed = await getPublic("/api/posts");
      assert.deepEqual(feed.posts.find((entry) => entry.id === post.id).poll, { ...savedVote, selectedOption: null });
      const profile = await get("/api/profiles/reply_author");
      assert.deepEqual(profile.posts.find((entry) => entry.id === post.id).poll, savedVote);

      const open = await send({
        poll: { ...poll, options: [...poll.options, "Green"], anonymous: false },
      });
      assert.equal(open.status, 201);
      const { post: publicPost } = await open.json();
      const publicPath = `/api/posts/${publicPost.id}`;
      async function publicVote(optionIndex, sessionToken) {
        const response = await request(`${publicPath}/poll/vote`, "PUT", { optionIndex }, sessionToken);
        assert.equal(response.status, 200);
        return (await response.json()).poll;
      }
      const { rows: [voter] } = await pool.query(
        "INSERT INTO users (handle, approved_at) VALUES ('other_voter', now()) RETURNING id",
      );
      const { rows: [otherIdentity] } = await pool.query(
        "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', 'other-voter', $1) RETURNING id",
        [voter.id],
      );
      const otherToken = randomUUID();
      await pool.query(
        "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
        [hash(otherToken), otherIdentity.id],
      );
      await publicVote(0);
      await publicVote(0, otherToken);
      const revised = await publicVote(1);
      assert.equal(revised.selectedOption, 1);
      assert.deepEqual(revised.options.map(({ votes }) => votes), [1, 1, 0]);
      assert.deepEqual((await get(`${publicPath}/poll/voters?option=0`)).users.map(({ id }) => id), [voter.id]);
      assert.deepEqual((await get(`${publicPath}/poll/voters?option=1`)).users.map(({ id }) => id), [user.id]);
      const publicVoters = await get(`${publicPath}/poll/voters`);
      const redOrBlue = await get(`${publicPath}/poll/voters?option=0&option=1`);
      assert.deepEqual(redOrBlue, publicVoters);
      const blueOrGreen = await get(`${publicPath}/poll/voters?option=1&option=2`);
      assert.deepEqual(blueOrGreen.users.map(({ id }) => id), [user.id]);
      assert.equal((await request(`${publicPath}/poll/voters?option=1&option=3`)).status, 400);
      assert.deepEqual(
        new Map(publicVoters.users.map(({ id, optionLabel }) => [id, optionLabel])),
        new Map([[voter.id, "Red"], [user.id, "Blue"]]),
      );
      const otherView = await request(publicPath, "GET", undefined, otherToken);
      assert.equal((await otherView.json()).post.poll.selectedOption, 0);
      assert.equal((await request(publicPath, "DELETE")).status, 204);
      const remaining = await pool.query("SELECT 1 FROM poll_votes WHERE post_id = $1", [publicPost.id]);
      assert.equal(remaining.rowCount, 0);
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
