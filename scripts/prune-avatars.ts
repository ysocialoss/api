import { pool } from "../src/db/index.ts";
import { sweepUnusedMedia } from "../src/storage/media-sweep.ts";
import { flushMediaDeletions } from "../src/storage/media-lifecycle.ts";
try {
  const remove = process.argv.includes("--delete");
  const count = await sweepUnusedMedia(remove);
  if (remove) await flushMediaDeletions();
  console.info({ event: "unused_media", count, queuedForDeletion: remove });
} finally {
  await pool.end();
}
