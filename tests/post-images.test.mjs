import assert from "node:assert/strict";
import { fakeR2 } from "./helpers/fake-r2.mjs";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import sharp from "sharp";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("screens and publishes image drafts, then moderates or cascades their removal", async (t) => {
  const connection = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_image_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  const appOrigin = "http://localhost:3000";
  const adminOrigin = "http://localhost:3200";
  const upstream = process.env.POST_IMAGE_TEST_SCANNER_URL;
  let verdict = "allow";
  let scanCount = 0;
  let scanned;
  const service = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/detect");
      const type = req.headers["content-type"];
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const form = await new Response(body, { headers: { "Content-Type": type } }).formData();
      const file = form.get("file");
      assert.equal(file.type, "image/avif");
      assert.equal(file.name, "image.avif");
      scanned = Buffer.from(await file.arrayBuffer());
      assert.equal(scanned.toString("ascii", 4, 12), "ftypavif");
      scanCount++;
      if (verdict === "offline") {
        res.writeHead(503).end();
      } else if (upstream && verdict === "allow") {
        const response = await fetch(new URL(req.url, upstream), {
          method: "POST", headers: { "Content-Type": type }, body,
          signal: AbortSignal.timeout(12_000),
        });
        res.writeHead(response.status, { "Content-Type": "application/json" }).end(await response.text());
      } else {
        res.writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(verdict === "invalid" ? {} : {
            is_nsfw: verdict === "reject", confidence_percentage: 97.5,
          }));
      }
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  }).listen(0, "127.0.0.1");
  await once(service, "listening");
  t.after(() => new Promise((resolve) => service.close(resolve)));
  t.after(() => connection.end());
  await connection.query(`CREATE DATABASE ${name}`);
  Object.assign(process.env, {
    DATABASE_URL: url.href,
    NODE_ENV: "test",
    NSFW_CHECK_URL: `http://127.0.0.1:${service.address().port}`,
    APP_ORIGIN: appOrigin,
    ADMIN_ORIGIN: adminOrigin,
    R2_ACCOUNT_ID: "a".repeat(32),
    R2_BUCKET: "image-flag-tests",
    R2_ACCESS_KEY_ID: "test-access-key",
    R2_SECRET_ACCESS_KEY: "test-secret-key",
  });
  const { db, pool } = await import("../src/db/index.ts");
  let server;
  try {
    const { app } = await import("../src/app.ts");
    const { hash } = await import("../src/auth/secrets.ts");
    const { avatarStorage } = await import("../src/storage/r2.ts");
    const { flushMediaDeletions } = await import("../src/storage/media-lifecycle.ts");
    let failDeletes = false;
    const objects = fakeR2(t, avatarStorage, {
      keys: /^(flagged-images|post-images)\/[0-9a-f-]{36}\.avif$/,
      onPut: (req) => assert.equal(req.headers["content-type"], "image/avif"),
      onDelete: () => { if (failDeletes) throw new Error("Simulated R2 deletion failure"); },
    });
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
    async function createUser(handle, role = "user") {
      const token = randomUUID();
      const { rows: [user] } = await pool.query(
        "INSERT INTO users (handle, role, approved_at) VALUES ($1, $2, now()) RETURNING id", [handle, role],
      );
      const { rows: [identity] } = await pool.query(
        "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', $1, $2) RETURNING id",
        [handle, user.id],
      );
      await pool.query(
        "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
        [hash(token), identity.id],
      );
      return { cookie: `session=${token}`, id: user.id };
    }
    const owner = await createUser("image_owner");
    const other = await createUser("image_other");
    const moderator = await createUser("image_moderator", "moderator");
    const admin = await createUser("image_admin", "admin");
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    function request(path, { user, method = "GET", body, type, filename } = {}) {
      if (path.startsWith("/api/admin/posts/") && method === "DELETE" && body === undefined) body = { ground: { type: "terms", ref: "5.7", facts: "Test decision" } };
      const headers = { Origin: path.startsWith("/api/admin/") ? adminOrigin : appOrigin };
      if (user) headers.Cookie = user.cookie;
      if (body !== undefined) headers["Content-Type"] = type ?? "application/json";
      if (filename) headers["X-Post-Image-Name"] = encodeURIComponent(filename);
      return fetch(base + path, { method, headers, body: type ? body : JSON.stringify(body) });
    }
    const image = await sharp({ create: { width: 128, height: 96, channels: 3, background: "#347768" } }).png().toBuffer();
    const upload = (body = image, user = owner) =>
      request("/api/post-images", { method: "POST", user, body, type: "application/octet-stream", filename: "$RXYK6ZT.png" });
    const publish = (body, user = owner, path = "/api/posts") => request(path, { method: "POST", user, body });
    const draft = async () => {
      const response = await upload();
      assert.equal(response.status, 201, response.ok ? undefined : await response.text());
      return (await response.json()).id;
    };
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    assert.equal((await upload(gif)).status, 400);
    const animation = await readFile(new URL("./fixtures/banner.gif", import.meta.url));
    const animatedWebp = await sharp(animation, { animated: true }).resize({ width: 32 }).webp().toBuffer();
    assert.equal((await upload(animatedWebp)).status, 400);
    assert.equal((await upload(Buffer.from("<svg/>"))).status, 400);
    assert.equal((await upload(Buffer.alloc(8 * 1024 * 1024 + 1))).status, 413);
    assert.equal(scanCount, 0);

    let rejectedBytes;
    for (const [mode, status] of [["reject", 422], ["invalid", 503], ["offline", 503]]) {
      verdict = mode;
      const response = await upload();
      assert.equal(response.status, status, mode);
      if (mode === "reject") {
        assert.deepEqual(await response.json(), { error: "post_image_rejected" });
        rejectedBytes = scanned;
      }
    }
    assert.equal((await pool.query("SELECT id FROM post_images")).rowCount, 0);
    assert.equal((await request("/api/admin/flags")).status, 401);
    assert.equal((await request("/api/admin/flags", { user: other })).status, 403);
    const flagPage = await request("/api/admin/flags", { user: moderator });
    assert.equal(flagPage.status, 200);
    assert.match(flagPage.headers.get("cache-control"), /no-store/);
    const { flags, hasNextPage } = await flagPage.json();
    assert.equal(hasNextPage, false);
    assert.equal(flags.length, 1);
    const [flag] = flags;
    const { rows: [storedFlag] } = await pool.query("SELECT object_key, data FROM post_image_flags WHERE id = $1", [flag.id]);
    assert.equal(storedFlag.data, null);
    assert.deepEqual(objects.get(storedFlag.object_key), rejectedBytes);
    assert.deepEqual(flag, {
      id: flag.id, createdAt: flag.createdAt, uploaderId: owner.id,
      handle: "image_owner", filename: "$RXYK6ZT.png", confidence: 97.5,
    });
    const flaggedImage = `/api/admin/flags/${flag.id}/image`;
    assert.equal((await request(flaggedImage, { user: owner })).status, 403);
    assert.equal((await request(`/api/post-images/${flag.id}`, { user: owner })).status, 404);
    assert.equal((await publish({ attachmentIds: [flag.id] })).status, 400);
    const reviewImage = await request(flaggedImage, { user: admin });
    assert.equal(reviewImage.status, 200);
    assert.equal(reviewImage.headers.get("content-type"), "image/avif");
    assert.match(reviewImage.headers.get("cache-control"), /no-store/);
    assert.deepEqual(Buffer.from(await reviewImage.arrayBuffer()), rejectedBytes);
    const removeFlag = (flagId, user) => request(`/api/admin/flags/${flagId}`, { method: "DELETE", user });
    assert.equal((await removeFlag(flag.id, moderator)).status, 403);
    assert.equal((await removeFlag(flag.id, admin)).status, 204);
    assert.equal(objects.has(storedFlag.object_key), false);
    assert.equal((await removeFlag(flag.id, admin)).status, 204);
    const { rows: activities } = await pool.query("SELECT target_id, detail FROM moderation_activity WHERE action = 'removeImageFlag'");
    assert.deepEqual(activities, [{ target_id: owner.id, detail: "$RXYK6ZT.png" }]);
    assert.equal((await request(flaggedImage, { user: admin })).status, 404);
    assert.deepEqual((await (await request("/api/admin/flags", { user: moderator })).json()).flags, []);

    verdict = "reject";
    assert.equal((await upload()).status, 422);
    const { rows: [retryFlag] } = await pool.query("SELECT id, object_key FROM post_image_flags");
    failDeletes = true;
    assert.equal((await removeFlag(retryFlag.id, admin)).status, 204);
    assert.equal(objects.has(retryFlag.object_key), true);
    const retry = await pool.query("UPDATE media_deletions SET available_at = now() WHERE key = $1 RETURNING attempts", [retryFlag.object_key]);
    assert.equal(retry.rows[0].attempts, 1);
    failDeletes = false;
    await flushMediaDeletions(retryFlag.object_key);
    assert.equal(objects.has(retryFlag.object_key), false);

    assert.equal((await upload()).status, 422);
    const { rows: [expired] } = await pool.query("UPDATE post_image_flags SET created_at = now() - interval '8 days' RETURNING id, object_key");
    assert.equal((await request(`/api/admin/flags/${expired.id}/image`, { user: admin })).status, 404);
    assert.deepEqual((await (await request("/api/admin/flags", { user: moderator })).json()).flags, []);
    await pool.query("DELETE FROM post_image_flags WHERE id = $1", [expired.id]);
    await flushMediaDeletions(expired.object_key);
    assert.equal(objects.has(expired.object_key), false);

    const { rows: [legacy] } = await pool.query(
      "INSERT INTO post_image_flags (uploader_id, data) VALUES ($1, $2) RETURNING id", [owner.id, rejectedBytes],
    );
    assert.equal((await request(`/api/admin/flags/${legacy.id}/image`, { user: admin })).status, 200);
    assert.equal((await removeFlag(legacy.id, admin)).status, 204);
    assert.equal((await request(`/api/admin/flags/${legacy.id}/image`, { user: admin })).status, 404);
    verdict = "allow";
    const first = await draft();
    const imagePath = `/api/post-images/${first}`;
    const staffImagePath = `/api/admin/post-images/${first}`;
    assert.equal((await request(imagePath)).status, 404);
    assert.equal((await request(imagePath, { user: other })).status, 404);
    assert.equal((await request(staffImagePath, { user: admin })).status, 404);
    assert.equal((await request(imagePath, { user: owner })).status, 200);
    assert.equal((await publish({ attachmentIds: [first] }, other)).status, 400);
    assert.equal((await publish({ attachmentIds: [first, first] })).status, 400);
    assert.equal((await publish({ attachmentIds: [first, randomUUID()] })).status, 400);
    assert.equal((await request(imagePath)).status, 404);

    const clientId = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await publish({ clientId, attachmentIds: [first] });
      assert.equal(response.status, 201);
      assert.deepEqual((await response.json()).post.imageIds, [first]);
    }
    assert.equal((await publish({ attachmentIds: [first] })).status, 400);
    const { rows: [stored] } = await pool.query("SELECT object_key, data FROM post_images WHERE id = $1", [first]);
    assert.equal(stored.data, null);
    assert.match(stored.object_key, /^post-images\//);
    assert.deepEqual(objects.get(stored.object_key), scanned);
    assert.equal((await pool.query("SELECT key FROM media_deletions WHERE key = $1", [stored.object_key])).rowCount, 0);
    const served = await request(imagePath);
    assert.equal(served.headers.get("content-type"), "image/avif");
    assert.equal(served.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), scanned);
    assert.equal((await request(staffImagePath, { user: moderator })).status, 200);
    assert.equal((await request(staffImagePath, { user: owner })).status, 403);

    const quote = await publish({ content: "A quote", quotedPostId: clientId });
    assert.deepEqual((await quote.json()).post.quote.post.imageIds, [first]);
    const second = await draft();
    const third = await draft();
    const reply = await publish({ content: "Caption", attachmentIds: [third, second] }, owner, `/api/posts/${clientId}/replies`);
    assert.equal(reply.status, 201);
    const { post: replyPost } = await reply.json();
    assert.deepEqual(replyPost.imageIds, [third, second]);
    const attachmentsPath = `/api/admin/posts/${replyPost.id}/attachments/images`;
    const changeImage = (path, user = admin, body = image) => request(path, {
      user, method: "POST", body, type: "application/octet-stream", filename: "admin-edit.png",
    });
    const readImages = async () => (await (await request(`/api/admin/post/${replyPost.id}`, { user: admin })).json()).imageIds;
    const scansBeforeEdit = scanCount;
    assert.equal((await changeImage(attachmentsPath, moderator)).status, 403);
    assert.equal((await changeImage(attachmentsPath, admin, Buffer.from("<svg/>"))).status, 400);
    assert.equal(scanCount, scansBeforeEdit);

    assert.equal((await changeImage(attachmentsPath)).status, 204);
    const addedImages = await readImages();
    const added = addedImages[2];
    assert.deepEqual(addedImages, [third, second, added]);
    assert.ok(added);
    const addedImage = await request(`/api/post-images/${added}`);
    assert.equal(addedImage.headers.get("content-type"), "image/avif");
    assert.deepEqual(Buffer.from(await addedImage.arrayBuffer()), scanned);

    for (const [mode, status] of [["reject", 422], ["offline", 503]]) {
      verdict = mode;
      assert.equal((await changeImage(`${attachmentsPath}/${second}`)).status, status);
      assert.deepEqual(await readImages(), addedImages);
      assert.equal((await request(`/api/post-images/${second}`)).status, 200);
    }
    const { rows: [adminFlag] } = await pool.query(
      "SELECT uploader_id, filename FROM post_image_flags WHERE filename = 'admin-edit.png'",
    );
    assert.deepEqual(adminFlag, { uploader_id: admin.id, filename: "admin-edit.png" });

    verdict = "allow";
    const additions = await Promise.all([changeImage(attachmentsPath), changeImage(attachmentsPath)]);
    assert.deepEqual(additions.map((response) => response.status).sort(), [204, 409]);
    const full = await readImages();
    assert.equal(full.length, 4);
    assert.equal((await changeImage(`${attachmentsPath}/${first}`)).status, 404);
    assert.equal((await changeImage(`${attachmentsPath}/${second}`)).status, 204);
    const updated = await readImages();
    const replacement = updated[1];
    assert.ok(replacement);
    assert.notEqual(replacement, second);
    assert.deepEqual(updated, [third, replacement, added, full[3]]);
    assert.equal((await request(`/api/post-images/${second}`)).status, 404);
    assert.deepEqual(Buffer.from(await (await request(`/api/post-images/${replacement}`)).arrayBuffer()), scanned);

    const removeImage = (path, user = admin) => request(path, { user, method: "DELETE" });
    assert.equal((await removeImage(`${attachmentsPath}/${replacement}`, moderator)).status, 403);
    assert.equal((await removeImage(`${attachmentsPath}/${replacement}`)).status, 204);
    assert.equal((await removeImage(`${attachmentsPath}/${replacement}`)).status, 204);
    assert.equal((await request(`/api/post-images/${replacement}`)).status, 404);
    assert.deepEqual(await readImages(), [third, added, full[3]]);
    assert.equal((await removeImage(`/api/admin/posts/${clientId}/attachments/images/${first}`)).status, 409);
    const { rows: imageActions } = await pool.query(
      "SELECT action, count(*)::integer AS count FROM moderation_activity WHERE target_id = $1 GROUP BY action ORDER BY action",
      [replyPost.id],
    );
    assert.deepEqual(imageActions, [
      { action: "addImage", count: 2 }, { action: "removeImage", count: 1 }, { action: "replaceImage", count: 1 },
    ]);

    const removeImages = (id, user) => request(`/api/admin/posts/${id}/attachments/images`, { user, method: "DELETE" });
    assert.equal((await removeImages(clientId, admin)).status, 409);
    assert.equal((await removeImages(replyPost.id, moderator)).status, 403);
    assert.equal((await removeImages(replyPost.id, admin)).status, 204);
    assert.equal((await request(`/api/post-images/${second}`)).status, 404);
    assert.equal((await request(`/api/post-images/${third}`)).status, 404);
    const detail = await request(`/api/admin/post/${replyPost.id}`, { user: admin });
    assert.deepEqual((await detail.json()).imageIds, []);
    const { rows: [legacyImage] } = await pool.query(
      "INSERT INTO post_images (uploader_id, post_id, data, expires_at) VALUES ($1, $2, $3, now()) RETURNING id",
      [owner.id, replyPost.id, scanned],
    );
    assert.deepEqual(Buffer.from(await (await request(`/api/post-images/${legacyImage.id}`)).arrayBuffer()), scanned);
    assert.equal((await request(`/api/posts/${clientId}`, { method: "DELETE", user: owner })).status, 204);
    assert.equal((await request(imagePath)).status, 404);

    // Removed rows queue their objects; only images that still exist stay in R2.
    await pool.query("UPDATE media_deletions SET available_at = now()");
    await flushMediaDeletions();
    const { rows: remaining } = await pool.query("SELECT object_key FROM post_images WHERE object_key IS NOT NULL");
    assert.deepEqual(
      [...objects.keys()].filter((key) => key.startsWith("post-images/")).sort(),
      remaining.map(({ object_key }) => object_key).sort(),
    );
    assert.equal(objects.has(stored.object_key), false);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await connection.query(`DROP DATABASE ${name}`);
  }
});
