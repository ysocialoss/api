import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

config({ path: new URL("../.env", import.meta.url), quiet: true });

const identities = {
  discord: { token: "https://discord.com/api/oauth2/token", me: "https://discord.com/api/users/@me", body: { id: "1234567890", username: "alice_d", global_name: "Alice D" }, host: "discord.com" },
  twitch: { token: "https://id.twitch.tv/oauth2/token", me: "https://api.twitch.tv/helix/users", body: { data: [{ id: "555", login: "alice_tv", display_name: "AliceTV" }] }, host: "www.twitch.tv" },
};

test("profile connections link, show, protect and unlink for every provider", async () => {
  const connection = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_connections_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  const realFetch = globalThis.fetch;
  let database;
  let server;
  try {
    await connection.query(`CREATE DATABASE ${name}`);
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      NODE_ENV: "development",
      APP_ORIGIN: "http://localhost:3000",
      ADMIN_ORIGIN: "http://localhost:3200",
      SESSION_ENCRYPTION_KEY: "a".repeat(64),
      DISCORD_CLIENT_ID: "d-id", DISCORD_CLIENT_SECRET: "d-secret",
      TWITCH_CLIENT_ID: "t-id", TWITCH_CLIENT_SECRET: "t-secret",
      STEAM_API_KEY: "s-key",
    });
    database = await import("../src/db/index.ts");
    const { app } = await import("../src/app.ts");
    const { hash } = await import("../src/auth/secrets.ts");
    await migrate(database.db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });

    async function account(handle) {
      const { rows: [user] } = await database.pool.query(
        "INSERT INTO users (handle, approved_at) VALUES ($1, now()) RETURNING id", [handle]);
      const { rows: [identity] } = await database.pool.query(
        "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', $1, $2) RETURNING id",
        [handle, user.id]);
      const token = randomUUID();
      await database.pool.query(
        "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
        [hash(token), identity.id]);
      return { id: user.id, cookie: `session=${token}` };
    }
    const alice = await account("alice");
    const bob = await account("bob");
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (who, method, path, body) => realFetch(base + path, {
      method,
      redirect: "manual",
      headers: { Cookie: who.cookie, Origin: "http://localhost:3000", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

    const seen = [];
    globalThis.fetch = async (input, init) => {
      const target = String(input instanceof Request ? input.url : input);
      for (const [provider, spec] of Object.entries(identities)) {
        if (target === spec.token) {
          seen.push({ provider, body: String(init?.body) });
          return Response.json({ access_token: `token-${provider}` });
        }
        if (target === spec.me) {
          assert.equal(init?.headers?.Authorization, `Bearer token-${provider}`);
          return Response.json(spec.body);
        }
      }
      return realFetch(input, init);
    };

    const list = await (await call(alice, "GET", "/api/connections")).json();
    assert.deepEqual(list.providers.map(({ provider, configured }) => [provider, configured]),
      [["discord", true], ["twitch", true], ["steam", true], ["spotify", true], ["apple_music", true]]);
    assert.equal((await call(alice, "POST", "/api/connections/spotify/connect", {})).status, 400);
    assert.equal((await call(alice, "POST", "/api/connections/spotify/link", { url: "https://evil.example/user/x" })).status, 400);
    assert.equal((await call(alice, "POST", "/api/connections/spotify/link", { url: "https://open.spotify.com/user/alice_s?si=1" })).status, 201);
    assert.equal((await call(alice, "POST", "/api/connections/spotify/link", { url: "https://open.spotify.com/user/other" })).status, 409);
    assert.equal((await call(alice, "DELETE", "/api/connections/spotify")).status, 204);
    assert.equal((await call(alice, "POST", "/api/connections/myspace/connect", {})).status, 404);

    async function link(who, provider, query = {}) {
      const { url: authorize } = await (await call(who, "POST", `/api/connections/${provider}/connect`, { returnTo: "settings" })).json();
      const parsed = new URL(authorize);
      const state = parsed.searchParams.get("state");
      const params = new URLSearchParams({ state, code: "the-code", ...query });
      const response = await realFetch(`${base}/api/connections/${provider}/callback?${params}`, {
        redirect: "manual", headers: { Cookie: who.cookie },
      });
      return { parsed, location: response.headers.get("location") };
    }

    for (const provider of ["discord", "twitch"]) {
      const { parsed, location } = await link(alice, provider);
      assert.equal(parsed.searchParams.get("redirect_uri"), `http://localhost:3000/api/connections/${provider}/callback`);
      assert.equal(parsed.searchParams.has("code_challenge"), provider !== "twitch");
      assert.equal(location, `http://localhost:3000/settings/account?connection=${provider}&result=connected`);
      assert.equal((await call(alice, "POST", `/api/connections/${provider}/connect`, {})).status, 409);
    }
    const exchanged = seen.find(({ provider }) => provider === "discord").body;
    assert.match(exchanged, /code_verifier=/);
    assert.match(exchanged, /client_secret=d-secret/);

    const mine = await (await call(alice, "GET", "/api/connections")).json();
    assert.equal(mine.providers.find(({ provider }) => provider === "twitch").connection.profileUrl, "https://www.twitch.tv/alice_tv");
    const profile = await (await call(bob, "GET", "/api/profiles/alice")).json();
    assert.deepEqual(profile.profile.connections.map(({ provider, username }) => [provider, username]),
      [["discord", "alice_d"], ["twitch", "alice_tv"]]);

    const liveCalls = [];
    const stubbed = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const target = String(input instanceof Request ? input.url : input);
      if (target === "https://id.twitch.tv/oauth2/token") return Response.json({ access_token: "app-token", expires_in: 3600 });
      if (target.startsWith("https://api.twitch.tv/helix/streams")) {
        liveCalls.push(target);
        assert.equal(init?.headers?.Authorization, "Bearer app-token");
        return Response.json({ data: [{ user_id: "555", type: "live" }] });
      }
      return stubbed(input, init);
    };
    const live = await (await realFetch(`${base}/api/connections/twitch/live?handles=alice,bob`)).json();
    assert.deepEqual(live, { live: { alice: { login: "alice_tv" } } });
    await realFetch(`${base}/api/connections/twitch/live?handles=alice`);
    assert.equal(liveCalls.length, 1);
    assert.equal((await call(bob, "PATCH", "/api/connections/twitch", { displayOnProfile: false })).status, 404);
    const hiddenTwitch = await call(alice, "PATCH", "/api/connections/twitch", { displayOnProfile: false });
    assert.equal(hiddenTwitch.status, 200);
    assert.equal((await hiddenTwitch.json()).connection.displayOnProfile, false);
    const hiddenLive = await (await realFetch(`${base}/api/connections/twitch/live?handles=alice`)).json();
    assert.deepEqual(hiddenLive, { live: {} });
    assert.equal((await realFetch(`${base}/api/connections/twitch/live?handles=Bad Handle`)).status, 400);
    globalThis.fetch = stubbed;

    await database.pool.query(
      "INSERT INTO github_connections (user_id, github_id, login) VALUES ($1, '1', 'alice-gh')",
      [alice.id],
    );
    const { rows: [domain] } = await database.pool.query(
      "INSERT INTO user_domains (user_id, domain, token, verified_at) VALUES ($1, 'alice.example', 'token', now()) RETURNING id",
      [alice.id],
    );
    const getProfile = async () => (await (await call(bob, "GET", "/api/profiles/alice")).json()).profile;
    const visibleProfile = await getProfile();
    assert.deepEqual(visibleProfile.domains, ["alice.example"]);
    assert.equal(visibleProfile.github.login, "alice-gh");

    for (const path of ["/api/github", `/api/domains/${domain.id}`]) {
      assert.equal((await call(bob, "PATCH", path, { displayOnProfile: false })).status, 404);
      assert.equal((await call(alice, "PATCH", path, { displayOnProfile: false })).status, 200);
    }
    const hiddenProfile = await getProfile();
    assert.deepEqual(hiddenProfile.connections.map(({ provider }) => provider), ["discord"]);
    assert.deepEqual(hiddenProfile.domains, []);
    assert.equal(hiddenProfile.github, null);
    assert.equal((await (await call(alice, "GET", "/api/github")).json()).github.displayOnProfile, false);
    assert.equal((await (await call(alice, "GET", "/api/domains")).json()).domains[0].displayOnProfile, false);

    for (const path of ["/api/connections/twitch", "/api/github", `/api/domains/${domain.id}`]) {
      assert.equal((await call(alice, "PATCH", path, { displayOnProfile: true })).status, 200);
    }
    const restoredProfile = await getProfile();
    assert.equal(restoredProfile.github.login, "alice-gh");
    assert.deepEqual(restoredProfile.domains, ["alice.example"]);
    assert.ok(restoredProfile.connections.some(({ provider }) => provider === "twitch"));

    const taken = await link(bob, "discord");
    assert.equal(taken.location, "http://localhost:3000/settings/account?connection=discord&result=account_taken");

    const stale = await realFetch(`${base}/api/connections/twitch/callback?state=${"x".repeat(43)}&code=c`, {
      redirect: "manual", headers: { Cookie: bob.cookie },
    });
    assert.equal(stale.headers.get("location"), "http://localhost:3000/settings/account?connection=twitch&result=invalid_state");

    const cancelled = await link(bob, "twitch", { error: "access_denied" });
    assert.equal(cancelled.location, "http://localhost:3000/settings/account?connection=twitch&result=cancelled");

    const { url: profileReturn } = await (await call(bob, "POST", "/api/connections/twitch/connect", { returnTo: "profile" })).json();
    assert.match(new URL(profileReturn).searchParams.get("state"), /^profile\./);

    assert.equal((await call(alice, "DELETE", "/api/connections/discord")).status, 204);
    const after = await (await call(alice, "GET", "/api/connections")).json();
    assert.equal(after.providers.find(({ provider }) => provider === "discord").connection, null);
    const relinked = await link(bob, "discord");
    assert.equal(relinked.location, "http://localhost:3000/settings/account?connection=discord&result=connected");
  } finally {
    globalThis.fetch = realFetch;
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await database?.pool.end();
    await connection.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await connection.end();
  }
});
