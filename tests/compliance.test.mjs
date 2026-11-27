import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { unzipSync, strFromU8 } from "fflate";
import pg from "pg";
import sharp from "sharp";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("legal, data rights, moderation transparency and safety", async (t) => {
  const connection = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_compliance_test_${randomUUID().replaceAll("-", "")}`;
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
      NSFW_CHECK_URL: "http://127.0.0.1:9",
      OPERATOR_NAME: "",
      OPERATOR_ADDRESS: "",
      OPERATOR_EMAIL: "",
      PRIVACY_EMAIL: "",
      ABUSE_EMAIL: "",
      PHOTODNA_URL: "",
      PHOTODNA_KEY: "",
      TRUST_PROXY: "",
      CLIENT_IP_HEADER: "CF-Connecting-IP",
    });
    database = await import("../src/db/index.ts");
    const { app } = await import("../src/app.ts");
    const { hash } = await import("../src/auth/secrets.ts");
    const { termsVersion } = await import("../src/legal.ts");
    const { runRetention } = await import("../src/retention.ts");
    const { setHashMatcher } = await import("../src/safety/hash-match.ts");
    await migrate(database.db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
    const query = (text, values) => database.pool.query(text, values);

    async function account(handle, role = "user") {
      const { rows: [user] } = await query(
        "INSERT INTO users (handle, role, approved_at, feed_choice_at, terms_version) VALUES ($1, $2, now(), now(), $3) RETURNING id",
        [handle, role, termsVersion]);
      const { rows: [identity] } = await query(
        "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', $1, $2) RETURNING id",
        [handle, user.id]);
      const token = randomUUID();
      await query(
        "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
        [hash(token), identity.id]);
      return { id: user.id, handle, cookie: `session=${token}`, identity: identity.id };
    }
    const post = async (author, content = "hello") => (await query(
      "INSERT INTO posts (author_id, content) VALUES ($1, $2) RETURNING id", [author.id, content])).rows[0].id;

    const alice = await account("alice");
    const bob = await account("bob");
    const admin = await account("root_admin", "admin");
    const moderator = await account("mod_one", "moderator");
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (who, method, path, body, origin = "http://localhost:3000", extra = {}) => fetch(base + path, {
      method,
      headers: {
        ...(who ? { Cookie: who.cookie } : {}),
        Origin: origin,
        ...(body !== undefined && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    const adminCall = (who, method, path, body) => call(who, method, path, body, "http://localhost:3200");
    const ground = { type: "terms", ref: "5.2", facts: "The post insults another user." };

    await t.test("legal endpoints expose terms and refuse an unconfigured imprint", async () => {
      assert.equal((await call(null, "GET", "/api/legal/operator")).status, 503);
      const terms = await (await call(null, "GET", "/api/legal/terms")).json();
      assert.equal(terms.version, termsVersion);
      assert.ok(terms.clauses.some((clause) => clause.id === "5.2"));
      const me = await (await call(alice, "GET", "/auth/me")).json();
      assert.equal(me.termsCurrent, true);
      assert.equal(me.feedChoiceNeeded, false);
      await query("UPDATE users SET terms_version = 'old', age_confirmed_at = NULL WHERE id = $1", [alice.id]);
      const outdated = await (await call(alice, "GET", "/auth/me")).json();
      assert.equal(outdated.termsCurrent, false);
      assert.equal(outdated.user.ageConfirmed, false);
      assert.equal((await call(alice, "POST", "/auth/terms", { version: termsVersion, acceptTerms: true })).status, 400);
      assert.equal((await query("SELECT terms_version FROM users WHERE id = $1", [alice.id])).rows[0].terms_version, "old");
      assert.equal((await call(alice, "POST", "/auth/terms", { version: termsVersion, acceptTerms: true, ageConfirmed: true })).status, 204);
      const accepted = await (await call(alice, "GET", "/auth/me")).json();
      assert.equal(accepted.termsCurrent, true);
      assert.equal(accepted.user.ageConfirmed, true);
      const { rows: [{ age_confirmed_at: confirmedAt }] } = await query("SELECT age_confirmed_at FROM users WHERE id = $1", [alice.id]);
      await query("UPDATE users SET terms_version = 'old' WHERE id = $1", [alice.id]);
      assert.equal((await call(alice, "POST", "/auth/terms", { version: termsVersion, acceptTerms: true })).status, 204);
      assert.equal((await (await call(alice, "GET", "/auth/me")).json()).termsCurrent, true);
      const { rows: [{ age_confirmed_at: keptAt }] } = await query("SELECT age_confirmed_at FROM users WHERE id = $1", [alice.id]);
      assert.equal(keptAt.getTime(), confirmedAt.getTime());
    });

    await t.test("the contact form stores messages for admins only and resists abuse", async () => {
      const message = { name: "Visitor", email: "visitor@example.test", message: "Hello, I have a question about my account." };
      assert.equal((await call(null, "POST", "/api/contact", message, "http://evil.test")).status, 403);
      assert.equal((await call(null, "POST", "/api/contact", { ...message, message: "short" })).status, 400);
      assert.equal((await call(null, "POST", "/api/contact", { ...message, email: "not-an-email" })).status, 400);
      assert.equal((await call(null, "POST", "/api/contact", { ...message, phone: "123" })).status, 400);
      assert.equal((await call(null, "POST", "/api/contact", { ...message, website: "https://spam.test" })).status, 204);
      assert.equal((await call(null, "POST", "/api/contact", { message: "Anonymous but long enough." })).status, 204);
      assert.equal((await call(null, "POST", "/api/contact", message)).status, 204);
      assert.equal((await query("SELECT count(*)::int AS total FROM contact_messages")).rows[0].total, 2);
      assert.equal((await call(null, "POST", "/api/contact", message)).status, 204);
      assert.equal((await call(null, "POST", "/api/contact", message)).status, 429);
      assert.equal((await call(null, "POST", "/api/contact", message, "http://localhost:3000", { "CF-Connecting-IP": "not-an-ip" })).status, 429);
      assert.equal((await call(null, "POST", "/api/contact", message, "http://localhost:3000", { "CF-Connecting-IP": "203.0.113.9" })).status, 204);
      assert.equal((await adminCall(moderator, "GET", "/api/admin/contact")).status, 403);
      const listed = await (await adminCall(admin, "GET", "/api/admin/contact")).json();
      assert.equal(listed.messages.length, 4);
      const stored = listed.messages.find((item) => item.email);
      assert.equal(stored.name, "Visitor");
      assert.equal((await adminCall(moderator, "PATCH", `/api/admin/contact/${stored.id}`, { handled: true })).status, 403);
      assert.equal((await adminCall(admin, "PATCH", `/api/admin/contact/${stored.id}`, { handled: true })).status, 204);
      const after = await (await adminCall(admin, "GET", "/api/admin/contact")).json();
      assert.equal(after.messages[0].id !== stored.id, true);
      assert.equal(after.messages.find((item) => item.id === stored.id).handledByHandle, "root_admin");
      await query("UPDATE contact_messages SET handled_at = now() - interval '4 months' WHERE id = $1", [stored.id]);
      assert.equal((await runRetention()).contact_handled, 1);
      for (const item of listed.messages.filter((entry) => entry.id !== stored.id))
        assert.equal((await adminCall(admin, "DELETE", `/api/admin/contact/${item.id}`)).status, 204);
      assert.equal((await query("SELECT count(*)::int AS total FROM contact_messages")).rows[0].total, 0);
    });

    await t.test("an export contains the account's data as JSON and is rate limited", async () => {
      const own = await post(alice, "my exported post");
      await query("INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2)", [await post(bob, "liked"), alice.id]);
      await query("INSERT INTO feed_events (user_id, type, post_id, origin) VALUES ($1, 'impression', $2, 'client')", [alice.id, own]);
      const response = await call(alice, "GET", "/api/me/export");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/zip");
      const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
      for (const file of ["profile.json", "posts.json", "social.json", "feed_events.json", "dm_metadata.json", "README.txt"])
        assert.ok(files[file], file);
      const read = (file) => JSON.parse(strFromU8(files[file]));
      assert.equal(read("profile.json").handle, "alice");
      assert.ok(read("posts.json").some((row) => row.content === "my exported post"));
      assert.equal(read("social.json").likes.length, 1);
      assert.equal(read("feed_events.json").length, 1);
      assert.equal((await call(alice, "GET", "/api/me/export")).status, 429);
    });

    await t.test("illegal content notices need an explanation and good faith", async () => {
      const target = await post(bob, "bad words");
      const incomplete = await call(alice, "POST", "/api/reports", { reason: "illegal", details: "short", target: { type: "post", id: target } });
      assert.equal((await incomplete.json()).error, "illegal_notice_incomplete");
      const complete = await call(alice, "POST", "/api/reports", {
        reason: "illegal", legalGround: "insult_defamation", goodFaith: true,
        details: "This post insults a named person in a way that is punishable.", target: { type: "post", id: target },
      });
      assert.equal(complete.status, 201);
      assert.ok((await complete.json()).reference);
    });

    await t.test("anyone can file a notice through the public form and follow its status", async () => {
      const target = await post(bob, "public notice target");
      const body = {
        url: `http://localhost:3000/posts/${target}`, reason: "hate", goodFaith: true,
        details: "This post attacks a group of people for their religion.",
      };
      assert.equal((await (await call(null, "POST", "/api/reports/public", body)).json()).error, "notifier_contact_required");
      const anonymous = await call(null, "POST", "/api/reports/public", { ...body, reason: "illegal", legalGround: "child_sexual_abuse" });
      assert.equal(anonymous.status, 201);
      const created = await call(null, "POST", "/api/reports/public", { ...body, name: "Erika Muster", email: "erika@example.org" });
      assert.equal(created.status, 201);
      const { reference, statusToken } = await created.json();
      assert.equal((await call(null, "POST", "/api/reports/public", { ...body, url: "https://evil.example/posts/x", name: "a", email: "a@example.org" })).status, 400);
      const status = await (await call(null, "GET", `/api/reports/status/${statusToken}`)).json();
      assert.equal(status.reference, reference);
      assert.equal(status.status, "open");
      const { rows: [row] } = await query("SELECT channel, notifier_email, reporter_id, status_token_hash FROM reports WHERE id = $1", [reference]);
      assert.deepEqual([row.channel, row.notifier_email, row.reporter_id], ["public", "erika@example.org", null]);
      assert.notEqual(row.status_token_hash, statusToken);
    });

    await t.test("staff actions write a statement of reasons the user can read and appeal, even when banned", async () => {
      const target = await post(bob, "an insult");
      assert.equal((await adminCall(moderator, "PATCH", `/api/admin/posts/${target}/visibility`, { hidden: true })).status, 400);
      assert.equal((await adminCall(moderator, "PATCH", `/api/admin/posts/${target}/visibility`, { hidden: true, ground: { ...ground, ref: "9.9" } })).status, 400);
      assert.equal((await adminCall(moderator, "PATCH", `/api/admin/posts/${target}/visibility`, { hidden: true, ground })).status, 204);
      assert.equal((await adminCall(admin, "PATCH", `/api/admin/users/${bob.id}/account`, { action: "ban", reason: "Repeated insults", ground })).status, 204);

      const notices = await (await call(bob, "GET", "/api/moderation/notices")).json();
      assert.equal(notices.decisions.length, 2);
      assert.equal(notices.unseen, 2);
      const hide = notices.decisions.find((decision) => decision.action === "hide_post");
      assert.equal(hide.groundRef, "5.2");
      assert.equal(hide.excerpt, "an insult");
      assert.equal(hide.automatedDecision, false);
      assert.equal(hide.canAppeal, true);
      assert.equal("decidedByHandle" in hide, false);

      assert.equal((await call(bob, "POST", `/api/moderation/decisions/${hide.id}/appeal`, { text: "short" })).status, 400);
      assert.equal((await call(bob, "POST", `/api/moderation/decisions/${hide.id}/appeal`, { text: "This was a quote from a film, not an insult." })).status, 201);
      assert.equal((await call(bob, "POST", `/api/moderation/decisions/${hide.id}/appeal`, { text: "This was a quote from a film, not an insult." })).status, 409);
      assert.equal((await call(alice, "GET", `/api/moderation/decisions/${hide.id}`)).status, 404);

      const queue = await (await adminCall(moderator, "GET", "/api/admin/appeals")).json();
      assert.equal(queue.appeals.length, 1);
      const appealId = queue.appeals[0].id;
      assert.equal((await adminCall(moderator, "POST", `/api/admin/appeals/${appealId}/resolve`, { outcome: "reversed", note: "Context shows a quote." })).status, 409);
      assert.equal((await adminCall(admin, "POST", `/api/admin/appeals/${appealId}/resolve`, { outcome: "reversed", note: "Context shows a quote." })).status, 204);
      assert.equal((await query("SELECT hidden_at FROM posts WHERE id = $1", [target])).rows[0].hidden_at, null);
      const reversed = await (await call(bob, "GET", `/api/moderation/decisions/${hide.id}`)).json();
      assert.ok(reversed.reversedAt);
      assert.equal(reversed.appeal.status, "reversed");
      assert.equal((await call(bob, "POST", "/api/moderation/notices/seen")).status, 204);
      assert.equal((await (await call(bob, "GET", "/api/moderation/notices")).json()).unseen, 0);
      await query("UPDATE users SET banned_at = null, ban_reason = null WHERE id = $1", [bob.id]);
    });

    await t.test("reporters learn the outcome of their report", async () => {
      const target = await post(bob, "spam spam spam");
      await call(alice, "POST", "/api/reports", { reason: "spam", target: { type: "post", id: target } });
      const { rows: [report] } = await query("SELECT id FROM reports WHERE target_key = $1", [target]);
      assert.equal((await adminCall(admin, "POST", `/api/admin/reports/${report.id}/resolve`, { decision: "resolve", removeContent: true })).status, 400);
      assert.equal((await adminCall(admin, "POST", `/api/admin/reports/${report.id}/resolve`, { decision: "resolve", removeContent: true, ground: { ...ground, ref: "5.7" } })).status, 204);
      const notices = await (await call(alice, "GET", "/api/moderation/notices")).json();
      const update = notices.reportUpdates.find((row) => row.id === report.id);
      assert.equal(update.actionTaken, true);
      const bobs = await (await call(bob, "GET", "/api/moderation/notices")).json();
      assert.ok(bobs.decisions.some((decision) => decision.action === "remove_post" && decision.fromReport));
      assert.equal((await adminCall(moderator, "POST", `/api/admin/reports/${report.id}/escalate`, { authority: "Polizei Schleswig-Holstein", reference: "AZ-1" })).status, 204);
      assert.ok((await query("SELECT escalated_at FROM reports WHERE id = $1", [report.id])).rows[0].escalated_at);
    });

    await t.test("a hash match blocks the upload, keeps only metadata and suspends the uploader", async () => {
      const carol = await account("carol");
      const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#123456" } }).png().toBuffer();
      const upload = () => call(carol, "POST", "/api/post-images", new Uint8Array(image), "http://localhost:3000", { "Content-Type": "application/octet-stream" });
      setHashMatcher({ name: "test", match: async () => { throw new Error("down"); } });
      assert.equal((await upload()).status, 503);
      setHashMatcher({ name: "test", match: async () => ({ matched: true, provider: "test", matchId: "m-1" }) });
      const rejected = await upload();
      assert.equal(rejected.status, 422);
      assert.equal((await rejected.json()).error, "upload_rejected");
      setHashMatcher(undefined);
      assert.equal((await query("SELECT 1 FROM post_images WHERE uploader_id = $1", [carol.id])).rowCount, 0);
      assert.equal((await query("SELECT 1 FROM post_image_flags WHERE uploader_id = $1", [carol.id])).rowCount, 0);
      const { rows: [incident] } = await query("SELECT * FROM csam_incidents WHERE user_id = $1", [carol.id]);
      assert.equal(incident.match_id, "m-1");
      assert.equal(incident.size, image.length);
      assert.match(incident.sha256, /^[0-9a-f]{64}$/);
      assert.ok((await query("SELECT banned_at FROM users WHERE id = $1", [carol.id])).rows[0].banned_at);
      assert.equal((await adminCall(moderator, "GET", "/api/admin/safety/incidents")).status, 403);
      const listed = await (await adminCall(admin, "GET", "/api/admin/safety/incidents")).json();
      assert.equal(listed.incidents.length, 1);
      assert.equal((await adminCall(admin, "PATCH", `/api/admin/safety/incidents/${incident.id}`, { bkaRef: "BKA-123" })).status, 204);
      assert.ok((await query("SELECT reported_bka_at FROM csam_incidents WHERE id = $1", [incident.id])).rows[0].reported_bka_at);
    });

    await t.test("the gif proxy only fetches Klipy media", async () => {
      assert.equal((await call(null, "GET", `/api/gifs/media?u=${encodeURIComponent("https://example.com/a.gif")}`)).status, 400);
      assert.equal((await call(null, "GET", "/api/gifs/media")).status, 400);
    });

    await t.test("deleting an account revokes sessions, leaves a tombstone and scrubs filed reports", async () => {
      const dave = await account("dave");
      await call(dave, "POST", "/api/reports", { reason: "spam", target: { type: "post", id: await post(alice, "dave reports this") } });
      assert.equal((await call(dave, "DELETE", "/api/profiles/me", { handle: "dave" })).status, 204);
      assert.equal((await query("SELECT 1 FROM auth_sessions WHERE identity_id = $1", [dave.identity])).rowCount, 0);
      assert.equal((await query("SELECT 1 FROM deleted_accounts WHERE user_id = $1", [dave.id])).rowCount, 1);
      assert.equal((await query("SELECT 1 FROM reports WHERE reporter_handle = 'dave'")).rowCount, 0);
    });

    await t.test("banned users can still delete their account", async () => {
      const erin = await account("erin");
      await query("UPDATE users SET banned_at = now() WHERE id = $1", [erin.id]);
      assert.equal((await call(erin, "DELETE", "/api/profiles/me", { handle: "erin" })).status, 204);
    });

    await t.test("retention removes expired data and keeps recent data", async () => {
      const fresh = await post(alice, "fresh");
      await query(`INSERT INTO feed_events (user_id, type, post_id, origin, created_at) VALUES
        ($1, 'impression', $2, 'client', now() - interval '200 days'),
        ($1, 'impression', $2, 'client', now() - interval '10 days'),
        ($1, 'like', $2, 'server', now() - interval '200 days'),
        ($1, 'like', $2, 'server', now() - interval '400 days')`, [bob.id, fresh]);
      await query("INSERT INTO deleted_accounts (user_id, deleted_at) VALUES ($1, now() - interval '40 days')", [randomUUID()]);
      await query("INSERT INTO moderation_activity (actor_id, actor_handle, target_id, target_handle, action, created_at) VALUES ($1, 'x', $1, 'x', 'old', now() - interval '13 months')", [admin.id]);
      const removed = await runRetention(database.pool);
      assert.equal(removed.feed_events_client, 1);
      assert.equal(removed.feed_events_server, 1);
      assert.equal(removed.deleted_accounts, 1);
      assert.equal(removed.moderation_activity, 1);
      assert.equal((await query("SELECT 1 FROM feed_events WHERE user_id = $1", [bob.id])).rowCount, 2);
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
