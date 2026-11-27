import { Router } from "express";
import { z } from "zod";
import { requireOrigin } from "./auth/request.ts";
import { AuthError } from "./auth/provider.ts";
import { db } from "./db/index.ts";
import { contactMessages } from "./db/schema.ts";

const windowMs = 10 * 60_000;
const limit = 3;
const recentByIp = new Map<string, number[]>();

function rateLimit(key: string) {
  const now = Date.now();
  const recent = (recentByIp.get(key) ?? []).filter((at) => now - at < windowMs);
  if (recent.length >= limit) throw new AuthError(429, "contact_rate_limited");
  recent.push(now);
  recentByIp.set(key, recent);
  if (recentByIp.size > 10_000) recentByIp.clear();
}

const plain = (max: number) => z.string().max(max).refine((value) => !value.includes("\u0000"));
const input = z.strictObject({
  name: plain(100).trim().optional(),
  email: z.union([z.literal(""), z.email().max(254)]).optional(),
  message: plain(2000).trim().min(10),
  website: z.string().max(200).optional(),
});

const router = Router();

router.post("/", async (req, res) => {
  requireOrigin(req);
  const parsed = input.safeParse(req.body);
  if (!parsed.success) throw new AuthError(400, "invalid_contact_message");
  if (parsed.data.website) {
    res.status(204).end();
    return;
  }
  rateLimit(req.ip ?? "unknown");
  await db.insert(contactMessages).values({
    name: parsed.data.name || null,
    email: parsed.data.email || null,
    message: parsed.data.message,
  });
  res.status(204).end();
});

export default router;
