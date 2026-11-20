import { avatarNode, h, renderCard, type Node } from "./kit.ts";
import { excerpt, stripUnrenderable, type OgProfile } from "./text.ts";

const counts = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const stat = (value: number, label: string) =>
  h("div", { alignItems: "baseline", marginRight: 40 }, [
    h("div", { fontSize: 36, fontWeight: 700 }, counts.format(value)),
    h("div", { fontSize: 26, color: "#a3a3a3", fontWeight: 700, marginLeft: 10 }, label),
  ]);

function card(profile: OgProfile, avatar: string | null): Node[] {
  const name = stripUnrenderable(profile.displayName) || profile.handle;
  const bio = excerpt(stripUnrenderable(profile.bio), 160);
  const pronouns = excerpt(stripUnrenderable(profile.pronouns), 40);
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
        h("div", { flexDirection: "column" }, [
          h("div", { alignItems: "center" }, [
            avatarNode(avatar, name, 144),
            h("div", { flexDirection: "column", marginLeft: 36, flex: 1 }, [
              h(
                "div",
                { fontSize: 60, fontWeight: 700, letterSpacing: -1.5, lineHeight: 1.1, overflow: "hidden" },
                excerpt(name, 28),
              ),
              h(
                "div",
                { fontSize: 32, color: "#a3a3a3", fontWeight: 700, marginTop: 6 },
                pronouns ? `@${profile.handle} · ${pronouns}` : `@${profile.handle}`,
              ),
            ]),
          ]),
          bio
            ? h(
                "div",
                {
                  marginTop: 32,
                  fontSize: bio.length < 90 ? 38 : 32,
                  fontWeight: 700,
                  lineHeight: 1.25,
                  overflow: "hidden",
                  wordBreak: "break-word",
                },
                bio,
              )
            : null,
        ]),
        h("div", { alignItems: "baseline" }, [
          stat(profile.followerCount, profile.followerCount === 1 ? "follower" : "followers"),
          stat(profile.followingCount, "following"),
          stat(profile.postCount, profile.postCount === 1 ? "post" : "posts"),
        ]),
      ],
    ),
  ];
}

export function renderProfileCard(profile: OgProfile, avatar: string | null = null) {
  return renderCard(card(profile, avatar));
}
