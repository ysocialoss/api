import { Router } from "express";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { cookie, requireApprovedUser, requireUser } from "./auth/request.ts";
import { hash, random } from "./auth/secrets.ts";
import { env } from "./config.ts";
import { db } from "./db/index.ts";
import { githubConnections, githubLinkAttempts, users } from "./db/schema.ts";
import { exchangeGithubCode, githubAuthorizeUrl, githubConfigured, readGithubContributions } from "./github-provider.ts";
import { githubProfileSelection } from "./user-data.ts";

const router = Router();
const attemptLength = 10 * 60_000;
const refreshCooldown = 60_000;
const automaticRefreshInterval = 24 * 60 * 60_000;
const automaticRefreshTick = (env.GITHUB_PUBLIC_READ_TOKEN ? 1 : 10) * 60_000;
const connectInput = z.strictObject({ returnTo: z.literal("profile").optional() }).optional();
const profileStatePrefix = "profile.";

router.use((_req, res, next) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  next();
});

router.get("/", async (req, res) => {
  const { id } = await requireApprovedUser(req);
  const [github] = await db.select(githubProfileSelection).from(githubConnections)
    .where(eq(githubConnections.userId, id));
  res.json({ configured: githubConfigured, github: github ?? null });
});

router.post("/connect", async (req, res) => {
  const { id } = await requireUser(req);
  if (!githubConfigured) throw new AuthError(503, "github_not_configured");
  const input = connectInput.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_github_connection");
  const state = (input.data?.returnTo === "profile" ? profileStatePrefix : "") + random();
  const verifier = random();
  const attempt = {
    stateHash: hash(state),
    sessionHash: hash(cookie(req, "session")),
    verifier,
    expiresAt: new Date(Date.now() + attemptLength),
  };

  await db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).for("update");
    const [existing] = await tx.select({ id: githubConnections.id }).from(githubConnections)
      .where(eq(githubConnections.userId, id));
    if (existing) throw new AuthError(409, "github_already_connected");
    await tx.insert(githubLinkAttempts).values({ userId: id, ...attempt })
      .onConflictDoUpdate({ target: githubLinkAttempts.userId, set: attempt });
  });
  res.json({ url: githubAuthorizeUrl(state, verifier) });
});

router.get("/callback", async (req, res) => {
  let returnPath = "/asettings";
  const redirect = (result: string) => res.redirect(`${returnPath}?github=${encodeURIComponent(result)}`);
  try {
    if (!githubConfigured) throw new AuthError(503, "github_not_configured");
    const { id, handle } = await requireApprovedUser(req);
    const state = z.string().regex(/^(?:profile\.)?[\w-]{43}$/).safeParse(req.query.state);
    if (!state.success) throw new AuthError(400, "github_invalid_state");
    const matchingAttempt = () => and(
      eq(githubLinkAttempts.userId, id),
      eq(githubLinkAttempts.stateHash, hash(state.data)),
      eq(githubLinkAttempts.sessionHash, hash(cookie(req, "session"))),
      gt(githubLinkAttempts.expiresAt, new Date()),
    );
    const [attempt] = await db.select({ verifier: githubLinkAttempts.verifier })
      .from(githubLinkAttempts).where(matchingAttempt());
    if (!attempt) throw new AuthError(400, "github_invalid_state");
    // The stored state hash binds the return destination to this session.
    if (state.data.startsWith(profileStatePrefix)) returnPath = `/@${handle}`;

    if (req.query.error === "access_denied") {
      await db.delete(githubLinkAttempts).where(matchingAttempt());
      redirect("cancelled");
      return;
    }

    const code = z.string().min(1).max(4096).safeParse(req.query.code);
    if (!code.success) throw new AuthError(400, "github_connection_failed");
    const identity = await exchangeGithubCode(code.data, attempt.verifier);
    if ((await requireApprovedUser(req)).id !== id) throw new AuthError(400, "github_invalid_state");
    const connection = await db.transaction(async (tx) => {
      const [owner] = await tx.select({ approvedAt: users.approvedAt, bannedAt: users.bannedAt })
        .from(users).where(eq(users.id, id)).for("update");
      if (!owner?.approvedAt || owner.bannedAt) throw new AuthError(403, "github_invalid_state");
      const [consumed] = await tx.delete(githubLinkAttempts).where(matchingAttempt())
        .returning({ userId: githubLinkAttempts.userId });
      if (!consumed) throw new AuthError(400, "github_invalid_state");
      const [linked] = await tx.insert(githubConnections).values({
        userId: id,
        githubId: identity.id,
        login: identity.login,
      }).onConflictDoNothing().returning({ id: githubConnections.id });
      return linked;
    });
    if (!connection) throw new AuthError(409, "github_account_taken");
    // The connection is valid even if GitHub's public contribution APIs fail.
    await refreshConnection(connection.id).catch(reportRefreshFailure);
    redirect("connected");
  } catch (error) {
    if (!(error instanceof AuthError || error instanceof z.ZodError))
      console.error({ event: "github_connection_failed" });
    redirect(error instanceof AuthError && error.code.startsWith("github_")
      ? error.code
      : "github_connection_failed");
  }
});

router.delete("/", async (req, res) => {
  const { id } = await requireUser(req);
  await db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).for("update");
    await tx.delete(githubLinkAttempts).where(eq(githubLinkAttempts.userId, id));
    await tx.delete(githubConnections).where(eq(githubConnections.userId, id));
  });
  res.sendStatus(204);
});

router.post("/refresh", async (req, res) => {
  const { id } = await requireUser(req);
  const [connection] = await db.select({ id: githubConnections.id }).from(githubConnections)
    .where(eq(githubConnections.userId, id));
  if (!connection) throw new AuthError(404, "github_not_connected");
  const github = await refreshConnection(connection.id);
  if (!github) throw new AuthError(429, "github_refresh_too_soon");
  res.json({ github });
});

async function refreshConnection(id: string) {
  const now = new Date();
  const [claimed] = await db.update(githubConnections).set({ attemptedAt: now })
    .where(and(
      eq(githubConnections.id, id),
      or(isNull(githubConnections.attemptedAt), lt(githubConnections.attemptedAt, new Date(now.getTime() - refreshCooldown))),
    )).returning({ githubId: githubConnections.githubId });
  if (!claimed) return;

  const result = await readGithubContributions(claimed.githubId).catch(() => {
    throw new AuthError(502, "github_unavailable");
  });
  const [updated] = await db.update(githubConnections).set({ ...result, checkedAt: new Date() })
    .where(eq(githubConnections.id, id)).returning(githubProfileSelection);
  return updated;
}

function reportRefreshFailure() {
  console.warn({ event: "github_contribution_refresh_failed" });
}

export function startGithubRefresh() {
  if (!githubConfigured) return () => {};
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const [connection] = await db.select({ id: githubConnections.id }).from(githubConnections)
        .where(and(
          or(isNull(githubConnections.checkedAt), lt(githubConnections.checkedAt, new Date(Date.now() - automaticRefreshInterval))),
          or(isNull(githubConnections.attemptedAt), lt(githubConnections.attemptedAt, new Date(Date.now() - attemptLength))),
        ))
        .orderBy(sql`${githubConnections.attemptedAt} asc nulls first`).limit(1);
      if (connection) await refreshConnection(connection.id);
    } catch {
      reportRefreshFailure();
    } finally {
      running = false;
    }
  }, automaticRefreshTick);
  timer.unref();
  return () => clearInterval(timer);
}

export default router;
