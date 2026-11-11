import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "../config.ts";
import { AuthError } from "../auth/provider.ts";
import { bannerUploadLimit } from "./banner-image.ts";
const mediaUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    ["static.klipy.com", "static1.klipy.com", "static2.klipy.com"].includes(
      url.hostname,
    ) &&
    !url.port &&
    !url.username &&
    !url.password
  );
});
const rendition = z.object({
  url: mediaUrl,
  size: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});
const itemSchema = z.object({
  slug: z.string(),
  title: z.string(),
  type: z.string(),
  file: z.object({
    hd: z.object({ webp: rendition.optional(), gif: rendition.optional() }),
    sm: z.object({ gif: rendition.optional(), webp: rendition.optional() }),
  }),
});
const envelope = z.object({
  result: z.boolean(),
  data: z.object({
    data: z.array(z.unknown()),
    has_next: z.boolean().optional(),
  }),
});
let windowStart = Date.now(),
  calls = 0;
function key() {
  if (!env.KLIPY_API_KEY) throw new AuthError(503, "klipy_not_configured");
  return env.KLIPY_API_KEY;
}
function signature(payload: string) {
  return createHmac("sha256", key()).update(payload).digest("base64url");
}
export async function searchGifs(query: string, page: number, userId: string) {
  const apiKey = key();
  if (Date.now() - windowStart > 3600000) {
    windowStart = Date.now();
    calls = 0;
  }
  if (calls >= 90) throw new AuthError(429, "gif_search_limit");
  calls++;
  const url = new URL(
    `https://api.klipy.com/api/v1/${apiKey}/gifs/${query ? "search" : "trending"}`,
  );
  url.search = new URLSearchParams({
    q: query,
    page: String(page),
    per_page: "12",
    customer_id: createHmac("sha256", apiKey).update(userId).digest("hex"),
    content_filter: "high",
    format_filter: "gif,webp",
  }).toString();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (response.status === 429) throw new AuthError(429, "gif_search_limit");
    if (!response.ok) throw new Error("Search failed");
    const data = envelope.parse(await response.json());
    if (!data.result) throw new Error("Search failed");
    return {
      items: data.data.data.flatMap((raw) => {
        const parsed = itemSchema.safeParse(raw);
        if (!parsed.success || parsed.data.type !== "gif") return [];
        const item = parsed.data;
        const media = item.file.hd.webp ?? item.file.hd.gif;
        const thumbnail = item.file.sm.gif ?? item.file.sm.webp;
        if (!media || !thumbnail || (media.size ?? 0) > bannerUploadLimit)
          return [];
        const payload = Buffer.from(
          JSON.stringify({
            url: media.url,
            userId,
            expires: Date.now() + 30 * 60000,
          }),
        ).toString("base64url");
        return [
          {
            id: item.slug,
            title: item.title,
            previewUrl: thumbnail.url,
            width: thumbnail.width,
            height: thumbnail.height,
            url: media.url,
            token: `${payload}.${signature(payload)}`,
          },
        ];
      }),
      hasNext: data.data.has_next ?? data.data.data.length === 12,
    };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(503, "gif_search_unavailable");
  }
}
export function selectedGifUrl(token: string, userId: string) {
  const [payload, signed] = token.split(".");
  if (!payload || !signed) throw new AuthError(400, "invalid_gif_selection");
  const expected = Buffer.from(signature(payload)),
    actual = Buffer.from(signed);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new AuthError(400, "invalid_gif_selection");
  let data;
  try {
    data = z
      .object({ url: mediaUrl, userId: z.string(), expires: z.number() })
      .parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
  } catch {
    throw new AuthError(400, "invalid_gif_selection");
  }
  if (data.userId !== userId || data.expires < Date.now())
    throw new AuthError(400, "invalid_gif_selection");
  return data.url;
}
