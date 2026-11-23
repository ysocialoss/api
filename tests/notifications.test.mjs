import assert from "node:assert/strict";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { config } from "dotenv";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as webpush from "web-push";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("notifications flow from actions to a private inbox and durable push deliveries", async () => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_notifications_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  let pool, server;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const vapid = webpush.generateVAPIDKeys();
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      NODE_ENV: "test",
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: "mailto:test@example.com",
    });
    const { app } = await import("../src/app.ts");
    const database = await import("../src/db/index.ts");
    pool = database.pool;
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    const { env } = await import("../src/config.ts");
    const { hash } = await import("../src/auth/secrets.ts");
    const { flushPushDeliveries } = await import("../src/push-delivery.ts");
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
    const owner = await account("notification_owner"),
      actor = await account("notification_actor"),
      stranger = await account("notification_stranger");
    await pool.query(
      "UPDATE users SET avatar_key = 'avatars/test.webp' WHERE id = $1",
      [actor.id],
    );
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(
      path,
      { user = owner, method = "GET", body, origin = env.APP_ORIGIN } = {},
    ) {
      return fetch(base + path, {
        method,
        headers: {
          ...(origin ? { Origin: origin } : {}),
          ...(user ? { Cookie: `session=${user.token}` } : {}),
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    async function json(path, options) {
      const response = await request(path, options);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "no-store");
      return response.json();
    }
    assert.equal(
      (await request("/api/notifications", { user: null })).status,
      401,
    );
    assert.deepEqual(
      (await json("/api/notifications", { origin: null })).notifications,
      [],
    );
    assert.equal((await json("/api/notifications/push")).promptDismissed, false);
    assert.equal((await request("/api/notifications/push/prompt-dismissal", { method: "PUT", user: null })).status, 401);
    assert.equal((await request("/api/notifications/push/prompt-dismissal", { method: "PUT", origin: "https://attacker.invalid" })).status, 403);
    assert.equal((await request("/api/notifications/push/prompt-dismissal", { method: "PUT" })).status, 204);
    assert.equal((await json("/api/notifications/push")).promptDismissed, true);
    assert.equal((await json("/api/notifications/push", { user: stranger })).promptDismissed, false);
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/test-notifications",
      expirationTime: null,
      keys: {
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    };
    assert.equal(
      (
        await request("/api/notifications/push", {
          method: "PUT",
          body: subscription,
          origin: "https://attacker.invalid",
        })
      ).status,
      403,
    );
    for (const endpoint of [
      "https://127.0.0.1/internal",
      "http://fcm.googleapis.com/test",
      "https://fcm.googleapis.com.evil.invalid/test",
      "https://fcm.googleapis.com:1234/test",
    ]) {
      assert.equal(
        (
          await request("/api/notifications/push", {
            method: "PUT",
            body: { ...subscription, endpoint },
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await request("/api/notifications/push", {
          method: "PUT",
          body: subscription,
        })
      ).status,
      204,
    );
    assert.equal(
      (
        await json(
          `/api/notifications/push?endpoint=${encodeURIComponent(subscription.endpoint)}`,
        )
      ).subscribed,
      true,
    );
    const {
      rows: [post],
    } = await pool.query(
      "INSERT INTO posts (author_id, content) VALUES ($1, 'A notification test post') RETURNING id",
      [owner.id],
    );
    const action = (path, method = "PUT", user = actor, body) =>
      request(path, { method, user, body });
    assert.equal((await action(`/api/posts/${post.id}/like`)).status, 200);
    assert.equal((await action(`/api/posts/${post.id}/like`)).status, 200);
    assert.equal(
      (await action(`/api/posts/${post.id}/like`, "DELETE")).status,
      200,
    );
    assert.equal((await action(`/api/posts/${post.id}/like`)).status, 200);
    assert.equal(
      (await action(`/api/posts/${post.id}/like`, "PUT", owner)).status,
      200,
    );
    assert.equal((await action(`/api/posts/${post.id}/repost`)).status, 200);
    assert.equal(
      (await action(`/api/profiles/${owner.handle}/follow`)).status,
      200,
    );
    assert.equal(
      (await action(`/api/profiles/${owner.handle}/follow`)).status,
      200,
    );
    const replyId = randomUUID();
    const replyContent = "An actual reply\n\n" + "🙂".repeat(200);
    const replyPreview = "An actual reply " + "🙂".repeat(143) + "…";
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await action(`/api/posts/${post.id}/replies`, "POST", actor, {
            clientId: replyId,
            content: replyContent,
          })
        ).status,
        201,
      );
    const inbox = await json("/api/notifications");
    assert.equal(inbox.notifications.length, 4);
    assert.equal(inbox.unreadCount, 4);
    assert.deepEqual(
      new Set(inbox.notifications.map((item) => item.kind)),
      new Set(["like", "repost", "reply", "follow"]),
    );
    assert.equal(
      inbox.notifications.find((item) => item.kind === "reply").postId,
      replyId,
    );
    assert.equal(
      inbox.notifications.find((item) => item.kind === "reply").preview,
      replyPreview,
    );
    assert.ok(
      inbox.notifications.every(
        (item) => item.actor.id === actor.id && item.readAt === null,
      ),
    );
    assert.equal(
      (await json("/api/notifications", { user: stranger })).unreadCount,
      0,
    );
    assert.equal(
      (
        await action(
          `/api/notifications/${inbox.notifications[0].id}/read`,
          "PUT",
          stranger,
        )
      ).status,
      404,
    );
    // Idempotent browser re-registration must preserve pending deliveries.
    assert.equal(
      (
        await request("/api/notifications/push", {
          method: "PUT",
          body: subscription,
        })
      ).status,
      204,
    );
    const sent = [];
    await Promise.all([
      flushPushDeliveries(async (target, payload, options) => {
        const details = webpush.generateRequestDetails(
          target,
          payload,
          options,
        );
        assert.ok(details.body.length > 0);
        assert.ok(details.headers.Authorization.startsWith("vapid "));
        sent.push(JSON.parse(payload));
        return { statusCode: 201, body: "", headers: {} };
      }),
      flushPushDeliveries(async (_target, payload) => {
        sent.push(JSON.parse(payload));
        return { statusCode: 201, body: "", headers: {} };
      }),
    ]);
    assert.equal(sent.length, 4);
    assert.equal(new Set(sent.map((item) => item.id)).size, 4);
    assert.ok(sent.every((item) => item.icon === "/api/avatars/test.webp"));
    assert.equal(
      sent.find((item) => item.body.includes("replied")).body,
      `notification_actor replied to your post\n${replyPreview}`,
    );
    assert.equal(Array.from(replyPreview).length, 160);
    assert.equal(
      sent.find((item) => item.body.includes("replied")).url,
      `/posts/${replyId}`,
    );
    assert.equal(
      (await pool.query("SELECT * FROM push_deliveries")).rowCount,
      0,
    );

    // Mute persists per browser, suppresses push, and keeps inbox activity.
    const mute = (duration, user = owner) =>
      request("/api/notifications/push/mute", {
        method: "PATCH",
        user,
        body: { endpoint: subscription.endpoint, duration },
      });
    assert.equal((await mute("invalid")).status, 400);
    assert.equal((await mute("1h", stranger)).status, 404);
    for (const hours of [1, 8]) {
      const response = await mute(`${hours}h`);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.ok(
        Math.abs(
          new Date(result.mutedUntil).getTime() - Date.now() - hours * 3600_000,
        ) < 5000,
      );
      assert.equal(result.mutedForever, false);
    }
    assert.equal((await mute("forever")).status, 200);
    await request("/api/notifications/push", {
      method: "PUT",
      body: subscription,
    });
    assert.equal(
      (
        await json(
          `/api/notifications/push?endpoint=${encodeURIComponent(subscription.endpoint)}`,
        )
      ).mutedForever,
      true,
    );
    // Record a new event in a transaction to prove mute suppresses queue creation.
    const { recordNotification } =
      await import("../src/notification-events.ts");
    await database.db.transaction((tx) =>
      recordNotification(tx, {
        recipientId: owner.id,
        actorId: stranger.id,
        kind: "repost",
        postId: post.id,
        subject: "muted-event",
      }),
    );
    assert.equal(
      (await pool.query("SELECT * FROM push_deliveries")).rowCount,
      0,
    );
    await pool.query("DELETE FROM notifications WHERE subject = 'muted-event'");
    await mute("1h");
    await pool.query(
      "UPDATE push_subscriptions SET muted_until = now() - interval '1 second'",
    );
    await database.db.transaction((tx) =>
      recordNotification(tx, {
        recipientId: owner.id,
        actorId: stranger.id,
        kind: "repost",
        postId: post.id,
        subject: "expired-mute",
      }),
    );
    assert.equal(
      (await pool.query("SELECT * FROM push_deliveries")).rowCount,
      1,
    );
    await mute("forever");
    await flushPushDeliveries(async () => {
      assert.fail("Muted queued push must not be delivered");
    });
    assert.equal(
      (await pool.query("SELECT * FROM push_deliveries")).rowCount,
      0,
    );
    await pool.query(
      "DELETE FROM notifications WHERE subject = 'expired-mute'",
    );
    assert.deepEqual(await (await mute("off")).json(), {
      mutedUntil: null,
      mutedForever: false,
    });

    // A temporary provider failure remains queued, then expires cleanly on 410.
    await action(`/api/posts/${post.id}/like`, "PUT", stranger);
    await flushPushDeliveries(async (_target, payload) => {
      assert.equal(JSON.parse(payload).icon, "/favicon.png");
      throw new Error("provider offline");
    });
    assert.equal(
      (await pool.query("SELECT attempts FROM push_deliveries")).rows[0]
        .attempts,
      1,
    );
    await pool.query("UPDATE push_deliveries SET available_at = now()");
    await flushPushDeliveries(async () => {
      throw new webpush.WebPushError(
        "Gone",
        410,
        {},
        "",
        subscription.endpoint,
      );
    });
    assert.equal(
      (await pool.query("SELECT * FROM push_subscriptions")).rowCount,
      0,
    );
    assert.equal(
      (await pool.query("SELECT * FROM push_deliveries")).rowCount,
      0,
    );

    assert.equal(
      (
        await action(
          `/api/notifications/${inbox.notifications[0].id}/read`,
          "PUT",
          owner,
        )
      ).status,
      204,
    );
    assert.equal(
      (await json("/api/notifications?unread=true")).notifications.length,
      4,
    );
    const latest = (await json("/api/notifications")).notifications[0];
    assert.equal(
      (
        await action("/api/notifications/read", "PUT", owner, {
          through: latest.createdAt,
        })
      ).status,
      204,
    );
    assert.equal((await json("/api/notifications")).unreadCount, 0);
    // Mark-all must not swallow events arriving after the displayed list.
    await pool.query(
      "INSERT INTO notifications (recipient_id, actor_id, kind, post_id, subject, created_at) VALUES ($1, $2, 'like', $3, 'later', now() + interval '1 minute')",
      [owner.id, actor.id, post.id],
    );
    await action("/api/notifications/read", "PUT", owner, {
      through: latest.createdAt,
    });
    assert.equal((await json("/api/notifications")).unreadCount, 1);
    for (const query of ["cursor=bad", "unread=invalid"])
      assert.equal((await request(`/api/notifications?${query}`)).status, 400);

    // Equal timestamps are paginated by ID without skips or duplicates.
    await pool.query(
      "INSERT INTO notifications (recipient_id, actor_id, kind, post_id, subject) SELECT $1, $2, 'like', $3, 'page-' || n FROM generate_series(1, 25) n",
      [owner.id, actor.id, post.id],
    );
    const first = await json("/api/notifications"),
      second = await json(`/api/notifications?cursor=${first.nextCursor}`);
    assert.equal(first.notifications.length, 20);
    assert.equal(
      new Set(
        [...first.notifications, ...second.notifications].map(
          (item) => item.id,
        ),
      ).size,
      31,
    );
    assert.equal(second.nextCursor, null);
    await action(`/api/posts/${post.id}`, "DELETE", owner);
    assert.deepEqual(
      (await json("/api/notifications")).notifications.map((item) => item.kind),
      ["follow"],
    );
    await request("/api/notifications/push", {
      method: "PUT",
      body: subscription,
    });

    const preferencePath = "/api/notifications/preferences";
    const setPreference = (kind, enabled) => json(preferencePath, {
      method: "PATCH", body: { kind, enabled },
    });
    assert.deepEqual(await json(preferencePath, { origin: null }), { mutedKinds: [] });
    assert.equal((await request(preferencePath, { user: null })).status, 401);
    assert.equal((await request(preferencePath, {
      method: "PATCH", body: { kind: "anything", enabled: false },
    })).status, 400);
    await Promise.all([setPreference("like", false), setPreference("friends_repost", false)]);
    assert.deepEqual(new Set((await json(preferencePath)).mutedKinds), new Set(["like", "friends_repost"]));
    assert.deepEqual(await json(preferencePath, { user: actor }), { mutedKinds: [] });

    const { rows: [newPost] } = await pool.query(
      "INSERT INTO posts (author_id, content) VALUES ($1, 'Preferences test') RETURNING id",
      [owner.id],
    );
    const extendedInbox = async () => (await json("/api/notifications?extendedKinds=true")).notifications;
    const postKinds = async () => (await extendedInbox())
      .filter((item) => item.postId === newPost.id).map((item) => item.kind);
    assert.equal((await action(`/api/posts/${newPost.id}/like`)).status, 200);
    assert.deepEqual(await postKinds(), []);
    assert.equal((await pool.query("SELECT * FROM push_deliveries")).rowCount, 0);
    assert.equal((await action(`/api/posts/${newPost.id}/like`, "DELETE")).status, 200);
    await setPreference("like", true);
    assert.equal((await action(`/api/posts/${newPost.id}/like`)).status, 200);
    assert.deepEqual(await postKinds(), ["like"]);
    await setPreference("like", false);
    let mutedPushes = 0;
    await flushPushDeliveries(async () => { mutedPushes++; });
    assert.equal(mutedPushes, 0);
    assert.equal((await pool.query("SELECT * FROM push_deliveries")).rowCount, 0);

    await setPreference("follow", false);
    assert.equal((await action(`/api/profiles/${owner.handle}/follow`, "PUT", stranger)).status, 200);
    assert.ok(!(await extendedInbox()).some((item) => item.actor.id === stranger.id));
    assert.equal((await action(`/api/profiles/${stranger.handle}/follow`, "PUT", owner)).status, 200);
    assert.ok((await json("/api/notifications?extendedKinds=true", { user: stranger })).notifications
      .some((item) => item.kind === "friend"));
    await setPreference("friend", false);
    assert.equal((await action(`/api/profiles/${owner.handle}/follow`, "DELETE", stranger)).status, 200);
    assert.equal((await action(`/api/profiles/${owner.handle}/follow`, "PUT", stranger)).status, 200);
    assert.ok(!(await extendedInbox()).some((item) => item.kind === "friend"));

    const repost = (audience) => action(`/api/posts/${newPost.id}/repost`, "PUT", stranger, { audience });
    assert.equal((await repost("friends")).status, 200);
    assert.deepEqual(await postKinds(), ["like"]);
    assert.equal((await repost("public")).status, 200);
    assert.ok((await postKinds()).includes("repost"));
    await setPreference("friends_repost", true);
    assert.equal((await repost("friends")).status, 200);
    assert.deepEqual(new Set(await postKinds()), new Set(["like", "friends_repost"]));
    assert.equal((await repost("friends")).status, 200);
    assert.equal((await postKinds()).filter((kind) => kind === "friends_repost").length, 1);
    assert.ok((await json("/api/notifications")).notifications
      .some((item) => item.kind === "repost" && item.postId === newPost.id));

    await setPreference("mention", false);
    const quoteResponse = await request("/api/posts", {
      method: "POST", user: actor, body: { content: `Hey @${owner.handle}`, quotedPostId: newPost.id },
    });
    assert.equal(quoteResponse.status, 201, await quoteResponse.clone().text());
    const { post: taggedQuote } = await quoteResponse.json();
    assert.deepEqual((await extendedInbox()).filter((item) => item.postId === taggedQuote.id)
      .map((item) => item.kind), ["quote"]);

    await pool.query("DELETE FROM auth_sessions WHERE token_hash = $1", [
      hash(owner.token),
    ]);
    assert.equal(
      (await pool.query("SELECT * FROM push_subscriptions")).rowCount,
      0,
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
