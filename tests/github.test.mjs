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
      GITHUB_PUBLIC_READ_TOKEN: "",
    });
    database = await import("../src/db/index.ts");
    const { app } = await import("../src/app.ts");
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
      assert.equal(options.headers.Authorization, undefined);
      if (pathname === "/user/42") return Response.json({ id: 42, login });
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
      assert.ok(query.startsWith("org:ysocialoss is:public "));
      if (failSearch) return new Response(null, { status: 503 });
      return Response.json({ incomplete_results: false, total_count: query.includes("reviewed-by:") ? 3 : 2 });
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
    const github = { login, contributionCount: 24 };
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

    assert.equal((await call("/api/github", { method: "DELETE", headers: owner.headers })).status, 204);
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
