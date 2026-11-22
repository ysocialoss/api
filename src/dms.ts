import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import express, { Router, type Request } from "express";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { requireApprovedUser, requireUser } from "./auth/request.ts";
import { db } from "./db/index.ts";
import { dmAttachments, dmConversations, dmDevices, dmMessages, dmPollVotes, dmReactions, notifications, users } from "./db/schema.ts";
import {
  deviceAction, deviceApproval, deviceLimit, deviceRevocation, directoryLimit, identifier,
  messageInput, messageProof, newDevice, parseInput, pendingLifetime, validDeviceAccess, validDeviceKeys, validSignature,
} from "./dm-protocol.ts";
import { userSelection } from "./user-data.ts";
import { recordNotification } from "./notification-events.ts";
import { attachmentLimit, requestLimit, validReaction } from "./dm-protocol.ts";
import { previewIconForPost, previewImageForPost, previewsForPost } from "./link-previews.ts";
import { publishDmChange, publishDmDeviceChange } from "./dm-events.ts";
import { eraseDmMessage } from "./dm-removal.ts";
import { blockState } from "./blocks.ts";

const router = Router();
const previewAuthor = alias(users, "chat_preview_author");
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Device = typeof dmDevices.$inferSelect;
type Conversation = typeof dmConversations.$inferSelect;
const publicDevice = {
  id: dmDevices.id,
  userId: dmDevices.userId,
  encryptionKey: dmDevices.encryptionKey,
  signingKey: dmDevices.signingKey,
  proof: dmDevices.proof,
  root: dmDevices.root,
  generation: dmDevices.generation,
  approvedBy: dmDevices.approvedBy,
  approval: dmDevices.approval,
  revokedAt: dmDevices.revokedAt,
  revokedBy: dmDevices.revokedBy,
  revocation: dmDevices.revocation,
};
const certified = or(eq(dmDevices.root, true), isNotNull(dmDevices.approvedBy));
const ownDevices = (userId: string) => eq(dmDevices.userId, userId);
const currentDevices = sql`exists (
  select 1 from users where users.id = ${dmDevices.userId} and users.dm_generation = ${dmDevices.generation}
)`;
const pending = and(eq(dmDevices.root, false), isNull(dmDevices.approvedBy), isNull(dmDevices.revokedAt));
const participants = ({ firstUserId, secondUserId }: Conversation) => [firstUserId, secondUserId];
const member = (userId: string) => or(eq(dmConversations.firstUserId, userId), eq(dmConversations.secondUserId, userId));
const expiryCutoff = () => new Date(Date.now() - pendingLifetime);
const hiddenFor = (userId: string) => sql`case when ${dmConversations.firstUserId} = ${userId} then ${dmConversations.firstHiddenAt} else ${dmConversations.secondHiddenAt} end`;
const peerOf = (conversation: Conversation, userId: string) => conversation.firstUserId === userId ? conversation.secondUserId : conversation.firstUserId;
const inviteFields = { invitedBy: dmConversations.invitedBy, inviteStatus: dmConversations.inviteStatus };

function requireAvailableAccounts(accounts: Awaited<ReturnType<typeof lockAccounts>>, viewerId?: string) {
  if (accounts.length !== 2 || accounts.some(({ approvedAt, bannedAt }) => !approvedAt || bannedAt))
    throw new AuthError(403, "dm_conversation_unavailable");
  const opted = accounts.find(({ optedOut }) => optedOut);
  if (opted) throw new AuthError(403, opted.id === viewerId ? "dm_opted_out" : "dm_recipient_opted_out");
}

function isActive(device: Device) {
  return !device.revokedAt && (device.root || !!device.approval);
}

function requireActive(device: Device | undefined): asserts device is Device {
  if (!device || !isActive(device)) throw new AuthError(403, "dm_device_unverified");
}

async function requireDeviceAccess(req: Request, userId: string, deviceId: string, binding = "") {
  const device = await readDevice(userId, deviceId);
  requireActive(device);
  if (!validDeviceAccess(device, req.method, req.originalUrl, binding, req.get("x-dm-time"), req.get("x-dm-signature")))
    throw new AuthError(403, "invalid_dm_device_access");
  return device;
}

// Lock the same account rows in UUID order for roster writes and message sends.
async function lockAccounts(tx: Transaction, ids: string[]) {
  return tx.select({ id: users.id, bannedAt: users.bannedAt, approvedAt: users.approvedAt, generation: users.dmGeneration, optedOut: users.dmOptedOut })
    .from(users).where(inArray(users.id, ids)).orderBy(users.id).for("update");
}

function readDevice(userId: string, id: string, database: Transaction | typeof db = db) {
  return database.query.dmDevices.findFirst({ where: and(ownDevices(userId), currentDevices, eq(dmDevices.id, id)) });
}

async function readContext(req: Request) {
  const viewer = await requireApprovedUser(req);
  const id = parseInput(identifier, req.params.id);
  const deviceId = parseInput(identifier, req.query.device);
  const device = await requireDeviceAccess(req, viewer.id, deviceId);
  const conversation = await readConversation(viewer.id, id);
  return { conversation, device, viewer };
}

async function readConversation(userId: string, id: string) {
  const conversation = await db.query.dmConversations.findFirst({ where: and(member(userId), eq(dmConversations.id, id)) });
  if (!conversation) throw new AuthError(404, "dm_conversation_not_found");
  return conversation;
}

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get("/preferences", async (req, res) => {
  const viewer = await requireApprovedUser(req);
  const [row] = await db.select({ optedOut: users.dmOptedOut }).from(users).where(eq(users.id, viewer.id));
  res.json({ enabled: !row?.optedOut });
});

router.put("/preferences", async (req, res) => {
  const viewer = await requireUser(req);
  const { deviceId, enabled } = parseInput(z.strictObject({ deviceId: identifier, enabled: z.boolean() }), req.body);
  await requireDeviceAccess(req, viewer.id, deviceId, enabled ? "on" : "off");
  await db.transaction(async (tx) => {
    await lockAccounts(tx, [viewer.id]);
    await tx.update(users).set({ dmOptedOut: !enabled }).where(eq(users.id, viewer.id));
    await publishDmDeviceChange(tx, viewer.id);
  });
  res.sendStatus(204);
});

router.get("/devices", async (req, res) => {
  const viewer = await requireApprovedUser(req);
  const devices = await db.select({ ...publicDevice, label: dmDevices.label, createdAt: dmDevices.createdAt })
    .from(dmDevices).where(and(ownDevices(viewer.id), currentDevices, or(certified, and(pending, gt(dmDevices.createdAt, expiryCutoff())))))
    .orderBy(asc(dmDevices.createdAt));
  res.json({ devices });
});

router.post("/devices", async (req, res) => {
  const viewer = await requireUser(req);
  const input = parseInput(newDevice, req.body);
  const registration = { ...input, userId: viewer.id };
  if (!validDeviceKeys(registration)) throw new AuthError(400, "invalid_dm_device_key");

  await db.transaction(async (tx) => {
    const [account] = await lockAccounts(tx, [viewer.id]);
    if (!account?.approvedAt || account.bannedAt) throw new AuthError(403, "dm_conversation_unavailable");
    const roster = and(ownDevices(viewer.id), eq(dmDevices.generation, account.generation));
    await tx.delete(dmDevices).where(and(roster, pending, lt(dmDevices.createdAt, expiryCutoff())));
    const devices = await tx.select().from(dmDevices).where(roster);
    const existing = await tx.query.dmDevices.findFirst({ where: and(ownDevices(viewer.id), eq(dmDevices.id, input.id)) });
    if (existing) {
      if (existing.signingKey !== input.signingKey || existing.encryptionKey !== input.encryptionKey)
        throw new AuthError(409, "invalid_dm_device_key");
      if (existing.revokedAt || existing.generation !== account.generation) throw new AuthError(403, "dm_device_revoked");
      return;
    }
    if (devices.length >= directoryLimit || devices.filter((device) => !device.root && !device.approval).length >= deviceLimit)
      throw new AuthError(409, "dm_device_limit");
    const inserted = await tx.insert(dmDevices).values({ ...registration, root: devices.length === 0, generation: account.generation })
      .onConflictDoNothing().returning({ id: dmDevices.id });
    if (!inserted.length) throw new AuthError(409, "invalid_dm_device_key");
    if (!devices.length) await publishDmDeviceChange(tx, viewer.id);
    else await publishDmChange(tx, viewer.id, { type: "devices" });
  });
  res.sendStatus(204);
});

router.post("/devices/reset", async (req, res) => {
  const viewer = await requireUser(req);
  const { previousRootId, ...input } = parseInput(newDevice.extend({ previousRootId: identifier }), req.body);
  const registration = { ...input, userId: viewer.id };
  if (!validDeviceKeys(registration)) throw new AuthError(400, "invalid_dm_device_key");

  await db.transaction(async (tx) => {
    const [account] = await lockAccounts(tx, [viewer.id]);
    if (!account?.approvedAt || account.bannedAt) throw new AuthError(403, "dm_conversation_unavailable");
    const roster = and(ownDevices(viewer.id), eq(dmDevices.generation, account.generation));
    const root = await tx.query.dmDevices.findFirst({ where: and(roster, eq(dmDevices.root, true)) });
    if (root?.id === input.id && root.signingKey === input.signingKey && root.encryptionKey === input.encryptionKey) return;
    if (root?.id !== previousRootId) throw new AuthError(409, "dm_identity_changed");
    const existing = await tx.query.dmDevices.findFirst({ where: eq(dmDevices.id, input.id) });
    if (existing && (existing.userId !== viewer.id || existing.generation !== account.generation ||
      isActive(existing) || existing.revokedAt ||
      existing.signingKey !== input.signingKey || existing.encryptionKey !== input.encryptionKey))
      throw new AuthError(409, "invalid_dm_device_key");
    const generation = account.generation + 1;
    if (existing) {
      await tx.update(dmDevices).set({ generation, root: true }).where(eq(dmDevices.id, existing.id));
    } else {
      await tx.insert(dmDevices).values({ ...registration, generation, root: true });
    }
    await tx.delete(dmDevices).where(and(roster, pending));
    await tx.update(users).set({ dmGeneration: generation }).where(eq(users.id, viewer.id));
    await publishDmDeviceChange(tx, viewer.id);
  });
  res.sendStatus(204);
});

router.post("/devices/:id/:action", async (req, res) => {
  const viewer = await requireUser(req);
  const targetId = parseInput(identifier, req.params.id);
  const action = parseInput(z.enum(["approve", "revoke"]), req.params.action);
  const { actorId, signature } = parseInput(deviceAction, req.body);
  if (actorId === targetId) throw new AuthError(400, "invalid_dm_request");

  await db.transaction(async (tx) => {
    await lockAccounts(tx, [viewer.id]);
    const devices = await tx.select().from(dmDevices).where(and(ownDevices(viewer.id), currentDevices));
    const actor = devices.find(({ id }) => id === actorId);
    const target = devices.find(({ id }) => id === targetId);
    requireActive(actor);
    if (!target) throw new AuthError(404, "dm_device_not_found");
    const payload = action === "approve" ? deviceApproval(actor.id, target) : deviceRevocation(actor.id, viewer.id, target.id);
    if (!validSignature(actor.signingKey, payload, signature)) throw new AuthError(403, "invalid_dm_signature");

    if (action === "revoke") {
      if (isActive(target)) {
        await tx.update(dmDevices).set({ revokedAt: new Date(), revokedBy: actor.id, revocation: signature })
          .where(eq(dmDevices.id, target.id));
        await publishDmDeviceChange(tx, viewer.id);
      }
      return;
    }
    if (target.revokedAt || target.root) throw new AuthError(409, "dm_device_unavailable");
    if (target.approval) return;
    if (target.createdAt <= expiryCutoff()) throw new AuthError(409, "dm_device_unavailable");
    if (devices.filter(isActive).length >= deviceLimit) throw new AuthError(409, "dm_device_limit");
    await tx.update(dmDevices).set({ approvedBy: actor.id, approval: signature }).where(eq(dmDevices.id, target.id));
    await publishDmDeviceChange(tx, viewer.id);
  });
  res.sendStatus(204);
});

router.get("/conversations", async (req, res) => {
  const viewer = await requireApprovedUser(req);
  await requireDeviceAccess(req, viewer.id, parseInput(identifier, req.query.device));
  const unreadByConversation = db.select({
    id: notifications.conversationId,
    count: sql<number>`count(*)::int`.as("unread_count"),
  }).from(notifications).where(and(
    eq(notifications.recipientId, viewer.id), eq(notifications.kind, "dm_message"), isNull(notifications.readAt),
  )).groupBy(notifications.conversationId).as("dm_unread");
  const conversations = await db.select({
    id: dmConversations.id, peer: userSelection, lastMessageAt: dmConversations.lastMessageAt, ...inviteFields,
    unread: sql<number>`coalesce(${unreadByConversation.count}, 0)`,
    requestSent: sql<number>`case when ${dmConversations.inviteStatus} = 'pending' and ${dmConversations.invitedBy} = ${viewer.id}
      then (select count(*)::int from ${dmMessages} where ${dmMessages.conversationId} = ${dmConversations.id}
        and ${dmMessages.senderId} = ${viewer.id} and ${dmMessages.deletedAt} is null)
      else 0 end`,
  })
    .from(dmConversations)
    .innerJoin(users, eq(users.id, sql`case when ${dmConversations.firstUserId} = ${viewer.id} then ${dmConversations.secondUserId} else ${dmConversations.firstUserId} end`))
    .leftJoin(unreadByConversation, eq(unreadByConversation.id, dmConversations.id))
    .where(and(member(viewer.id), sql`${hiddenFor(viewer.id)} is null`, or(
      and(eq(dmConversations.inviteStatus, "accepted"), isNotNull(dmConversations.lastMessageAt)),
      and(eq(dmConversations.inviteStatus, "accepted"), isNotNull(dmConversations.invitedBy)),
      and(eq(dmConversations.invitedBy, viewer.id), inArray(dmConversations.inviteStatus, ["pending", "declined"])),
      and(isNotNull(dmConversations.invitedBy), sql`${dmConversations.invitedBy} <> ${viewer.id}`, isNotNull(dmConversations.lastMessageAt),
        inArray(dmConversations.inviteStatus, ["pending", "declined"])),
    )))
    .orderBy(sql`${dmConversations.lastMessageAt} desc nulls last`, desc(dmConversations.id));
  res.json({ conversations });
});

router.get("/unread", async (req, res) => {
  const viewer = await requireApprovedUser(req);
  const [row] = await db.select({
    unread: sql<number>`count(*) filter (where ${dmConversations.inviteStatus} <> 'declined')::int`,
    requests: sql<number>`count(distinct ${dmConversations.id}) filter (where ${dmConversations.inviteStatus} = 'pending')::int`,
  })
    .from(notifications)
    .innerJoin(dmConversations, eq(dmConversations.id, notifications.conversationId))
    .where(and(eq(notifications.recipientId, viewer.id), eq(notifications.kind, "dm_message"), isNull(notifications.readAt)));
  res.json({ unread: row?.unread ?? 0, requests: row?.requests ?? 0 });
});

router.post("/conversations", async (req, res) => {
  const viewer = await requireUser(req);
  const { handle, deviceId } = parseInput(z.strictObject({
    handle: z.string().toLowerCase().regex(/^[a-z0-9_]{3,32}$/),
    deviceId: identifier,
  }), req.body);
  await requireDeviceAccess(req, viewer.id, deviceId, handle);
  const peer = await db.query.users.findFirst({ where: eq(users.handle, handle) });
  if (!peer || !peer.approvedAt || peer.bannedAt) throw new AuthError(404, "dm_user_not_found");
  const blocks = await blockState(db, viewer.id, peer.id);
  if (blocks.blocking || blocks.blockedBy) throw new AuthError(403, "dm_blocked");
  if (peer.id === viewer.id) throw new AuthError(400, "dm_self");
  const firstUserId = viewer.id < peer.id ? viewer.id : peer.id;
  const secondUserId = viewer.id < peer.id ? peer.id : viewer.id;
  const conversation = await db.transaction(async (tx) => {
    requireAvailableAccounts(await lockAccounts(tx, [firstUserId, secondUserId]), viewer.id);
    requireActive(await readDevice(viewer.id, deviceId, tx));
    const [inserted] = await tx.insert(dmConversations)
      .values({ firstUserId, secondUserId, invitedBy: viewer.id, inviteStatus: "pending" })
      .onConflictDoNothing({ target: [dmConversations.firstUserId, dmConversations.secondUserId] })
      .returning({ id: dmConversations.id });
    if (inserted) return inserted;
    const existing = await tx.query.dmConversations.findFirst({
      where: and(eq(dmConversations.firstUserId, firstUserId), eq(dmConversations.secondUserId, secondUserId)),
    });
    if (existing) {
      const hidden = existing.firstUserId === viewer.id ? existing.firstHiddenAt : existing.secondHiddenAt;
      if (hidden) {
        await tx.update(dmConversations)
          .set(existing.firstUserId === viewer.id ? { firstHiddenAt: null } : { secondHiddenAt: null })
          .where(eq(dmConversations.id, existing.id));
        await publishDmChange(tx, viewer.id, { type: "conversation", id: existing.id, roster: true });
      }
    }
    return existing;
  });
  if (!conversation) throw new AuthError(404, "dm_conversation_not_found");
  res.json({ id: conversation.id, peerId: peer.id });
});

router.get("/conversations/:id", async (req, res) => {
  const { conversation, viewer } = await readContext(req);
  const ids = participants(conversation);
  const [accounts, devices, [sent]] = await Promise.all([
    db.select({ ...userSelection, optedOut: users.dmOptedOut }).from(users).where(inArray(users.id, ids)),
    db.select(publicDevice).from(dmDevices).where(and(inArray(dmDevices.userId, ids), certified)),
    conversation.inviteStatus === "pending"
      ? db.select({ value: sql<number>`count(*)::int` }).from(dmMessages).where(and(
        eq(dmMessages.conversationId, conversation.id), eq(dmMessages.senderId, conversation.invitedBy ?? viewer.id), isNull(dmMessages.deletedAt),
      ))
      : [],
  ]);
  res.json({
    members: accounts.map(({ optedOut: _optedOut, ...user }) => user),
    devices, invitedBy: conversation.invitedBy, inviteStatus: conversation.inviteStatus,
    selfOptedOut: accounts.some(({ id, optedOut }) => id === viewer.id && optedOut),
    peerOptedOut: accounts.some(({ id, optedOut }) => id !== viewer.id && optedOut),
    requestSent: sent?.value ?? 0,
  });
});

router.post("/conversations/:id/invite", async (req, res) => {
  const viewer = await requireUser(req);
  const id = parseInput(identifier, req.params.id);
  const { deviceId, response } = parseInput(z.strictObject({
    deviceId: identifier, response: z.enum(["accepted", "declined"]),
  }), req.body);
  await requireDeviceAccess(req, viewer.id, deviceId, response);
  const conversation = await readConversation(viewer.id, id);
  if (!conversation.invitedBy || conversation.invitedBy === viewer.id)
    throw new AuthError(403, "dm_invite_recipient_required");

  await db.transaction(async (tx) => {
    requireAvailableAccounts(await lockAccounts(tx, participants(conversation)), viewer.id);
    requireActive(await readDevice(viewer.id, deviceId, tx));
    const [updated] = await tx.update(dmConversations).set({ inviteStatus: response })
      .where(and(eq(dmConversations.id, id), eq(dmConversations.inviteStatus, "pending")))
      .returning({ id: dmConversations.id });
    if (!updated) {
      const current = await tx.query.dmConversations.findFirst({ where: eq(dmConversations.id, id) });
      if (current?.inviteStatus !== response) throw new AuthError(409, "dm_invite_already_answered");
    }
    if (response === "declined") {
      await tx.update(notifications).set({ readAt: new Date() }).where(and(
        eq(notifications.recipientId, viewer.id), eq(notifications.conversationId, id), isNull(notifications.readAt),
      ));
    }
    if (updated) {
      for (const userId of participants(conversation)) {
        await publishDmChange(tx, userId, { type: "conversation", id, roster: true });
      }
    }
  });
  res.sendStatus(204);
});

router.post("/conversations/:id/unblock", async (req, res) => {
  const viewer = await requireUser(req);
  const id = parseInput(identifier, req.params.id);
  const { deviceId } = parseInput(z.strictObject({ deviceId: identifier }), req.body);
  await requireDeviceAccess(req, viewer.id, deviceId, "unblock");
  const conversation = await readConversation(viewer.id, id);
  if (!conversation.invitedBy || conversation.invitedBy === viewer.id)
    throw new AuthError(403, "dm_block_owner_required");
  await db.transaction(async (tx) => {
    requireAvailableAccounts(await lockAccounts(tx, participants(conversation)), viewer.id);
    requireActive(await readDevice(viewer.id, deviceId, tx));
    const [updated] = await tx.update(dmConversations).set({ inviteStatus: "accepted" })
      .where(and(eq(dmConversations.id, id), eq(dmConversations.inviteStatus, "declined")))
      .returning({ id: dmConversations.id });
    if (updated) {
      for (const userId of participants(conversation)) await publishDmChange(tx, userId, { type: "conversation", id, roster: true });
    }
  });
  res.sendStatus(204);
});

router.post("/conversations/:id/close", async (req, res) => {
  const viewer = await requireUser(req);
  const id = parseInput(identifier, req.params.id);
  const { deviceId } = parseInput(z.strictObject({ deviceId: identifier }), req.body);
  await requireDeviceAccess(req, viewer.id, deviceId, "close");
  const conversation = await readConversation(viewer.id, id);
  await db.transaction(async (tx) => {
    await lockAccounts(tx, participants(conversation));
    await tx.update(dmConversations)
      .set(conversation.firstUserId === viewer.id ? { firstHiddenAt: new Date() } : { secondHiddenAt: new Date() })
      .where(eq(dmConversations.id, id));
    await publishDmChange(tx, viewer.id, { type: "conversation", id, roster: true });
  });
  res.sendStatus(204);
});

const cursor = z.string().regex(/^[1-9][0-9]{0,18}$/).transform((value) => BigInt(value))
  .refine((value) => value <= 9_223_372_036_854_775_807n);
const messageQuery = z.strictObject({ device: identifier, before: cursor.optional(), after: cursor.optional() })
  .refine(({ before, after }) => before === undefined || after === undefined);

function messageSelection(deviceId: string) {
  return {
    id: dmMessages.id, senderId: dmMessages.senderId, senderDeviceId: dmMessages.senderDeviceId,
    version: dmMessages.version, iv: dmMessages.iv, ciphertext: dmMessages.ciphertext, signature: dmMessages.signature,
    envelope: sql<string>`(${dmMessages.envelopes} ->> ${deviceId}::text)`,
    sequence: dmMessages.sequence, createdAt: dmMessages.createdAt, editedAt: dmMessages.editedAt,
  };
}

type Selected = { id: string; sequence: bigint };

function byMessage<T extends { messageId: string }>(rows: T[]) {
  const grouped = new Map<string, Omit<T, "messageId">[]>();
  for (const { messageId, ...row } of rows) {
    const entries = grouped.get(messageId);
    if (entries) entries.push(row);
    else grouped.set(messageId, [row]);
  }
  return grouped;
}

async function withReactions<T extends Selected>(messages: T[]) {
  if (!messages.length) return [];
  const ids = messages.map(({ id }) => id);
  const [reactions, votes] = await Promise.all([
    db.select({ messageId: dmReactions.messageId, userId: dmReactions.userId, emoji: dmReactions.emoji })
      .from(dmReactions).where(inArray(dmReactions.messageId, ids)),
    db.select({ messageId: dmPollVotes.messageId, userId: dmPollVotes.userId, option: dmPollVotes.option })
      .from(dmPollVotes).where(inArray(dmPollVotes.messageId, ids)),
  ]);
  const reactionsByMessage = byMessage(reactions);
  const votesByMessage = byMessage(votes);
  return messages.map((message) => ({
    ...message, sequence: String(message.sequence),
    reactions: reactionsByMessage.get(message.id) ?? [],
    votes: votesByMessage.get(message.id) ?? [],
  }));
}

const messageParams = z.strictObject({ id: identifier, messageId: identifier });

router.get("/notification-previews/:id", async (req, res) => {
  const viewer = await requireApprovedUser(req);
  const id = parseInput(identifier, req.params.id);
  const device = await requireDeviceAccess(req, viewer.id, parseInput(identifier, req.query.device));
  const selection = messageSelection(device.id);
  const [event] = await db.select({
    conversationId: dmMessages.conversationId,
    message: selection,
    author: { displayName: previewAuthor.displayName, handle: previewAuthor.handle },
  })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.recipientId))
    .innerJoin(previewAuthor, eq(previewAuthor.id, notifications.actorId))
    .innerJoin(dmMessages, and(
      eq(dmMessages.conversationId, notifications.conversationId),
      eq(dmMessages.senderId, notifications.actorId),
      sql`${dmMessages.id}::text = ${notifications.subject}`,
    ))
    .where(and(
      eq(notifications.id, id), eq(notifications.recipientId, viewer.id), eq(notifications.kind, "dm_message"),
      eq(users.hideNotificationContent, false), sql`${selection.envelope} is not null`,
    ));
  if (!event) {
    res.sendStatus(204);
    return;
  }
  const { conversationId, message, author } = event;
  await readConversation(viewer.id, conversationId);
  const devices = await db.select(publicDevice).from(dmDevices)
    .where(and(inArray(dmDevices.userId, [viewer.id, message.senderId]), certified, currentDevices));
  res.json({ conversationId, author, devices, message: { ...message, sequence: String(message.sequence) } });
});

router.get("/conversations/:id/messages", async (req, res) => {
  const { before, after } = parseInput(messageQuery, req.query);
  const { conversation, device } = await readContext(req);
  const selection = messageSelection(device.id);
  const limit = 40;
  const messages = await db.select(selection).from(dmMessages).where(and(
    eq(dmMessages.conversationId, conversation.id), sql`${selection.envelope} is not null`, isNull(dmMessages.deletedAt),
    before !== undefined ? lt(dmMessages.sequence, before) : undefined,
    after !== undefined ? gt(dmMessages.sequence, after) : undefined,
  )).orderBy(after === undefined ? desc(dmMessages.sequence) : asc(dmMessages.sequence)).limit(limit + 1);
  const page = messages.slice(0, limit);
  if (after === undefined) page.reverse();
  res.json({ messages: await withReactions(page), more: messages.length > limit });
});

router.get("/conversations/:id/messages/:messageId", async (req, res) => {
  const { messageId } = parseInput(messageParams, req.params);
  const { conversation, device } = await readContext(req);
  const selection = messageSelection(device.id);
  const [message] = await db.select(selection).from(dmMessages).where(and(
    eq(dmMessages.id, messageId), eq(dmMessages.conversationId, conversation.id),
    sql`${selection.envelope} is not null`, isNull(dmMessages.deletedAt),
  ));
  if (!message) throw new AuthError(404, "dm_message_not_found");
  res.json({ message: (await withReactions([message]))[0] });
});

router.put("/conversations/:id/read", async (req, res) => {
  const viewer = await requireUser(req);
  const id = parseInput(identifier, req.params.id);
  const { deviceId, messageIds } = parseInput(z.strictObject({
    deviceId: identifier, messageIds: z.array(identifier).min(1).max(40),
  }), req.body);
  const device = await requireDeviceAccess(req, viewer.id, deviceId, JSON.stringify(messageIds));
  const conversation = await readConversation(viewer.id, id);
  const delivered = db.select({ subject: sql`${dmMessages.id}::text` }).from(dmMessages).where(and(
    eq(dmMessages.conversationId, id), inArray(dmMessages.id, messageIds),
    sql`${messageSelection(device.id).envelope} is not null`,
  ));
  await db.transaction(async (tx) => {
    await lockAccounts(tx, [viewer.id]);
    requireActive(await readDevice(viewer.id, device.id, tx));
    const updated = await tx.update(notifications).set({ readAt: new Date() }).where(and(
      eq(notifications.recipientId, viewer.id), eq(notifications.conversationId, conversation.id),
      eq(notifications.kind, "dm_message"), isNull(notifications.readAt),
      inArray(notifications.subject, delivered),
    )).returning({ id: notifications.id });
    if (updated.length) await publishDmChange(tx, viewer.id, { type: "conversation", id: conversation.id, roster: false, read: true });
  });
  res.sendStatus(204);
});

router.post("/conversations/:id/messages", async (req, res) => {
  const viewer = await requireUser(req);
  const id = parseInput(identifier, req.params.id);
  const input = parseInput(messageInput, req.body);
  const conversation = await readConversation(viewer.id, id);
  const ids = participants(conversation);

  await db.transaction(async (tx) => {
    const accounts = await lockAccounts(tx, ids);
    const previous = await tx.query.dmMessages.findFirst({
      columns: { conversationId: true, senderId: true, senderDeviceId: true },
      where: eq(dmMessages.id, input.id),
    });
    if (previous?.conversationId === id && previous.senderId === viewer.id && previous.senderDeviceId === input.senderDeviceId) {
      const sender = await readDevice(viewer.id, input.senderDeviceId, tx);
      requireActive(sender);
      if (!validSignature(sender.signingKey, messageProof(id, viewer.id, input), input.signature))
        throw new AuthError(403, "invalid_dm_signature");
      return;
    }
    requireAvailableAccounts(accounts, viewer.id);
    const current = await tx.query.dmConversations.findFirst({ where: eq(dmConversations.id, id) });
    if (current?.inviteStatus === "declined") throw new AuthError(403, "dm_blocked");
    const blocks = await blockState(tx, viewer.id, peerOf(conversation, viewer.id));
    if (blocks.blocking || blocks.blockedBy) throw new AuthError(403, "dm_blocked");
    if (current?.inviteStatus === "pending") {
      if (current.invitedBy !== viewer.id) throw new AuthError(409, "dm_invite_required");
      const [sent] = await tx.select({ value: sql<number>`count(*)::int` }).from(dmMessages)
        .where(and(eq(dmMessages.conversationId, id), eq(dmMessages.senderId, viewer.id), isNull(dmMessages.deletedAt)));
      if ((sent?.value ?? 0) >= requestLimit) throw new AuthError(409, "dm_request_limit");
    } else if (current?.inviteStatus !== "accepted") throw new AuthError(409, "dm_invite_required");
    const devices = (await tx.select().from(dmDevices).where(and(inArray(dmDevices.userId, ids), certified, currentDevices))).filter(isActive);
    const sender = devices.find((device) => device.id === input.senderDeviceId && device.userId === viewer.id);
    requireActive(sender);
    if (!validSignature(sender.signingKey, messageProof(id, viewer.id, input), input.signature))
      throw new AuthError(403, "invalid_dm_signature");
    if (previous) throw new AuthError(409, "dm_message_id_used");
    if (ids.some((userId) => !devices.some((device) => device.userId === userId)))
      throw new AuthError(409, "dm_recipient_not_enrolled");
    if (Object.keys(input.envelopes).length !== devices.length || devices.some((device) => !Object.hasOwn(input.envelopes, device.id)))
      throw new AuthError(409, "dm_device_roster_changed");
    const now = new Date();
    const { attachmentId, ...fields } = input;
    const inserted = await tx.insert(dmMessages).values({ ...fields, conversationId: id, senderId: viewer.id, createdAt: now })
      .onConflictDoNothing().returning({ id: dmMessages.id });
    if (!inserted.length) throw new AuthError(409, "dm_message_id_used");
    if (attachmentId) {
      const [linked] = await tx.update(dmAttachments).set({ messageId: input.id }).where(and(
        eq(dmAttachments.id, attachmentId), eq(dmAttachments.conversationId, id),
        eq(dmAttachments.uploaderId, viewer.id), isNull(dmAttachments.messageId),
      )).returning({ id: dmAttachments.id });
      if (!linked) throw new AuthError(409, "dm_attachment_unavailable");
    }
    await tx.update(dmConversations).set({ lastMessageAt: now, firstHiddenAt: null, secondHiddenAt: null }).where(eq(dmConversations.id, id));
    const recipientId = peerOf(conversation, viewer.id);
    await recordNotification(tx, {
      recipientId, actorId: viewer.id, kind: "dm_message", conversationId: id, subject: input.id,
    });
    for (const userId of ids) await publishDmChange(tx, userId, { type: "conversation", id, roster: false });
  });
  res.sendStatus(204);
});

router.put("/conversations/:id/messages/:messageId", async (req, res) => {
  const viewer = await requireUser(req);
  const { id, messageId } = parseInput(messageParams, req.params);
  const input = parseInput(messageInput, req.body);
  if (input.id !== messageId) throw new AuthError(400, "invalid_dm_request");
  const conversation = await readConversation(viewer.id, id);
  const ids = participants(conversation);

  await db.transaction(async (tx) => {
    requireAvailableAccounts(await lockAccounts(tx, ids), viewer.id);
    const current = await tx.query.dmConversations.findFirst({ where: eq(dmConversations.id, id) });
    if (current?.inviteStatus === "declined") throw new AuthError(403, "dm_blocked");
    const previous = await tx.query.dmMessages.findFirst({ where: and(eq(dmMessages.id, messageId), eq(dmMessages.conversationId, id)) });
    if (!previous || previous.deletedAt) throw new AuthError(404, "dm_message_not_found");
    if (previous.senderId !== viewer.id) throw new AuthError(403, "dm_message_owner_required");
    const devices = (await tx.select().from(dmDevices).where(and(inArray(dmDevices.userId, ids), certified, currentDevices))).filter(isActive);
    const sender = devices.find((device) => device.id === input.senderDeviceId && device.userId === viewer.id);
    requireActive(sender);
    if (!validSignature(sender.signingKey, messageProof(id, viewer.id, input), input.signature))
      throw new AuthError(403, "invalid_dm_signature");
    if (Object.keys(input.envelopes).length !== devices.length || devices.some((device) => !Object.hasOwn(input.envelopes, device.id)))
      throw new AuthError(409, "dm_device_roster_changed");
    const { id: _id, attachmentId: _attachment, ...fields } = input;
    await tx.update(dmMessages).set({ ...fields, editedAt: new Date() }).where(eq(dmMessages.id, messageId));
    for (const userId of ids) await publishDmChange(tx, userId, { type: "conversation", id, roster: false, message: messageId });
  });
  res.sendStatus(204);
});

router.delete("/conversations/:id/messages/:messageId", async (req, res) => {
  const viewer = await requireUser(req);
  const { id, messageId } = parseInput(messageParams, req.params);
  const conversation = await readConversation(viewer.id, id);
  const ids = participants(conversation);
  await db.transaction(async (tx) => {
    await lockAccounts(tx, ids);
    if (await eraseDmMessage(tx, id, messageId, ids, viewer.id)) return;
    const existing = await tx.query.dmMessages.findFirst({ where: and(eq(dmMessages.id, messageId), eq(dmMessages.conversationId, id)) });
    if (!existing) throw new AuthError(404, "dm_message_not_found");
    if (existing.senderId !== viewer.id) throw new AuthError(403, "dm_message_owner_required");
  });
  res.sendStatus(204);
});

router.put("/conversations/:id/messages/:messageId/reaction", async (req, res) => {
  const viewer = await requireUser(req);
  const { id, messageId } = parseInput(messageParams, req.params);
  const { emoji } = parseInput(z.strictObject({ emoji: z.string().max(64).nullable() }), req.body);
  if (emoji !== null && !validReaction(emoji)) throw new AuthError(400, "invalid_dm_reaction");
  const conversation = await readConversation(viewer.id, id);
  const ids = participants(conversation);
  await db.transaction(async (tx) => {
    requireAvailableAccounts(await lockAccounts(tx, ids), viewer.id);
    const current = await tx.query.dmConversations.findFirst({ where: eq(dmConversations.id, id) });
    if (current?.inviteStatus !== "accepted") throw new AuthError(409, "dm_invite_required");
    const message = await tx.query.dmMessages.findFirst({ where: and(eq(dmMessages.id, messageId), eq(dmMessages.conversationId, id)) });
    if (!message || message.deletedAt) throw new AuthError(404, "dm_message_not_found");
    if (emoji === null) {
      await tx.delete(dmReactions).where(and(eq(dmReactions.messageId, messageId), eq(dmReactions.userId, viewer.id)));
    } else {
      await tx.insert(dmReactions).values({ messageId, userId: viewer.id, emoji })
        .onConflictDoUpdate({ target: [dmReactions.messageId, dmReactions.userId], set: { emoji, createdAt: new Date() } });
    }
    for (const userId of ids) await publishDmChange(tx, userId, { type: "conversation", id, roster: false, message: messageId });
  });
  res.sendStatus(204);
});

router.put("/conversations/:id/messages/:messageId/vote", async (req, res) => {
  const viewer = await requireUser(req);
  const { id, messageId } = parseInput(messageParams, req.params);
  const { option } = parseInput(z.strictObject({ option: z.number().int().min(0).max(9).nullable() }), req.body);
  const conversation = await readConversation(viewer.id, id);
  const ids = participants(conversation);
  await db.transaction(async (tx) => {
    requireAvailableAccounts(await lockAccounts(tx, ids), viewer.id);
    const current = await tx.query.dmConversations.findFirst({ where: eq(dmConversations.id, id) });
    if (current?.inviteStatus !== "accepted") throw new AuthError(409, "dm_invite_required");
    const message = await tx.query.dmMessages.findFirst({ where: and(eq(dmMessages.id, messageId), eq(dmMessages.conversationId, id)) });
    if (!message || message.deletedAt) throw new AuthError(404, "dm_message_not_found");
    if (option === null) {
      await tx.delete(dmPollVotes).where(and(eq(dmPollVotes.messageId, messageId), eq(dmPollVotes.userId, viewer.id)));
    } else {
      await tx.insert(dmPollVotes).values({ messageId, userId: viewer.id, option })
        .onConflictDoUpdate({ target: [dmPollVotes.messageId, dmPollVotes.userId], set: { option, createdAt: new Date() } });
    }
    for (const userId of ids) await publishDmChange(tx, userId, { type: "conversation", id, roster: false, message: messageId });
  });
  res.sendStatus(204);
});

const previewQuery = z.strictObject({ url: z.url({ protocol: /^https$/ }).max(2048) });
const assetKey = z.string().regex(/^[0-9a-f]{64}$/);
const previewAssetHeaders = {
  "Cache-Control": "public, max-age=3600",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

router.get("/link-preview", async (req, res) => {
  await requireApprovedUser(req);
  const { url } = parseInput(previewQuery, req.query);
  res.json(await previewsForPost(url));
});

router.get("/link-preview-image", async (req, res) => {
  await requireApprovedUser(req);
  const { url, key } = parseInput(previewQuery.extend({ key: assetKey }), req.query);
  const image = await previewImageForPost(url, key);
  if (!image) {
    res.sendStatus(404);
    return;
  }
  res.set(previewAssetHeaders).type("image/webp").send(image);
});

router.get("/link-preview-icon", async (req, res) => {
  await requireApprovedUser(req);
  const { url, key } = parseInput(previewQuery.extend({ key: assetKey }), req.query);
  const icon = await previewIconForPost(url, key);
  if (!icon) {
    res.sendStatus(404);
    return;
  }
  res.set({
    ...previewAssetHeaders,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  }).type(icon.type).send(icon.body);
});

const unsent = () => new Date(Date.now() - 60 * 60_000);

router.post("/conversations/:id/attachments", express.raw({ type: "application/octet-stream", limit: attachmentLimit }), async (req, res) => {
  const viewer = await requireUser(req);
  const id = parseInput(identifier, req.params.id);
  const attachmentId = parseInput(identifier, req.get("x-dm-attachment-id"));
  const data = req.body;
  if (!Buffer.isBuffer(data) || data.length < 29) throw new AuthError(400, "invalid_dm_request");
  const conversation = await readConversation(viewer.id, id);
  await db.transaction(async (tx) => {
    requireAvailableAccounts(await lockAccounts(tx, participants(conversation)), viewer.id);
    const current = await tx.query.dmConversations.findFirst({ where: eq(dmConversations.id, id) });
    if (current?.inviteStatus === "declined") throw new AuthError(403, "dm_blocked");
    if (current?.inviteStatus === "pending" && current.invitedBy !== viewer.id) throw new AuthError(409, "dm_invite_required");
    await tx.delete(dmAttachments).where(and(isNull(dmAttachments.messageId), lt(dmAttachments.createdAt, unsent())));
    const [pendingCount] = await tx.select({ value: sql<number>`count(*)::int` }).from(dmAttachments)
      .where(and(eq(dmAttachments.uploaderId, viewer.id), isNull(dmAttachments.messageId)));
    if ((pendingCount?.value ?? 0) >= 10) throw new AuthError(429, "dm_attachment_limit");
    await tx.insert(dmAttachments).values({ id: attachmentId, conversationId: id, uploaderId: viewer.id, data, size: data.length })
      .onConflictDoNothing();
  });
  res.status(201).json({ id: attachmentId });
});

router.get("/conversations/:id/attachments/:attachmentId", async (req, res) => {
  const viewer = await requireApprovedUser(req);
  const { id, attachmentId } = parseInput(z.strictObject({ id: identifier, attachmentId: identifier }), req.params);
  await readConversation(viewer.id, id);
  const [file] = await db.select({ data: dmAttachments.data }).from(dmAttachments)
    .where(and(eq(dmAttachments.id, attachmentId), eq(dmAttachments.conversationId, id), isNotNull(dmAttachments.messageId)));
  if (!file) throw new AuthError(404, "dm_attachment_not_found");
  res.set({ "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" }).type("application/octet-stream").send(file.data);
});

export default router;
