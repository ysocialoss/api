import { createHash } from "node:crypto";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { env } from "./config.ts";

const organization = "ysocialoss";
const apiOrigin = "https://api.github.com";
const githubOrigin = "https://github.com";
const publicToken = env.GITHUB_PUBLIC_READ_TOKEN;
const commitCacheDuration = (publicToken ? 5 : 30) * 60_000;
const login = z.string().regex(/^[a-z\d][a-z\d_-]{0,99}$/i);
const githubId = z.number().int().positive().transform(String);
const identitySchema = z.object({ id: githubId, login });
export const githubConfigured = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
const redirectUri = `${env.APP_ORIGIN}/api/github/callback`;

export function githubAuthorizeUrl(state: string, verifier: string) {
  const url = new URL("/login/oauth/authorize", githubOrigin);
  url.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    scope: "",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return url.href;
}

async function githubFetch(url: URL, options: RequestInit) {
  try {
    const response = await fetch(url, {
      ...options,
      redirect: "error",
      signal: options.signal ?? AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new AuthError(502, "github_unavailable");
    const data: unknown = response.status === 204 ? [] : await response.json();
    return { data, next: /;\s*rel="next"/.test(response.headers.get("link") ?? "") };
  } catch {
    throw new AuthError(502, "github_unavailable");
  }
}

function apiGet(path: string, token: string | undefined, signal?: AbortSignal) {
  return githubFetch(new URL(path, apiOrigin), {
    signal,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ysocial",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

export async function exchangeGithubCode(code: string, verifier: string) {
  const { data } = await githubFetch(new URL("/login/oauth/access_token", githubOrigin), {
    method: "POST",
    headers: { Accept: "application/json" },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID ?? "",
      client_secret: env.GITHUB_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }),
  });
  const token = z.object({ access_token: z.string().min(1) }).parse(data);
  const identity = await apiGet("/user", token.access_token);
  return identitySchema.parse(identity.data);
}

const repoSchema = z.object({
  name: z.string().regex(/^[a-z\d._-]+$/i),
  private: z.boolean(),
  owner: z.object({ login }),
  fork: z.boolean(),
});
const forkSchema = z.object({
  default_branch: z.string().min(1),
  parent: z.object({
    default_branch: z.string().min(1),
    owner: z.object({ login }),
  }),
});
const compareSchema = z.object({ commits: z.array(z.object({
  author: z.object({ id: githubId }).nullable(),
})) });
const contributorSchema = z.object({ id: githubId, contributions: z.number().int().nonnegative() });
const searchSchema = z.object({ total_count: z.number().int().nonnegative(), incomplete_results: z.literal(false) });

async function* pages<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal) {
  const url = new URL(path, apiOrigin);
  url.searchParams.set("per_page", "100");
  for (let page = 1; ; page++) {
    url.searchParams.set("page", String(page));
    const result = await apiGet(url.pathname + url.search, publicToken, signal);
    yield schema.parse(result.data);
    if (!result.next) break;
  }
}

async function loadCommitCounts() {
  const counts = new Map<string, number>();
  const add = (id: string, contributions: number) =>
    counts.set(id, (counts.get(id) ?? 0) + contributions);
  const signal = AbortSignal.timeout(15_000);
  for await (const repos of pages(`/orgs/${organization}/repos?type=public`, z.array(repoSchema), signal)) {
    for (const repo of repos) {
      if (repo.private || repo.owner.login.toLowerCase() !== organization) continue;
      const path = `/repos/${organization}/${encodeURIComponent(repo.name)}`;
      if (repo.fork) {
        // A fork's contributors endpoint also credits commits it inherited from upstream.
        const { data } = await apiGet(path, publicToken, signal);
        const fork = forkSchema.parse(data);
        const base = encodeURIComponent(`${fork.parent.owner.login}:${fork.parent.default_branch}`);
        const head = encodeURIComponent(`${organization}:${fork.default_branch}`);
        for await (const { commits } of pages(`${path}/compare/${base}...${head}`, compareSchema, signal)) {
          for (const { author } of commits) if (author) add(author.id, 1);
        }
      } else {
        for await (const contributors of pages(`${path}/contributors?anon=false`, z.array(contributorSchema), signal)) {
          for (const { id, contributions } of contributors) add(id, contributions);
        }
      }
    }
  }
  return counts;
}

let commitCounts: { expiresAt: number; result: ReturnType<typeof loadCommitCounts> } | undefined;
function readCommitCounts() {
  if (!commitCounts || commitCounts.expiresAt <= Date.now()) {
    const snapshot = {
      expiresAt: Date.now() + 60_000,
      result: loadCommitCounts(),
    };
    commitCounts = snapshot;
    void snapshot.result.then(() => {
      snapshot.expiresAt = Date.now() + commitCacheDuration;
    }, () => {
      // Reuse the failed request briefly to avoid hammering GitHub.
    });
  }
  return commitCounts.result;
}

async function searchCount(query: string, signal: AbortSignal) {
  const params = new URLSearchParams({ q: `org:${organization} is:public ${query}`, per_page: "1" });
  const { data } = await apiGet(`/search/issues?${params}`, publicToken, signal);
  return searchSchema.parse(data).total_count;
}

export async function readGithubContributions(id: string) {
  const signal = AbortSignal.timeout(15_000);
  const { data } = await apiGet(`/user/${encodeURIComponent(id)}`, publicToken, signal);
  const identity = identitySchema.parse(data);
  if (identity.id !== id) throw new AuthError(502, "github_unavailable");
  // Authenticated search can reject queries that mix issues and pull requests.
  const [commits, issues, pullRequests, reviewed] = await Promise.all([
    readCommitCounts(),
    searchCount(`is:issue author:${identity.login}`, signal),
    searchCount(`is:pr author:${identity.login}`, signal),
    searchCount(`is:pr reviewed-by:${identity.login}`, signal),
  ]);
  return {
    login: identity.login,
    contributionCount: (commits.get(id) ?? 0) + issues + pullRequests + reviewed,
  };
}
