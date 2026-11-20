import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as webpush from "web-push";
import { WebSocket } from "ws";

config({ path: new URL("../.env", import.meta.url), quiet: true });

function makeDevice(userId) {
  const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const encryption = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const id = randomUUID();
  const exportKey = ({ publicKey }) => publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const encryptionKey = exportKey(encryption);
  const signingKey = exportKey(signing);
  const signature = (fields) => sign("sha256", Buffer.from(JSON.stringify(fields)), {
    key: signing.privateKey, dsaEncoding: "ieee-p1363",
  }).toString("base64");
  return {
    id,
    registration: {
      id, encryptionKey, signingKey, label: "Test browser",
      proof: signature(["ysocial.dm.device", 1, userId, id, encryptionKey, signingKey]),
    },
    access(method, path, binding = "") {
      const timestamp = String(Date.now());
      return {
        "x-dm-time": timestamp,
        "x-dm-signature": signature(["ysocial.dm.access", 1, userId, id, method, path, binding, timestamp]),
      };
    },
    message(conversationId, recipients, messageId = randomUUID()) {
      const iv = randomBytes(12).toString("base64");
      const ciphertext = randomBytes(32).toString("base64");
      return {
        id: messageId, senderDeviceId: id, version: 1, iv, ciphertext,
        signature: signature(["ysocial.dm.message", 1, conversationId, messageId, userId, id, iv, ciphertext]),
        envelopes: Object.fromEntries(recipients.map((device) => [device.id, randomBytes(256).toString("base64")])),
      };
    },
  };
}

test("DMs preserve legacy notifications and update live readers across API replicas", async (t) => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const database = "ysocial_dms_test_" + randomUUID().replaceAll("-", "");
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = "/" + database;
  let pool, main, replica, stopEvents, transport, socket;
  try {
    await admin.query("CREATE DATABASE " + database);
    process.env.DATABASE_URL = url.href;
    process.env.NODE_ENV = "test";
    const vapid = webpush.generateVAPIDKeys();
    Object.assign(process.env, { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: "mailto:test@example.com" });
    const { flushPushDeliveries } = await import("../src/push-delivery.ts");
    const { db, pool: appPool } = await import("../src/db/index.ts");
    pool = appPool;
    const { app } = await import("../src/app.ts");
    const { env } = await import("../src/config.ts");
    const { hash } = await import("../src/auth/secrets.ts");
    const { startLiveEvents } = await import("../src/live-events.ts");
    const { attachDmSocket } = await import("../src/dm-socket.ts");
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
    main = app.listen(0, "127.0.0.1");
    replica = app.listen(0, "127.0.0.1");
    await Promise.all([once(main, "listening"), once(replica, "listening")]);
    const base = "http://127.0.0.1:" + main.address().port;
    transport = attachDmSocket(replica);
    const listening = Promise.withResolvers();
    stopEvents = startLiveEvents({
      ...transport,
      setListening(ready) {
        transport.setListening(ready);
        if (ready) listening.resolve();
      },
    });
    await Promise.race([listening.promise, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("PostgreSQL listener did not start")), 5000);
      timer.unref();
    })]);

    async function account(handle) {
      const { rows: [user] } = await pool.query(
        "INSERT INTO users (handle, display_name, approved_at) VALUES ($1, $1, now()) RETURNING id",
        [handle],
      );
      const { rows: [identity] } = await pool.query(
        "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', $1, $2) RETURNING id",
        [handle, user.id],
      );
      const token = randomUUID();
      await pool.query(
        "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
        [hash(token), identity.id],
      );
      return { ...user, handle, token, device: makeDevice(user.id) };
    }

    async function request(user, path, { method = "GET", body, device, binding, status = 200 } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: {
          Cookie: "session=" + user.token,
          Origin: env.APP_ORIGIN,
          "Content-Type": "application/json",
          ...device?.access(method, path, binding),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(response.status, status, method + " " + path + " " + await response.clone().text());
      return status === 200 ? response.json() : undefined;
    }

    const [alice, bob, carol] = await Promise.all(["dm_alice", "dm_bob", "dm_carol"].map(account));
    for (const user of [alice, bob, carol]) {
      await request(user, "/api/dms/devices", { method: "POST", body: user.device.registration, status: 204 });
    }
    const frames = [];
    socket = new WebSocket("ws://127.0.0.1:" + replica.address().port + "/api/dms/live", {
      headers: { Cookie: "session=" + bob.token, Origin: env.APP_ORIGIN },
    });
    socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
    async function event(type, matches = () => true) {
      for (let waited = 0; waited < 3000; waited += 20) {
        const index = frames.findIndex((frame) => frame.type === type && matches(frame));
        if (index >= 0) return frames.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail("Missing live event " + type);
    }
    await event("ready");
    const notifications = (user, includeDms = true) => request(user, "/api/notifications" + (includeDms ? "?includeDms=true" : ""));
    const open = (sender, recipient) => request(sender, "/api/dms/conversations", {
      method: "POST", device: sender.device, binding: recipient.handle,
      body: { handle: recipient.handle, deviceId: sender.device.id },
    });
    const respond = (recipient, conversation, response) => request(recipient, conversation + "/invite", {
      method: "POST", device: recipient.device, binding: response,
      body: { deviceId: recipient.device.id, response }, status: 204,
    });
    const context = (user, path) => request(user, path + "?device=" + user.device.id, { device: user.device });
    const { id } = await open(alice, bob);
    const path = "/api/dms/conversations/" + id;

    await t.test("a new conversation stays invisible to the recipient until a message arrives", async () => {
      assert.deepEqual((await request(bob, "/api/dms/conversations?device=" + bob.device.id, { device: bob.device })).conversations, []);
      assert.deepEqual(await request(bob, "/api/dms/unread"), { unread: 0, requests: 0 });
      assert.equal((await notifications(bob)).unreadCount, 0);
      await respond(bob, path, "accepted");
      assert.equal((await context(alice, path)).inviteStatus, "accepted");
    });

    await t.test("message requests are capped, declining blocks both sides and only the blocker can lift it", async () => {
      const { id: requestId } = await open(carol, bob);
      const requestPath = "/api/dms/conversations/" + requestId;
      const send = (user, status = 204, ...recipients) => request(user, requestPath + "/messages", {
        method: "POST", body: user.device.message(requestId, recipients.length ? recipients : [carol.device, bob.device]), status,
      });
      for (let count = 0; count < 3; count++) await send(carol);
      await send(carol, 409);
      await send(bob, 409);
      assert.equal((await context(carol, requestPath)).requestSent, 3);
      assert.deepEqual(await request(bob, "/api/dms/unread"), { unread: 3, requests: 1 });
      const [entry] = (await request(bob, "/api/dms/conversations?device=" + bob.device.id, { device: bob.device })).conversations;
      assert.deepEqual({ id: entry.id, unread: entry.unread, invitedBy: entry.invitedBy, status: entry.inviteStatus }, {
        id: requestId, unread: 3, invitedBy: carol.id, status: "pending",
      });
      assert.equal((await notifications(bob, false)).unreadCount, 0);

      await respond(bob, requestPath, "declined");
      assert.deepEqual(await request(bob, "/api/dms/unread"), { unread: 0, requests: 0 });
      await send(carol, 403);
      assert.equal((await open(carol, bob)).id, requestId);
      assert.equal((await context(carol, requestPath)).inviteStatus, "declined");
      const unblock = (user, status) => request(user, requestPath + "/unblock", {
        method: "POST", device: user.device, binding: "unblock", body: { deviceId: user.device.id }, status,
      });
      await unblock(carol, 403);
      await unblock(bob, 204);
      assert.equal((await context(carol, requestPath)).inviteStatus, "accepted");
      await send(carol);

      const close = () => request(bob, requestPath + "/close", {
        method: "POST", device: bob.device, binding: "close", body: { deviceId: bob.device.id }, status: 204,
      });
      const listed = async (user) => (await request(user, "/api/dms/conversations?device=" + user.device.id, { device: user.device }))
        .conversations.some((conversation) => conversation.id === requestId);
      await close();
      assert.equal(await listed(bob), false);
      assert.equal(await listed(carol), true);
      await send(carol);
      assert.equal(await listed(bob), true);
    });

    await t.test("typing reaches the other person and malformed socket frames close the connection", async () => {
      const typing = [];
      const aliceSocket = new WebSocket("ws://127.0.0.1:" + replica.address().port + "/api/dms/live", {
        headers: { Cookie: "session=" + alice.token, Origin: env.APP_ORIGIN },
      });
      aliceSocket.on("message", (data) => typing.push(JSON.parse(data.toString())));
      try {
        await once(aliceSocket, "open");
        for (let waited = 0; waited < 3000 && !typing.some((frame) => frame.type === "ready"); waited += 20)
          await new Promise((resolve) => setTimeout(resolve, 20));
        socket.send(JSON.stringify({ type: "typing", id }));
        for (let waited = 0; waited < 3000 && !typing.some((frame) => frame.type === "typing"); waited += 20)
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(typing.find((frame) => frame.type === "typing"), { type: "typing", id, userId: bob.id });
        const closed = once(socket, "close");
        socket.send("not json");
        assert.equal((await closed)[0], 1008);
      } finally {
        aliceSocket.terminate();
      }
      socket = new WebSocket("ws://127.0.0.1:" + replica.address().port + "/api/dms/live", {
        headers: { Cookie: "session=" + bob.token, Origin: env.APP_ORIGIN },
      });
      socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
      await event("ready");
    });

    let message;
    await t.test("a committed message triggers a live event and can be acknowledged twice", async () => {
      frames.length = 0;
      message = alice.device.message(id, [alice.device, bob.device]);
      for (let attempt = 0; attempt < 2; attempt++) {
        await request(alice, path + "/messages", { method: "POST", body: message, status: 204 });
      }
      const frame = await event("conversation", (frame) => frame.id === id && !frame.roster);
      assert.deepEqual(frame, { type: "conversation", id, roster: false });
      const received = await context(bob, path + "/messages");
      assert.deepEqual(received.messages.map(({ id }) => id), [message.id]);
      const unread = async () => (await request(bob, "/api/dms/conversations?device=" + bob.device.id, { device: bob.device }))
        .conversations.find((conversation) => conversation.id === id).unread;
      assert.equal(await unread(), 1);
      const messageIds = [message.id];
      for (let attempt = 0; attempt < 2; attempt++) {
        await request(bob, path + "/read", {
          method: "PUT", body: { deviceId: bob.device.id, messageIds },
          device: bob.device, binding: JSON.stringify(messageIds), status: 204,
        });
      }
      assert.equal(await unread(), 0);
    });

    await t.test("people can react to, edit and delete messages", async () => {
      const second = alice.device.message(id, [alice.device, bob.device]);
      await request(alice, path + "/messages", { method: "POST", body: second, status: 204 });
      const react = (user, emoji, status = 204) => request(user, path + "/messages/" + second.id + "/reaction", {
        method: "PUT", body: { emoji }, status,
      });
      const fetchOne = (user) => request(user, path + "/messages/" + second.id + "?device=" + user.device.id, { device: user.device });
      frames.length = 0;
      await react(bob, "👍");
      assert.deepEqual(await event("conversation", (frame) => frame.message === second.id),
        { type: "conversation", id, roster: false, message: second.id });
      await react(bob, "not an emoji", 400);
      await react(bob, "👍👍", 400);
      assert.deepEqual((await fetchOne(alice)).message.reactions, [{ userId: bob.id, emoji: "👍" }]);
      await react(bob, "❤️");
      await react(alice, "🎉");
      assert.deepEqual((await fetchOne(alice)).message.reactions.map(({ emoji }) => emoji).sort(), ["❤️", "🎉"].sort());
      await react(bob, null);
      assert.deepEqual((await fetchOne(alice)).message.reactions, [{ userId: alice.id, emoji: "🎉" }]);

      const edited = alice.device.message(id, [alice.device, bob.device], second.id);
      const edit = (user, body, status = 204) => request(user, path + "/messages/" + second.id, { method: "PUT", body, status });
      await edit(bob, { ...bob.device.message(id, [alice.device, bob.device], second.id) }, 403);
      await edit(alice, { ...edited, signature: edited.signature.replace(/^./, (first) => first === "A" ? "B" : "A") }, 403);
      await edit(alice, edited);
      const after = (await fetchOne(bob)).message;
      assert.equal(after.ciphertext, edited.ciphertext);
      assert.ok(after.editedAt);
      assert.equal((await fetchOne(alice)).message.reactions.length, 1);

      const remove = (user, status) => request(user, path + "/messages/" + second.id, { method: "DELETE", status });
      await remove(bob, 403);
      frames.length = 0;
      await remove(alice, 204);
      await event("conversation", (frame) => frame.message === second.id);
      await request(bob, path + "/messages/" + second.id + "?device=" + bob.device.id, { device: bob.device, status: 404 });
      assert.ok(!(await context(bob, path + "/messages")).messages.some((entry) => entry.id === second.id));
      await react(bob, "👍", 404);
      await remove(alice, 204);
    });

    await t.test("polls store only the chosen index and voice files stay ciphertext", async () => {
      const poll = alice.device.message(id, [alice.device, bob.device]);
      await request(alice, path + "/messages", { method: "POST", body: poll, status: 204 });
      const vote = (user, option, status = 204) => request(user, path + "/messages/" + poll.id + "/vote", { method: "PUT", body: { option }, status });
      const fetchOne = (user) => request(user, path + "/messages/" + poll.id + "?device=" + user.device.id, { device: user.device });
      await vote(bob, 1);
      await vote(alice, 0);
      await vote(bob, 10, 400);
      assert.deepEqual((await fetchOne(alice)).message.votes.map(({ option }) => option).sort(), [0, 1]);
      await vote(bob, 0);
      await vote(alice, null);
      assert.deepEqual((await fetchOne(bob)).message.votes, [{ userId: bob.id, option: 0 }]);

      const upload = async (user, bytes, attachmentId = randomUUID(), conversation = path) => {
        const response = await fetch(base + conversation + "/attachments", {
          method: "POST", body: bytes,
          headers: { Cookie: "session=" + user.token, Origin: env.APP_ORIGIN, "Content-Type": "application/octet-stream", "X-DM-Attachment-Id": attachmentId },
        });
        return { status: response.status, attachmentId };
      };
      const download = async (user, attachmentId) => {
        const response = await fetch(base + path + "/attachments/" + attachmentId, { headers: { Cookie: "session=" + user.token } });
        return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
      };
      const ciphertext = randomBytes(300);
      assert.equal((await upload(alice, randomBytes(8))).status, 400);
      const { status, attachmentId } = await upload(alice, ciphertext);
      assert.equal(status, 201);
      assert.equal((await download(bob, attachmentId)).status, 404);
      const voice = alice.device.message(id, [alice.device, bob.device]);
      await request(alice, path + "/messages", { method: "POST", body: { ...voice, attachmentId: randomUUID() }, status: 409 });
      await request(alice, path + "/messages", { method: "POST", body: { ...voice, attachmentId }, status: 204 });
      const received = await download(bob, attachmentId);
      assert.equal(received.status, 200);
      assert.ok(received.bytes.equals(ciphertext));
      assert.equal((await download(carol, attachmentId)).status, 404);
      await request(alice, path + "/messages/" + voice.id, { method: "DELETE", status: 204 });
      assert.equal((await download(bob, attachmentId)).status, 404);
      await request(alice, path + "/messages/" + poll.id, { method: "DELETE", status: 204 });
    });

    await t.test("turning Messages off pauses sending in both directions until it is turned back on", async () => {
      const setMessaging = (user, enabled, status = 204) => request(user, "/api/dms/preferences", {
        method: "PUT", device: user.device, binding: enabled ? "on" : "off", body: { deviceId: user.device.id, enabled }, status,
      });
      const send = (user, status) => request(user, path + "/messages", {
        method: "POST", body: user.device.message(id, [alice.device, bob.device]), status,
      });
      assert.deepEqual(await request(bob, "/api/dms/preferences"), { enabled: true });
      await request(bob, "/api/dms/preferences", { method: "PUT", body: { deviceId: bob.device.id, enabled: false }, status: 403 });
      await setMessaging(bob, false);
      assert.deepEqual(await request(bob, "/api/dms/preferences"), { enabled: false });
      await send(alice, 403);
      await send(bob, 403);
      await open(alice, bob).catch(() => undefined);
      await request(alice, "/api/dms/conversations", {
        method: "POST", device: alice.device, binding: bob.handle, body: { handle: bob.handle, deviceId: alice.device.id }, status: 403,
      });
      const flags = await context(alice, path);
      assert.deepEqual([flags.peerOptedOut, flags.selfOptedOut], [true, false]);
      await setMessaging(bob, true);
      await send(alice, 204);
      await send(bob, 204);
    });

    await t.test("a message queues a push for the recipient that names the conversation, and read or deleted messages are never sent", async () => {
      const subscribe = async () => {
        const { rows: [session] } = await pool.query("SELECT token_hash FROM auth_sessions WHERE token_hash = $1", [(await import("../src/auth/secrets.ts")).hash(bob.token)]);
        await pool.query("DELETE FROM push_subscriptions WHERE user_id = $1", [bob.id]);
        await pool.query("INSERT INTO push_subscriptions (user_id, session_hash, endpoint, p256dh, auth) VALUES ($1, $2, $3, 'p', 'a')", [bob.id, session.token_hash, "https://push.invalid/" + randomUUID()]);
      };
      const flush = async () => {
        const sent = [];
        await flushPushDeliveries(async (_target, payload) => { sent.push(JSON.parse(payload)); });
        return sent;
      };
      const post = (user, body = user.device.message(id, [alice.device, bob.device])) =>
        request(user, path + "/messages", { method: "POST", body, status: 204 }).then(() => body);
      await subscribe();
      const first = await post(alice);
      const [push] = await flush();
      assert.equal(push.url, "/messages/" + id);
      assert.equal(push.body, "New message");
      assert.equal(push.chatRecipient, bob.id);
      assert.ok(!JSON.stringify(push).includes(first.ciphertext));

      const read = await post(alice);
      await request(bob, path + "/read", { method: "PUT", body: { deviceId: bob.device.id, messageIds: [read.id] }, device: bob.device, binding: JSON.stringify([read.id]), status: 204 });
      assert.deepEqual(await flush(), []);
      const gone = await post(alice);
      await request(alice, path + "/messages/" + gone.id, { method: "DELETE", status: 204 });
      assert.deepEqual(await flush(), []);
      await request(bob, "/api/notifications/previews", { method: "PATCH", body: { hideContent: true }, status: 204 });
      await post(alice);
      const [hidden] = await flush();
      assert.equal(hidden.chatRecipient, undefined);
      await request(bob, "/api/notifications/previews", { method: "PATCH", body: { hideContent: false }, status: 204 });
      await pool.query("UPDATE users SET dm_opted_out = true WHERE id = $1", [bob.id]);
      await post(alice, alice.device.message(id, [alice.device, bob.device])).catch(() => undefined);
      await pool.query("UPDATE users SET dm_opted_out = false WHERE id = $1", [bob.id]);
    });

    await t.test("link previews need a signed-in, approved account and an https address", async () => {
      const preview = (user, url, status) => request(user, "/api/dms/link-preview?" + new URLSearchParams({ url }), { status });
      await preview(alice, "http://example.com/", 400);
      await preview(alice, "not a url", 400);
      const anonymous = await fetch(base + "/api/dms/link-preview?" + new URLSearchParams({ url: "https://example.com/" }));
      assert.equal(anonymous.status, 401);
    });

    await t.test("privacy changes reach open tabs and suppress preview data", async () => {
      const dm = (await notifications(bob)).notifications.find(({ kind }) => kind === "dm_message");
      assert.ok(dm.chatPreview);
      await request(bob, "/api/notifications/previews", { method: "PATCH", body: { hideContent: true }, status: 204 });
      assert.equal((await event("previews")).hidden, true);
      const hidden = await notifications(bob);
      assert.equal(hidden.hideContent, true);
      assert.equal(hidden.notifications.find(({ id }) => id === dm.id).chatPreview, false);
      await request(bob, "/api/dms/notification-previews/" + dm.id + "?device=" + bob.device.id, {
        device: bob.device, status: 204,
      });
    });

    await t.test("recovery creates a new active root and preserves historical signing keys", async () => {
      const replacement = makeDevice(alice.id);
      await request(alice, "/api/dms/devices", { method: "POST", body: replacement.registration, status: 204 });
      const reset = { ...replacement.registration, previousRootId: alice.device.id };
      for (let attempt = 0; attempt < 2; attempt++) {
        await request(alice, "/api/dms/devices/reset", { method: "POST", body: reset, status: 204 });
      }
      const { devices } = await request(alice, "/api/dms/devices");
      assert.deepEqual(devices.map(({ id, root, generation }) => ({ id, root, generation })), [
        { id: replacement.id, root: true, generation: 2 },
      ]);
      const peerContext = await context(bob, path);
      assert.deepEqual(peerContext.devices.filter(({ userId }) => userId === alice.id).map(({ generation }) => generation).sort(), [1, 2]);
      assert.equal((await context(bob, path + "/messages")).messages[0].id, message.id);
      assert.deepEqual((await context({ ...alice, device: replacement }, path + "/messages")).messages, []);
    });
  } finally {
    socket?.terminate();
    stopEvents?.();
    transport?.stop();
    await Promise.all([main, replica].filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))));
    await pool?.end();
    await admin.query("DROP DATABASE IF EXISTS " + database + " WITH (FORCE)");
    await admin.end();
  }
});
