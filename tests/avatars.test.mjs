import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import test from "node:test";
import { config } from "dotenv";
import pg from "pg";
import sharp from "sharp";
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
process.env.KLIPY_API_KEY = "test-klipy-key";
process.env.SESSION_ENCRYPTION_KEY = "ab".repeat(32);
if (!live) {
  process.env.R2_ACCOUNT_ID = "a".repeat(32);
  process.env.R2_BUCKET = "avatar-tests";
  process.env.R2_ACCESS_KEY_ID = "test-access-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
}

await test("avatar upload, persistence, access, and failures", async (t) => {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const { app } = await import("../src/app.ts");
  const { db, pool } = await import("../src/db/index.ts");
  const { env } = await import("../src/config.ts");
  const { r2ConfigSchema } = await import("../src/storage/r2-config.ts");
  const { avatarStorage } = await import("../src/storage/r2.ts");
  const { hash } = await import("../src/auth/secrets.ts");
  let server;
  const uploaded = [];
  const objects = new Map();
  let failWrites = false;
  let failDeletes = false;
  if (!live) {
    // Only replace the external storage transport. HTTP, authentication, PostgreSQL,
    // image decoding, AWS request serialization, and all response paths are real.
    t.mock.method(
      avatarStorage.client.config.requestHandler,
      "handle",
      async (request) => {
        assert.match(request.hostname, /\.eu\.r2\.cloudflarestorage\.com$/);
        if (request.query?.["list-type"] === "2") {
          const prefix = request.query.prefix;
          const xml = `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>${[
            ...objects.keys(),
          ]
            .filter((key) => key.startsWith(prefix))
            .map(
              (key) =>
                `<Contents><Key>${key}</Key><LastModified>2020-01-01T00:00:00.000Z</LastModified></Contents>`,
            )
            .join("")}</ListBucketResult>`;
          return {
            response: {
              statusCode: 200,
              headers: { "content-type": "application/xml" },
              body: Readable.from([Buffer.from(xml)]),
            },
          };
        }
        const key = decodeURIComponent(
          request.path.match(/(?:avatars|banners)\/.+$/)[0],
        );
        if (request.method === "PUT") {
          if (failWrites) throw new Error("Simulated R2 outage");
          assert.equal(
            request.headers["content-type"],
            key.endsWith(".gif")
              ? "image/gif"
              : key.endsWith(".png")
                ? "image/png"
                : key.endsWith(".webp")
                  ? "image/webp"
                  : "image/avif",
          );
          assert.equal(request.headers["cache-control"], "no-store");
          objects.set(key, Buffer.from(request.body));
        }
        if (request.method === "DELETE") {
          if (failDeletes) throw new Error("Simulated deletion outage");
          objects.delete(key);
        }
        const body =
          request.method === "GET" ? objects.get(key) : Buffer.alloc(0);
        return {
          response: {
            statusCode: 200,
            headers: {
              "content-type": key.endsWith(".avif")
                ? "image/avif"
                : "image/png",
            },
            body: Readable.from([body]),
          },
        };
      },
    );
  }
  try {
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    const {
      rows: [alice],
    } = await pool.query(
      "INSERT INTO users (handle, display_name) VALUES ('avatar_alice', 'Alice') RETURNING id",
    );
    const {
      rows: [bob],
    } = await pool.query(
      "INSERT INTO users (handle, display_name) VALUES ('avatar_bob', 'Bob') RETURNING id",
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
        await assertObjectDeleted(firstUrl.replace("/api/", ""));
        assert.equal((await fetch(`${origin}${data.avatarUrl}`)).status, 200);
        assert.equal(
          (await fetch(`${origin}/api/avatars/not-a-key.png`)).status,
          404,
        );
      },
    );
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
        const still = await uploadBanner(picture, "image/png");
        assert.equal(still.response.status, 200);
        assert.match(still.data.bannerUrl, /\.png$/);
        assert.deepEqual(
          Buffer.from(
            await fetch(`${origin}${still.data.bannerUrl}`).then((res) =>
              res.arrayBuffer(),
            ),
          ),
          picture,
        );
        const gif = await readFile(
          new URL("./fixtures/banner.gif", import.meta.url),
        );
        const animated = await uploadBanner(gif, "image/gif");
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
          failDeletes = true;
          const replacement = await upload();
          assert.equal(replacement.result.status, 200);
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
          for (const item of uploads) {
            const key = item.data.avatarUrl.replace("/api/", "");
            assert.equal(objects.has(key), key === saved.avatar_key);
          }
          assert.equal(objects.has(current), false);
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
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (live) {
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
