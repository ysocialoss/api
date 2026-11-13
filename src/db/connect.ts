import timers from "node:timers/promises";
import type pg from "pg";

export async function connectWithRetry(pool: Pick<pg.Pool, "connect">, signal?: AbortSignal) {
  const retryDelayMs = 5000;

  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const client = await pool.connect();
      client.release();
      console.info({ event: "database_connected", attempt });
      return;
    } catch {
      signal?.throwIfAborted();
      console.warn({
        event: "database_connection_retry",
        attempt,
        retryDelayMs,
      });
      await timers.setTimeout(retryDelayMs, undefined, { signal });
    }
  }
}
