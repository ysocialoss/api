import { createHash } from "node:crypto";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { env } from "./config.ts";
import { connectionProviders } from "./db/schema.ts";

export type ConnectionProvider = (typeof connectionProviders)[number];
export const providerIds = connectionProviders;

export type ProviderIdentity = {
  id: string;
  username: string;
  displayName: string;
  url: string;
};

type Definition = {
  clientId?: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  pkce: boolean;
  urlHost: string;
  fetchIdentity: (accessToken: string, clientId: string) => Promise<ProviderIdentity>;
};

const text = (max: number) =>
  z.string().transform((value) => value.replace(/[\u0000-\u001f\u007f]/g, "").trim()).pipe(z.string().min(1).max(max));
const id = z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^[\w-]{1,64}$/));

async function getJson(url: string, headers: Record<string, string>) {
  try {
    const response = await fetch(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new AuthError(502, "connection_unavailable");
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(502, "connection_unavailable");
  }
}

const definitions: Record<ConnectionProvider, Definition> = {
  discord: {
    clientId: env.DISCORD_CLIENT_ID,
    clientSecret: env.DISCORD_CLIENT_SECRET,
    authorizeUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    scope: "identify",
    pkce: true,
    urlHost: "discord.com",
    async fetchIdentity(token) {
      const data = z.object({
        id,
        username: text(100),
        global_name: z.string().nullish(),
      }).parse(await getJson("https://discord.com/api/users/@me", { Authorization: `Bearer ${token}` }));
      return {
        id: data.id,
        username: data.username,
        displayName: data.global_name?.trim() || data.username,
        url: `https://discord.com/users/${data.id}`,
      };
    },
  },
  twitch: {
    clientId: env.TWITCH_CLIENT_ID,
    clientSecret: env.TWITCH_CLIENT_SECRET,
    authorizeUrl: "https://id.twitch.tv/oauth2/authorize",
    tokenUrl: "https://id.twitch.tv/oauth2/token",
    scope: "",
    pkce: false,
    urlHost: "www.twitch.tv",
    async fetchIdentity(token, clientId) {
      const data = z.object({
        data: z.array(z.object({ id, login: z.string().regex(/^\w{1,25}$/), display_name: text(100) })).min(1),
      }).parse(await getJson("https://api.twitch.tv/helix/users", {
        Authorization: `Bearer ${token}`,
        "Client-Id": clientId,
      }));
      const user = data.data[0];
      return {
        id: user.id,
        username: user.login,
        displayName: user.display_name,
        url: `https://www.twitch.tv/${user.login}`,
      };
    },
  },
};

export const isProvider = (value: string): value is ConnectionProvider =>
  (providerIds as readonly string[]).includes(value);

export const providerConfigured = (provider: ConnectionProvider) =>
  Boolean(definitions[provider].clientId && definitions[provider].clientSecret);

const redirectUri = (provider: ConnectionProvider) =>
  `${env.APP_ORIGIN}/api/connections/${provider}/callback`;

export function providerAuthorizeUrl(provider: ConnectionProvider, state: string, verifier: string) {
  const definition = definitions[provider];
  const params: Record<string, string> = {
    response_type: "code",
    client_id: definition.clientId ?? "",
    redirect_uri: redirectUri(provider),
    state,
  };
  if (definition.scope) params.scope = definition.scope;
  if (definition.pkce) {
    params.code_challenge = createHash("sha256").update(verifier).digest("base64url");
    params.code_challenge_method = "S256";
  }
  if (provider === "discord") params.prompt = "none";
  const url = new URL(definition.authorizeUrl);
  url.search = new URLSearchParams(params).toString();
  return url.href;
}

export async function exchangeProviderCode(
  provider: ConnectionProvider,
  code: string,
  verifier: string,
): Promise<ProviderIdentity> {
  const definition = definitions[provider];
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: definition.clientId ?? "",
    client_secret: definition.clientSecret ?? "",
    redirect_uri: redirectUri(provider),
    code,
  });
  if (definition.pkce) body.set("code_verifier", verifier);
  let token: string;
  try {
    const response = await fetch(definition.tokenUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new AuthError(400, "connection_failed");
    token = z.object({ access_token: z.string().min(1) }).parse(await response.json()).access_token;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(502, "connection_unavailable");
  }
  const identity = await definition.fetchIdentity(token, definition.clientId ?? "");
  if (new URL(identity.url).host !== definition.urlHost) throw new AuthError(502, "connection_unavailable");
  return identity;
}
