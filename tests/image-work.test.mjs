import assert from "node:assert/strict";
import test from "node:test";
import { config } from "dotenv";

config({ path: new URL("../.env", import.meta.url), quiet: true });

const { ImageWorkGate } = await import("../src/storage/image-work-gate.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function job(log, name, ms = 20) {
  return async () => {
    log.push(`start ${name}`);
    await sleep(ms);
    log.push(`end ${name}`);
    return name;
  };
}

test("never runs more jobs at once than allowed, in arrival order", async () => {
  const gate = new ImageWorkGate(1, 8, 5_000);
  const log = [];
  const results = await Promise.all(["a", "b", "c", "d"].map((name) => gate.run(job(log, name))));
  assert.deepEqual(results, ["a", "b", "c", "d"]);
  assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c", "start d", "end d"]);
  assert.deepEqual(gate.stats(), { active: 0, queued: 0, completed: 4, rejected: 0 });
});

test("runs up to the limit in parallel", async () => {
  const gate = new ImageWorkGate(2, 8, 5_000);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 6 }, () => gate.run(async () => {
    peak = Math.max(peak, ++active);
    await sleep(15);
    active--;
  })));
  assert.equal(peak, 2);
});

test("rejects with 429 post_image_busy when the queue is full", async () => {
  const gate = new ImageWorkGate(1, 1, 5_000);
  const running = gate.run(() => sleep(60));
  const queued = gate.run(() => sleep(1));
  await assert.rejects(gate.run(() => sleep(1)), (error) => error.status === 429 && error.message === "post_image_busy");
  assert.equal(gate.stats().rejected, 1);
  await Promise.all([running, queued]);
  assert.deepEqual(gate.stats(), { active: 0, queued: 0, completed: 2, rejected: 1 });
});

test("rejects a job that waits longer than the limit and keeps the queue consistent", async () => {
  const gate = new ImageWorkGate(1, 4, 30);
  const slow = gate.run(() => sleep(120));
  await assert.rejects(gate.run(() => sleep(1)), (error) => error.status === 429);
  assert.equal(gate.stats().queued, 0);
  await slow;
  assert.equal(await gate.run(async () => "after"), "after");
  assert.deepEqual(gate.stats(), { active: 0, queued: 0, completed: 2, rejected: 1 });
});

test("a failing job frees its slot for the next one", async () => {
  const gate = new ImageWorkGate(1, 4, 5_000);
  const failing = gate.run(async () => { await sleep(5); throw new Error("decode failed"); });
  const next = gate.run(async () => "ok");
  await assert.rejects(failing, /decode failed/);
  assert.equal(await next, "ok");
  assert.equal(gate.stats().active, 0);
});
