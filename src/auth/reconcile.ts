import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "../db/index.ts";
import { authIdentities, authSessions } from "../db/schema.ts";
import { env } from "../config.ts";
import { decrypt } from "./secrets.ts";
import { metadata } from "./provider.ts";
import { readSessionHash } from "./session.ts";

const profileSchema = z.object({
  id: z
    .union([z.number().int().nonnegative().safe(), z.string().regex(/^\d+$/)])
    .transform(String),
  username: z.string(),
  display_name: z.string().nullable().optional(),
  avatar: z.url().nullable().optional(),
});

export async function reconcileProfiles() {
  const { issuer } = await metadata();
  const sessions = await db
    .select({
      tokenHash: authSessions.tokenHash,
      encryptedTokens: authSessions.encryptedTokens,
    })
    .from(authSessions)
    .innerJoin(authIdentities, eq(authSessions.identityId, authIdentities.id))
    .where(
      and(
        eq(authIdentities.issuer, issuer),
        isNull(authIdentities.deletedAt),
        gt(authSessions.expiresAt, new Date()),
      ),
    );
  let accessToken: string | undefined;
  for (const session of sessions) {
    if (
      !(decrypt(session.encryptedTokens).scope ?? "")
        .split(" ")
        .includes("users:read")
    )
      continue;
    const current = await readSessionHash(session.tokenHash);
    if (current.kind === "anonymous") continue;
    const [fresh] = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.tokenHash, session.tokenHash));
    if (fresh) {
      accessToken = decrypt(fresh.encryptedTokens).access_token;
      break;
    }
  }
  if (!accessToken) {
    console.info({
      event: "profile_reconciliation_skipped",
      reason: "no_directory_session",
    });
    return;
  }
  const identities = await db
    .select()
    .from(authIdentities)
    .where(
      and(eq(authIdentities.issuer, issuer), isNull(authIdentities.deletedAt)),
    );
  let updated = 0;
  for (let offset = 0; offset < identities.length; offset += 100) {
    const batch = identities.slice(offset, offset + 100);
    const url = new URL("/api/users", env.CNS_API_ORIGIN);
    url.searchParams.set(
      "ids",
      batch.map((identity) => identity.subject).join(","),
    );
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        "Directory unavailable; reconciliation can be retried later",
      );
    // Fail visibly if the deployed directory envelope differs from the guide.
    const profiles = z.array(profileSchema).parse(await response.json());
    const requested = new Set(batch.map((identity) => identity.subject));
    for (const profile of profiles) {
      if (!requested.has(profile.id)) continue;
      const previous = batch.find(
        (identity) => identity.subject === profile.id,
      );
      if (!previous) continue;
      await db
        .update(authIdentities)
        .set({
          username: profile.username,
          displayName: profile.display_name ?? "",
          picture: profile.avatar ?? null,
          profileSyncedAt: new Date(),
        })
        .where(
          and(
            eq(authIdentities.issuer, issuer),
            eq(authIdentities.subject, profile.id),
            isNull(authIdentities.deletedAt),
            eq(authIdentities.profileSyncedAt, previous.profileSyncedAt),
          ),
        );
      updated++;
    }
    // Missing IDs never trigger destructive deletion.
  }
  console.info({ event: "profile_reconciliation_complete", updated });
}
if (import.meta.main) {
  try {
    await reconcileProfiles();
  } catch {
    console.error({ event: "profile_reconciliation_failed" });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
