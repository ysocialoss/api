import { createPrivateKey, createSign } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { Router } from "express";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { requireApprovedUser, requireUser } from "./auth/request.ts";
import { random } from "./auth/secrets.ts";
import { env } from "./config.ts";
import { db } from "./db/index.ts";
import { userDomains } from "./db/schema.ts";
import { iconForSite } from "./link-previews.ts";
import { fetchPublicPreview, isPublicPreviewAddress } from "./public-preview-fetch.ts";

const router = Router();
const maxDomains = 10;
const challengeLabel = "_ysocial-challenge";
const valuePrefix = "ysocial-verify=";
export const domainConnectProviderId = "ysocial.cc";
export const domainConnectServiceId = "verify-domain";

const domainPattern = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;
const jsonTypes = new Set(["application/json"]);

router.use((_req, res, next) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  next();
});

export function normalizeDomain(raw: string) {
  const trimmed = raw.trim().toLowerCase();
  const host = URL.parse(trimmed.includes("://") ? trimmed : `https://${trimmed}`)?.hostname
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (!host || !domainPattern.test(host)) return null;
  const own = URL.parse(env.APP_ORIGIN)?.hostname;
  if (own && (host === own || host.endsWith(`.${own}`))) return null;
  return host;
}

const selection = {
  id: userDomains.id,
  domain: userDomains.domain,
  token: userDomains.token,
  verifiedAt: userDomains.verifiedAt,
};
const present = (row: { id: string; domain: string; token: string; verifiedAt: Date | null }) => ({
  id: row.id,
  domain: row.domain,
  verified: row.verifiedAt !== null,
  record: row.verifiedAt
    ? null
    : { type: "TXT" as const, host: `${challengeLabel}.${row.domain}`, name: challengeLabel, value: `${valuePrefix}${row.token}` },
});

async function ownDomain(userId: string, id: string) {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new AuthError(404, "domain_not_found");
  const [row] = await db.select(selection).from(userDomains)
    .where(and(eq(userDomains.id, parsed.data), eq(userDomains.userId, userId)));
  if (!row) throw new AuthError(404, "domain_not_found");
  return row;
}

async function isClaimedByAnother(domain: string, userId: string) {
  const [claim] = await db.select({ userId: userDomains.userId }).from(userDomains)
    .where(and(eq(userDomains.domain, domain), isNotNull(userDomains.verifiedAt)));
  return Boolean(claim && claim.userId !== userId);
}

router.get("/icon/:domain", async (req, res) => {
  const domain = normalizeDomain(req.params.domain);
  if (!domain || domain !== req.params.domain) {
    res.sendStatus(404);
    return;
  }
  const [claim] = await db.select({ id: userDomains.id }).from(userDomains)
    .where(and(eq(userDomains.domain, domain), isNotNull(userDomains.verifiedAt)));
  const icon = claim && (await iconForSite(new URL(`https://${domain}/`)));
  if (!icon) {
    res.set("Cache-Control", "public, max-age=300").sendStatus(404);
    return;
  }
  res.set({
    "Cache-Control": "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
  }).type(icon.type).send(icon.body);
});

router.get("/", async (req, res) => {
  const { id } = await requireApprovedUser(req);
  const rows = await db.select(selection).from(userDomains)
    .where(eq(userDomains.userId, id)).orderBy(userDomains.createdAt, userDomains.domain);
  res.json({ domains: rows.map(present), max: maxDomains });
});

router.post("/", async (req, res) => {
  const { id } = await requireUser(req);
  const input = z.strictObject({ domain: z.string().min(1).max(300) }).safeParse(req.body);
  const domain = input.success ? normalizeDomain(input.data.domain) : null;
  if (!domain) throw new AuthError(400, "invalid_domain");
  if (await isClaimedByAnother(domain, id)) throw new AuthError(409, "domain_taken");
  const created = await db.transaction(async (tx) => {
    const owned = await tx.select({ id: userDomains.id, domain: userDomains.domain }).from(userDomains)
      .where(eq(userDomains.userId, id)).for("update");
    if (owned.some((row) => row.domain === domain)) throw new AuthError(409, "domain_exists");
    const [{ total }] = await tx.select({ total: count() }).from(userDomains).where(eq(userDomains.userId, id));
    if (total >= maxDomains) throw new AuthError(409, "domain_limit");
    const [row] = await tx.insert(userDomains).values({ userId: id, domain, token: random() }).returning(selection);
    return row;
  });
  res.status(201).json({ domain: present(created) });
});

const safeAddresses = (addresses: string[]) =>
  addresses.filter((address) => {
    try {
      return isPublicPreviewAddress(address);
    } catch {
      return false;
    }
  });

async function authoritativeServers(name: string) {
  const resolver = new Resolver({ timeout: 2500, tries: 2 });
  const labels = name.split(".");
  for (let start = 0; start < labels.length - 1; start++) {
    const zone = labels.slice(start).join(".");
    const hosts = await resolver.resolveNs(zone).catch(() => []);
    if (!hosts.length) continue;
    const addresses = await Promise.all(
      hosts.slice(0, 6).map((host) => resolver.resolve4(host).catch(() => [] as string[])),
    );
    return safeAddresses(addresses.flat());
  }
  return [];
}

export async function lookupTxt(name: string) {
  const read = async (servers?: string[]) => {
    const resolver = new Resolver({ timeout: 2500, tries: 2 });
    if (servers) resolver.setServers(servers);
    try {
      return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(""));
    } catch {
      return [];
    }
  };
  for (const server of (await authoritativeServers(name)).slice(0, 4)) {
    const values = await read([server]);
    if (values.length) return values;
  }
  return read();
}

router.post("/:id/verify", async (req, res) => {
  const { id: userId } = await requireUser(req);
  const row = await ownDomain(userId, req.params.id);
  if (row.verifiedAt) {
    res.json({ domain: present(row) });
    return;
  }
  const values = await lookupTxt(`${challengeLabel}.${row.domain}`);
  if (!values.includes(`${valuePrefix}${row.token}`)) throw new AuthError(422, "domain_record_missing");
  let verified;
  try {
    [verified] = await db.update(userDomains).set({ verifiedAt: new Date() })
      .where(and(eq(userDomains.id, row.id), eq(userDomains.userId, userId))).returning(selection);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new AuthError(409, "domain_taken");
    throw error;
  }
  res.json({ domain: present(verified ?? { ...row, verifiedAt: new Date() }) });
});

router.delete("/:id", async (req, res) => {
  const { id: userId } = await requireUser(req);
  const row = await ownDomain(userId, req.params.id);
  await db.delete(userDomains).where(and(eq(userDomains.id, row.id), eq(userDomains.userId, userId)));
  res.sendStatus(204);
});

export const domainConnectKeyHost = "_dck1";
function signQuery(query: string) {
  if (!env.DOMAIN_CONNECT_PRIVATE_KEY) return null;
  const key = createPrivateKey(env.DOMAIN_CONNECT_PRIVATE_KEY.replaceAll("\\n", "\n"));
  return createSign("RSA-SHA256").update(query).sign(key, "base64");
}

const settingsSchema = z.object({
  providerName: z.string().max(200).default(""),
  urlSyncUX: z.url({ protocol: /^https$/ }).max(500),
  urlAPI: z.url({ protocol: /^https$/ }).max(500),
});
const discoveryHost = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[\w./-]{0,100})?$/i;

async function fetchJson(url: URL) {
  const result = await fetchPublicPreview(url, { accept: "application/json", types: jsonTypes, byteLimit: 64 * 1024 });
  if (!result) return undefined;
  try {
    return JSON.parse(result.body.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

router.post("/:id/domain-connect", async (req, res) => {
  const { id: userId } = await requireUser(req);
  const row = await ownDomain(userId, req.params.id);
  if (row.verifiedAt) throw new AuthError(409, "domain_already_verified");
  const [host] = await lookupTxt(`_domainconnect.${row.domain}`);
  if (!host || !discoveryHost.test(host)) throw new AuthError(422, "domain_connect_unsupported");
  const settings = settingsSchema.safeParse(
    await fetchJson(new URL(`https://${host.replace(/\/$/, "")}/v2/${row.domain}/settings`)),
  );
  if (!settings.success) throw new AuthError(502, "domain_connect_unavailable");
  const base = (value: string) => value.replace(/\/$/, "");
  const template = `/v2/domainTemplates/providers/${domainConnectProviderId}/services/${domainConnectServiceId}`;
  const known = await fetchJson(new URL(`${base(settings.data.urlAPI)}${template}`));
  if (!known) throw new AuthError(422, "domain_connect_unsupported");
  const apply = new URL(`${base(settings.data.urlSyncUX)}${template}/apply`);
  const query = new URLSearchParams({
    domain: row.domain,
    token: row.token,
    redirect_uri: `${env.APP_ORIGIN}/settings/account?domainconnect=${row.id}`,
  }).toString();
  const signature = signQuery(query);
  if (!signature) throw new AuthError(422, "domain_connect_unsupported");
  apply.search = `${query}&${new URLSearchParams({ sig: signature, key: domainConnectKeyHost })}`;
  res.json({ url: apply.href, provider: settings.data.providerName || null });
});

export default router;
