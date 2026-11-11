import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { env } from "../config.ts";
import { AuthError } from "../auth/provider.ts";

export const avatarStorage = env.R2
  ? {
      client: new S3Client({ ...env.R2, maxAttempts: 3 }),
      bucket: env.R2.bucket,
    }
  : null;

export function requireAvatarStorage() {
  if (!avatarStorage) throw new AuthError(503, "avatar_storage_not_configured");
  return avatarStorage;
}

export async function checkAvatarStorage() {
  const { client, bucket } = requireAvatarStorage();
  await client.send(new HeadBucketCommand({ Bucket: bucket }), {
    abortSignal: AbortSignal.timeout(10000),
  });
}

export async function putAvatar(
  key: string,
  body: Buffer,
  contentType = "image/avif",
) {
  const { client, bucket } = requireAvatarStorage();
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: "no-store",
      }),
      { abortSignal: AbortSignal.timeout(15000) },
    );
  } catch {
    throw new AuthError(503, "avatar_storage_unavailable");
  }
}

export async function getAvatar(key: string) {
  const { client, bucket } = requireAvatarStorage();
  try {
    const object = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(10000) },
    );
    if (!object.Body) throw new Error("Missing avatar body");
    return await object.Body.transformToByteArray();
  } catch {
    throw new AuthError(503, "avatar_storage_unavailable");
  }
}
