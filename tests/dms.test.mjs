import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
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
    message(conversationId, recipients) {
      const messageId = randomUUID();
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

    const [alice, bob] = await Promise.all(["dm_alice", "dm_bob"].map(account));
    for (const user of [alice, bob]) {
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

    await t.test("older clients see neither DM rows nor their unread count", async () => {
      await event("conversation", (frame) => frame.id === id && frame.roster);
      await event("notifications");
      assert.equal((await notifications(bob)).unreadCount, 1);
      assert.deepEqual((await notifications(bob, false)).notifications, []);
      assert.equal((await notifications(bob, false)).unreadCount, 0);
      await request(bob, "/api/notifications/read", {
        method: "PUT", body: { through: new Date(Date.now() + 5000).toISOString() }, status: 204,
      });
      assert.equal((await notifications(bob)).unreadCount, 1);
    });

    await t.test("the recipient can reverse a declined invite", async () => {
      await respond(bob, path, "declined");
      await open(alice, bob);
      assert.equal((await context(alice, path)).inviteStatus, "declined");
      assert.equal((await open(bob, alice)).id, id);
      assert.equal((await context(alice, path)).invitedBy, bob.id);
      assert.equal((await notifications(alice)).notifications[0].kind, "dm_invite");
      await respond(alice, path, "accepted");
    });

    let message;
    await t.test("a committed message triggers a live event and can be acknowledged twice", async () => {
      message = alice.device.message(id, [alice.device, bob.device]);
      for (let attempt = 0; attempt < 2; attempt++) {
        await request(alice, path + "/messages", { method: "POST", body: message, status: 204 });
      }
      const frame = await event("conversation", (frame) => frame.id === id && !frame.roster);
      assert.deepEqual(frame, { type: "conversation", id, roster: false });
      const received = await context(bob, path + "/messages");
      assert.deepEqual(received.messages.map(({ id }) => id), [message.id]);
      assert.equal((await notifications(bob)).unreadCount, 1);
      const messageIds = [message.id];
      for (let attempt = 0; attempt < 2; attempt++) {
        await request(bob, path + "/read", {
          method: "PUT", body: { deviceId: bob.device.id, messageIds },
          device: bob.device, binding: JSON.stringify(messageIds), status: 204,
        });
      }
      assert.equal((await notifications(bob)).unreadCount, 0);
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
