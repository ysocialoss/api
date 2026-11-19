import { readSession } from "./session.ts";
import type { Request } from "express";
import { env } from "../config.ts";
import { AuthError } from "./provider.ts";

export function cookie(req: Request, key: string) {
  return (
    req.headers.cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${key}=`))
      ?.slice(key.length + 1) ?? ""
  );
}
export function requireOrigin(req: Request, origin = env.APP_ORIGIN) {
  if (req.headers.origin !== origin)
    throw new AuthError(403, "invalid_origin");
}

export async function readViewerId(req: Request): Promise<string | null> {
  const token = cookie(req, "session");
  if (!token) return null;
  try {
    const session = await readSession(token);
    return session.kind === "authenticated" ? (session.user?.id ?? null) : null;
  } catch (error) {
    // Public posts remain readable during a temporary provider outage.
    if (error instanceof AuthError && error.status === 503) return null;
    throw error;
  }
}

export async function requireUser(req: Request) {
  requireOrigin(req);
  return requireSessionUser(req);
}

// Safe reads authenticate the session without requiring the Origin header
// that browsers omit on same-origin GET requests.
export async function requireSessionUser(req: Request) {
  const session = await readSession(cookie(req, "session"));
  if (session.kind === "anonymous")
    throw new AuthError(401, "sign_in_required");
  if (!session.user) throw new AuthError(403, "onboarding_required");
  return session.user;
}
