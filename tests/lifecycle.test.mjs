import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";

process.env.DATABASE_URL = "postgres://test:test@localhost/test";
process.env.NODE_ENV = "test";
const { createHealthRouter, beginDraining } = await import("../src/health.ts");
const { pool } = await import("../src/db/index.ts");

test("startup readiness and draining compose, including an in-flight readiness probe", async (t) => {
  let startupReady = false;
  let completeProbe;
  t.mock.method(pool, "query", () => new Promise((resolve) => { completeProbe = resolve; }));
  const app = express();
  app.use(createHealthRouter(() => startupReady));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const request = (path) => fetch(`http://127.0.0.1:${server.address().port}${path}`);
  try {
    const pending = request("/ready");
    while (!completeProbe) await new Promise((resolve) => setTimeout(resolve, 5));
    completeProbe({ rows: [] });
    assert.equal((await pending).status, 503);
    startupReady = true;
    assert.equal((await request("/ready")).status, 200);
    // Expire the cache so shutdown races with a real pending probe.
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 16_000);
    completeProbe = undefined;
    const drainingProbe = request("/ready");
    while (!completeProbe) await new Promise((resolve) => setTimeout(resolve, 5));
    beginDraining();
    completeProbe({ rows: [] });
    assert.equal((await drainingProbe).status, 503);
    assert.equal((await request("/ready")).status, 503);
    assert.equal((await request("/live")).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
