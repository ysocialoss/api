import type { notifications } from "./db/schema.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const descriptions = {
  like: "liked your post",
  repost: "reposted your post",
  friends_repost: "reposted your post to friends",
  quote: "quoted your post",
  reply: "replied to your post",
  follow: "followed you",
  friend: "is now your friend",
  mention: "mentioned you in a post",
};

export function notificationPreview(content: string, hasGif = false, hasVoice = false) {
  const text = content.replace(/\s+/gu, " ").trim();
  if (!text && hasVoice) return "Voice message";
  if (!text && hasGif) return "GIF";
  const characters = Array.from(graphemes.segment(text), (part) => part.segment);
  return characters.length > 160
    ? `${characters.slice(0, 159).join("")}…`
    : text;
}

export function pushNotificationContent({ notification, actor, content, hideContent, hasGif, hasVoice }: {
  notification: Pick<typeof notifications.$inferSelect, "id" | "kind" | "conversationId" | "postId" | "recipientId">;
  actor: { displayName: string; handle: string; avatarUrl: string | null };
  content: string | null;
  hideContent: boolean;
  hasGif: boolean;
  hasVoice: boolean;
}) {
  const { id, kind, conversationId, postId } = notification;
  const base = { id, title: "ysocial" };
  if (kind === "dm_invite" || kind === "dm_message") {
    return {
      ...base,
      body: kind === "dm_invite" ? "New chat invite" : "New message",
      icon: "/favicon.png",
      url: conversationId ? `/messages/${conversationId}` : "/messages",
      ...(kind === "dm_message" && !hideContent ? { chatRecipient: notification.recipientId } : {}),
    };
  }
  const summary = `${actor.displayName || actor.handle} ${descriptions[kind]}`;
  const preview = !hideContent && (kind === "reply" || kind === "mention") && content !== null
    ? notificationPreview(content, hasGif, hasVoice)
    : null;
  return {
    ...base,
    body: preview ? `${summary}\n${preview}` : summary,
    icon: actor.avatarUrl ?? "/favicon.png",
    url: postId ? `/posts/${postId}` : `/@${actor.handle}`,
  };
}
