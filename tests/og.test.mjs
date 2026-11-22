import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://og:og@localhost/og";
process.env.KLIPY_API_KEY = "og-test-key";

const { renderPostCard } = await import("../src/og/post-card.ts");
const { renderProfileCard } = await import("../src/og/profile-card.ts");
const {
  excerpt,
  metaPage,
  postMeta,
  postSummary,
  profileMeta,
  profileSummary,
  stripUnrenderable,
} = await import("../src/og/text.ts");
const { app } = await import("../src/app.ts");

const post = {
  id: "11111111-2222-4333-8444-555555555555",
  parentId: null,
  content: "Hello <script>alert(1)</script> \"world\"",
  poll: null,
  gif: null,
  voice: null,
  author: { handle: "aaron", displayName: "Aaron" },
};

const profile = {
  handle: "aaron",
  displayName: "Aaron <b>",
  bio: "Builds <things>",
  pronouns: "he/him",
  followerCount: 1234,
  followingCount: 5,
  postCount: 1,
};

await test("image text keeps supported scripts and drops the rest", () => {
  assert.equal(stripUnrenderable("Hi 🎉 Привет Γειά 日本語 → ok"), "Hi Привет Γειά ok");
  assert.equal(stripUnrenderable("日本語"), "");
});

await test("excerpts end on a word and stay within the limit", () => {
  const text = "alpha beta gamma delta epsilon zeta eta theta";
  const short = excerpt(text, 20);
  assert.ok([...short].length <= 20 && short.endsWith("…"));
  assert.equal(short, "alpha beta gamma…");
  assert.equal(excerpt("  a   b ", 20), "a b");
});

await test("summaries fall back for posts without text", () => {
  assert.equal(postSummary({ ...post, content: "", poll: { title: "Pick" } }), "Poll: Pick");
  assert.equal(postSummary({ ...post, content: "", gif: {} }), "Shared a GIF");
  assert.equal(postSummary({ ...post, content: "", parentId: "x" }), "Reply by @aaron on ysocial");
});

await test("meta page escapes post content", () => {
  const meta = postMeta(post, "https://ysocial.cc");
  const html = metaPage(meta, postSummary(post));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes('content="https://ysocial.cc/api/og/posts/' + post.id + '.png"'));
  assert.ok(html.includes(`<link rel="canonical" href="https://ysocial.cc/posts/${post.id}" />`));
});

await test("renders a 1200x630 PNG even for text with no renderable glyphs", async () => {
  const png = await renderPostCard({ ...post, content: "日本語" });
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

await test("routes reject malformed post ids before touching the database", async () => {
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/og/posts`;
    for (const path of ["nope", "nope.png", "../x"]) {
      const response = await fetch(`${base}/${path}`);
      assert.equal(response.status, 404, path);
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

await test("profile meta page points at the profile and its own image", () => {
  const meta = profileMeta(profile, "https://ysocial.cc");
  const html = metaPage(meta, profileSummary(profile));
  assert.ok(html.includes('<meta property="og:type" content="profile" />'));
  assert.ok(html.includes('content="https://ysocial.cc/api/og/profiles/aaron.png"'));
  assert.ok(html.includes('<link rel="canonical" href="https://ysocial.cc/@aaron" />'));
  assert.ok(!html.includes("<b>") && !html.includes("<things>"));
  assert.equal(
    profileSummary({ ...profile, bio: "" }),
    "@aaron on ysocial · 1 post",
  );
});

await test("renders a 1200x630 profile PNG with and without a bio", async () => {
  for (const input of [profile, { ...profile, bio: "", pronouns: "", displayName: "日本語" }]) {
    const png = await renderProfileCard(input);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
  }
});

await test("profile routes reject malformed handles before touching the database", async () => {
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/og/profiles`;
    for (const path of ["no", "no.png", "bad-handle", "bad-handle.png", "a".repeat(40)]) {
      const response = await fetch(`${base}/${path}`);
      assert.equal(response.status, 404, path);
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
