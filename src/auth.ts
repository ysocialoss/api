import { cookie, requireOrigin, requireSessionUser, requireUser } from "./auth/request.ts";
import { publishAccountChange, publishWaitlistChange } from "./live-events.ts";
import { serveLiveStream } from "./live.ts";
import { createHash } from "node:crypto";
import { Router } from "express";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { termsVersion } from "./legal.ts";
import { z } from "zod";
import { pronounsSchema } from "./pronouns.ts";
import { displayNameOr } from "./display-name.ts";
import { db } from "./db/index.ts";
import {
  authIdentities,
  authSessions,
  oauthTransactions,
  users,
} from "./db/schema.ts";
import { env } from "./config.ts";
import { AuthError, exchange, providerPost } from "./auth/provider.ts";
import { decrypt, encrypt, hash, random } from "./auth/secrets.ts";
import { readSession } from "./auth/session.ts";

const router = Router();
const callbackPath = "/auth/callback";
const cookieOptions = (origin: string) => ({
  httpOnly: true,
  secure: origin.startsWith("https:"),
  sameSite: "lax",
  path: "/",
} satisfies import("express").CookieOptions);
function adminOrigin() {
  if (!env.ADMIN_ORIGIN) throw new AuthError(503, "admin_login_not_configured");
  return env.ADMIN_ORIGIN;
}

const duration = 30 * 86400000;
router.use((_req, res, next) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  next();
});
router.get(["/login", "/admin/login"], async (req, res) => {
  const admin = req.path.toLowerCase().startsWith("/admin/");
  const origin = admin ? adminOrigin() : env.APP_ORIGIN;
  if (!env.SESSION_ENCRYPTION_KEY)
    throw new AuthError(503, "login_not_configured");
  const state = random(),
    verifier = random() + random(),
    nonce = random();
  const browser = cookie(req, "oauth_browser") || random();
  await db
    .delete(oauthTransactions)
    .where(lt(oauthTransactions.expiresAt, new Date()));
  await db.delete(authSessions).where(lt(authSessions.expiresAt, new Date()));
  await db.insert(oauthTransactions).values({
    state: hash(state),
    browserHash: hash(browser),
    verifier,
    admin,
    nonce,
    expiresAt: new Date(Date.now() + 600000),
  });
  res.cookie("oauth_browser", browser, { ...cookieOptions(origin), maxAge: 600000 });
  const url = new URL(env.CNS_LOGIN_URL);
  url.search = new URLSearchParams({
    client_id: env.CNS_CLIENT_ID,
    redirect_uri: `${origin}${callbackPath}`,
    response_type: "code",
    scope: admin ? "openid profile users:read" : "openid profile",
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }).toString();
  res.redirect(url.href);
});
router.get("/callback", async (req, res) => {
  let admin = false;
  try {
    const state = z.string().min(1).max(256).safeParse(req.query.state);
    const browser = cookie(req, "oauth_browser");
    if (!state.success || !browser)
      throw new AuthError(400, "invalid_login_state");
    const [attempt] = await db
      .delete(oauthTransactions)
      .where(
        and(
          eq(oauthTransactions.state, hash(state.data)),
          eq(oauthTransactions.browserHash, hash(browser)),
          gt(oauthTransactions.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!attempt) throw new AuthError(400, "invalid_login_state");
    admin = attempt.admin;
    const origin = admin ? adminOrigin() : env.APP_ORIGIN;
    const code = z.string().min(1).max(4096).safeParse(req.query.code);
    if (!code.success) throw new AuthError(400, "login_failed");
    const result = await exchange({
      state: state.data,
      code: code.data,
      verifier: attempt.verifier,
      redirectUri: `${origin}${callbackPath}`,
      nonce: attempt.nonce,
    });
    const token = random();
    const userId = await db.transaction(async (tx) => {
      // Lock the old session before the identity, matching onboarding and refresh.
      await tx
        .delete(authSessions)
        .where(eq(authSessions.tokenHash, hash(cookie(req, "session"))));
      // Upsert also serializes simultaneous callbacks for one CNS identity.
      const [identity] = await tx
        .insert(authIdentities)
        .values({
          issuer: result.issuer,
          subject: result.profile.sub,
          username: result.profile.preferred_username,
          displayName: result.profile.name,
          picture: result.profile.picture ?? null,
        })
        .onConflictDoUpdate({
          target: [authIdentities.issuer, authIdentities.subject],
          set: {
            username: result.profile.preferred_username,
            displayName: result.profile.name,
            picture: result.profile.picture ?? null,
            profileSyncedAt: new Date(),
            deletedAt: null,
          },
        })
        .returning();
      await tx.insert(authSessions).values({
        tokenHash: hash(token),
        identityId: identity.id,
        sessionVersion: identity.sessionVersion,
        encryptedTokens: encrypt(result.tokens),
        refreshAfter: new Date(Date.now() + result.tokens.expires_in * 800),
        expiresAt: new Date(Date.now() + duration),
      });
      return identity.userId;
    });
    res.cookie("session", token, { ...cookieOptions(origin), maxAge: duration });
    res.redirect(admin || userId ? "/" : "/onboarding");
  } catch (error) {
    const code = error instanceof AuthError ? error.code : "login_failed";
    res.redirect(`${admin ? "/" : "/login"}?error=${encodeURIComponent(code)}`);
  }
});
router.get("/me", async (req, res) => {
  const session = await readSession(cookie(req, "session"));
  if (session.kind === "anonymous") {
    res.clearCookie("session", cookieOptions(env.APP_ORIGIN));
    res.json({ authenticated: false });
    return;
  }
  res.json({
    authenticated: true,
    needsOnboarding: !session.user,
    pendingApproval: session.user?.approvedAt === null,
    ban: session.user?.bannedAt ? {
      at: session.user.bannedAt,
      reason: session.user.banReason,
      by: session.user.bannedBy,
      byProfileHandle: session.user.bannedByProfileHandle,
    } : null,
    termsCurrent: session.user ? session.user.termsVersion === termsVersion : null,
    termsVersion,
    feedChoiceNeeded: session.user ? session.user.feedChoiceAt === null : false,
    user: session.user,
    avatarUrl: session.user ? session.user.avatarUrl : session.identity.picture,
    suggestedHandle: /^[a-z0-9_]{3,32}$/.test(
      session.identity.username.toLowerCase(),
    )
      ? session.identity.username.toLowerCase()
      : "",
    suggestedDisplayName: session.user ? undefined : session.identity.displayName.slice(0, 80),
  });
});
const navigationItems = z.enum([
  "feed", "following", "search", "messages", "activity", "communities", "profile", "saved",
]);
const navigationInput = z.strictObject({
  userId: z.uuid(),
  items: z.array(navigationItems)
    .max(navigationItems.options.length)
    .refine((items) => new Set(items).size === items.length)
    .nullable(),
});

router.put("/navigation", async (req, res) => {
  const user = await requireUser(req);
  const input = navigationInput.safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_navigation");
  if (input.data.userId !== user.id)
    throw new AuthError(403, "retry_account_changed");
  await db.update(users)
    .set({ navigation: input.data.items })
    .where(eq(users.id, user.id));
  res.sendStatus(204);
});
const namePaintPreferenceInput = z.strictObject({ userId: z.uuid(), disabled: z.boolean() });
for (const [path, preference] of [
  ["/name-paints", "namePaintsDisabled"],
  ["/name-paint-animations", "namePaintAnimationsDisabled"],
] as const) {
  router.put(path, async (req, res) => {
    requireOrigin(req);
    const user = await requireSessionUser(req);
    const input = namePaintPreferenceInput.safeParse(req.body);
    if (!input.success) throw new AuthError(400, "invalid_name_paint_preference");
    if (input.data.userId !== user.id)
      throw new AuthError(403, "retry_account_changed");
    await db.update(users)
      .set({ [preference]: input.data.disabled })
      .where(eq(users.id, user.id));
    res.sendStatus(204);
  });
}
router.get("/approval/live", async (req, res) => {
  const user = await requireSessionUser(req);
  serveLiveStream(req, res, { approvalFor: user.id });
});
router.post("/profile", async (req, res) => {
  requireOrigin(req);
  const input = z
    .strictObject({
      handle: z.string().regex(/^[a-z0-9_]{3,32}$/),
      displayName: z.string().trim().max(80).optional(),
      pronouns: pronounsSchema.optional(),
      acceptTerms: z.literal(true).optional(),
      ageConfirmed: z.literal(true).optional(),
    })
    .safeParse(req.body);
  if (!input.success) {
    if (input.error.issues.some((issue) => issue.path[0] === "acceptTerms" || issue.path[0] === "ageConfirmed"))
      throw new AuthError(400, "terms_required");
    if (input.error.issues.some((issue) => issue.path[0] === "pronouns" || issue.path[0] === "displayName"))
      throw new AuthError(400, "invalid_profile");
    throw new AuthError(400, "invalid_handle");
  }
  if (!input.data.acceptTerms || !input.data.ageConfirmed)
    throw new AuthError(400, "terms_required");
  const session = await readSession(cookie(req, "session"));
  if (session.kind === "anonymous")
    throw new AuthError(401, "sign_in_required");
  const user = await db.transaction(async (tx) => {
    // Lock the session before the identity, as in refresh/logout.
    const [active] = await tx
      .select()
      .from(authSessions)
      .where(
        and(
          eq(authSessions.tokenHash, hash(cookie(req, "session"))),
          gt(authSessions.expiresAt, new Date()),
        ),
      )
      .for("update");
    if (!active) throw new AuthError(401, "sign_in_required");
    const [identity] = await tx
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.id, active.identityId))
      .for("update");
    if (!identity || identity.deletedAt || identity.sessionVersion !== active.sessionVersion)
      throw new AuthError(401, "sign_in_required");
    if (identity.userId) throw new AuthError(409, "already_onboarded");
    const [created] = await tx
      .insert(users)
      .values({
        handle: input.data.handle,
        displayName: displayNameOr(input.data.displayName ?? identity.displayName, input.data.handle),
        pronouns: input.data.pronouns,
        termsVersion,
        termsAcceptedAt: new Date(),
        ageConfirmedAt: new Date(),
      })
      .returning();
    await tx
      .update(authIdentities)
      .set({ userId: created.id })
      .where(eq(authIdentities.id, identity.id));
    await publishWaitlistChange(tx);
    return { ...created, avatarUrl: identity.picture };
  });
  res.status(201).json({
    user: {
      id: user.id,
      handle: user.handle,
      displayName: user.displayName,
      pronouns: user.pronouns,
      avatarUrl: user.avatarUrl,
    },
  });
});
router.post("/terms", async (req, res) => {
  requireOrigin(req);
  const user = await requireSessionUser(req);
  const input = z.strictObject({
    version: z.literal(termsVersion),
    acceptTerms: z.literal(true),
    ageConfirmed: z.literal(true).optional(),
  }).safeParse(req.body);
  if (!input.success) throw new AuthError(400, "terms_required");
  await db.transaction(async (tx) => {
    const [updated] = await tx.update(users).set({
      termsVersion,
      termsAcceptedAt: new Date(),
      ageConfirmedAt: input.data.ageConfirmed ? sql`coalesce(${users.ageConfirmedAt}, now())` : users.ageConfirmedAt,
    }).where(eq(users.id, user.id)).returning({ ageConfirmedAt: users.ageConfirmedAt });
    if (!updated?.ageConfirmedAt) throw new AuthError(400, "terms_required");
    await publishAccountChange(tx, user.id);
  });
  res.sendStatus(204);
});
router.post(["/logout", "/admin/logout"], async (req, res) => {
  const origin = req.path.startsWith("/admin/") ? adminOrigin() : env.APP_ORIGIN;
  if (req.headers.origin !== origin) throw new AuthError(403, "invalid_origin");
  // DELETE waits for an in-flight refresh and returns its newest token.
  const [session] = await db.transaction(async (tx) => {
    const sessions = await tx.delete(authSessions)
      .where(eq(authSessions.tokenHash, hash(cookie(req, "session"))))
      .returning();
    if (sessions.length) {
      const [identity] = await tx.select({ userId: authIdentities.userId }).from(authIdentities)
        .where(eq(authIdentities.id, sessions[0].identityId));
      if (identity?.userId) await publishAccountChange(tx, identity.userId);
    }
    return sessions;
  });
  res.clearCookie("session", cookieOptions(origin));
  if (session) {
    try {
      await providerPost(
        "/api/auth/logout",
        {},
        decrypt(session.encryptedTokens).access_token,
      );
    } catch {
      console.warn({ event: "cns_logout_unavailable" });
    }
  }
  res.sendStatus(204);
});
export default router;
