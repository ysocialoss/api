import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../config.ts";
import * as schema from "./schema.ts";

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});
export const db = drizzle({ client: pool, schema });
pool.on("error", (error) => console.error("PostgreSQL pool error", error));
