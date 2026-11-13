import { Router } from "express";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { importJWK } from "jose";
import type { QueryConfig } from "pg";
import { z } from "zod";
import { pool } from "./db/index.ts";
import { env } from "./config.ts";
import { avatarStorage } from "./storage/r2.ts";

type CheckStatus = "ok" | "unavailable" | "rate_limited";
type Check = { status: CheckStatus; checkedAt: string; latencyMs: number };

// Cache failures too, and share pending requests so polling cannot fan out probes.
function cachedCheck(intervalMs: number, probe: () => Promise<CheckStatus>) {
  let cached: Check | undefined;
  let expires = 0;
  let pending: Promise<Check> | undefined;
  return async (): Promise<Check> => {
    if (cached && Date.now() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      const started = performance.now();
      let status: CheckStatus;
      try {
        status = await probe();
      } catch {
        status = "unavailable";
      }
      cached = {
        status,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
      };
      expires = Date.now() + intervalMs;
      return cached;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}

const discoverySchema = z.object({
  issuer: z.string().min(1),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
});
const jwksSchema = z.object({
  keys: z.array(z.object({
    kty: z.string(),
    alg: z.string().optional(),
    use: z.string().optional(),
    key_ops: z.array(z.string()).optional(),
    n: z.string().optional(),
    e: z.string().optional(),
  })),
});
const klipySchema = z.object({
  result: z.literal(true),
  data: z.object({ data: z.array(z.unknown()) }),
});

export function createHealthRouter() {
  const router = Router();
  const database = cachedCheck(15_000, async () => {
    // Pool acquisition is separately bounded by connectionTimeoutMillis.
    // pg supports per-query timeouts, but @types/pg only declares the client option.
    const query: QueryConfig & { query_timeout: number } = {
      text: "SELECT 1", query_timeout: 2000,
    };
    await pool.query(query);
    return "ok";
  });
  const r2 = cachedCheck(60_000, async () => {
    await avatarStorage!.client.send(
      new HeadBucketCommand({ Bucket: avatarStorage!.bucket }),
      { abortSignal: AbortSignal.timeout(2000) },
    );
    return "ok";
  });
  const klipy = cachedCheck(300_000, async () => {
    const url = new URL(`https://api.klipy.com/api/v1/${env.KLIPY_API_KEY}/gifs/trending`);
    url.search = new URLSearchParams({
      page: "1", per_page: "1", content_filter: "high", format_filter: "gif,webp",
    }).toString();
    const response = await fetch(url, {
      signal: AbortSignal.timeout(2000), redirect: "error",
    });
    if (response.status === 429) {
      await response.body?.cancel();
      return "rate_limited";
    }
    if (!response.ok) {
      await response.body?.cancel();
      return "unavailable";
    }
    klipySchema.parse(await response.json());
    return "ok";
  });
  const cns = cachedCheck(60_000, async () => {
    // One deadline covers discovery, keys, and response body consumption.
    const signal = AbortSignal.timeout(3000);
    const options = { signal, redirect: "error" } satisfies RequestInit;
    const response = await fetch(env.CNS_DISCOVERY_URL, options);
    if (!response.ok) {
      await response.body?.cancel();
      return "unavailable";
    }
    const metadata = discoverySchema.parse(await response.json());
    if (env.NODE_ENV === "production" &&
      [metadata.token_endpoint, metadata.jwks_uri].some(
        (url) => new URL(url).protocol !== "https:",
      )) return "unavailable";
    const keysResponse = await fetch(metadata.jwks_uri, options);
    if (!keysResponse.ok) {
      await keysResponse.body?.cancel();
      return "unavailable";
    }
    const { keys } = jwksSchema.parse(await keysResponse.json());
    const signingKeys = keys.filter((key) =>
      key.kty === "RSA" && key.n && key.e &&
      (!key.alg || key.alg === "RS256") &&
      (!key.use || key.use === "sig") &&
      (!key.key_ops || key.key_ops.includes("verify")),
    );
    if (!signingKeys.length) return "unavailable";
    await Promise.all(signingKeys.map((key) => importJWK(key, "RS256")));
    return "ok";
  });

  router.use(["/live", "/ready", "/health"], (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/live", (_req, res) => {
    res.json({ status: "ok" });
  });
  router.get("/ready", async (_req, res) => {
    const result = await database();
    res.status(result.status === "ok" ? 200 : 503).json({
      status: result.status === "ok" ? "ok" : "unavailable",
      checks: { database: result },
    });
  });
  router.get("/health", async (_req, res) => {
    const [dbResult, r2Result, klipyResult, cnsResult] = await Promise.all([
      database(), r2(), klipy(), cns(),
    ]);
    const checks = { database: dbResult, r2: r2Result, klipy: klipyResult, cns: cnsResult };
    const ready = dbResult.status === "ok";
    res.status(ready ? 200 : 503).json({
      status: !ready ? "unavailable" : Object.values(checks).every(
        (check) => check.status === "ok",
      ) ? "ok" : "degraded",
      checks,
    });
  });
  return router;
}
