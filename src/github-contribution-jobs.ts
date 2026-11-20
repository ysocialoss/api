import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { AuthError } from "./auth/provider.ts";
import { env } from "./config.ts";
import { db } from "./db/index.ts";
import { githubConnections, githubContributionJobs } from "./db/schema.ts";
import { githubConfigured, readGithubContributions } from "./github-provider.ts";
import { githubProfileSelection } from "./user-data.ts";

const pollIntervalMs = (env.GITHUB_PUBLIC_READ_TOKEN ? 1 : 10) * 60_000;
const due = lte(githubContributionJobs.runAt, sql`now()`);

export async function processGithubContributionJob(connectionId?: string) {
  const lease = randomUUID();
  const available = connectionId ? or(isNull(githubContributionJobs.lease), due) : due;
  const job = await db.transaction(async (tx) => {
    // Lock the connection first so claims, completion, and cascading deletes
    // acquire locks in the same order.
    const [candidate] = await tx.select({ id: githubConnections.id, githubId: githubConnections.githubId })
      .from(githubContributionJobs)
      .innerJoin(githubConnections, eq(githubConnections.id, githubContributionJobs.connectionId))
      .where(and(
        connectionId ? eq(githubConnections.id, connectionId) : undefined,
        available,
        or(isNull(githubConnections.attemptedAt), lte(githubConnections.attemptedAt, sql`now() - interval '1 minute'`)),
      ))
      .orderBy(asc(githubContributionJobs.runAt), asc(githubContributionJobs.connectionId))
      .limit(1).for("update", { of: githubConnections, skipLocked: true });
    if (!candidate) return;
    // GitHub reads are bounded. A dead worker makes the job visible again
    // when the lease expires, and only the current lease can publish a count.
    const [claimed] = await tx.update(githubContributionJobs).set({ lease, runAt: sql`now() + interval '2 minutes'` })
      .where(and(eq(githubContributionJobs.connectionId, candidate.id), available))
      .returning({ connectionId: githubContributionJobs.connectionId });
    if (!claimed) return;
    await tx.update(githubConnections).set({ attemptedAt: sql`now()` })
      .where(eq(githubConnections.id, candidate.id));
    return candidate;
  });
  if (!job) return;

  const result = await readGithubContributions(job.githubId).catch(() => null);
  const profile = await db.transaction(async (tx) => {
    const [connection] = await tx.select({ id: githubConnections.id }).from(githubConnections)
      .where(eq(githubConnections.id, job.id)).for("update");
    if (!connection) return;
    const [finished] = await tx.update(githubContributionJobs).set({
      lease: null,
      runAt: result ? sql`now() + interval '24 hours'` : sql`now() + interval '10 minutes'`,
    }).where(and(eq(githubContributionJobs.connectionId, job.id), eq(githubContributionJobs.lease, lease)))
      .returning({ connectionId: githubContributionJobs.connectionId });
    if (!finished || !result) return;

    const [updated] = await tx.update(githubConnections).set({ ...result, checkedAt: sql`now()` })
      .where(eq(githubConnections.id, job.id)).returning(githubProfileSelection);
    return updated;
  });
  if (!result) throw new AuthError(502, "github_unavailable");
  return profile;
}

export function reportGithubRefreshFailure() {
  console.warn({ event: "github_contribution_refresh_failed" });
}

export function startGithubRefresh() {
  if (!githubConfigured) return () => {};
  let running = false;
  async function poll() {
    if (running) return;
    running = true;
    try {
      await processGithubContributionJob();
    } catch {
      reportGithubRefreshFailure();
    } finally {
      running = false;
    }
  }
  void poll();
  const timer = setInterval(poll, pollIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
