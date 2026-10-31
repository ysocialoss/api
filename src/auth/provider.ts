import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { env } from "../config.ts";

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const metadataSchema = z.object({
  issuer: z.string().min(1),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
});
export const tokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().positive().max(86400),
  scope: z.string().optional(),
});
const loginTokensSchema = tokensSchema.extend({
  id_token: z.string().min(1),
  state: z.string().optional(),
});
let cached:
  { value: z.infer<typeof metadataSchema>; until: number } | undefined;
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function metadata() {
  if (cached && cached.until > Date.now()) return cached.value;
  try {
    const response = await fetch(env.CNS_DISCOVERY_URL, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("discovery");
    const value = metadataSchema.parse(await response.json());
    // Provider endpoints are configuration, never supplied by a browser.
    if (
      env.NODE_ENV === "production" &&
      [value.token_endpoint, value.jwks_uri].some(
        (url) => !url.startsWith("https:"),
      )
    ) {
      throw new Error("insecure discovery");
    }
    cached = { value, until: Date.now() + 600000 };
    return value;
  } catch {
    throw new AuthError(503, "provider_unavailable");
  }
}
export async function providerPost(
  path: string,
  body: unknown,
  accessToken?: string,
) {
  try {
    return await fetch(new URL(path, env.CNS_API_ORIGIN), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
  } catch {
    throw new AuthError(503, "provider_unavailable");
  }
}
export async function exchange(input: {
  code: string;
  state: string;
  verifier: string;
  nonce: string;
}) {
  const config = await metadata();
  const response = await providerPost(config.token_endpoint, {
    code: input.code,
    state: input.state,
    code_verifier: input.verifier,
    client_id: env.CNS_CLIENT_ID,
    redirect_uri: `${env.APP_ORIGIN}/auth/callback`,
  });
  if (!response.ok)
    throw new AuthError(
      response.status >= 500 || response.status === 429 ? 503 : 400,
      "login_failed",
    );
  try {
    const tokens = loginTokensSchema.parse(await response.json());
    if (tokens.state !== undefined && tokens.state !== input.state)
      throw new Error("state");
    let jwks = keys.get(config.jwks_uri);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(config.jwks_uri), {
        cacheMaxAge: 600000,
        cooldownDuration: 1000,
        timeoutDuration: 10000,
      });
      keys.set(config.jwks_uri, jwks);
    }
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: config.issuer,
      audience: env.CNS_CLIENT_ID,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "nonce"],
    });
    if (
      payload.nonce !== input.nonce ||
      !payload.sub ||
      (payload.azp !== undefined && payload.azp !== env.CNS_CLIENT_ID) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== env.CNS_CLIENT_ID)
    )
      throw new Error("identity");
    const profile = z
      .object({
        sub: z.string().min(1),
        preferred_username: z.string().default(""),
        name: z.string().default(""),
        picture: z.url().nullable().optional(),
      })
      .parse(payload);
    return {
      tokens: tokensSchema.parse(tokens),
      issuer: config.issuer,
      profile,
    };
  } catch {
    throw new AuthError(400, "invalid_provider_identity");
  }
}
