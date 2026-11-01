import { and, eq, gt } from "drizzle-orm";
import { db } from "../db/index.ts";
import { authSessions, authIdentities, users } from "../db/schema.ts";
import { env } from "../config.ts";
import { AuthError, providerPost, tokensSchema } from "./provider.ts";
import { decrypt, encrypt, hash } from "./secrets.ts";

export function readSession(token: string) {
  return readSessionHash(hash(token));
}

// Used by the server-only reconciliation command; never exposed over HTTP.
export async function readSessionHash(tokenHash: string) {
  const outcome = await db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(authSessions)
      .where(
        and(
          eq(authSessions.tokenHash, tokenHash),
          gt(authSessions.expiresAt, new Date()),
        ),
      )
      .for("update");
    if (!session) return { kind: "anonymous" } as const;
    if (session.retryAfter && session.retryAfter.getTime() > Date.now())
      return { kind: "unavailable" } as const;
    if (session.refreshAfter.getTime() <= Date.now()) {
      const tokens = decrypt(session.encryptedTokens);
      try {
        const response = await providerPost("/api/auth/token/refresh", {
          refresh_token: tokens.refresh_token,
          client_id: env.CNS_CLIENT_ID,
        });
        if (response.status === 401) {
          await tx
            .delete(authSessions)
            .where(eq(authSessions.tokenHash, session.tokenHash));
          return { kind: "anonymous" } as const;
        }
        if (!response.ok) throw new AuthError(503, "provider_unavailable");
        const rotated = tokensSchema.parse(await response.json());
        await tx
          .update(authSessions)
          .set({
            encryptedTokens: encrypt({
              ...rotated,
              scope: rotated.scope ?? tokens.scope,
            }),
            refreshAfter: new Date(Date.now() + rotated.expires_in * 800),
            retryAfter: null,
            refreshFailures: 0,
          })
          .where(eq(authSessions.tokenHash, session.tokenHash));
      } catch {
        const failures = session.refreshFailures + 1;
        await tx
          .update(authSessions)
          .set({
            refreshFailures: failures,
            retryAfter: new Date(
              Date.now() +
                Math.min(60000, 1000 * 2 ** Math.min(failures - 1, 6)) +
                Math.random() * 500,
            ),
          })
          .where(eq(authSessions.tokenHash, session.tokenHash));
        return { kind: "unavailable" } as const;
      }
    }
    const [identity] = await tx
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.id, session.identityId));
    if (!identity || identity.deletedAt) {
      await tx
        .delete(authSessions)
        .where(eq(authSessions.tokenHash, session.tokenHash));
      return { kind: "anonymous" } as const;
    }
    const [user] = identity.userId
      ? await tx
          .select({
            id: users.id,
            handle: users.handle,
            displayName: users.displayName,
          })
          .from(users)
          .where(eq(users.id, identity.userId))
      : [];
    return { kind: "authenticated", identity, user: user ?? null } as const;
  });
  if (outcome.kind === "unavailable")
    throw new AuthError(503, "provider_unavailable");
  return outcome;
}
