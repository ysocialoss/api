import { avatarNode, h, renderCard, type Node } from "./kit.ts";
import { excerpt, stripUnrenderable, type OgPost } from "./text.ts";

export { avatarDataUri } from "./kit.ts";

const bodySize = (text: string) =>
  text.length < 80 ? 60 : text.length < 160 ? 48 : 40;

function card(post: OgPost, avatar: string | null): Node[] {
  const name = stripUnrenderable(post.author.displayName) || post.author.handle;
  const text =
    excerpt(stripUnrenderable(post.content), 260) ||
    (post.poll
      ? excerpt(stripUnrenderable(post.poll.title), 150)
      : post.gif
        ? "Shared a GIF"
        : post.voice
          ? "Voice message"
          : `${post.parentId ? "Reply" : "Post"} by @${post.author.handle}`);
  return [
    h(
      "div",
      {
        position: "absolute",
        top: 150,
        left: 56,
        width: 1088,
        height: 410,
        flexDirection: "column",
        justifyContent: "space-between",
      },
      [
        h(
          "div",
          {
            flex: 1,
            fontSize: bodySize(text),
            fontWeight: 700,
            lineHeight: 1.2,
            letterSpacing: -1,
            overflow: "hidden",
            wordBreak: "break-word",
          },
          text,
        ),
        h("div", { alignItems: "center", marginTop: 24 }, [
          avatarNode(avatar, name, 64),
          h("div", { flexDirection: "column", marginLeft: 18 }, [
            h("div", { fontSize: 30, fontWeight: 700 }, excerpt(name, 40)),
            h(
              "div",
              { fontSize: 24, color: "#a3a3a3", fontWeight: 700 },
              `@${post.author.handle}${post.parentId ? " · reply" : ""}`,
            ),
          ]),
        ]),
      ],
    ),
  ];
}

export function renderPostCard(post: OgPost, avatar: string | null = null) {
  return renderCard(card(post, avatar));
}
