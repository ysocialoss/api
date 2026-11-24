import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("GitHub links are session-bound and publish only verified contribution data", async (t) => {
  const origin = "http://localhost:3000";
  const connection = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const databaseName = `ysocial_github_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${databaseName}`;
  let database;
  let server;
  try {
    await connection.query(`CREATE DATABASE ${databaseName}`);
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      NODE_ENV: "test",
      APP_ORIGIN: origin,
      GITHUB_CLIENT_ID: "test-client",
      GITHUB_CLIENT_SECRET: "test-secret",
      GITHUB_PUBLIC_READ_TOKEN: "github-public-test-token",
    });
    database = await import("../src/db/index.ts");
    const { app } = await import("../src/app.ts");
    const { processGithubContributionJob } = await import("../src/github-contribution-jobs.ts");
    const { hash } = await import("../src/auth/secrets.ts");
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    async function makeUser(handle, role) {
      const { rows: [user] } = await database.pool.query(
        "INSERT INTO users (handle, role, approved_at) VALUES ($1, $2, now()) RETURNING id",
        [handle, role],
      );
      const { rows: [identity] } = await database.pool.query(
        "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', $1, $2) RETURNING id",
        [handle, user.id],
      );
      const token = randomUUID();
      await database.pool.query(
        "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
        [hash(token), identity.id],
      );
      return { id: user.id, headers: { Cookie: `session=${token}`, Origin: origin } };
    }
    const owner = await makeUser("github_owner", "user");
    const staff = await makeUser("github_admin", "admin");
    await database.pool.query(
      "UPDATE users SET badges = $1 WHERE id = $2",
      [JSON.stringify([{ id: randomUUID(), icon: "bug", tooltip: "Bug hunter" }]), owner.id],
    );
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const realFetch = globalThis.fetch;
    let challenge;
    let exchanged = 0;
    let failSearch = true;
    let login = "first-login";
    let holdIdentity;
    let identityReads = 0;
    t.mock.method(globalThis, "fetch", (input, options) => {
      const target = new URL(input);
      const { hostname, pathname, searchParams } = target;
      if (hostname === "github.com") {
        assert.equal(pathname, "/login/oauth/access_token");
        assert.equal(options.body.get("redirect_uri"), origin + "/api/github/callback");
        assert.equal(createHash("sha256").update(options.body.get("code_verifier")).digest("base64url"), challenge);
        exchanged++;
        return Response.json({ access_token: "github-test-token" });
      }
      if (hostname !== "api.github.com") return realFetch(input, options);
      if (pathname === "/user") {
        assert.equal(options.headers.Authorization, "Bearer github-test-token");
        return Response.json({ id: 42, login });
      }
      assert.equal(options.headers.Authorization, "Bearer github-public-test-token");
      if (pathname === "/user/42") {
        identityReads++;
        const response = Response.json({ id: 42, login });
        if (!holdIdentity) return response;
        const gate = holdIdentity;
        holdIdentity = undefined;
        gate.entered.resolve();
        return gate.release.promise.then(() => response);
      }
      if (pathname === "/orgs/ysocialoss/repos") return Response.json([
        { name: "web", private: false, owner: { login: "ysocialoss" }, fork: false },
        { name: "api", private: false, owner: { login: "ysocialoss" }, fork: false },
        { name: "fork", private: false, owner: { login: "ysocialoss" }, fork: true },
        { name: "private", private: true, owner: { login: "ysocialoss" }, fork: false },
      ]);
      if (pathname === "/repos/ysocialoss/web/contributors") {
        if (searchParams.get("page") === "1") return Response.json([{ id: 99, contributions: 50 }], {
          headers: { Link: '<https://api.github.com/next>; rel="next"' },
        });
        return Response.json([{ id: 42, contributions: 7 }]);
      }
      if (pathname === "/repos/ysocialoss/api/contributors")
        return Response.json([{ id: 42, contributions: 11 }]);
      if (pathname === "/repos/ysocialoss/fork") return Response.json({
        default_branch: "main", parent: { default_branch: "main", owner: { login: "upstream" } },
      });
      if (decodeURIComponent(pathname) === "/repos/ysocialoss/fork/compare/upstream:main...ysocialoss:main")
        return Response.json({ commits: [{ author: { id: 42 } }, { author: null }] });
      assert.equal(pathname, "/search/issues");
      const query = searchParams.get("q");
      const queryPrefix = "org:ysocialoss is:public ";
      assert.ok(query.startsWith(queryPrefix));
      if (!/\bis:(?:issue|pr)\b/.test(query)) return new Response(null, { status: 422 });
      if (failSearch) return new Response(null, { status: 503 });
      const counts = new Map([
        [`is:issue author:${login}`, 2],
        [`is:pr author:${login}`, 5],
        [`is:pr reviewed-by:${login}`, 3],
      ]);
      const totalCount = counts.get(query.slice(queryPrefix.length));
      assert.notEqual(totalCount, undefined);
      return Response.json({ incomplete_results: false, total_count: totalCount });
    });
    const call = (path, options) => fetch(base + path, options);
    const connect = async (headers, returnTo) => {
      const response = await call("/api/github/connect", {
        method: "POST",
        headers: returnTo ? { ...headers, "Content-Type": "application/json" } : headers,
        body: returnTo ? JSON.stringify({ returnTo }) : undefined,
      });
      assert.equal(response.status, 200);
      const authorize = new URL((await response.json()).url);
      assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
      challenge = authorize.searchParams.get("code_challenge");
      return "/api/github/callback?code=test-code&state=" + authorize.searchParams.get("state");
    };
    const callback = async (path, headers) => {
      const response = await call(path, { headers, redirect: "manual" });
      assert.equal(response.status, 302);
      return response.headers.get("location");
    };
    const publicProfile = async () => {
      const response = await call("/api/profiles/github_owner");
      assert.equal(response.status, 200);
      return (await response.json()).profile;
    };
    assert.equal((await call("/api/github/connect", { method: "POST", headers: { Cookie: owner.headers.Cookie } })).status, 403);
    const invalidReturn = await call("/api/github/connect", {
      method: "POST",
      headers: { ...owner.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ returnTo: "https://example.com" }),
    });
    assert.equal(invalidReturn.status, 400);
    const cancelledPath = (await connect(owner.headers, "profile")).replace("code=test-code", "error=access_denied");
    assert.equal(await callback(cancelledPath, owner.headers), "/@github_owner?github=cancelled");
    const settingsPath = (await connect(owner.headers, "settings")).replace("code=test-code", "error=access_denied");
    assert.equal(await callback(settingsPath, owner.headers), "/settings/account?github=cancelled");
    const path = await connect(owner.headers, "profile");
    assert.equal(await callback(path, staff.headers), "/asettings?github=github_invalid_state");
    assert.equal(exchanged, 0);
    assert.equal(await callback(path, owner.headers), "/@github_owner?github=connected");
    assert.equal(await callback(path, owner.headers), "/asettings?github=github_invalid_state");
    assert.equal(exchanged, 1);
    assert.deepEqual((await publicProfile()).github, { login, contributionCount: null });

    const staffPath = await connect(staff.headers);
    assert.equal(await callback(staffPath, staff.headers), "/asettings?github=github_account_taken");
    await database.pool.query("UPDATE github_connections SET attempted_at = NULL");
    failSearch = false;
    login = "renamed-login";
    const refresh = await call("/api/github/refresh", { method: "POST", headers: owner.headers });
    assert.equal(refresh.status, 200);
    const github = { login, contributionCount: 29 };
    assert.deepEqual(await refresh.json(), { github });
    assert.equal((await call("/api/github/refresh", { method: "POST", headers: owner.headers })).status, 429);
    assert.deepEqual((await publicProfile()).github, github);
    const details = await call("/api/admin/user/" + owner.id, { headers: staff.headers });
    assert.deepEqual((await details.json()).github, github);
    const list = await call("/api/admin/users", { headers: staff.headers });
    assert.deepEqual((await list.json()).users.find(user => user.id === owner.id).github, github);
    await database.pool.query("UPDATE github_connections SET attempted_at = NULL");
    failSearch = true;
    assert.equal((await call("/api/github/refresh", { method: "POST", headers: owner.headers })).status, 502);
    assert.deepEqual((await publicProfile()).github, github);

    const { rows: [queued] } = await database.pool.query(
      "SELECT lease, run_at > now() + interval '9 minutes' AS retry_scheduled FROM github_contribution_jobs",
    );
    assert.deepEqual(queued, { lease: null, retry_scheduled: true });
    assert.equal(await processGithubContributionJob(), undefined, "workers respect the persisted retry time");

    async function makeJobDue() {
      await database.pool.query("UPDATE github_connections SET attempted_at = now() - interval '3 minutes'");
      await database.pool.query("UPDATE github_contribution_jobs SET run_at = now() - interval '1 second'");
    }
    await makeJobDue();
    failSearch = false;
    const gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
    holdIdentity = gate;
    const stalledWorker = processGithubContributionJob();
    try {
      await Promise.race([gate.entered.promise, stalledWorker.then(() => assert.fail("job was not claimed"))]);
      const readsBeforeRetry = identityReads;
      assert.equal(await processGithubContributionJob(), undefined, "another worker cannot claim a live lease");
      assert.equal(identityReads, readsBeforeRetry);
      const manualRefresh = await call("/api/github/refresh", { method: "POST", headers: owner.headers });
      assert.equal(manualRefresh.status, 429, "manual refresh uses the same lease");

      await makeJobDue();
      assert.deepEqual(await processGithubContributionJob(), github, "another worker recovers an expired lease");
      gate.release.resolve();
      assert.equal(await stalledWorker, undefined, "a replaced worker cannot publish its result");
    } finally {
      gate.release.resolve();
      await stalledWorker;
    }
    const { rows: [scheduled] } = await database.pool.query(
      "SELECT lease, run_at > now() + interval '23 hours' AS refresh_scheduled FROM github_contribution_jobs",
    );
    assert.deepEqual(scheduled, { lease: null, refresh_scheduled: true });

    assert.equal((await call("/api/github", { method: "DELETE", headers: owner.headers })).status, 204);
    assert.equal((await database.pool.query("SELECT 1 FROM github_contribution_jobs")).rowCount, 0);
    const profile = await publicProfile();
    assert.equal(profile.github, null);
    assert.equal(profile.badges[0].tooltip, "Bug hunter");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.pool.end();
    await connection.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await connection.end();
  }
});
