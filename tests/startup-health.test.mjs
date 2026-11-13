import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { createServer } from "node:net";

test("HTTP probes stay available while startup retries the database", { timeout: 20000 }, async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ["src/app.ts"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "test", PORT: String(port),
      DATABASE_URL: "postgres://test:test@127.0.0.1:1/test",
      R2_ACCOUNT_ID: "", R2_BUCKET: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      child.once("exit", (code) => reject(new Error(`API exited early: ${code}`)));
      child.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("API listening")) resolve();
      });
    });
    const request = (path) => fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal((await request("/live")).status, 200);
    const ready = await request("/ready");
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).checks.database.status, "unavailable");
    assert.equal((await request("/api/posts")).status, 503);
    assert.equal((await request("/live")).status, 200);
  } finally {
    child.kill();
    await once(child, "exit");
  }
});
