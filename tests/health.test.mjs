import assert from "node:assert/strict";
import { once } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://health:health@localhost/health";
process.env.KLIPY_API_KEY = "health-test-key";
process.env.R2_ACCOUNT_ID = "a".repeat(32);
process.env.R2_BUCKET = "health-tests";
process.env.R2_ACCESS_KEY_ID = "test";
process.env.R2_SECRET_ACCESS_KEY = "test";

const { app } = await import("../src/app.ts");
const { pool } = await import("../src/db/index.ts");
const { avatarStorage } = await import("../src/storage/r2.ts");
const { env } = await import("../src/config.ts");
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });

await test("health routes probe dependencies, share work, and recover after expiry", async (t) => {
  let dbCalls = 0, r2Calls = 0, klipyCalls = 0, cnsCalls = 0;
  let failDatabase = false, rateLimit = false, badKeys = false, failR2 = false;
  let failCns = false, malformedKlipy = false;
  t.mock.method(pool, "query", async (query) => {
    dbCalls++;
    assert.equal(query.text, "SELECT 1");
    assert.equal(query.query_timeout, 2000);
    if (failDatabase) throw new Error("secret connection details");
    return { rows: [{ "?column?": 1 }] };
  });
  t.mock.method(avatarStorage.client, "send", async (command, options) => {
    r2Calls++;
    assert.equal(command.constructor.name, "HeadBucketCommand");
    assert.equal(command.input.Bucket, "health-tests");
    assert.ok(options.abortSignal);
    if (failR2) throw new Error("storage unavailable");
    return {};
  });
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    if (url.hostname === "127.0.0.1") return realFetch(input, options);
    assert.ok(options.signal);
    if (url.hostname === "api.klipy.com") {
      klipyCalls++;
      if (malformedKlipy) return Response.json({ result: false });
      return Response.json({ result: true, data: { data: [] } }, { status: rateLimit ? 429 : 200 });
    }
    cnsCalls++;
    if (failCns) throw new DOMException("Timed out", "TimeoutError");
    if (url.href === env.CNS_DISCOVERY_URL) return Response.json({
      issuer: "cns-auth-v2-staging", token_endpoint: "https://identity.test/token",
      jwks_uri: "https://identity.test/keys",
    });
    assert.equal(url.href, "https://identity.test/keys");
    return Response.json({ keys: badKeys ? [] : [jwk] });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path) => realFetch(base + path);
  try {
    assert.equal((await request("/live")).status, 200);
    assert.equal(dbCalls + r2Calls + klipyCalls + cnsCalls, 0);
    const responses = await Promise.all(Array.from({ length: 5 }, () => request("/health")));
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      assert.equal(body.status, "ok");
      for (const check of Object.values(body.checks)) {
        assert.equal(check.status, "ok");
        assert.ok(Date.parse(check.checkedAt));
        assert.equal(typeof check.latencyMs, "number");
      }
    }
    assert.deepEqual([dbCalls, r2Calls, klipyCalls, cnsCalls], [1, 1, 1, 2]);
    assert.equal((await request("/ready")).status, 200);
    const originalNow = Date.now;
    let offset = 301_000;
    t.mock.method(Date, "now", () => originalNow() + offset);
    failDatabase = true;
    rateLimit = true;
    badKeys = true;
    const failed = await request("/health");
    assert.equal(failed.status, 503);
    const body = await failed.json();
    assert.equal(body.checks.database.status, "unavailable");
    assert.equal(body.checks.klipy.status, "rate_limited");
    assert.equal(body.checks.cns.status, "unavailable");
    assert.ok(!JSON.stringify(body).includes("secret"));
    assert.equal((await request("/ready")).status, 503);
    offset += 16_000;
    failDatabase = false;
    const degraded = await request("/health");
    assert.equal(degraded.status, 200);
    assert.equal((await degraded.json()).status, "degraded");
    offset += 301_000;
    rateLimit = false;
    badKeys = false;
    failR2 = true;
    failCns = true;
    malformedKlipy = true;
    const outages = await (await request("/health")).json();
    assert.equal(outages.status, "degraded");
    for (const name of ["r2", "klipy", "cns"]) {
      assert.equal(outages.checks[name].status, "unavailable");
    }
    assert.equal((await request("/live")).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
