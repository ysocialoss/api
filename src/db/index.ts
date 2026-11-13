import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../config.ts";
import * as schema from "./schema.ts";

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
});
export const db = drizzle({ client: pool, schema });
pool.on("error", (error) => console.error("PostgreSQL pool error", error));
