import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { runImageWork } from "../storage/image-work.ts";
import { AuthError } from "../auth/provider.ts";
import { env } from "../config.ts";
import { db } from "../db/index.ts";
import { csamIncidents, users } from "../db/schema.ts";
import { publishAccountChange } from "../live-events.ts";
import { publishUserPostVisibility } from "../user-removal.ts";

export type Surface = "post_image" | "avatar" | "banner" | "flag";
export type MatchResult = { matched: boolean; provider: string; matchId?: string | null };

export interface HashMatcher {
  readonly name: string;
  match(frame: Buffer): Promise<MatchResult>;
}

const photoDnaMatcher = (url: string, key: string): HashMatcher => ({
  name: "photodna",
  async match(frame) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "image/png", "Ocp-Apim-Subscription-Key": key },
      body: new Uint8Array(frame),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`PhotoDNA answered ${response.status}`);
    const result = await response.json() as {
      IsMatch?: boolean;
      Status?: { Code?: number };
      MatchDetails?: { MatchFlags?: { MatchId?: string | number; Source?: string }[] };
    };
    if (result.Status?.Code !== undefined && result.Status.Code !== 3000) throw new Error(`PhotoDNA status ${result.Status.Code}`);
    const flag = result.MatchDetails?.MatchFlags?.[0];
    return {
      matched: result.IsMatch === true,
      provider: "photodna",
      matchId: flag ? [flag.Source, flag.MatchId].filter((value) => value !== undefined).join(":") || null : null,
    };
  },
});

let override: HashMatcher | null | undefined;

export function setHashMatcher(matcher: HashMatcher | null | undefined) {
  override = matcher;
}

export function hashMatcher(): HashMatcher | null {
  if (override !== undefined) return override;
  if (env.PHOTODNA_URL && env.PHOTODNA_KEY) return photoDnaMatcher(env.PHOTODNA_URL, env.PHOTODNA_KEY);
  return null;
}

async function frames(bytes: Buffer) {
  return runImageWork(async () => {
    const metadata = await sharp(bytes, { animated: true, limitInputPixels: 40_000_000 }).metadata();
    const pages = Math.max(1, metadata.pages ?? 1);
    const picks = [...new Set([0, Math.floor(pages / 2), pages - 1])];
    // One frame at a time: decoding all picks in parallel multiplies the peak memory.
    const decoded: Buffer[] = [];
    for (const page of picks)
      decoded.push(await sharp(bytes, { page, limitInputPixels: 40_000_000 })
        .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer());
    return decoded;
  });
}

export async function recordIncident(details: {
  userId: string | null;
  surface: Surface;
  provider: string;
  matchId?: string | null;
  bytes: Buffer;
  mime: string;
  ip?: string | null;
}) {
  return db.transaction(async (tx) => {
    const [user] = details.userId
      ? await tx.select({ id: users.id, handle: users.handle, bannedAt: users.bannedAt, role: users.role })
        .from(users).where(eq(users.id, details.userId)).for("update")
      : [];
    const [incident] = await tx.insert(csamIncidents).values({
      userId: user?.id ?? details.userId,
      handle: user?.handle ?? "",
      surface: details.surface,
      provider: details.provider,
      matchId: details.matchId ?? null,
      sha256: createHash("sha256").update(details.bytes).digest("hex"),
      mime: details.mime,
      size: details.bytes.length,
      ip: details.ip ?? null,
    }).returning({ id: csamIncidents.id });
    if (user && !user.bannedAt && user.role !== "admin") {
      await tx.update(users).set({ bannedAt: new Date(), banReason: "Account suspended pending a safety review." })
        .where(eq(users.id, user.id));
      await publishAccountChange(tx, user.id);
      await publishUserPostVisibility(tx, user.id);
    }
    return incident.id;
  });
}

export async function scanUpload(input: { bytes: Buffer; mime: string; surface: Surface; uploaderId: string; ip?: string | null }) {
  const matcher = hashMatcher();
  if (!matcher) return;
  let result: MatchResult = { matched: false, provider: matcher.name };
  let decoded: Buffer[];
  try {
    decoded = await frames(input.bytes);
  } catch {
    return;
  }
  try {
    for (const frame of decoded) {
      result = await matcher.match(frame);
      if (result.matched) break;
    }
  } catch {
    console.error({ event: "hash_match_unavailable", provider: matcher.name });
    throw new AuthError(503, "safety_check_unavailable");
  }
  if (!result.matched) return;
  const incident = await recordIncident({
    userId: input.uploaderId, surface: input.surface, provider: result.provider, matchId: result.matchId,
    bytes: input.bytes, mime: input.mime, ip: input.ip,
  });
  console.warn({ event: "safety_incident", incident });
  throw new AuthError(422, "upload_rejected");
}
