export type OgPost = {
  id: string;
  parentId: string | null;
  content: string;
  poll: { title: string } | null;
  gif: unknown | null;
  voice: unknown | null;
  author: { handle: string; displayName: string };
};

export type OgProfile = {
  handle: string;
  displayName: string;
  bio: string;
  pronouns: string;
  followerCount: number;
  followingCount: number;
  postCount: number;
};

export const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();

const unrenderable =
  /[\p{Extended_Pictographic}\p{So}\p{Sk}←-⇿∀-⋿‍️]|[^\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]/gu;
export const stripUnrenderable = (value: string) =>
  collapse(value.replace(unrenderable, ""));

export function excerpt(value: string, max: number) {
  const text = collapse(value);
  const chars = [...text];
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max - 1).join("");
  const word = cut.replace(/\s+\S*$/, "");
  return `${(word.length > max * 0.6 ? word : cut).trimEnd()}…`;
}

export function postSummary(post: OgPost) {
  const text = excerpt(post.content, 200);
  if (text) return text;
  if (post.poll) return `Poll: ${excerpt(post.poll.title, 150)}`;
  if (post.gif) return "Shared a GIF";
  if (post.voice) return "Voice message";
  return `${post.parentId ? "Reply" : "Post"} by @${post.author.handle} on ysocial`;
}

export function postMeta(post: OgPost, origin: string) {
  const name = post.author.displayName || post.author.handle;
  return {
    title: `${name} (@${post.author.handle}) on ysocial`,
    description: postSummary(post),
    url: `${origin}/posts/${post.id}`,
    image: `${origin}/api/og/posts/${post.id}.png`,
  };
}

export function profileSummary(profile: OgProfile) {
  const bio = excerpt(profile.bio, 160);
  if (bio) return bio;
  const posts = profile.postCount === 1 ? "1 post" : `${profile.postCount} posts`;
  return `@${profile.handle} on ysocial · ${posts}`;
}

export function profileMeta(profile: OgProfile, origin: string) {
  const name = profile.displayName || profile.handle;
  return {
    title: `${name} (@${profile.handle}) on ysocial`,
    description: profileSummary(profile),
    url: `${origin}/@${profile.handle}`,
    image: `${origin}/api/og/profiles/${profile.handle}.png`,
    type: "profile" as const,
  };
}

export function metaPage(
  meta: {
    title: string;
    description: string;
    url: string;
    image: string;
    type?: "article" | "profile";
  },
  body: string,
) {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const url = escapeHtml(meta.url);
  const image = escapeHtml(meta.image);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<meta name="description" content="${description}" />
<link rel="canonical" href="${url}" />
<meta property="og:site_name" content="ysocial" />
<meta property="og:type" content="${meta.type ?? "article"}" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="${image}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${title}" />
<meta name="twitter:description" content="${description}" />
<meta name="twitter:image" content="${image}" />
</head>
<body>
<h1>${title}</h1>
<p>${escapeHtml(body)}</p>
<p><a href="${url}">View on ysocial</a></p>
</body>
</html>
`;
}
