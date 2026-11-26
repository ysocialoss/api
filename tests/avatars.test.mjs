import assert from "node:assert/strict";
import { fakeR2 } from "./helpers/fake-r2.mjs";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import test from "node:test";
import { config } from "dotenv";
import pg from "pg";
import sharp from "sharp";
import { makeVoiceWav } from "./fixtures/voice.mjs";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

config({ path: new URL("../.env", import.meta.url), quiet: true });
const live = process.env.AVATAR_TEST_LIVE_R2 === "1";
const databaseUrl = new URL(process.env.DATABASE_URL);
const databaseName = `ysocial_avatar_test_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString: databaseUrl.href });
databaseUrl.pathname = `/${databaseName}`;
process.env.DATABASE_URL = databaseUrl.href;
process.env.NODE_ENV = "test";
process.env.ADMIN_ORIGIN = "https://admin.example.test";
process.env.KLIPY_API_KEY = "test-klipy-key";
process.env.SESSION_ENCRYPTION_KEY = "ab".repeat(32);
if (!live) {
  process.env.R2_ACCOUNT_ID = "a".repeat(32);
  process.env.R2_BUCKET = "avatar-tests";
  process.env.R2_ACCESS_KEY_ID = "test-access-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
}

await test("avatar upload, persistence, access, and failures", async (t) => {
  let scanCount = 0;
  let rejectScan = 0;
  let scannerUnavailable = false;
  const scanner = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/detect");
      const form = await new Response(Readable.toWeb(req), {
        headers: { "Content-Type": req.headers["content-type"] },
      }).formData();
      const image = form.get("file");
      assert.equal(image.type, "image/avif");
      assert.equal(Buffer.from(await image.arrayBuffer()).toString("ascii", 4, 12), "ftypavif");
      scanCount++;
      if (scannerUnavailable) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        is_nsfw: scanCount === rejectScan, confidence_percentage: 97.5,
      }));
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  }).listen(0, "127.0.0.1");
  await once(scanner, "listening");
  t.after(() => new Promise((resolve) => scanner.close(resolve)));
  process.env.NSFW_CHECK_URL = `http://127.0.0.1:${scanner.address().port}`;
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const { app } = await import("../src/app.ts");
  const { db, pool } = await import("../src/db/index.ts");
  const { env } = await import("../src/config.ts");
  const { r2ConfigSchema } = await import("../src/storage/r2-config.ts");
  const { avatarStorage } = await import("../src/storage/r2.ts");
  const { hash } = await import("../src/auth/secrets.ts");
  let server;
  const uploaded = [];
  let failWrites = false;
  let holdVoiceWrite;
  let failDeletes = false;
  // Only replace the external storage transport. HTTP, authentication, PostgreSQL,
  // image decoding, AWS request serialization, and all response paths are real.
  const objects = live ? new Map() : fakeR2(t, avatarStorage, {
    keys: /^(avatars|banners|voices|flagged-images)\/.+$/,
    allowMissing: true,
    onPut: async (request, key) => {
      if (failWrites) throw new Error("Simulated R2 outage");
      if (key.startsWith("voices/")) await holdVoiceWrite;
      const extension = key.split(".").pop();
      assert.equal(request.headers["content-type"],
        { m4a: "audio/mp4", gif: "image/gif", png: "image/png", webp: "image/webp" }[extension] ?? "image/avif");
      assert.equal(request.headers["cache-control"], "no-store");
    },
    onDelete: () => { if (failDeletes) throw new Error("Simulated deletion outage"); },
  });
  try {
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    const {
      rows: [alice],
    } = await pool.query(
      "INSERT INTO users (handle, display_name, approved_at) VALUES ('avatar_alice', 'Alice', now()) RETURNING id",
    );
    const {
      rows: [bob],
    } = await pool.query(
      "INSERT INTO users (handle, display_name, approved_at) VALUES ('avatar_bob', 'Bob', now()) RETURNING id",
    );
    const {
      rows: [identity],
    } = await pool.query(
      "INSERT INTO auth_identities (issuer, subject, user_id, picture) VALUES ('https://test.invalid', 'alice', $1, 'https://test.invalid/provider.png') RETURNING id",
      [alice.id],
    );
    const token = randomUUID();
    await pool.query(
      "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
      [hash(token), identity.id],
    );
    await pool.query(
      "INSERT INTO posts (author_id, content) VALUES ($1, 'Avatar integration test')",
      [alice.id],
    );
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      Origin: env.APP_ORIGIN,
      Cookie: `session=${token}`,
      "Content-Type": "image/png",
    };
    const picture = await sharp({
      create: { width: 800, height: 600, channels: 3, background: "#5c4ec4" },
    })
      .withMetadata()
      .png()
      .toBuffer();
    async function upload(body = picture, overrides = {}) {
      const result = await fetch(`${origin}/api/avatars/me`, {
        method: "PUT",
        headers: { ...headers, ...overrides },
        body,
      });
      const data = await result.json();
      if (data.avatarUrl) uploaded.push(data.avatarUrl.replace("/api/", ""));
      return { result, data };
    }
    async function assertObjectDeleted(key) {
      if (!live) {
        assert.equal(objects.has(key), false);
        return;
      }
      await assert.rejects(
        avatarStorage.client.send(
          new HeadObjectCommand({ Bucket: avatarStorage.bucket, Key: key }),
        ),
        (error) => error.$metadata?.httpStatusCode === 404,
      );
    }
    let firstUrl;
    const voicePollHeaders = { Cookie: headers.Cookie };
    async function waitForVoiceJob(id) {
      const signal = AbortSignal.timeout(20_000);
      const path = `${origin}/api/voices/jobs/${id}`;
      for (;;) {
        const response = await fetch(path, { headers: voicePollHeaders, signal });
        if (response.status !== 202) return response;
        assert.deepEqual(await response.json(), { pending: true, jobId: id });
        await delay(100, undefined, { signal });
      }
    }

    async function finishVoiceUpload(response) {
      if (response.status !== 202) return response;
      const pending = await response.json();
      assert.equal(pending.pending, true);
      assert.match(pending.jobId, /^[0-9a-f-]{36}$/i);
      return waitForVoiceJob(pending.jobId);
    }

    await t.test("voice uploads, posts, replies, retries, range playback and deletion", async () => {
      async function voiceUpload(body, overrides = {}) {
        return fetch(`${origin}/api/voices`, {
          method: "POST", headers: { ...headers, "Content-Type": "audio/wav", ...overrides }, body,
        });
      }
      async function postRequest(path, body, method = "POST") {
        return fetch(origin + path, {
          method, headers: { ...headers, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      }
      const wav = makeVoiceWav(3);
      async function uploadDraft() {
        const initial = await voiceUpload(wav);
        const response = await finishVoiceUpload(initial);
        assert.equal(response.status, initial.status === 202 ? 200 : 201);
        const draft = await response.json();
        uploaded.push(draft.key);
        return draft;
      }
      assert.equal((await voiceUpload(wav, { Cookie: "" })).status, 401);
      assert.equal((await voiceUpload(wav, { Origin: "https://other.invalid" })).status, 403);
      assert.equal((await voiceUpload(wav, { "Content-Type": "text/plain" })).status, 415);
      assert.equal((await voiceUpload(Buffer.alloc(8 * 1024 * 1024 + 1))).status, 413);
      const short = await finishVoiceUpload(await voiceUpload(makeVoiceWav(1)));
      assert.equal(short.status, 400);
      assert.equal((await short.json()).error, "voice_too_short");
      const voice = await uploadDraft();
      assert.equal(voice.durationMs, 3000);
      assert.equal(voice.waveform.length, 48);
      assert.ok(voice.waveform.some((level) => level > 0));
      assert.ok(voice.waveform.every((level) => Number.isInteger(level) && level >= 0 && level <= 100));
      assert.ok(voice.bytes < 60000);
      assert.equal((await fetch(origin + voice.url)).status, 404, "unattached uploads are private");
      const { readVoiceSelection } = await import("../src/storage/voice-selection.ts");
      assert.throws(() => readVoiceSelection(voice.token, bob.id));
      const invalid = await postRequest("/api/posts", { voiceToken: `${voice.token}x` });
      assert.equal(invalid.status, 400);
      const clientId = randomUUID();
      const input = { clientId, voiceToken: voice.token };
      const created = await postRequest("/api/posts", input);
      assert.equal(created.status, 201);
      const post = (await created.json()).post;
      assert.equal((await postRequest("/api/voices", { token: voice.token }, "DELETE")).status, 204);
      assert.equal((await fetch(origin + voice.url)).status, 200, "discard cannot delete posted audio");
      assert.equal(post.content, "");
      assert.equal(post.voice.url, voice.url);
      assert.deepEqual(post.voice.waveform, voice.waveform);
      assert.equal((await pool.query("SELECT key FROM media_deletions WHERE key = $1", [voice.key])).rowCount, 0);
      const retried = await postRequest("/api/posts", input);
      assert.equal(retried.status, 201);
      assert.equal((await retried.json()).post.id, post.id);
      assert.equal((await postRequest("/api/posts", { voiceToken: voice.token })).status, 400, "single use");
      assert.equal((await postRequest("/api/posts", { ...input, content: "changed" })).status, 400);
      const audio = await fetch(origin + voice.url);
      assert.equal(audio.status, 200);
      assert.match(audio.headers.get("content-type"), /audio\/mp4/);
      assert.equal((await audio.arrayBuffer()).byteLength, voice.bytes);
      const range = await fetch(origin + voice.url, { headers: { Range: "bytes=0-99" } });
      assert.equal(range.status, 206);
      assert.equal((await range.arrayBuffer()).byteLength, 100);
      assert.equal(range.headers.get("content-range"), `bytes 0-99/${voice.bytes}`);
      assert.equal((await fetch(origin + voice.url, { headers: { Range: `bytes=${voice.bytes + 1}-` } })).status, 416);
      assert.equal((await postRequest(`/api/posts/${post.id}`, { content: "Caption" }, "PATCH")).status, 200);
      assert.equal((await postRequest(`/api/posts/${post.id}`, { content: "" }, "PATCH")).status, 200);
      const nextVoice = await uploadDraft();
      const replied = await postRequest(`/api/posts/${post.id}/replies`, { voiceToken: nextVoice.token });
      assert.equal(replied.status, 201);
      const reply = (await replied.json()).post;
      assert.equal(reply.voice.url, nextVoice.url);
      const thread = await (await fetch(`${origin}/api/posts/${post.id}/replies`)).json();
      assert.equal(thread.posts[0].voice.durationMs, 3000);
      assert.equal((await postRequest(`/api/posts/${post.id}`, undefined, "DELETE")).status, 204);
      assert.equal((await fetch(origin + voice.url)).status, 404);
      assert.equal((await fetch(origin + nextVoice.url)).status, 404);
      assert.deepEqual(
        (await pool.query("SELECT key FROM media_deletions WHERE key = ANY($1)", [[voice.key, nextVoice.key]])).rows,
        [{ key: nextVoice.key }],
        "the deleted post is cleaned immediately and cascaded replies remain queued",
      );
      await assertObjectDeleted(voice.key);
      assert.equal((await postRequest("/api/posts", { voiceToken: voice.token })).status, 400, "deleted recordings cannot be reused");
      const { flushMediaDeletions } = await import("../src/storage/media-lifecycle.ts");
      await flushMediaDeletions();
      await assertObjectDeleted(voice.key);
      await assertObjectDeleted(nextVoice.key);
      for (const action of ["discard", "expire"]) {
        const draft = await uploadDraft();
        const { rows: [pending] } = await pool.query("SELECT available_at FROM media_deletions WHERE key = $1", [draft.key]);
        const remaining = pending.available_at.getTime() - Date.now();
        assert.ok(remaining > 29 * 60 * 1000 && remaining <= 30 * 60 * 1000);
        const selection = readVoiceSelection(draft.token, alice.id);
        assert.ok(selection.expires - Date.now() <= 30 * 60 * 1000);
        if (action === "discard") {
          const denied = await fetch(origin + "/api/voices", { method: "DELETE", headers: { ...headers, Cookie: "", "Content-Type": "application/json" }, body: JSON.stringify({ token: draft.token }) });
          assert.equal(denied.status, 401);
          assert.equal((await postRequest("/api/voices", { token: draft.token + "x" }, "DELETE")).status, 400);
          assert.equal((await postRequest("/api/voices", { token: draft.token }, "DELETE")).status, 204);
          assert.equal((await postRequest("/api/voices", { token: draft.token }, "DELETE")).status, 204, "idempotent discard");
        } else {
          await flushMediaDeletions(draft.key);
          if (!live) assert.ok(objects.has(draft.key), "draft remains until its deadline");
          await pool.query("UPDATE media_deletions SET available_at = now() - interval '1 second' WHERE key = $1", [draft.key]);
          assert.equal((await postRequest("/api/posts", { voiceToken: draft.token })).status, 400, "expired draft cannot be published");
          await flushMediaDeletions(draft.key);
        }
        await assertObjectDeleted(draft.key);
        assert.equal((await postRequest("/api/posts", { voiceToken: draft.token })).status, 400);
      }
    });
    await t.test("slow storage returns a queued upload before the write completes", { skip: live }, async () => {
      let releaseWrite;
      holdVoiceWrite = new Promise((resolve) => { releaseWrite = resolve; });
      const id = randomUUID();
      const path = `${origin}/api/voices/jobs/${id}`;
      try {
        const upload = await fetch(`${origin}/api/voices`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "audio/wav", "Idempotency-Key": id },
          body: makeVoiceWav(3),
          signal: AbortSignal.timeout(20_000),
        });
        assert.equal(upload.status, 202);
        assert.deepEqual(await upload.json(), { pending: true, jobId: id });
        assert.equal((await fetch(path, { headers: { Cookie: headers.Cookie } })).status, 202);
      } finally {
        releaseWrite();
        holdVoiceWrite = undefined;
      }
      const response = await waitForVoiceJob(id);
      assert.equal(response.status, 200);
      uploaded.push((await response.json()).key);
      assert.equal((await fetch(path, { method: "DELETE", headers })).status, 204);
    });

    await t.test("voice jobs recover an expired pod lease and replay the same draft", async () => {
      const { startVoiceJobs } = await import("../src/storage/voice-jobs.ts");
      const id = randomUUID();
      const wav = makeVoiceWav(3);
      await pool.query(
        `INSERT INTO voice_jobs (user_id, id, input, lease, next_attempt_at, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '30 minutes', now() + interval '30 minutes')`,
        [alice.id, id, wav, randomUUID()],
      );
      const path = `${origin}/api/voices/jobs/${id}`;
      const upload = () => fetch(`${origin}/api/voices`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "audio/wav", "Idempotency-Key": id },
        body: wav,
      });
      const pending = await upload();
      assert.equal(pending.status, 202);
      assert.deepEqual(await pending.json(), { pending: true, jobId: id });

      // A browser's same-origin GET sends the session cookie without an Origin header.
      assert.equal((await fetch(path)).status, 401);
      assert.equal((await fetch(path, { headers: voicePollHeaders })).status, 202);
      assert.equal((await fetch(path, { method: "DELETE", headers: voicePollHeaders })).status, 403);

      const { rows: [otherIdentity] } = await pool.query(
        "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', 'bob', $1) RETURNING id",
        [bob.id],
      );
      const otherToken = randomUUID();
      await pool.query(
        "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
        [hash(otherToken), otherIdentity.id],
      );
      const otherHeaders = { Cookie: `session=${otherToken}` };
      assert.equal((await fetch(path, { headers: otherHeaders })).status, 404);

      await pool.query(
        "UPDATE voice_jobs SET next_attempt_at = now() - interval '1 second' WHERE user_id = $1 AND id = $2",
        [alice.id, id],
      );
      const stopWorkers = [startVoiceJobs(), startVoiceJobs()];
      try {
        const response = await waitForVoiceJob(id);
        assert.equal(response.status, 200);
        const voice = await response.json();
        assert.equal((await fetch(path, { headers: otherHeaders })).status, 404);
        uploaded.push(voice.key);
        const replays = await Promise.all([upload(), upload()]);
        for (const replay of replays) {
          assert.equal(replay.status, 201);
          assert.deepEqual(await replay.json(), voice);
        }
        const { rows: [job] } = await pool.query(
          "SELECT input, lease FROM voice_jobs WHERE id = $1", [id],
        );
        assert.deepEqual(job, { input: null, lease: null });
        assert.equal((await fetch(path, { method: "DELETE", headers })).status, 204);
        assert.equal((await upload()).status, 404, "a delayed retry must not revive a cancelled job");
      } finally {
        for (const stop of stopWorkers) stop();
      }
    });

    await t.test(
      "rejects partial R2 settings and fixes jurisdiction to EU",
      () => {
        assert.equal(r2ConfigSchema.parse({}), null);
        assert.equal(
          r2ConfigSchema.safeParse({ R2_BUCKET: "test" }).success,
          false,
        );
        assert.match(
          env.R2.endpoint,
          /^https:\/\/[a-f0-9]{32}\.eu\.r2\.cloudflarestorage\.com$/,
        );
      },
    );
    await t.test(
      "requires matching origin and an authenticated user",
      async () => {
        assert.equal(
          (await upload(picture, { Origin: "https://other.invalid" })).result
            .status,
          403,
        );
        assert.equal(
          (await upload(picture, { Cookie: "" })).result.status,
          401,
        );
      },
    );
    await t.test(
      "rejects unsupported, malformed, oversized, and excessive-pixel inputs",
      async () => {
        assert.equal(
          (await upload(picture, { "Content-Type": "image/svg+xml" })).result
            .status,
          415,
        );
        assert.equal(
          (await upload(Buffer.from("not an image"))).result.status,
          400,
        );
        assert.equal(
          (await upload(Buffer.alloc(2 * 1024 * 1024 + 1))).result.status,
          413,
        );
        const huge = await sharp({
          create: { width: 5000, height: 5000, channels: 3, background: "red" },
        })
          .png()
          .toBuffer();
        assert.equal((await upload(huge)).result.status, 400);
      },
    );
    await t.test(
      "AVIF preserves transparency and does not enlarge small images",
      async () => {
        const { normalizeAvatar } =
          await import("../src/storage/avatar-image.ts");
        const input = await sharp({
          create: {
            width: 64,
            height: 64,
            channels: 4,
            background: { r: 40, g: 80, b: 120, alpha: 0.5 },
          },
        })
          .png()
          .toBuffer();
        const output = await normalizeAvatar(input);
        const metadata = await sharp(output).metadata();
        assert.equal(metadata.compression, "av1");
        assert.equal(metadata.width, 64);
        assert.equal(metadata.height, 64);
        assert.equal(metadata.hasAlpha, true);
      },
    );
    await t.test("previously saved PNG avatars still load", async () => {
      const key = `avatars/${randomUUID()}.png`;
      if (live) {
        await avatarStorage.client.send(
          new PutObjectCommand({
            Bucket: avatarStorage.bucket,
            Key: key,
            Body: picture,
            ContentType: "image/png",
          }),
        );
      } else {
        objects.set(key, picture);
      }
      uploaded.push(key);
      await pool.query("UPDATE users SET avatar_key = $1 WHERE id = $2", [
        key,
        alice.id,
      ]);
      const response = await fetch(`${origin}/api/${key}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), picture);
    });
    await t.test(
      "saves the crop and serves a sanitized image without caching",
      async () => {
        const { result, data } = await upload();
        assert.equal(result.status, 200);
        firstUrl = data.avatarUrl;
        assert.match(firstUrl, /^\/api\/avatars\/[a-f0-9-]{36}\.avif$/);
        const saved = await fetch(`${origin}${firstUrl}`);
        assert.equal(saved.status, 200);
        assert.equal(saved.headers.get("cache-control"), "no-store");
        assert.equal(saved.headers.get("x-content-type-options"), "nosniff");
        const metadata = await sharp(
          Buffer.from(await saved.arrayBuffer()),
        ).metadata();
        assert.equal(saved.headers.get("content-type"), "image/avif");
        assert.equal(metadata.format, "heif");
        assert.equal(metadata.compression, "av1");
        assert.equal(metadata.width, 512);
        assert.equal(metadata.height, 512);
        assert.equal(metadata.exif, undefined);
        const {
          rows: [user],
        } = await pool.query("SELECT avatar_key FROM users WHERE id = $1", [
          alice.id,
        ]);
        assert.equal(`/api/${user.avatar_key}`, firstUrl);
        const {
          rows: [other],
        } = await pool.query("SELECT avatar_key FROM users WHERE id = $1", [
          bob.id,
        ]);
        assert.equal(other.avatar_key, null);
      },
    );
    await t.test(
      "session, profile, and post author use the persisted picture",
      async () => {
        const session = await fetch(`${origin}/auth/me`, { headers }).then(
          (res) => res.json(),
        );
        assert.equal(session.avatarUrl, firstUrl);
        assert.equal(session.user.avatarUrl, firstUrl);
        const profile = await fetch(`${origin}/api/profiles/avatar_alice`, {
          headers,
        }).then((res) => res.json());
        assert.equal(profile.profile.avatarUrl, firstUrl);
        assert.equal(profile.posts[0].author.avatarUrl, firstUrl);
        await pool.query(
          "UPDATE auth_identities SET picture = 'https://test.invalid/changed.png' WHERE id = $1",
          [identity.id],
        );
        const reloaded = await fetch(
          `${origin}/api/profiles/avatar_alice`,
        ).then((res) => res.json());
        assert.equal(reloaded.profile.avatarUrl, firstUrl);
      },
    );
    if (!live)
      await t.test(
        "R2 failure preserves the current saved picture",
        async () => {
          failWrites = true;
          assert.equal((await upload()).result.status, 503);
          failWrites = false;
          const session = await fetch(`${origin}/auth/me`, { headers }).then(
            (res) => res.json(),
          );
          assert.equal(session.avatarUrl, firstUrl);
        },
      );
    await t.test(
      "replacement persists and makes the old URL inaccessible",
      async () => {
        const { result, data } = await upload();
        assert.equal(result.status, 200);
        assert.notEqual(data.avatarUrl, firstUrl);
        assert.equal((await fetch(`${origin}${firstUrl}`)).status, 404);
        assert.equal((await fetch(`${origin}${data.avatarUrl}`)).status, 200);
        assert.equal(
          (await fetch(`${origin}/api/avatars/not-a-key.png`)).status,
          404,
        );
      },
    );
    await t.test("recent pictures: list, access, switch and remove", async () => {
      const json = { ...headers, "Content-Type": "application/json" };
      const recent = () =>
        fetch(`${origin}/api/avatars/recent`, { headers }).then((res) =>
          res.json(),
        );
      const session = () =>
        fetch(`${origin}/auth/me`, { headers }).then((res) => res.json());
      const current = (await session()).avatarUrl;
      const before = (await recent()).avatars;
      assert.ok(before.length >= 1);
      assert.ok(before.every((item) => item.avatarUrl !== current));
      assert.equal(
        (await fetch(`${origin}/api/avatars/recent`)).status,
        401,
      );
      const target = before[0];
      assert.match(target.id, /^[a-f0-9-]{36}\.(avif|png)$/);
      assert.equal(target.avatarUrl, `/api/avatars/${target.id}`);
      assert.equal(
        (await fetch(`${origin}${target.avatarUrl}`)).status,
        404,
      );
      const owned = await fetch(`${origin}${target.avatarUrl}`, { headers });
      assert.equal(owned.status, 200);
      assert.match(owned.headers.get("cache-control"), /^private/);
      assert.equal(
        (
          await fetch(`${origin}/api/avatars/recent/${target.id}`, {
            method: "POST",
            headers: { ...json, Origin: "https://other.invalid" },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/avatars/recent/${randomUUID()}.avif`, {
            method: "POST",
            headers: json,
          })
        ).status,
        404,
      );
      const switched = await fetch(
        `${origin}/api/avatars/recent/${target.id}`,
        { method: "POST", headers: json },
      );
      assert.equal(switched.status, 200);
      assert.equal((await switched.json()).avatarUrl, target.avatarUrl);
      assert.equal((await session()).avatarUrl, target.avatarUrl);
      assert.equal(
        (await fetch(`${origin}${target.avatarUrl}`)).status,
        200,
      );
      const after = (await recent()).avatars;
      assert.equal(after.length, before.length);
      assert.ok(after.some((item) => item.avatarUrl === current));
      assert.ok(after.every((item) => item.avatarUrl !== target.avatarUrl));
      assert.equal(
        (
          await fetch(`${origin}/api/avatars/recent/${target.id}`, {
            method: "DELETE",
            headers,
          })
        ).status,
        409,
      );
      const victim = after[0];
      const removed = await fetch(
        `${origin}/api/avatars/recent/${victim.id}`,
        { method: "DELETE", headers },
      );
      assert.equal(removed.status, 204);
      await assertObjectDeleted(victim.avatarUrl.replace("/api/", ""));
      assert.equal(
        (await fetch(`${origin}${victim.avatarUrl}`, { headers })).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/avatars/recent/${victim.id}`, {
            method: "DELETE",
            headers,
          })
        ).status,
        404,
      );
      assert.ok(
        (await recent()).avatars.every((item) => item.id !== victim.id),
      );
      const keys = [];
      for (let index = 0; index < 8; index++) {
        const { result, data } = await upload();
        assert.equal(result.status, 200);
        keys.push(data.avatarUrl.replace("/api/", ""));
      }
      const listed = (await recent()).avatars;
      assert.equal(listed.length, 5);
      assert.deepEqual(
        listed.map((item) => `avatars/${item.id}`),
        keys.slice(2, 7).reverse(),
      );
      const {
        rows: [{ count }],
      } = await pool.query(
        "SELECT count(*)::int FROM avatar_history WHERE user_id = $1",
        [alice.id],
      );
      assert.equal(count, 6);
      for (const key of keys.slice(0, 2))
        await assertObjectDeleted(key);
      if (!live) {
        for (const key of keys.slice(2)) assert.ok(objects.has(key));
        const { sweepUnusedMedia } = await import("../src/storage/media-sweep.ts");
        await sweepUnusedMedia(true);
        const { flushMediaDeletions } = await import("../src/storage/media-lifecycle.ts");
        await flushMediaDeletions();
        for (const key of keys.slice(2)) assert.ok(objects.has(key));
      }
    });
    await t.test(
      "banner still image, animation, profile persistence, replacement, and removal",
      async () => {
        async function uploadBanner(body, type) {
          const response = await fetch(
            `${origin}/api/banners/me?crop=${encodeURIComponent(JSON.stringify({ x: 0.1, y: 0.2, width: 0.8, height: 0.3 }))}`,
            {
              method: "PUT",
              headers: { ...headers, "Content-Type": type },
              body,
            },
          );
          const data = await response.json();
          if (data.bannerUrl)
            uploaded.push(data.bannerUrl.replace("/api/", ""));
          return { response, data };
        }
        assert.equal(
          (await uploadBanner(Buffer.from("invalid"), "image/gif")).response
            .status,
          400,
        );
        const scansBeforeStill = scanCount;
        const still = await uploadBanner(picture, "image/png");
        assert.equal(still.response.status, 200);
        assert.equal(scanCount, scansBeforeStill + 1);
        assert.match(still.data.bannerUrl, /\.avif$/);
        const stillResponse = await fetch(`${origin}${still.data.bannerUrl}`);
        const stillBody = Buffer.from(await stillResponse.arrayBuffer());
        assert.ok(stillBody.length < picture.length);
        const stillMetadata = await sharp(stillBody).metadata();
        assert.equal(stillMetadata.width, 800);
        assert.equal(stillMetadata.height, 600);
        const gif = await readFile(
          new URL("./fixtures/banner.gif", import.meta.url),
        );
        const singleFrameGif = await sharp(gif, { pages: 1 }).gif().toBuffer();
        rejectScan = scanCount + 1;
        const rejected = await uploadBanner(singleFrameGif, "image/gif");
        assert.equal(rejected.response.status, 422);
        assert.equal(scanCount, rejectScan);
        assert.equal((await fetch(`${origin}${still.data.bannerUrl}`)).status, 200);

        const scansBeforeAnimation = scanCount;
        scannerUnavailable = true;
        const animated = await uploadBanner(gif, "image/gif").finally(() => {
          scannerUnavailable = false;
        });
        assert.equal(animated.response.status, 200);
        assert.match(animated.data.bannerUrl, /\.gif$/);
        const response = await fetch(`${origin}${animated.data.bannerUrl}`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "image/gif");
        const metadata = await sharp(
          Buffer.from(await response.arrayBuffer()),
          { animated: true },
        ).metadata();
        assert.equal(metadata.width, 450);
        assert.equal(metadata.pageHeight, 150);
        assert.equal(metadata.pages, 24);
        assert.equal(scanCount, scansBeforeAnimation);
        const profile = await fetch(`${origin}/api/profiles/avatar_alice`).then(
          (res) => res.json(),
        );
        assert.equal(profile.profile.bannerUrl, animated.data.bannerUrl);
        assert.deepEqual(profile.profile.bannerCrop, {
          x: 0.1,
          y: 0.2,
          width: 0.8,
          height: 0.3,
        });
        assert.equal(
          (await fetch(`${origin}${still.data.bannerUrl}`)).status,
          404,
        );
        const removed = await fetch(`${origin}/api/banners/me`, {
          method: "DELETE",
          headers,
        });
        assert.equal(removed.status, 204);
        await assertObjectDeleted(animated.data.bannerUrl.replace("/api/", ""));
        await assertObjectDeleted(still.data.bannerUrl.replace("/api/", ""));
        assert.equal(
          (await fetch(`${origin}${animated.data.bannerUrl}`)).status,
          404,
        );
        const reloaded = await fetch(
          `${origin}/api/profiles/avatar_alice`,
        ).then((res) => res.json());
        assert.equal(reloaded.profile.bannerUrl, null);
      },
    );
    await t.test(
      "KLIPY selection saves the external URL without uploading to R2",
      async () => {
        const external = "https://static.klipy.com/test/banner.webp";
        const payload = Buffer.from(
          JSON.stringify({
            url: external,
            userId: alice.id,
            expires: Date.now() + 60000,
          }),
        ).toString("base64url");
        const signed = createHmac("sha256", env.KLIPY_API_KEY)
          .update(payload)
          .digest("base64url");
        const previousCount = objects.size;
        const response = await fetch(`${origin}/api/banners/gifs`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            token: `${payload}.${signed}`,
            crop: { x: 0, y: 0.2, width: 1, height: 0.5 },
          }),
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).bannerUrl, external);
        const profile = await fetch(`${origin}/api/profiles/avatar_alice`).then(
          (res) => res.json(),
        );
        assert.equal(profile.profile.bannerUrl, external);
        const {
          rows: [saved],
        } = await pool.query(
          "SELECT banner_key, banner_external_url FROM users WHERE id = $1",
          [alice.id],
        );
        assert.equal(saved.banner_key, null);
        assert.equal(saved.banner_external_url, external);
        assert.deepEqual(profile.profile.bannerCrop, {
          x: 0,
          y: 0.2,
          width: 1,
          height: 0.5,
        });
        assert.equal(objects.size, previousCount);
        const invalid = await fetch(`${origin}/api/banners/gifs`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ token: `${payload}.invalid` }),
        });
        assert.equal(invalid.status, 400);
      },
    );
    if (!live)
      await t.test(
        "automatic media deletion retries, active-object protection, and concurrent replacement",
        async () => {
          const { flushMediaDeletions, stageMediaUpload, replaceProfileMedia } =
            await import("../src/storage/media-lifecycle.ts");
          const old = (await upload()).data.avatarUrl.replace("/api/", "");
          assert.ok(objects.has(old));
          const replacement = await upload();
          assert.equal(replacement.result.status, 200);
          assert.ok(objects.has(old));
          failDeletes = true;
          const dropped = await fetch(
            `${origin}/api/${old.replace("avatars/", "avatars/recent/")}`,
            { method: "DELETE", headers },
          );
          assert.equal(dropped.status, 204);
          assert.ok(objects.has(old));
          const {
            rows: [queued],
          } = await pool.query(
            "SELECT attempts FROM media_deletions WHERE key = $1",
            [old],
          );
          assert.equal(queued.attempts, 1);
          failDeletes = false;
          await pool.query(
            "UPDATE media_deletions SET available_at = now() - interval '1 second' WHERE key = $1",
            [old],
          );
          await flushMediaDeletions();
          assert.equal(objects.has(old), false);
          assert.equal(
            (
              await pool.query(
                "SELECT key FROM media_deletions WHERE key = $1",
                [old],
              )
            ).rowCount,
            0,
          );
          const current = replacement.data.avatarUrl.replace("/api/", "");
          await pool.query("INSERT INTO media_deletions (key) VALUES ($1)", [
            current,
          ]);
          await flushMediaDeletions();
          assert.ok(objects.has(current));
          const orphan = `avatars/${randomUUID()}.avif`;
          await stageMediaUpload(
            orphan,
            await sharp(picture).avif().toBuffer(),
          );
          assert.equal(
            (
              await pool.query(
                "SELECT key FROM media_deletions WHERE key = $1",
                [orphan],
              )
            ).rowCount,
            1,
          );
          await assert.rejects(
            replaceProfileMedia(randomUUID(), { kind: "avatar", key: orphan }),
          );
          assert.equal(objects.has(orphan), false);
          const uploads = await Promise.all([upload(), upload()]);
          assert.ok(uploads.every((item) => item.result.status === 200));
          const {
            rows: [saved],
          } = await pool.query("SELECT avatar_key FROM users WHERE id = $1", [
            alice.id,
          ]);
          for (const item of uploads)
            assert.ok(objects.has(item.data.avatarUrl.replace("/api/", "")));
          const {
            rows: [{ kept }],
          } = await pool.query(
            "SELECT count(*)::int AS kept FROM avatar_history WHERE key = $1",
            [current],
          );
          assert.equal(objects.has(current), kept === 1);
          const stale = `banners/${randomUUID()}.gif`;
          objects.set(stale, picture);
          const { sweepUnusedMedia } =
            await import("../src/storage/media-sweep.ts");
          assert.ok((await sweepUnusedMedia(true)) > 0);
          await flushMediaDeletions();
          assert.equal(objects.has(stale), false);
          assert.ok(objects.has(saved.avatar_key));
        },
      );
    await t.test("admins replace another user's profile media through the shared upload path", async () => {
      const crop = { x: 0, y: 0.25, width: 1, height: 0.5 };
      const uploadForBob = (kind, requestOrigin = env.ADMIN_ORIGIN, body = picture) => {
        const query = kind === "banner" ? "?" + new URLSearchParams({ crop: JSON.stringify(crop) }) : "";
        return fetch(`${origin}/api/admin/users/${bob.id}/profile/${kind}${query}`, {
          method: "PUT",
          headers: { ...headers, Origin: requestOrigin },
          body,
        });
      };

      await pool.query("UPDATE users SET role = 'moderator' WHERE id = $1", [alice.id]);
      assert.equal((await uploadForBob("avatar")).status, 403);
      await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [alice.id]);
      assert.equal((await uploadForBob("avatar", "https://wrong.example.test")).status, 403);

      const profileResponse = await fetch(`${origin}/api/admin/user/${alice.id}`, { headers });
      assert.equal(profileResponse.status, 200);
      const actorProfile = await profileResponse.json();
      const media = {};
      for (const kind of ["avatar", "banner"]) {
        const response = await uploadForBob(kind);
        assert.equal(response.status, 200);
        const { url } = await response.json();
        uploaded.push(url.slice("/api/".length));
        assert.match(url, new RegExp(`^/api/${kind}s/`));
        const served = await fetch(origin + url);
        assert.equal(served.status, 200);
        assert.match(served.headers.get("content-type"), /^image\//);
        await served.arrayBuffer();
        media[kind] = url;

        rejectScan = scanCount + 1;
        const rejected = await uploadForBob(kind);
        assert.equal(rejected.status, 422);
        assert.deepEqual(await rejected.json(), { error: "post_image_rejected" });

        scannerUnavailable = true;
        try {
          const unavailable = await uploadForBob(kind);
          assert.equal(unavailable.status, 503);
          assert.deepEqual(await unavailable.json(), { error: "post_image_check_unavailable" });
        } finally {
          scannerUnavailable = false;
        }
      }

      assert.equal((await uploadForBob("avatar", env.ADMIN_ORIGIN, Buffer.from("invalid"))).status, 400);
      const targetResponse = await fetch(`${origin}/api/admin/user/${bob.id}`, { headers });
      assert.equal(targetResponse.status, 200);
      const target = await targetResponse.json();
      assert.equal(target.avatarUrl, media.avatar);
      assert.equal(target.bannerUrl, media.banner);
      assert.deepEqual(target.bannerCrop, crop);
      const actor = await (await fetch(`${origin}/api/admin/user/${alice.id}`, { headers })).json();
      assert.equal(actor.avatarUrl, actorProfile.avatarUrl);
      assert.equal(actor.bannerUrl, actorProfile.bannerUrl);
      const { rows: flags } = await pool.query("SELECT uploader_id FROM post_image_flags ORDER BY created_at");
      assert.deepEqual(flags.map(({ uploader_id }) => uploader_id), [alice.id, alice.id, alice.id]);
      const { rows: activity } = await pool.query(
        "SELECT action FROM moderation_activity WHERE actor_id = $1 AND target_id = $2 ORDER BY action",
        [alice.id, bob.id],
      );
      assert.deepEqual(activity.map(({ action }) => action), ["replaceAvatar", "replaceBanner"]);
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (live) {
      const { rows: flags } = await pool.query("SELECT object_key FROM post_image_flags WHERE object_key IS NOT NULL");
      uploaded.push(...flags.map(({ object_key }) => object_key));
      for (const key of uploaded)
        await avatarStorage.client.send(
          new DeleteObjectCommand({ Bucket: avatarStorage.bucket, Key: key }),
        );
    }
    avatarStorage.client.destroy();
    await pool.end();
    await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});
