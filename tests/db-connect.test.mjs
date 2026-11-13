import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { connectWithRetry } from "../src/db/connect.ts";

test("retries failed connections every five seconds and releases the client", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const connected = t.mock.method(console, "info", () => {});
  let attempts = 0;
  let released = false;
  const pending = connectWithRetry({
    async connect() {
      attempts++;
      if (attempts < 3) throw new Error("unavailable");
      return { release() { released = true; } };
    },
  });
  await setImmediate();
  t.mock.timers.tick(4999);
  await setImmediate();
  assert.equal(attempts, 1);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(attempts, 2);
  t.mock.timers.tick(5000);
  await pending;
  assert.equal(attempts, 3);
  assert.equal(released, true);
  assert.equal(connected.mock.callCount(), 1);
  assert.deepEqual(connected.mock.calls[0].arguments, [
    { event: "database_connected", attempt: 3 },
  ]);
});

test("keeps retrying beyond twelve failed attempts until connected", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  const pending = connectWithRetry({
    async connect() {
      attempts++;
      if (attempts <= 15) throw new Error("unavailable");
      return { release() {} };
    },
  });
  for (let i = 0; i < 15; i++) {
    await setImmediate();
    t.mock.timers.tick(5000);
  }
  await pending;
  assert.equal(attempts, 16);
});
