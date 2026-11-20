import assert from "node:assert/strict";
import test from "node:test";
import { notificationPreview, pushNotificationContent } from "../src/notification-content.ts";

test("short previews are collapsed and trimmed", () => {
  assert.equal(notificationPreview("  hello \n\n world  "), "hello world");
  assert.equal(notificationPreview("love it ❤️👨‍👩‍👧‍👦"), "love it ❤️👨‍👩‍👧‍👦");
});

test("long previews never cut an emoji in half", () => {
  const family = "👨‍👩‍👧‍👦";
  const content = family.repeat(200);
  const preview = notificationPreview(content);
  assert.equal(preview, `${family.repeat(159)}…`);
  const flags = notificationPreview(`${"a".repeat(158)}🇩🇪🇩🇪🇩🇪`);
  assert.equal(flags, `${"a".repeat(158)}🇩🇪…`);
});

test("GIF posts use their caption or a GIF fallback", () => {
  assert.equal(notificationPreview("", true), "GIF");
  assert.equal(notificationPreview(""), "");
  assert.equal(notificationPreview(" 👋 ", true), "👋");
});

test("voice posts use their caption or a voice fallback", () => {
  assert.equal(notificationPreview("", false, true), "Voice message");
  assert.equal(notificationPreview(" Listen ", false, true), "Listen");
});

test("DM pushes deep-link to the conversation and keep content and sender details private", () => {
  const event = {
    notification: { id: "notification", conversationId: "conversation", postId: null, recipientId: "recipient" },
    actor: { displayName: "Alice", handle: "alice", avatarUrl: "/avatar/alice" },
    content: "Private message",
    hideContent: false,
    hasGif: false,
    hasVoice: false,
  };
  for (const [kind, body] of [
    ["dm_invite", "New chat invite"],
    ["dm_message", "New message"],
  ]) {
    assert.deepEqual(pushNotificationContent({ ...event, notification: { ...event.notification, kind } }), {
      id: "notification",
      title: "ysocial",
      body,
      icon: "/favicon.png",
      url: "/messages/conversation",
      ...(kind === "dm_message" ? { chatRecipient: "recipient" } : {}),
    });
    assert.equal(Object.hasOwn(pushNotificationContent({
      ...event, hideContent: true, notification: { ...event.notification, kind },
    }), "chatRecipient"), false);
  }
});

test("hiding content keeps the push summary and omits text and attachment previews", () => {
  const event = {
    notification: { id: "notification", kind: "reply", conversationId: null, postId: "post" },
    actor: { displayName: "Alice", handle: "alice", avatarUrl: null },
    content: "Hello there",
    hasGif: false,
    hasVoice: false,
  };
  for (const [content, hasVoice, preview] of [["Hello there", false, "Hello there"], ["", true, "Voice message"]]) {
    const input = { ...event, content, hasVoice };
    assert.equal(pushNotificationContent({ ...input, hideContent: false }).body, `Alice replied to your post\n${preview}`);
    const hidden = pushNotificationContent({ ...input, hideContent: true });
    assert.equal(hidden.body, "Alice replied to your post");
    assert.equal(hidden.url, "/posts/post");
  }
});
