import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { config } from "dotenv";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";

config({ path: new URL("../.env", import.meta.url), quiet: true });

const tick = () => new Promise((resolve) => setTimeout(resolve, 8));

test("reposts, friends-only reposts and quotes", async () => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_reposts_test_${randomUUID().replaceAll("-", "")}`;
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
    const { env } = await import("../src/config.ts");
    const { hash } = await import("../src/auth/secrets.ts");
    async function account(handle) {
      const {
        rows: [user],
      } = await pool.query(
        "INSERT INTO users (handle, display_name, approved_at) VALUES ($1, $1, now()) RETURNING id, handle",
        [handle],
      );
      const {
        rows: [identity],
      } = await pool.query(
        "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', $1, $2) RETURNING id",
        [handle, user.id],
      );
      const token = randomUUID();
      await pool.query(
        "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
        [hash(token), identity.id],
      );
      return { ...user, token };
    }
    const author = await account("rp_author"),
      alice = await account("rp_alice"),
      bob = await account("rp_bob"),
      carol = await account("rp_carol"),
      stranger = await account("rp_stranger"),
      watcher = await account("rp_watcher");
    const follow = (a, b) =>
      pool.query("INSERT INTO user_follows (follower_id, following_id) VALUES ($1, $2)", [a.id, b.id]);
    // alice <-> bob and alice <-> author are friends; carol only follows alice.
    await follow(alice, bob);
    await follow(bob, alice);
    await follow(alice, author);
    await follow(author, alice);
    await follow(carol, alice);
    for (const followed of [author, alice, bob, carol, stranger]) await follow(watcher, followed);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(path, { user, method = "GET", body } = {}) {
      return fetch(base + path, {
        method,
        headers: {
          Origin: env.APP_ORIGIN,
          ...(user ? { Cookie: `session=${user.token}` } : {}),
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    async function ok(path, options, status = 200) {
      const response = await request(path, options);
      assert.equal(response.status, status, await response.clone().text());
      return status === 204 ? null : response.json();
    }
    const publish = async (user, content, extra = {}) =>
      (await ok("/api/posts", { user, method: "POST", body: { content, ...extra } }, 201)).post;
    const ids = (page) => page.posts.map((post) => post.id);
    const feed = (user, query = "") => query.startsWith("?topic=")
      ? ok(`/api/posts${query}`, { user })
      : ok(`/api/feed/following${query}`, { user: user ?? watcher });
    const notifications = async (user) =>
      (await ok("/api/notifications", { user })).notifications.map((item) => item.kind);

    // --- plain reposts -------------------------------------------------
    const first = await publish(author, "first post");
    await tick();
    const second = await publish(author, "second post");
    await tick();
    const third = await publish(stranger, "third post");
    assert.deepEqual(ids(await feed()), [third.id, second.id, first.id]);
    assert.deepEqual((await feed()).repostedBy, {});

    assert.equal((await request(`/api/posts/${first.id}/repost`, { method: "PUT" })).status, 401);
    assert.equal(
      (await request(`/api/posts/${first.id}/repost`, { method: "PUT", user: alice, body: { audience: "everyone" } })).status,
      400,
    );
    assert.deepEqual(
      await ok(`/api/posts/${first.id}/repost`, { method: "PUT", user: alice }),
      { reposts: 1, reposted: true, repostAudience: "public" },
    );
    // A repost brings the post to the top, once, labelled with who shared it.
    let page = await feed();
    assert.deepEqual(ids(page), [first.id, third.id, second.id]);
    assert.equal(page.repostedBy[first.id].by.handle, "rp_alice");
    assert.equal(page.repostedBy[first.id].audience, "public");
    assert.equal(page.repostedBy[first.id].others, 0);
    assert.equal(page.posts[0].reposts, 1);
    await tick();
    await ok(`/api/posts/${first.id}/repost`, { method: "PUT", user: bob });
    page = await feed();
    assert.deepEqual(ids(page), [first.id, third.id, second.id]);
    assert.equal(page.repostedBy[first.id].by.handle, "rp_bob");
    assert.equal(page.repostedBy[first.id].others, 1);
    assert.equal((await feed(alice)).posts[0].reposted, true);
    assert.equal((await feed(stranger)).posts[0].reposted, false);
    // Reposting twice is harmless and notifies the author once.
    await ok(`/api/posts/${first.id}/repost`, { method: "PUT", user: bob });
    assert.deepEqual((await notifications(author)).filter((kind) => kind === "repost").length, 2);
    // Undo restores the old position and removes the label.
    for (const user of [alice, bob])
      await ok(`/api/posts/${first.id}/repost`, { method: "DELETE", user });
    page = await feed();
    assert.deepEqual(ids(page), [third.id, second.id, first.id]);
    assert.deepEqual(page.repostedBy, {});

    // Reposts of replies join the feed, with the reply's context.
    const reply = (
      await ok(`/api/posts/${second.id}/replies`, { user: bob, method: "POST", body: { content: "a reply" } }, 201)
    ).post;
    assert.equal(reply.replyTo.handle, "rp_author");
    assert.deepEqual(ids(await feed()), [third.id, second.id, first.id]);
    await ok(`/api/posts/${reply.id}/repost`, { method: "PUT", user: carol });
    page = await feed();
    assert.deepEqual(ids(page), [reply.id, third.id, second.id, first.id]);
    assert.equal(page.repostedBy[reply.id].by.handle, "rp_carol");
    assert.equal(page.posts[0].replyTo.handle, "rp_author");
    await ok(`/api/posts/${reply.id}/repost`, { method: "DELETE", user: carol });
    assert.equal((await request(`/api/posts/${randomUUID()}/repost`, { method: "PUT", user: alice })).status, 404);

    // Pagination with reposts: every post exactly once across pages.
    for (let index = 0; index < 24; index++) {
      await publish(stranger, `bulk ${index}`);
      await tick();
    }
    await ok(`/api/posts/${first.id}/repost`, { method: "PUT", user: alice });
    const seen = [];
    let cursor;
    do {
      const next = await feed(undefined, cursor ? `?cursor=${cursor}` : "");
      seen.push(...ids(next));
      cursor = next.nextCursor;
    } while (cursor);
    assert.equal(seen.length, 27);
    assert.equal(new Set(seen).size, 27);
    assert.equal(seen[0], first.id);
    await ok(`/api/posts/${first.id}/repost`, { method: "DELETE", user: alice });

    // --- friends-only reposts -----------------------------------------
    // alice shares the stranger's post with friends only. Only bob (her friend) sees it;
    // carol (a one-way follower), the stranger and anonymous viewers see nothing.
    assert.deepEqual(
      await ok(`/api/posts/${third.id}/repost`, { method: "PUT", user: alice, body: { audience: "friends" } }),
      { reposts: 0, reposted: true, repostAudience: "friends" },
    );
    // The repost surfaces `third` at the top for viewers who may see it, and for no one else.
    const labelled = async (user) => {
      const top = user ? await feed(user) : await ok("/api/posts");
      const context = top.repostedBy[third.id];
      assert.equal(ids(top)[0] === third.id, context !== undefined);
      return context;
    };
    const one = async (user, id) => (await ok(`/api/posts/${id}`, { user })).post;
    assert.equal((await labelled(alice)).audience, "friends");
    assert.equal((await labelled(bob)).by.handle, "rp_alice");
    assert.equal(await labelled(carol), undefined);
    assert.equal(await labelled(undefined), undefined);
    assert.equal(await labelled(stranger), undefined);
    // Public counts never include it, and the reposter still sees their own state.
    assert.equal((await one(carol, third.id)).reposts, 0);
    assert.equal((await one(alice, third.id)).reposted, true);
    assert.equal((await one(alice, third.id)).repostAudience, "friends");
    assert.equal((await one(carol, third.id)).reposted, false);
    // The author (stranger) is not alice's friend: no notification leak.
    assert.equal((await notifications(stranger)).includes("repost"), false);
    // Activity lists only reposters the viewer may see.
    const reposters = async (user) =>
      (await ok(`/api/posts/${third.id}/activity?type=reposts`, { user })).users.map((row) => row.handle);
    assert.deepEqual(await reposters(bob), ["rp_alice"]);
    assert.deepEqual(await reposters(alice), ["rp_alice"]);
    assert.deepEqual(await reposters(carol), []);
    assert.deepEqual(await reposters(undefined), []);
    // Switching to public publishes it and notifies the author.
    await ok(`/api/posts/${third.id}/repost`, { method: "PUT", user: alice });
    assert.equal((await labelled(carol)).by.handle, "rp_alice");
    assert.equal((await one(carol, third.id)).reposts, 1);
    assert.equal((await notifications(stranger)).filter((kind) => kind === "repost").length, 1);
    // ...and back to friends-only withdraws that notification again.
    await ok(`/api/posts/${third.id}/repost`, { method: "PUT", user: alice, body: { audience: "friends" } });
    assert.equal(await labelled(carol), undefined);
    assert.equal((await notifications(stranger)).includes("repost"), false);
    // Friends repost of a friend's post does notify.
    await ok(`/api/posts/${second.id}/repost`, { method: "PUT", user: alice, body: { audience: "friends" } });
    assert.equal((await notifications(author)).filter((kind) => kind === "repost").length, 3);
    await ok(`/api/posts/${second.id}/repost`, { method: "DELETE", user: alice });
    await ok(`/api/posts/${third.id}/repost`, { method: "DELETE", user: alice });

    // --- quotes ---------------------------------------------------------
    const quoted = await publish(author, "Launching #quotes today with @rp_alice");
    await tick();
    assert.equal(quoted.quote, null);
    assert.equal(quoted.quotes, 0);
    const quote = await publish(alice, "Big news! #quotes", { quotedPostId: quoted.id });
    assert.equal(quote.parentId, null);
    assert.equal(quote.quote.state, "available");
    assert.equal(quote.quote.post.id, quoted.id);
    assert.equal(quote.quote.post.author.handle, "rp_author");
    assert.equal(quote.quote.post.content, quoted.content);
    assert.equal(quote.quote.post.isQuote, false);
    // The quote is an ordinary top-level post: it heads the feed...
    assert.equal((await feed()).posts[0].id, quote.id);
    assert.equal((await feed()).posts[0].quote.post.id, quoted.id);
    // ...counts on the original...
    assert.equal((await ok(`/api/posts/${quoted.id}`)).post.quotes, 1);
    // ...appears in its own #topic feed with the embed for context, but a plain repost does not.
    await ok(`/api/posts/${quoted.id}/repost`, { method: "PUT", user: bob });
    const topic = await feed(undefined, "?topic=quotes");
    assert.deepEqual(new Set(ids(topic)), new Set([quoted.id, quote.id]));
    assert.deepEqual(topic.repostedBy, {});
    assert.equal(topic.posts.find((post) => post.id === quote.id).quote.post.id, quoted.id);
    await ok(`/api/posts/${quoted.id}/repost`, { method: "DELETE", user: bob });
    // A quote without matching text is not in the topic feed.
    const bare = await publish(carol, "no tag here", { quotedPostId: quoted.id });
    assert.equal(ids(await feed(undefined, "?topic=quotes")).includes(bare.id), false);
    // The author is told once (mentioned in the original, not in the quote).
    assert.deepEqual((await notifications(author)).filter((kind) => kind === "quote").length, 2);
    // Quoting a post that mentions the author does not double-notify.
    const tagged = await publish(bob, "hey @rp_author look", { quotedPostId: second.id });
    assert.ok(tagged.id);
    assert.deepEqual((await notifications(author)).filter((kind) => kind === "quote").length, 2);
    assert.ok((await notifications(author)).includes("mention"));
    // Retries with the same client id are idempotent; a different quote target conflicts.
    const clientId = randomUUID();
    const once1 = await publish(alice, "retry me", { quotedPostId: first.id, clientId });
    const once2 = await publish(alice, "retry me", { quotedPostId: first.id, clientId });
    assert.equal(once1.id, once2.id);
    assert.equal(
      (await request("/api/posts", { user: alice, method: "POST", body: { content: "retry me", quotedPostId: second.id, clientId } })).status,
      409,
    );
    // Validation: quoting something missing, quoting in a reply, nothing to say.
    assert.equal(
      (await request("/api/posts", { user: alice, method: "POST", body: { content: "x", quotedPostId: randomUUID() } })).status,
      404,
    );
    assert.equal(
      (await request(`/api/posts/${first.id}/replies`, { user: alice, method: "POST", body: { content: "x", quotedPostId: second.id } })).status,
      400,
    );
    assert.equal(
      (await request("/api/posts", { user: alice, method: "POST", body: { quotedPostId: first.id } })).status,
      400,
    );
    // Quotes can carry polls and GIF-less text; a quote of a quote embeds one level only.
    const poll = await publish(bob, "poll quote", {
      quotedPostId: quote.id,
      poll: { title: "Yes or no?", options: ["yes", "no"], anonymous: false },
    });
    assert.equal(poll.quote.post.id, quote.id);
    assert.equal(poll.quote.post.isQuote, true);
    assert.equal("quote" in poll.quote.post, false);
    // Quotes of replies work too, with the reply's text embedded.
    const replyQuote = await publish(carol, "look at this reply", { quotedPostId: reply.id });
    assert.equal(replyQuote.quote.post.parentId, second.id);
    // Activity: who quoted a post.
    const quoters = (await ok(`/api/posts/${quoted.id}/activity?type=quotes`)).users;
    assert.deepEqual(quoters.map((row) => row.handle).sort(), ["rp_alice", "rp_carol"]);
    assert.deepEqual(new Set(quoters.map((row) => row.quoteId)), new Set([quote.id, bare.id]));
    // Editing a quote keeps the embed.
    const edited = (await ok(`/api/posts/${quote.id}`, { user: alice, method: "PATCH", body: { content: "Big news!! #quotes" } })).post;
    assert.equal(edited.quote.post.id, quoted.id);
    // Deleting the original leaves the quote with an "unavailable" embed.
    await ok(`/api/posts/${quoted.id}`, { user: author, method: "DELETE" }, 204);
    const orphan = (await ok(`/api/posts/${quote.id}`)).post;
    assert.deepEqual(orphan.quote, { state: "unavailable" });
    assert.equal((await ok(`/api/posts/${first.id}`)).post.quote, null);
    // Retrying a saved quote after its original vanished returns the same quote.
    const clientId2 = randomUUID();
    const quotedLater = await publish(bob, "to be orphaned", { quotedPostId: first.id, clientId: clientId2 });
    await ok(`/api/posts/${first.id}`, { user: author, method: "DELETE" }, 204);
    assert.deepEqual((await ok(`/api/posts/${quotedLater.id}`)).post.quote, { state: "unavailable" });
    const retried = await publish(bob, "to be orphaned", { quotedPostId: first.id, clientId: clientId2 });
    assert.equal(retried.id, quotedLater.id);

    // --- profile Reposts tab ----------------------------------------------
    const mine = await publish(stranger, "profile post");
    await tick();
    await ok(`/api/posts/${mine.id}/repost`, { method: "PUT", user: carol });
    await tick();
    const carolQuote = await publish(carol, "carol quotes", { quotedPostId: mine.id });
    await tick();
    await ok(`/api/posts/${third.id}/repost`, { method: "PUT", user: carol, body: { audience: "friends" } });
    const tab = (user) => ok("/api/profiles/rp_carol", { user });
    let profile = await tab(carol);
    assert.deepEqual(ids({ posts: profile.reposts }).slice(0, 3), [third.id, carolQuote.id, mine.id]);
    assert.equal(profile.repostedBy[third.id].audience, "friends");
    assert.equal(profile.repostedBy[mine.id].by.handle, "rp_carol");
    assert.equal(profile.repostedBy[carolQuote.id], undefined);
    // The quote also lists on the Posts tab.
    assert.ok(ids(profile).includes(carolQuote.id));
    // Carol's friends-only repost is hidden from non-friends. Carol has no mutual follows.
    profile = await tab(undefined);
    assert.equal(ids({ posts: profile.reposts }).includes(third.id), false);
    assert.deepEqual(ids({ posts: profile.reposts }).slice(0, 2), [carolQuote.id, mine.id]);
    profile = await tab(stranger);
    assert.equal(ids({ posts: profile.reposts }).includes(third.id), false);
  } finally {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
