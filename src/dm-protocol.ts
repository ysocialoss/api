import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";

export const deviceLimit = 8;
export const attachmentLimit = 3 * 1024 * 1024;
export const requestLimit = 3;
export const directoryLimit = 128;
export const pendingLifetime = 15 * 60_000;
export const identifier = z.uuid().refine((value) => value === value.toLowerCase());
const base64 = (max: number, bytes?: number) => z.string().min(1).max(max).refine((value) => {
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value && (bytes === undefined || decoded.length === bytes);
});
const signature = base64(88, 64);
export const newDevice = z.strictObject({
  id: identifier,
  label: z.string().trim().min(1).max(60),
  encryptionKey: base64(400, 294),
  signingKey: base64(124, 91),
  proof: signature,
});
export const deviceAction = z.strictObject({ actorId: identifier, signature });
export const messageInput = z.strictObject({
  id: identifier,
  senderDeviceId: identifier,
  version: z.literal(1),
  iv: base64(16, 12),
  ciphertext: base64(5360).refine((value) => Buffer.from(value, "base64").length >= 17),
  signature,
  envelopes: z.record(identifier, base64(344, 256)),
  attachmentId: identifier.optional(),
}).refine(({ envelopes }) => Object.keys(envelopes).length <= deviceLimit * 2);

export type DeviceKeys = Pick<z.infer<typeof newDevice>, "id" | "encryptionKey" | "signingKey"> & { userId: string };
export type MessageInput = z.infer<typeof messageInput>;

export function transcript(...fields: (number | string)[]) {
  return Buffer.from(JSON.stringify(fields));
}

export function validDeviceAccess(device: DeviceKeys, method: string, path: string, binding: string, timestamp: string | undefined, proof: string | undefined, now = Date.now()) {
  if (!timestamp || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300_000 || !signature.safeParse(proof).success)
    return false;
  return !!proof && validSignature(device.signingKey,
    transcript("ysocial.dm.access", 1, device.userId, device.id, method, path, binding, timestamp), proof);
}

export function deviceProof(device: DeviceKeys) {
  return transcript("ysocial.dm.device", 1, device.userId, device.id, device.encryptionKey, device.signingKey);
}

export function deviceApproval(actorId: string, device: DeviceKeys) {
  return transcript("ysocial.dm.approve", 1, actorId, device.userId, device.id, device.encryptionKey, device.signingKey);
}

export function deviceRevocation(actorId: string, userId: string, targetId: string) {
  return transcript("ysocial.dm.revoke", 1, actorId, userId, targetId);
}

export function messageProof(conversationId: string, senderId: string, message: MessageInput) {
  return transcript("ysocial.dm.message", message.version, conversationId, message.id, senderId, message.senderDeviceId, message.iv, message.ciphertext);
}

function importKey(value: string) {
  return createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
}

export function validDeviceKeys(device: DeviceKeys & { proof: string }) {
  try {
    const key = importKey(device.encryptionKey);
    return key.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails?.modulusLength === 2048
      && key.asymmetricKeyDetails.publicExponent === 65537n
      && validSignature(device.signingKey, deviceProof(device), device.proof);
  } catch {
    return false;
  }
}

export function validSignature(signingKey: string, payload: Buffer, signature: string) {
  try {
    const key: KeyObject = importKey(signingKey);
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
      && verify("sha256", payload, { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function parseInput<T>(schema: z.ZodType<T>, value: unknown) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AuthError(400, "invalid_dm_request");
  return parsed.data;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const pictograph = /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}[\p{Emoji_Modifier}\uFE0F\u200D\p{Extended_Pictographic}\u{E0020}-\u{E007F}]*)$/u;

export function validReaction(value: string) {
  const parts = Array.from(graphemes.segment(value));
  return parts.length === 1 && pictograph.test(value);
}
