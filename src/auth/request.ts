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
export function requireOrigin(req: Request) {
  if (req.headers.origin !== env.APP_ORIGIN)
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
