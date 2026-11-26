import { Router } from "express";
import { AuthError } from "./auth/provider.ts";
import { klipyMediaUrl } from "./storage/klipy.ts";

const maxBytes = 20 * 1024 * 1024;
const allowedTypes = new Set(["image/gif", "image/webp", "image/png", "image/jpeg", "video/mp4", "video/webm"]);

const router = Router();

router.get("/media", async (req, res) => {
  const parsed = klipyMediaUrl.safeParse(req.query.u);
  if (!parsed.success) throw new AuthError(400, "invalid_gif_url");
  let upstream: Response;
  try {
    upstream = await fetch(parsed.data, {
      redirect: "error",
      headers: { Accept: "image/*,video/*", "User-Agent": "YSocial Media Proxy" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AuthError(502, "gif_unavailable");
  }
  const type = upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  const length = Number(upstream.headers.get("content-length") ?? 0);
  if (!upstream.ok || !upstream.body || !allowedTypes.has(type) || length > maxBytes) {
    await upstream.body?.cancel();
    throw new AuthError(upstream.status === 404 ? 404 : 502, "gif_unavailable");
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  if (body.length > maxBytes) throw new AuthError(502, "gif_unavailable");
  res.set({
    "Content-Type": type,
    "Cache-Control": "public, max-age=604800, immutable",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  });
  res.send(body);
});

export default router;
