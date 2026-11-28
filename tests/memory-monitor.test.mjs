import assert from "node:assert/strict";
import test from "node:test";
import { config } from "dotenv";

config({ path: new URL("../.env", import.meta.url), quiet: true });

const { containerMemoryLimit } = await import("../src/memory-monitor.ts");

test("reads the container memory limit from cgroup v2 and v1, ignoring unlimited", () => {
  const files = (map) => (path) => { if (path in map) return map[path]; throw new Error("ENOENT"); };
  assert.equal(containerMemoryLimit(files({ "/sys/fs/cgroup/memory.max": "536870912\n" })), 536870912);
  assert.equal(containerMemoryLimit(files({ "/sys/fs/cgroup/memory.max": "max\n" })), null);
  assert.equal(containerMemoryLimit(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "268435456" })), 268435456);
  assert.equal(containerMemoryLimit(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712" })), null);
  assert.equal(containerMemoryLimit(files({})), null);
});
