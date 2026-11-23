import { beginDraining, createHealthRouter, isDraining } from "./health.ts";
import { startMediaCleanup } from "./storage/media-lifecycle.ts";
import banners from "./banners.ts";
import avatars from "./avatars.ts";
import voices from "./voices.ts";
import { startVoiceJobs } from "./storage/voice-jobs.ts";
import { checkAvatarStorage } from "./storage/r2.ts";
import profiles from "./profiles.ts";
import github from "./github.ts";
import connectionRoutes from "./connections.ts";
import domainRoutes from "./domains.ts";
import { startGithubRefresh } from "./github-contribution-jobs.ts";
import posts from "./posts.ts";
import postImages, { startPostImageCleanup } from "./post-images.ts";
import og from "./og.ts";
import live from "./live.ts";
import { startLiveEvents } from "./live-events.ts";
import notifications from "./notifications.ts";
import topics from "./topics.ts";
import search from "./search.ts";
import dms from "./dms.ts";
import { attachDmSocket } from "./dm-socket.ts";
import { startPushDelivery } from "./push-delivery.ts";
import { AuthError } from "./auth/provider.ts";
import express, { type ErrorRequestHandler } from "express";
import pg from "pg";
import admin from "./admin.ts";
import reports from "./reports.ts";
import blocks from "./blocks.ts";
import auth from "./auth.ts";
import { pool } from "./db/index.ts";
import { connectWithRetry } from "./db/connect.ts";
import { env } from "./config.ts";

export const app = express();

let startupReady = !import.meta.main;
app.use((_req, res, next) => {
  if (isDraining()) res.set("Connection", "close");
  next();
});
app.use(createHealthRouter(() => startupReady));
app.use((req, res, next) => {
  if (!startupReady && (req.path.startsWith("/api/") || req.path.startsWith("/auth"))) {
    res.status(503).json({ error: "API is starting" });
    return;
  }
  next();
});

// The provider has not supplied its webhook envelope or timestamp header contract.
// Do not acknowledge delivery until signature verification can be implemented.
app.post("/webhooks/cns", (_req, res) => {
  res.status(503).json({ error: "webhooks_not_configured" });
});
app.use("/api/reports", express.json({ limit: "64kb" }), reports);
app.use(express.json({ limit: "16kb" }));
app.use("/auth", auth);
app.use("/api/admin", admin);
app.use("/api/blocks", blocks);
app.use("/api/posts", posts);
app.use("/api/post-images", postImages);
app.use("/api/og", og);
app.use("/api/live", live);
app.use("/api/notifications", notifications);
app.use("/api/topics", topics);
app.use("/api/search", search);
app.use("/api/dms", dms);
app.use("/api/profiles", profiles);
app.use("/api/github", github);
app.use("/api/connections", connectionRoutes);
app.use("/api/domains", domainRoutes);
app.use("/api/avatars", avatars);
app.use("/api/banners", banners);
app.use("/api/voices", voices);
// Unknown API routes answer in JSON like every other API error.
app.use(["/api", "/auth"], (_req, res) => {
  res.status(404).json({ error: "route_not_found" });
});

app.get("/", (_req, res) => {
  res.redirect("https://docs.ysocial.cc/");
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
  const shutdown = new AbortController();
  let stopMediaCleanup = () => {};
  let stopPostImageCleanup = () => {};
  let stopVoiceJobs = () => {};
  let stopPushDelivery = () => {};
  let stopLiveEvents = () => {};
  let stopGithubRefresh = () => {};
  const server = app.listen(env.PORT, () =>
    console.info(`API listening on port ${env.PORT}`),
  );
  const dmSocket = attachDmSocket(server);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      beginDraining();
      startupReady = false;
      shutdown.abort();
      stopMediaCleanup();
      stopPostImageCleanup();
      stopPushDelivery();
      stopVoiceJobs();
      stopLiveEvents();
      dmSocket.stop();
      stopGithubRefresh();
      setTimeout(() => {
        server.close(() => { void pool.end(); });
        server.closeIdleConnections();
        setTimeout(() => {
          server.closeAllConnections();
          process.exit(0);
        }, env.SHUTDOWN_TIMEOUT_MS).unref();
      }, env.SHUTDOWN_DRAIN_MS);
    });
  }
  try {
    await connectWithRetry(pool, shutdown.signal);
    shutdown.signal.throwIfAborted();
    const schema = await pool.query<{ ready: boolean }>(`SELECT
      to_regclass('public.post_likes') IS NOT NULL AND
      to_regclass('public.post_topics') IS NOT NULL AND
      to_regclass('public.posts_content_search_idx') IS NOT NULL AND
      to_regclass('public.media_deletions') IS NOT NULL AND
      to_regclass('public.voice_jobs') IS NOT NULL AND
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.posts') AND tgname = 'posts_voice_cleanup' AND tgenabled IN ('O', 'A')) AND
      to_regclass('public.posts') IS NOT NULL AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'posts' AND column_name = 'gif') AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'posts' AND column_name = 'voice') AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'posts' AND column_name = 'flagged_at') AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'posts' AND column_name = 'hidden_at') AND
      to_regclass('public.post_mentions') IS NOT NULL AND
      to_regclass('public.users') IS NOT NULL AND
      to_regclass('public.user_handles') IS NOT NULL AND
      to_regclass('public.moderation_activity') IS NOT NULL AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'notification_prompt_dismissed') AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'banner_crop') AND
      to_regclass('public.user_follows') IS NOT NULL AND
      to_regclass('public.notifications') IS NOT NULL AND
      to_regclass('public.dm_conversations') IS NOT NULL AND
      to_regclass('public.dm_messages') IS NOT NULL AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'dm_devices' AND column_name = 'generation') AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'dm_generation') AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'hide_notification_content') AND
      to_regclass('public.push_subscriptions') IS NOT NULL AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'muted_forever') AND
      to_regclass('public.push_deliveries') IS NOT NULL AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'role') AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'approved_at') AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'banned_at') AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'ban_reason') AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'auth_sessions' AND column_name = 'session_version') AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'auth_identities' AND column_name = 'session_version') AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'identity_avatar_hidden') AND
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'oauth_transactions' AND column_name = 'admin') AND
      to_regclass('public.auth_sessions') IS NOT NULL AND
      to_regclass('public.auth_identities') IS NOT NULL AND
      to_regclass('public.oauth_transactions') IS NOT NULL AND
      to_regclass('public.connections') IS NOT NULL AND
      to_regclass('public.connection_link_attempts') IS NOT NULL AND
      to_regclass('public.user_domains') IS NOT NULL AND
      to_regclass('public.post_saves') IS NOT NULL AND
      to_regclass('public.profile_pins') IS NOT NULL AND
      to_regclass('public.github_connections') IS NOT NULL AND
      to_regclass('public.github_link_attempts') IS NOT NULL AND
      to_regclass('public.github_contribution_jobs') IS NOT NULL AS ready`);
    if (!schema.rows[0]?.ready) {
      throw new Error(
        "Database schema is missing. Run pnpm db:migrate in api/ before starting the API.",
      );
    }
    if (env.R2) await checkAvatarStorage();
    shutdown.signal.throwIfAborted();
    stopMediaCleanup = startMediaCleanup();
    stopPostImageCleanup = startPostImageCleanup();
    stopVoiceJobs = startVoiceJobs();
    stopPushDelivery = startPushDelivery();
    stopLiveEvents = startLiveEvents(dmSocket);
    stopGithubRefresh = startGithubRefresh();
    startupReady = true;
  } catch (error) {
    if (!shutdown.signal.aborted) {
      console.error(
        "API startup failed. Check database migrations and EU R2 configuration.",
        error,
      );
      dmSocket.stop();
      server.close();
      await pool.end();
      process.exitCode = 1;
    }
  }
}
