import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import pg from "pg";

test("migration runner and locked media work with a one-connection pool", { timeout: 30000 }, async (t) => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_lock_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  let pool;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const env = { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href, DATABASE_POOL_MAX: "1" };
    const run = () => promisify(execFile)(process.execPath, ["src/db/migrate.ts"], {
      cwd: new URL("..", import.meta.url), env, timeout: 15000,
    });
    await Promise.all([run(), run()]);
    await run();
    Object.assign(process.env, env, {
      NODE_ENV: "test", R2_ACCOUNT_ID: "a".repeat(32), R2_BUCKET: "lock-tests",
      R2_ACCESS_KEY_ID: "test", R2_SECRET_ACCESS_KEY: "test",
    });
    const database = await import("../src/db/index.ts");
    pool = database.pool;
    const { avatarStorage } = await import("../src/storage/r2.ts");
    let deleted = 0;
    t.mock.method(avatarStorage.client, "send", async (command) => {
      if (command.constructor.name === "DeleteObjectCommand") {
        deleted++;
        return {};
      }
      return { Contents: command.input.Prefix === "avatars/" ? [{
        Key: `avatars/${randomUUID()}.png`, LastModified: new Date(0),
      }] : [] };
    });
    const { sweepUnusedMedia } = await import("../src/storage/media-sweep.ts");
    const { flushMediaDeletions } = await import("../src/storage/media-lifecycle.ts");
    const lock = await pool.connect();
    try {
      await lock.query("SELECT pg_advisory_lock($1)", [7_001_001]);
      const db = database.createDatabase(lock);
      assert.equal(await sweepUnusedMedia(true, db), 1);
      await flushMediaDeletions(undefined, db);
      assert.equal(deleted, 1);
      const { mediaDeletions } = await import("../src/db/schema.ts");
      assert.deepEqual(await db.select().from(mediaDeletions), []);
      assert.equal(pool.totalCount, 1);
      assert.equal(pool.waitingCount, 0);
    } finally {
      lock.release(true);
    }
  } finally {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
