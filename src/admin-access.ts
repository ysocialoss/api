import type { Request } from "express";
import { AuthError } from "./auth/provider.ts";
import { requireApprovedUser, requireOrigin } from "./auth/request.ts";
import { env } from "./config.ts";

export async function requireStaff(req: Request) {
  const user = await requireApprovedUser(req);
  if (user.role !== "admin" && user.role !== "moderator")
    throw new AuthError(403, "staff_required");
  return user;
}

export async function requireStaffWrite(req: Request) {
  const viewer = await requireStaff(req);
  if (!env.ADMIN_ORIGIN) throw new AuthError(503, "admin_login_not_configured");
  requireOrigin(req, env.ADMIN_ORIGIN);
  return viewer;
}

export async function requireAdminWrite(req: Request) {
  const viewer = await requireStaffWrite(req);
  if (viewer.role !== "admin") throw new AuthError(403, "admin_required");
  return viewer;
}
