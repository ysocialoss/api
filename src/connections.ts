import { Router } from "express";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { cookie, requireApprovedUser, requireUser } from "./auth/request.ts";
import { hash, random } from "./auth/secrets.ts";
import { env } from "./config.ts";
import { db } from "./db/index.ts";
import { connectionLinkAttempts, connections, users } from "./db/schema.ts";
import { liveTwitchStreams } from "./twitch-live.ts";
import {
  exchangeProviderCode,
  isProvider,
  providerAuthorizeUrl,
  providerConfigured,
  providerIds,
  type ConnectionProvider,
} from "./connection-providers.ts";

const router = Router();
const attemptLength = 10 * 60_000;
const connectInput = z.strictObject({ returnTo: z.enum(["profile", "settings"]).optional() }).optional();
const profileStatePrefix = "profile.";

router.use((_req, res, next) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  next();
});

function parseProvider(value: string): ConnectionProvider {
  if (!isProvider(value)) throw new AuthError(404, "unknown_connection");
  return value;
}

const connectionSelection = {
  provider: connections.provider,
  username: connections.username,
  displayName: connections.displayName,
  profileUrl: connections.profileUrl,
};

router.get("/twitch/live", async (req, res) => {
  const handles = z.string().max(2000).transform((value) => [...new Set(value.split(","))])
    .pipe(z.array(z.string().regex(/^[a-z0-9_]{3,32}$/)).min(1).max(50))
    .safeParse(req.query.handles);
  if (!handles.success) throw new AuthError(400, "invalid_handles");
  res.set("Cache-Control", "public, max-age=30");
  res.json({ live: await liveTwitchStreams(handles.data) });
});

router.get("/", async (req, res) => {
  const { id } = await requireApprovedUser(req);
  const linked = await db.select(connectionSelection).from(connections).where(eq(connections.userId, id));
  res.json({
    providers: providerIds.map((provider) => ({
      provider,
      configured: providerConfigured(provider),
      connection: linked.find((entry) => entry.provider === provider) ?? null,
    })),
  });
});

router.post("/:provider/connect", async (req, res) => {
  const provider = parseProvider(req.params.provider);
  const { id } = await requireUser(req);
  if (!providerConfigured(provider)) throw new AuthError(503, "connection_not_configured");
  const input = connectInput.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_connection");
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
    const [existing] = await tx.select({ id: connections.id }).from(connections)
      .where(and(eq(connections.userId, id), eq(connections.provider, provider)));
    if (existing) throw new AuthError(409, "connection_already_connected");
    await tx.insert(connectionLinkAttempts).values({ userId: id, provider, ...attempt })
      .onConflictDoUpdate({ target: [connectionLinkAttempts.userId, connectionLinkAttempts.provider], set: attempt });
  });
  res.json({ url: providerAuthorizeUrl(provider, state, verifier) });
});

router.get("/:provider/callback", async (req, res) => {
  const provider = parseProvider(req.params.provider);
  let returnPath = "/settings/account";
  const redirect = (result: string) =>
    res.redirect(`${env.APP_ORIGIN}${returnPath}?connection=${provider}&result=${encodeURIComponent(result)}`);
  try {
    if (!providerConfigured(provider)) throw new AuthError(503, "connection_not_configured");
    const { id, handle } = await requireApprovedUser(req);
    const state = z.string().regex(/^(?:profile\.)?[\w-]{43}$/).safeParse(req.query.state);
    if (!state.success) throw new AuthError(400, "connection_invalid_state");
    const matchingAttempt = () => and(
      eq(connectionLinkAttempts.userId, id),
      eq(connectionLinkAttempts.provider, provider),
      eq(connectionLinkAttempts.stateHash, hash(state.data)),
      eq(connectionLinkAttempts.sessionHash, hash(cookie(req, "session"))),
      gt(connectionLinkAttempts.expiresAt, new Date()),
    );
    const [attempt] = await db.select({ verifier: connectionLinkAttempts.verifier })
      .from(connectionLinkAttempts).where(matchingAttempt());
    if (!attempt) throw new AuthError(400, "connection_invalid_state");
    if (state.data.startsWith(profileStatePrefix)) returnPath = `/@${handle}`;

    if (typeof req.query.error === "string") {
      await db.delete(connectionLinkAttempts).where(matchingAttempt());
      redirect("cancelled");
      return;
    }

    const code = z.string().min(1).max(4096).safeParse(req.query.code);
    if (!code.success) throw new AuthError(400, "connection_failed");
    const identity = await exchangeProviderCode(provider, code.data, attempt.verifier);
    if ((await requireApprovedUser(req)).id !== id) throw new AuthError(400, "connection_invalid_state");
    const linked = await db.transaction(async (tx) => {
      const [owner] = await tx.select({ approvedAt: users.approvedAt, bannedAt: users.bannedAt })
        .from(users).where(eq(users.id, id)).for("update");
      if (!owner?.approvedAt || owner.bannedAt) throw new AuthError(403, "connection_invalid_state");
      const [consumed] = await tx.delete(connectionLinkAttempts).where(matchingAttempt())
        .returning({ userId: connectionLinkAttempts.userId });
      if (!consumed) throw new AuthError(400, "connection_invalid_state");
      const [created] = await tx.insert(connections).values({
        userId: id,
        provider,
        externalId: identity.id,
        username: identity.username,
        displayName: identity.displayName,
        profileUrl: identity.url,
      }).onConflictDoNothing().returning({ id: connections.id });
      return created;
    });
    if (!linked) throw new AuthError(409, "connection_account_taken");
    redirect("connected");
  } catch (error) {
    if (!(error instanceof AuthError || error instanceof z.ZodError))
      console.error({ event: "connection_failed", provider });
    redirect(error instanceof AuthError && error.code.startsWith("connection_")
      ? error.code.replace(/^connection_/, "")
      : "failed");
  }
});

router.delete("/:provider", async (req, res) => {
  const provider = parseProvider(req.params.provider);
  const { id } = await requireUser(req);
  await db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).for("update");
    await tx.delete(connectionLinkAttempts).where(
      and(eq(connectionLinkAttempts.userId, id), eq(connectionLinkAttempts.provider, provider)),
    );
    await tx.delete(connections).where(and(eq(connections.userId, id), eq(connections.provider, provider)));
  });
  res.sendStatus(204);
});

export default router;
