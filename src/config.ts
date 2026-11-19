import { config } from "dotenv";
import { z } from "zod";
import { r2ConfigSchema } from "./storage/r2-config.ts";
import { pushConfigSchema } from "./push-config.ts";

config({ path: new URL("../.env", import.meta.url), quiet: true });

export const env = z
  .object({
    KLIPY_API_KEY: z.string().optional(),
    R2: z.preprocess(() => process.env, r2ConfigSchema),
    PUSH: z.preprocess(() => process.env, pushConfigSchema),
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
    ADMIN_ORIGIN: z
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol))
      .transform((value) => new URL(value).origin)
      .optional(),
    CNS_CLIENT_ID: z.string().min(1).default("ysocial"),
    CNS_DISCOVERY_URL: z
      .url()
      .default("https://api.cns.ad/.well-known/openid-configuration"),
    CNS_LOGIN_URL: z.url().default("https://accounts.cns.ad/login"),
    CNS_API_ORIGIN: z.url().default("https://api.cns.ad"),
    SESSION_ENCRYPTION_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/)
        .optional(),
    ),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    // per replica. keep replicas * DATABASE_POOL_MAX below max_connections.
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(30_000),
    LIVE_MAX_STREAMS: z.coerce.number().int().min(0).default(2000),
    SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).max(60_000).default(0),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20_000),
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

if (env.NODE_ENV === "production" && env.ADMIN_ORIGIN && !env.ADMIN_ORIGIN.startsWith("https:")) {
  throw new Error("Production requires an HTTPS ADMIN_ORIGIN");
}

if (
  env.NODE_ENV === "production" &&
  [env.CNS_DISCOVERY_URL, env.CNS_LOGIN_URL, env.CNS_API_ORIGIN].some(
    (value) => !value.startsWith("https:"),
  )
) {
  throw new Error("Production CNS endpoints must use HTTPS");
}

export const adminHandle = env.NODE_ENV === "development" ? "ytest" : "whz";
export const reservedAdminHandle = adminHandle.includes("test") ? null : adminHandle;
