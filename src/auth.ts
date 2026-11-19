import { cookie, requireOrigin } from "./auth/request.ts";
import { createHash } from "node:crypto";
import { Router } from "express";
import { and, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import {
  authIdentities,
  authSessions,
  oauthTransactions,
  users,
} from "./db/schema.ts";
import { adminHandle, env, reservedAdminHandle } from "./config.ts";
import { AuthError, exchange, providerPost } from "./auth/provider.ts";
import { decrypt, encrypt, hash, random } from "./auth/secrets.ts";
import { readSession } from "./auth/session.ts";

const router = Router();
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
  const origin = req.path.startsWith("/admin/") ? adminOrigin() : env.APP_ORIGIN;
  const admin = origin !== env.APP_ORIGIN;
  const callback = admin ? "/auth/admin/callback" : "/auth/callback";
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
    redirect_uri: `${origin}${callback}`,
    response_type: "code",
    scope: "openid profile users:read",
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }).toString();
  res.redirect(url.href);
});
router.get(["/callback", "/admin/callback"], async (req, res) => {
  const admin = req.path.startsWith("/admin/");
  const origin = admin ? adminOrigin() : env.APP_ORIGIN;
  const callback = admin ? "/auth/admin/callback" : "/auth/callback";
  try {
    const parsed = z
      .object({
        state: z.string().min(1).max(256),
        code: z.string().min(1).max(4096),
      })
      .safeParse(req.query);
    if (!parsed.success || !cookie(req, "oauth_browser"))
      throw new AuthError(400, "invalid_login_state");
    const { state, code } = parsed.data;
    const [attempt] = await db
      .delete(oauthTransactions)
      .where(
        and(
          eq(oauthTransactions.state, hash(state)),
          eq(oauthTransactions.admin, admin),
          eq(oauthTransactions.browserHash, hash(cookie(req, "oauth_browser"))),
          gt(oauthTransactions.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!attempt) throw new AuthError(400, "invalid_login_state");
    const result = await exchange({
      state,
      code,
      verifier: attempt.verifier,
      redirectUri: `${origin}${callback}`,
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
          },
        })
        .returning();
      if (identity.deletedAt) throw new AuthError(403, "account_deleted");
      if (identity.userId && identity.username.toLowerCase() === adminHandle) {
        await tx.update(users)
          .set({ role: "admin" })
          .where(and(eq(users.id, identity.userId), eq(users.handle, adminHandle)));
      }
      await tx.insert(authSessions).values({
        tokenHash: hash(token),
        identityId: identity.id,
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
    user: session.user,
    avatarUrl: session.user ? session.user.avatarUrl : session.identity.picture,
    suggestedHandle: /^[a-z0-9_]{3,32}$/.test(
      session.identity.username.toLowerCase(),
    )
      ? session.identity.username.toLowerCase()
      : "",
  });
});
router.post("/profile", async (req, res) => {
  requireOrigin(req);
  const input = z
    .strictObject({ handle: z.string().regex(/^[a-z0-9_]{3,32}$/) })
    .safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_handle");
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
    if (!identity || identity.deletedAt)
      throw new AuthError(401, "sign_in_required");
    if (identity.userId) throw new AuthError(409, "already_onboarded");
    const verifiedAdmin = input.data.handle === adminHandle && identity.username.toLowerCase() === adminHandle;
    if (input.data.handle === reservedAdminHandle && !verifiedAdmin)
      throw new AuthError(409, "handle_unavailable");
    const [created] = await tx
      .insert(users)
      .values({
        handle: input.data.handle,
        role: verifiedAdmin ? "admin" : "user",
        displayName: identity.displayName.slice(0, 80),
      })
      .returning();
    await tx
      .update(authIdentities)
      .set({ userId: created.id })
      .where(eq(authIdentities.id, identity.id));
    return { ...created, avatarUrl: identity.picture };
  });
  res.status(201).json({
    user: {
      id: user.id,
      handle: user.handle,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
    },
  });
});
router.post(["/logout", "/admin/logout"], async (req, res) => {
  const origin = req.path.startsWith("/admin/") ? adminOrigin() : env.APP_ORIGIN;
  if (req.headers.origin !== origin) throw new AuthError(403, "invalid_origin");
  // DELETE waits for an in-flight refresh and returns its newest token.
  const [session] = await db
    .delete(authSessions)
    .where(eq(authSessions.tokenHash, hash(cookie(req, "session"))))
    .returning();
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
