import { config } from "dotenv";
import { z } from "zod";

config({ path: new URL("../.env", import.meta.url), quiet: true });

export const env = z
  .object({
    DATABASE_URL: z
      .url()
      .refine(
        (value) =>
          ["postgres:", "postgresql:"].includes(new URL(value).protocol),
        {
          message: "DATABASE_URL must be a PostgreSQL URL",
        },
      ),
    APP_ORIGIN: z
      .url()
      .default("http://localhost:3000")
      .transform((value) => new URL(value).origin),
    CNS_CLIENT_ID: z.string().min(1).default("ysocial"),
    CNS_DISCOVERY_URL: z
      .url()
      .default("https://api.cns.ad/.well-known/openid-configuration"),
    CNS_LOGIN_URL: z.url().default("https://accounts.cns.ad/login"),
    CNS_API_ORIGIN: z.url().default("https://api.cns.ad"),
    SESSION_ENCRYPTION_KEY: z.preprocess(
      value => value === '' ? undefined : value,
      z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
    ),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  })
  .parse(process.env);

if (
  env.NODE_ENV === "production" &&
  (!env.APP_ORIGIN.startsWith("https:") || !env.SESSION_ENCRYPTION_KEY)
) {
  throw new Error(
    "Production requires an HTTPS APP_ORIGIN and SESSION_ENCRYPTION_KEY",
  );
}

if (env.NODE_ENV === 'production' && [env.CNS_DISCOVERY_URL, env.CNS_LOGIN_URL, env.CNS_API_ORIGIN].some(value => !value.startsWith('https:'))) {
  throw new Error('Production CNS endpoints must use HTTPS');
}
