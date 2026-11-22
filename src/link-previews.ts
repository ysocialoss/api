import { createHash } from "node:crypto";
import { parse } from "parse5";
import sharp from "sharp";
import { postLinks } from "./post-links.ts";
import { canPreviewUrl, fetchPublicPreview } from "./public-preview-fetch.ts";

const htmlTypes = new Set(["text/html", "application/xhtml+xml"]);
const imageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);
const rasterFormats = new Set(["jpeg", "png", "webp", "gif", "heif"]);
const iconTypes = new Set([
  ...imageTypes,
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/ico",
  "image/svg+xml",
]);
const CACHE_LIMIT = 512;
const CACHE_AGE = 10 * 60_000;
const LINK_BATCH_SIZE = 4;
const imgurFavicon = new URL("https://s.imgur.com/images/favicon-32x32.png");

export function websiteLinks(content: string) {
  const links = postLinks(content).filter(
    (url) => url.hostname !== "ysocial.cns-preview.de" && canPreviewUrl(url),
  );
  return [...new Map(links.map((url) => [url.href, url])).values()];
}

function cleanText(value: string | undefined, limit: number) {
  return value?.replace(/\s+/g, " ").trim().slice(0, limit) || undefined;
}

export function readPreviewMetadata(html: string, url: URL) {
  const root = parse(html).childNodes.find(
    (node) => "tagName" in node && node.tagName === "html",
  );
  const head =
    root && "childNodes" in root
      ? root.childNodes.find(
          (node) => "tagName" in node && node.tagName === "head",
        )
      : undefined;
  if (!head || !("childNodes" in head)) return;

  const metadata = new Map<string, string>();
  let icon: URL | undefined;
  let vectorIcon: URL | undefined;
  let pageTitle: string | undefined;
  for (const node of head.childNodes) {
    if (!("tagName" in node)) continue;
    if (node.tagName === "title") {
      pageTitle = node.childNodes.find((child) => "value" in child)?.value;
    }
    if (node.tagName === "link") {
      const rel = node.attrs
        .find(({ name }) => name === "rel")
        ?.value.toLowerCase();
      const href = node.attrs.find(({ name }) => name === "href")?.value;
      const candidate =
        href && rel?.split(/\s+/).includes("icon")
          ? URL.parse(href, url)
          : null;
      if (candidate && canPreviewUrl(candidate)) {
        const type = node.attrs.find(({ name }) => name === "type")?.value;
        if (type === "image/svg+xml" || /\.svg$/i.test(candidate.pathname))
          vectorIcon ??= candidate;
        else icon ??= candidate;
      }
    }
    if (node.tagName !== "meta") continue;
    const name = node.attrs
      .find(({ name }) => name === "property" || name === "name")
      ?.value.toLowerCase();
    const value = node.attrs
      .find(({ name }) => name === "content")
      ?.value.trim();
    if (name && value && !metadata.has(name)) metadata.set(name, value);
  }
  const title = cleanText(
    metadata.get("og:title") || metadata.get("twitter:title") || pageTitle,
    180,
  );
  if (!title) return;
  const description = cleanText(
    metadata.get("og:description") ||
      metadata.get("twitter:description") ||
      metadata.get("description"),
    320,
  );
  const siteName = cleanText(metadata.get("og:site_name"), 80) ?? url.hostname;
  const image = [
    "og:image:secure_url",
    "og:image",
    "og:image:url",
    "twitter:image",
    "twitter:image:src",
  ]
    .map((key) => {
      const value = metadata.get(key);
      return value ? URL.parse(value, url) : null;
    })
    .find((value) => value && canPreviewUrl(value));
  return {
    title,
    description,
    siteName,
    image,
    icon: icon ?? vectorIcon ?? new URL("/favicon.ico", url),
  };
}

type PreviewMetadata = NonNullable<ReturnType<typeof readPreviewMetadata>>;
const cache = new Map<
  string,
  { deadline: number; result: Promise<PreviewMetadata | undefined> }
>();

function metadataFor(source: URL) {
  const url = new URL(source);
  url.hash = "";
  const cached = cache.get(url.href);
  if (cached && cached.deadline > Date.now()) return cached.result;
  cache.delete(url.href);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const result = fetchPublicPreview(url, {
    accept: "text/html, application/xhtml+xml",
    types: htmlTypes,
    byteLimit: 256 * 1024,
    allowPartial: true,
  })
    .then(
      (page) =>
        page && readPreviewMetadata(page.body.toString("utf8"), page.url),
    )
    .catch(() => undefined);
  cache.set(url.href, { deadline: Date.now() + CACHE_AGE, result });
  return result;
}

function assetKey(url: URL) {
  return createHash("sha256").update(url.href).digest("hex");
}

export function imgurImageUrl(url: URL) {
  if (!canPreviewUrl(url)) return;
  if (url.hostname === "i.imgur.com") {
    if (/^\/[a-z0-9]+\.(?:png|jpe?g|gif|webp|avif)$/i.test(url.pathname)) {
      const image = new URL(url);
      image.hash = "";
      return image;
    }
    return;
  }
  if (url.hostname !== "imgur.com" && url.hostname !== "www.imgur.com") return;
  const page = /^\/([a-z0-9]{5}|[a-z0-9]{7})\/?$/i.exec(url.pathname)?.[1];
  if (page && /[A-Z0-9]/.test(page))
    return new URL(`https://i.imgur.com/${page}.png`);
}

function isImgurAlbum(url: URL) {
  return (
    (url.hostname === "imgur.com" || url.hostname === "www.imgur.com") &&
    /^\/a\/[a-z0-9]+\/?$/i.test(url.pathname)
  );
}

export async function previewsForPost(content: string, offset = 0) {
  const sources = websiteLinks(content);
  const end = offset + LINK_BATCH_SIZE;
  const details = await Promise.all(
    sources.slice(offset, end).map(async (url) => {
      if (imgurImageUrl(url))
        return { kind: "image" as const, url, key: assetKey(url) };
      const metadata = await metadataFor(url);
      if (
        isImgurAlbum(url) &&
        metadata?.image &&
        imgurImageUrl(metadata.image)
      )
        return { kind: "image" as const, url, key: assetKey(url) };
      return metadata
        ? { kind: "website" as const, url, metadata, key: assetKey(url) }
        : null;
    }),
  );
  const first = offset === 0 ? details[0] : undefined;
  return {
    nextOffset: end < sources.length ? end : undefined,
    links: details.flatMap((entry) =>
      entry
        ? [
            {
              href: entry.url.href,
              title:
                entry.kind === "image" ? "Imgur image" : entry.metadata.title,
              iconKey: entry.key,
            },
          ]
        : [],
    ),
    previews:
      first?.kind === "image"
        ? [
            {
              kind: "image",
              href: first.url.href,
              title: "Imgur image",
              imageKey: first.key,
              iconKey: first.key,
            },
          ]
        : first
          ? [
              {
                href: first.url.href,
                title: first.metadata.title,
                description: first.metadata.description,
                siteName: first.metadata.siteName,
                imageKey: first.metadata.image ? first.key : undefined,
                iconKey: first.key,
              },
            ]
          : [],
  };
}

export async function previewIconForPost(content: string, key: string) {
  const source = websiteLinks(content).find((url) => assetKey(url) === key);
  if (!source) return;
  return iconForSite(source);
}

export async function iconForSite(source: URL) {
  const direct = imgurImageUrl(source);
  const icon = direct ? imgurFavicon : (await metadataFor(source))?.icon;
  if (!icon) return;
  try {
    return await fetchPublicPreview(icon, {
      accept: [...iconTypes].join(", "),
      types: iconTypes,
      byteLimit: 128 * 1024,
      sameHost: Boolean(direct),
    });
  } catch {
    return;
  }
}

export async function previewImageForPost(content: string, key: string) {
  const source = websiteLinks(content)[0];
  if (!source || assetKey(source) !== key) return;
  const direct = imgurImageUrl(source);
  const url = direct ?? (await metadataFor(source))?.image;
  if (!url) return;
  try {
    const result = await fetchPublicPreview(url, {
      accept: [...imageTypes].join(", "),
      types: imageTypes,
      byteLimit: (direct ? 5 : 2) * 1024 * 1024,
      sameHost: Boolean(direct),
    });
    if (!result) return;
    const image = sharp(result.body, {
      limitInputPixels: 12_000_000,
      failOn: "error",
    });
    const { format } = await image.metadata();
    if (!format || !rasterFormats.has(format)) return;
    return await image
      .rotate()
      .resize(direct ? 1200 : 800, direct ? 1200 : 450, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    return;
  }
}
