import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { env } from "../config.ts";
import { AuthError, tokensSchema } from "./provider.ts";
export const random = () => randomBytes(32).toString("base64url");
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function key() {
  if (!env.SESSION_ENCRYPTION_KEY)
    throw new AuthError(503, "login_not_configured");
  return Buffer.from(env.SESSION_ENCRYPTION_KEY, "hex");
}
export function encrypt(tokens: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const content = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), content]).toString(
    "base64url",
  );
}
export function decrypt(value: string) {
  const data = Buffer.from(value, "base64url");
  const cipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return tokensSchema.parse(
    JSON.parse(
      Buffer.concat([
        cipher.update(data.subarray(28)),
        cipher.final(),
      ]).toString("utf8"),
    ),
  );
}
