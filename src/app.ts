import profiles from "./profiles.ts";
import posts from "./posts.ts";
import { AuthError } from "./auth/provider.ts";
import express, { type ErrorRequestHandler } from "express";
import pg from "pg";
import auth from "./auth.ts";
import { pool } from "./db/index.ts";
import { env } from "./config.ts";

export const app = express();
// The provider has not supplied its webhook envelope or timestamp header contract.
// Do not acknowledge delivery until signature verification can be implemented.
app.post("/webhooks/cns", (_req, res) => {
  res.status(503).json({ error: "webhooks_not_configured" });
});
app.use(express.json({ limit: "16kb" }));
app.use("/auth", auth);
app.use("/api/posts", posts);
app.use("/api/profiles", profiles);

app.get("/", (_req, res) => {
  res.send("Hello World!");
});

const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.code });
    return;
  }
  // Drizzle wraps the original PostgreSQL error in Error.cause.
  const cause = error instanceof Error && error.cause ? error.cause : error;
  if (cause instanceof pg.DatabaseError && cause.code === "23505") {
    res.status(409).json({ error: "Handle is already taken" });
    return;
  }
  if (
    error instanceof SyntaxError &&
    "status" in error &&
    error.status === 400
  ) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }
  if (error instanceof Error && "status" in error && error.status === 413) {
    res.status(413).json({ error: "Request body is too large" });
    return;
  }
  console.error({
    event: "request_failed",
    databaseCode: cause instanceof pg.DatabaseError ? cause.code : undefined,
  });
  res.status(500).json({ error: "Internal server error" });
};
app.use(handleError);

if (import.meta.main) {
  try {
    const schema = await pool.query<{ ready: boolean }>(`SELECT
      to_regclass('public.post_likes') IS NOT NULL AND
      to_regclass('public.posts') IS NOT NULL AND
      to_regclass('public.users') IS NOT NULL AND
      to_regclass('public.auth_sessions') IS NOT NULL AND
      to_regclass('public.auth_identities') IS NOT NULL AND
      to_regclass('public.oauth_transactions') IS NOT NULL AS ready`);
    if (!schema.rows[0]?.ready) {
      throw new Error(
        "Database schema is missing. Run pnpm db:migrate in api/ before starting the API.",
      );
    }
    const server = app.listen(env.PORT, () =>
      console.info(`API listening on port ${env.PORT}`),
    );
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        server.close(() => {
          void pool.end();
        });
      });
    }
  } catch (error) {
    console.error(
      "Could not connect to PostgreSQL. Check DATABASE_URL and start the database.",
      error,
    );
    await pool.end();
    process.exitCode = 1;
  }
}
