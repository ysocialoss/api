import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://unit:unit@127.0.0.1/unit";
const {
  deviceApproval, deviceProof, deviceRevocation, messageInput, messageProof, newDevice,
  requestLimit, validDeviceAccess, validDeviceKeys, validReaction, validSignature,
} = await import("../src/dm-protocol.ts");

function device(userId = randomUUID()) {
  const encryption = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keys = {
    userId,
    id: randomUUID(),
    encryptionKey: encryption.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    signingKey: signing.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
  const signPayload = (payload) =>
    sign("sha256", payload, { key: signing.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  return { keys, signPayload, proof: signPayload(deviceProof(keys)) };
}

test("device registration and approvals bind immutable keys to an account", () => {
  const root = device();
  const next = device(root.keys.userId);
  const { userId, ...publicKeys } = next.keys;
  assert.ok(newDevice.safeParse({ ...publicKeys, label: "Test browser", proof: next.proof }).success);
  assert.ok(validDeviceKeys({ ...next.keys, proof: next.proof }));
  assert.equal(validDeviceKeys({ ...next.keys, userId: randomUUID(), proof: next.proof }), false);

  const approval = root.signPayload(deviceApproval(root.keys.id, next.keys));
  assert.ok(validSignature(root.keys.signingKey, deviceApproval(root.keys.id, next.keys), approval));
  assert.equal(validSignature(root.keys.signingKey, deviceApproval(root.keys.id, { ...next.keys, encryptionKey: root.keys.encryptionKey }), approval), false);
  assert.equal(validSignature(root.keys.signingKey, deviceRevocation(root.keys.id, userId, next.keys.id), approval), false);
});

test("a signed browser request expires and cannot be replayed against a different route or method", () => {
  const { keys, signPayload } = device();
  const now = Date.now();
  const path = `/api/dms/conversations?device=${keys.id}`;
  const proof = signPayload(Buffer.from(JSON.stringify(["ysocial.dm.access", 1, keys.userId, keys.id, "GET", path, "", String(now)])));
  assert.ok(validDeviceAccess(keys, "GET", path, "", String(now), proof, now));
  assert.equal(validDeviceAccess(keys, "GET", path, "", String(now), undefined, now), false);
  assert.equal(validDeviceAccess(keys, "GET", path, "", String(now), proof, now + 300_001), false);
  assert.equal(validDeviceAccess(keys, "GET", path + "&after=1", "", String(now), proof, now), false);
  assert.equal(validDeviceAccess(keys, "POST", path, "", String(now), proof, now), false);
});

test("message input accepts the maximum encrypted payload and rejects plaintext or additional envelopes", () => {
  const sender = device();
  const encrypted = (bytes) => randomBytes(bytes).toString("base64");
  const conversationId = randomUUID();
  const fields = {
    id: randomUUID(), senderDeviceId: sender.keys.id, version: 1,
    iv: encrypted(12), ciphertext: encrypted(4016),
    envelopes: Object.fromEntries(Array.from({ length: 16 }, () => [randomUUID(), encrypted(256)])),
  };
  const message = { ...fields, signature: sender.signPayload(messageProof(conversationId, sender.keys.userId, fields)) };
  assert.ok(messageInput.safeParse(message).success);
  assert.ok(Buffer.byteLength(JSON.stringify(message)) < 16_384);
  assert.equal(messageInput.safeParse({ ...message, text: "private" }).success, false);
  assert.equal(messageInput.safeParse({ ...message, envelopes: { ...message.envelopes, [randomUUID()]: encrypted(256) } }).success, false);
  assert.equal(validSignature(sender.keys.signingKey, messageProof(randomUUID(), sender.keys.userId, message), message.signature), false);
});

test("reactions are a single emoji and message requests stay short", () => {
  for (const emoji of ["👍", "❤️", "🇩🇪", "👨‍👩‍👧", "1️⃣", "👍🏽"]) assert.ok(validReaction(emoji), emoji);
  for (const text of ["", "a", "hi", "👍👍", "👍 ", ":+1:"]) assert.ok(!validReaction(text), JSON.stringify(text));
  assert.equal(requestLimit, 3);
});
