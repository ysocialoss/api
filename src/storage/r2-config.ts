import { z } from "zod";

const credential = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);
export const r2ConfigSchema = z
  .object({
    R2_ACCOUNT_ID: credential.pipe(
      z
        .string()
        .regex(/^[a-f0-9]{32}$/i)
        .optional(),
    ),
    R2_BUCKET: credential.pipe(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
        .optional(),
    ),
    R2_ACCESS_KEY_ID: credential,
    R2_SECRET_ACCESS_KEY: credential,
  })
  .transform((values, ctx) => {
    const { R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } =
      values;
    if (Object.values(values).every((value) => value === undefined))
      return null;
    if (
      !R2_ACCOUNT_ID ||
      !R2_BUCKET ||
      !R2_ACCESS_KEY_ID ||
      !R2_SECRET_ACCESS_KEY
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Set all four R2 settings or leave all four empty",
      });
      return z.NEVER;
    }
    return {
      // No configurable endpoint or location hint: jurisdiction is always EU.
      endpoint: `https://${R2_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`,
      region: "auto",
      bucket: R2_BUCKET,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    };
  });
