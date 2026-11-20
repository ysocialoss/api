import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { Router, type Request } from "express";
import { randomUUID } from "node:crypto";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { requireApprovedUser, requireUser } from "./auth/request.ts";
import { db } from "./db/index.ts";
import { dmConversations, dmDevices, dmMessages, notifications, users } from "./db/schema.ts";
import {
  deviceAction, deviceApproval, deviceLimit, deviceRevocation, directoryLimit, identifier,
  messageInput, messageProof, newDevice, parseInput, pendingLifetime, validDeviceAccess, validDeviceKeys, validSignature,
} from "./dm-protocol.ts";
import { userSelection } from "./user-data.ts";
import { recordNotification } from "./notification-events.ts";
import { publishDmChange, publishDmDeviceChange } from "./dm-events.ts";

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
const inviteFields = { invitedBy: dmConversations.invitedBy, inviteStatus: dmConversations.inviteStatus };

function requireAvailableAccounts(accounts: Awaited<ReturnType<typeof lockAccounts>>) {
  if (accounts.length !== 2 || accounts.some(({ approvedAt, bannedAt }) => !approvedAt || bannedAt))
    throw new AuthError(403, "dm_conversation_unavailable");
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
  return tx.select({ id: users.id, bannedAt: users.bannedAt, approvedAt: users.approvedAt, generation: users.dmGeneration })
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
  return { conversation, device };
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
  const conversations = await db.select({ id: dmConversations.id, peer: userSelection, lastMessageAt: dmConversations.lastMessageAt, ...inviteFields })
    .from(dmConversations)
    .innerJoin(users, eq(users.id, sql`case when ${dmConversations.firstUserId} = ${viewer.id} then ${dmConversations.secondUserId} else ${dmConversations.firstUserId} end`))
    .where(and(member(viewer.id), or(
      isNotNull(dmConversations.lastMessageAt),
      and(isNotNull(dmConversations.invitedBy), inArray(dmConversations.inviteStatus, ["pending", "accepted"])),
    )))
    .orderBy(sql`${dmConversations.lastMessageAt} desc nulls last`, desc(dmConversations.id));
  res.json({ conversations });
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
  if (peer.id === viewer.id) throw new AuthError(400, "dm_self");
  const firstUserId = viewer.id < peer.id ? viewer.id : peer.id;
  const secondUserId = viewer.id < peer.id ? peer.id : viewer.id;
  const conversation = await db.transaction(async (tx) => {
    requireAvailableAccounts(await lockAccounts(tx, [firstUserId, secondUserId]));
    requireActive(await readDevice(viewer.id, deviceId, tx));
    const [inserted] = await tx.insert(dmConversations)
      .values({ firstUserId, secondUserId, invitedBy: viewer.id, inviteStatus: "pending" })
      .onConflictDoNothing({ target: [dmConversations.firstUserId, dmConversations.secondUserId] })
      .returning({ id: dmConversations.id });
    let opened = inserted;
    if (!opened) {
      const existing = await tx.query.dmConversations.findFirst({
        where: and(eq(dmConversations.firstUserId, firstUserId), eq(dmConversations.secondUserId, secondUserId)),
      });
      if (existing?.inviteStatus !== "declined" || existing.invitedBy === viewer.id) return existing;
      await tx.update(dmConversations).set({ invitedBy: viewer.id, inviteStatus: "pending" })
        .where(eq(dmConversations.id, existing.id));
      opened = existing;
    }
    await recordNotification(tx, {
      recipientId: peer.id, actorId: viewer.id, kind: "dm_invite", conversationId: opened.id, subject: randomUUID(),
    });
    await publishDmChange(tx, peer.id, { type: "conversation", id: opened.id, roster: true });
    await publishDmChange(tx, peer.id, { type: "notifications" });
    return opened;
  });
  if (!conversation) throw new AuthError(404, "dm_conversation_not_found");
  res.json({ id: conversation.id, peerId: peer.id });
});

router.get("/conversations/:id", async (req, res) => {
  const { conversation } = await readContext(req);
  const ids = participants(conversation);
  const members = await db.select(userSelection).from(users).where(inArray(users.id, ids));
  const devices = await db.select(publicDevice).from(dmDevices).where(and(inArray(dmDevices.userId, ids), certified));
  res.json({ members, devices, invitedBy: conversation.invitedBy, inviteStatus: conversation.inviteStatus });
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
    requireAvailableAccounts(await lockAccounts(tx, participants(conversation)));
    requireActive(await readDevice(viewer.id, deviceId, tx));
    const [updated] = await tx.update(dmConversations).set({ inviteStatus: response })
      .where(and(eq(dmConversations.id, id), eq(dmConversations.inviteStatus, "pending")))
      .returning({ id: dmConversations.id });
    if (!updated) {
      const current = await tx.query.dmConversations.findFirst({ where: eq(dmConversations.id, id) });
      if (current?.inviteStatus !== response) throw new AuthError(409, "dm_invite_already_answered");
    }
    await tx.update(notifications).set({ readAt: new Date() }).where(and(
      eq(notifications.recipientId, viewer.id), eq(notifications.conversationId, id),
      eq(notifications.kind, "dm_invite"), isNull(notifications.readAt),
    ));
    if (updated) {
      for (const userId of participants(conversation)) {
        await publishDmChange(tx, userId, { type: "conversation", id, roster: true });
      }
      await publishDmChange(tx, viewer.id, { type: "notifications" });
    }
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
    sequence: dmMessages.sequence, createdAt: dmMessages.createdAt,
  };
}

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
    eq(dmMessages.conversationId, conversation.id), sql`${selection.envelope} is not null`,
    before !== undefined ? lt(dmMessages.sequence, before) : undefined,
    after !== undefined ? gt(dmMessages.sequence, after) : undefined,
  )).orderBy(after === undefined ? desc(dmMessages.sequence) : asc(dmMessages.sequence)).limit(limit + 1);
  const page = messages.slice(0, limit);
  if (after === undefined) page.reverse();
  res.json({
    messages: page.map((message) => ({ ...message, sequence: String(message.sequence) })),
    more: messages.length > limit,
  });
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
    if (updated.length) await publishDmChange(tx, viewer.id, { type: "notifications" });
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
    requireAvailableAccounts(await lockAccounts(tx, ids));
    const current = await tx.query.dmConversations.findFirst({ where: eq(dmConversations.id, id) });
    if (current?.inviteStatus !== "accepted") throw new AuthError(409, "dm_invite_required");
    const devices = (await tx.select().from(dmDevices).where(and(inArray(dmDevices.userId, ids), certified, currentDevices))).filter(isActive);
    const sender = devices.find((device) => device.id === input.senderDeviceId && device.userId === viewer.id);
    requireActive(sender);
    if (!validSignature(sender.signingKey, messageProof(id, viewer.id, input), input.signature))
      throw new AuthError(403, "invalid_dm_signature");
    const previous = await tx.query.dmMessages.findFirst({ where: eq(dmMessages.id, input.id) });
    if (previous) {
      if (previous.conversationId === id && previous.senderId === viewer.id && previous.senderDeviceId === sender.id) return;
      throw new AuthError(409, "dm_message_id_used");
    }
    if (ids.some((userId) => !devices.some((device) => device.userId === userId)))
      throw new AuthError(409, "dm_recipient_not_enrolled");
    if (Object.keys(input.envelopes).length !== devices.length || devices.some((device) => !Object.hasOwn(input.envelopes, device.id)))
      throw new AuthError(409, "dm_device_roster_changed");
    const now = new Date();
    const inserted = await tx.insert(dmMessages).values({ ...input, conversationId: id, senderId: viewer.id, createdAt: now })
      .onConflictDoNothing().returning({ id: dmMessages.id });
    if (!inserted.length) throw new AuthError(409, "dm_message_id_used");
    await tx.update(dmConversations).set({ lastMessageAt: now }).where(eq(dmConversations.id, id));
    const recipientId = conversation.firstUserId === viewer.id ? conversation.secondUserId : conversation.firstUserId;
    await recordNotification(tx, {
      recipientId, actorId: viewer.id, kind: "dm_message", conversationId: id, subject: input.id,
    });
    for (const userId of ids) await publishDmChange(tx, userId, { type: "conversation", id, roster: false });
    await publishDmChange(tx, recipientId, { type: "notifications" });
  });
  res.sendStatus(204);
});

export default router;
