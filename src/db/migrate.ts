import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDatabase, pool } from "./index.ts";

const MIGRATION_LOCK = 7_001_000;
const lock = await pool.connect();
try {
  await lock.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
  await migrate(createDatabase(lock), {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
  console.info("Migrations applied");
} catch (error) {
  console.error("Migration failed", error);
  process.exitCode = 1;
} finally {
  lock.release(true);
  await pool.end();
}
