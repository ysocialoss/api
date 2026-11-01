import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

test("CNS login lifecycle against a local signed-token provider", async (t) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const wrongKey = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "local-test",
    alg: "RS256",
    use: "sig",
  };
  const subject = `${Date.now()}${Math.floor(Math.random() * 1000000)}`;
  const handle = `test_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const codes = new Map<
    string,
    { nonce: string; state: string; challenge: string; mode: string }
  >();
  let providerOrigin = "",
    refreshes = 0,
    logouts = 0,
    refreshMode = 200;
  const seenRefresh = new Set<string>();
  let directoryCalls = 0;
  let directoryMissing = false;
  let logoutMode = 204;
  const attemptStates: string[] = [];
  const mock = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/discovery") {
      res.end(
        JSON.stringify({
          issuer: providerOrigin,
          token_endpoint: `${providerOrigin}/token`,
          jwks_uri: `${providerOrigin}/jwks`,
        }),
      );
      return;
    }
    if (req.url === "/jwks") {
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.url?.startsWith("/api/users?")) {
      directoryCalls++;
      assert.match(req.headers.authorization ?? "", /^Bearer /);
      assert.ok(
        new URL(req.url, providerOrigin).searchParams
          .get("ids")
          ?.includes(subject),
      );
      res.end(
        JSON.stringify(
          directoryMissing
            ? []
            : [
                {
                  id: subject,
                  username: "renamed_cns",
                  display_name: "Changed CNS",
                  avatar: null,
                },
              ],
        ),
      );
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    if (req.url === "/token") {
      const code = codes.get(body.code);
      codes.delete(body.code);
      if (
        !code ||
        body.state !== code.state ||
        createHash("sha256").update(body.code_verifier).digest("base64url") !==
          code.challenge ||
        body.redirect_uri !== "http://localhost:3000/auth/callback"
      ) {
        res.writeHead(400);
        res.end("{}");
        return;
      }
      const jwt = await new SignJWT({
        nonce: code.mode === "nonce" ? "wrong" : code.nonce,
        preferred_username: "test_cns",
        name: "Test CNS",
        ...(code.mode === "azp" ? { azp: "other-app" } : {}),
      })
        .setProtectedHeader({ alg: "RS256", kid: "local-test" })
        .setIssuer(code.mode === "issuer" ? "wrong-issuer" : providerOrigin)
        .setAudience(code.mode === "audience" ? "other-app" : "ysocial")
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime(
          code.mode === "expired" ? Math.floor(Date.now() / 1000) - 60 : "15m",
        )
        .sign(code.mode === "signature" ? wrongKey.privateKey : privateKey);
      const tokens = {
        access_token: "access",
        refresh_token: randomUUID(),
        id_token: jwt,
        token_type: "Bearer",
        expires_in: 900,
        scope: "openid profile users:read",
        state: code.state,
      };
      res.end(
        JSON.stringify(
          code.mode === "missing" ? { ...tokens, id_token: undefined } : tokens,
        ),
      );
      return;
    }
    if (req.url === "/api/auth/token/refresh") {
      refreshes++;
      if (refreshMode !== 200) {
        res.writeHead(refreshMode);
        res.end("{}");
        return;
      }
      if (seenRefresh.has(body.refresh_token)) {
        res.writeHead(401);
        res.end("{}");
        return;
      }
      seenRefresh.add(body.refresh_token);
      await new Promise((resolve) => setTimeout(resolve, 30));
      res.end(
        JSON.stringify({
          access_token: "rotated",
          refresh_token: randomUUID(),
          token_type: "Bearer",
          expires_in: 900,
          scope: "openid profile users:read",
        }),
      );
      return;
    }
    if (req.url === "/api/auth/logout") {
      logouts++;
      res.writeHead(logoutMode);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const address = mock.address();
  assert.ok(address && typeof address === "object");
  providerOrigin = `http://127.0.0.1:${address.port}`;
  process.env.CNS_DISCOVERY_URL = `${providerOrigin}/discovery`;
  process.env.CNS_API_ORIGIN = providerOrigin;
  process.env.CNS_LOGIN_URL = `${providerOrigin}/login`;
  process.env.APP_ORIGIN = "http://localhost:3000";
  process.env.CNS_CLIENT_ID = "ysocial";
  process.env.NODE_ENV = "test";
  process.env.SESSION_ENCRYPTION_KEY = "ab".repeat(32);
  const { app } = await import("../src/app.ts");
  const { pool } = await import("../src/db/index.ts");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiAddress = server.address();
  assert.ok(apiAddress && typeof apiAddress === "object");
  const base = `http://127.0.0.1:${apiAddress.port}`;
  function request(
    path: string,
    cookie = "",
    body?: unknown,
    origin = "http://localhost:3000",
  ) {
    return fetch(base + path, {
      redirect: "manual",
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  function cookies(response: Response) {
    return response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }
  async function begin(mode = "") {
    const response = await request("/auth/login");
    assert.equal(response.status, 302);
    const url = new URL(response.headers.get("location")!);
    assert.equal(url.origin, providerOrigin);
    assert.equal(url.searchParams.get("scope"), "openid profile users:read");
    const state = url.searchParams.get("state")!;
    attemptStates.push(state);
    const code = randomUUID();
    codes.set(code, {
      state,
      nonce: url.searchParams.get("nonce")!,
      challenge: url.searchParams.get("code_challenge")!,
      mode,
    });
    return {
      path: `/auth/callback?code=${code}&state=${state}`,
      cookie: cookies(response),
    };
  }
  let session = "";
  try {
    await t.test(
      "anonymous, removed sample endpoints, callback CSRF",
      async () => {
        assert.deepEqual(await (await request("/auth/me")).json(), {
          authenticated: false,
        });
        assert.equal((await request("/users")).status, 404);
        const login = await begin();
        assert.match(
          (await request(login.path)).headers.get("location")!,
          /invalid_login_state/,
        );
        const response = await request(login.path, login.cookie);
        assert.equal(response.headers.get("location"), "/onboarding");
        session = cookies(response);
        assert.match(session, /session=/);
        assert.ok(response.headers.get("set-cookie")?.includes("HttpOnly"));
        const replay = await request(login.path, login.cookie);
        assert.match(replay.headers.get("location")!, /invalid_login_state/);
      },
    );
    await t.test(
      "expired login transaction cannot create a session",
      async () => {
        const login = await begin();
        const state = new URL(login.path, base).searchParams.get("state");
        assert.ok(state);
        await pool.query(
          "UPDATE oauth_transactions SET expires_at=now()-interval '1 minute' WHERE state=$1",
          [createHash("sha256").update(state).digest("hex")],
        );
        const response = await request(login.path, login.cookie);
        assert.match(response.headers.get("location")!, /invalid_login_state/);
        assert.equal(response.headers.getSetCookie().length, 0);
      },
    );
    await t.test(
      "onboarding validates origin and handle, commits one account",
      async () => {
        const me = await (await request("/auth/me", session)).json();
        assert.equal(me.needsOnboarding, true);
        assert.equal(me.suggestedHandle, "test_cns");
        assert.equal(
          (
            await request(
              "/auth/profile",
              session,
              { handle },
              "https://attacker.example",
            )
          ).status,
          403,
        );
        assert.equal(
          (await request("/auth/profile", session, { handle: "BAD!" })).status,
          400,
        );
        const taken = `${handle}_x`;
        await pool.query("INSERT INTO users(handle) VALUES($1)", [taken]);
        try {
          assert.equal(
            (await request("/auth/profile", session, { handle: taken })).status,
            409,
          );
        } finally {
          await pool.query("DELETE FROM users WHERE handle=$1", [taken]);
        }
        const responses = await Promise.all([
          request("/auth/profile", session, { handle }),
          request("/auth/profile", session, { handle }),
        ]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
        const me2 = await (await request("/auth/me", session)).json();
        assert.equal(me2.user.handle, handle);
        assert.equal(me2.user.displayName, "Test CNS");
        assert.ok(!JSON.stringify(me2).includes("access_token"));
      },
    );
    await t.test(
      "rejects wrong audience, nonce, and absent ID token",
      async () => {
        for (const mode of [
          "nonce",
          "audience",
          "missing",
          "issuer",
          "expired",
          "signature",
          "azp",
        ]) {
          const login = await begin(mode);
          const response = await request(login.path, login.cookie);
          assert.match(
            response.headers.get("location")!,
            /invalid_provider_identity/,
          );
          assert.equal(response.headers.getSetCookie().length, 0);
        }
      },
    );
    await t.test(
      "returning login maps subject, rotates local session",
      async () => {
        const login = await begin();
        const response = await request(
          login.path,
          `${login.cookie}; ${session}`,
        );
        assert.equal(response.headers.get("location"), "/");
        const old = session;
        session = cookies(response);
        assert.deepEqual(await (await request("/auth/me", old)).json(), {
          authenticated: false,
        });
        assert.equal(
          (await (await request("/auth/me", session)).json()).user.handle,
          handle,
        );
      },
    );
    await t.test(
      "concurrent refresh serializes and tokens are encrypted",
      async () => {
        await pool.query(
          "UPDATE auth_sessions SET refresh_after=now()-interval '1 minute' WHERE identity_id IN (SELECT id FROM auth_identities WHERE subject=$1)",
          [subject],
        );
        const results = await Promise.all(
          Array.from({ length: 5 }, () => request("/auth/me", session)),
        );
        assert.ok(results.every((response) => response.status === 200));
        assert.equal(refreshes, 1);
        const stored = await pool.query(
          "SELECT encrypted_tokens FROM auth_sessions WHERE identity_id IN (SELECT id FROM auth_identities WHERE subject=$1)",
          [subject],
        );
        assert.ok(!stored.rows[0].encrypted_tokens.includes("rotated"));
      },
    );
    await t.test(
      "temporary refresh failure retains session and backs off",
      async () => {
        refreshMode = 429;
        await pool.query(
          "UPDATE auth_sessions SET refresh_after=now()-interval '1 minute' WHERE identity_id IN (SELECT id FROM auth_identities WHERE subject=$1)",
          [subject],
        );
        assert.equal((await request("/auth/me", session)).status, 503);
        const before = refreshes;
        assert.equal((await request("/auth/me", session)).status, 503);
        assert.equal(refreshes, before);
        const stored = await pool.query(
          "SELECT count(*) FROM auth_sessions WHERE identity_id IN (SELECT id FROM auth_identities WHERE subject=$1)",
          [subject],
        );
        assert.equal(stored.rows[0].count, "1");
        refreshMode = 503;
        await pool.query(
          "UPDATE auth_sessions SET retry_after=NULL WHERE identity_id IN (SELECT id FROM auth_identities WHERE subject=$1)",
          [subject],
        );
        assert.equal((await request("/auth/me", session)).status, 503);
        refreshMode = 200;
        await pool.query(
          "UPDATE auth_sessions SET retry_after=NULL WHERE identity_id IN (SELECT id FROM auth_identities WHERE subject=$1)",
          [subject],
        );
        assert.equal((await request("/auth/me", session)).status, 200);
      },
    );
    await t.test(
      "directory updates cache without changing local handles or deleting missing users",
      async () => {
        const { reconcileProfiles } = await import("../src/auth/reconcile.ts");
        await reconcileProfiles();
        assert.equal(directoryCalls, 1);
        const identity = await pool.query(
          "SELECT username FROM auth_identities WHERE subject=$1",
          [subject],
        );
        assert.equal(identity.rows[0].username, "renamed_cns");
        const me = await (await request("/auth/me", session)).json();
        assert.equal(me.user.handle, handle);
        assert.equal(me.user.displayName, "Test CNS");
        directoryMissing = true;
        await reconcileProfiles();
        assert.equal(
          (await (await request("/auth/me", session)).json()).user.handle,
          handle,
        );
      },
    );
    await t.test("logout revokes CNS and local session", async () => {
      assert.equal(
        (await request("/auth/logout", session, {}, "https://attacker.example"))
          .status,
        403,
      );
      assert.equal((await request("/auth/logout", session, {})).status, 204);
      assert.equal(logouts, 1);
      assert.deepEqual(await (await request("/auth/me", session)).json(), {
        authenticated: false,
      });
    });
    await t.test(
      "failed remote logout still removes local session",
      async () => {
        const login = await begin();
        session = cookies(await request(login.path, login.cookie));
        logoutMode = 503;
        assert.equal((await request("/auth/logout", session, {})).status, 204);
        assert.deepEqual(await (await request("/auth/me", session)).json(), {
          authenticated: false,
        });
        logoutMode = 204;
      },
    );
    await t.test("refresh revocation clears session", async () => {
      const login = await begin();
      session = cookies(await request(login.path, login.cookie));
      refreshMode = 401;
      await pool.query(
        "UPDATE auth_sessions SET refresh_after=now()-interval '1 minute' WHERE identity_id IN (SELECT id FROM auth_identities WHERE subject=$1)",
        [subject],
      );
      assert.deepEqual(await (await request("/auth/me", session)).json(), {
        authenticated: false,
      });
    });
  } finally {
    await pool.query("DELETE FROM auth_identities WHERE subject=$1", [subject]);
    await pool.query("DELETE FROM users WHERE handle=$1", [handle]);
    await pool.query(
      "DELETE FROM oauth_transactions WHERE state = ANY($1::text[])",
      [
        attemptStates.map((state) =>
          createHash("sha256").update(state).digest("hex"),
        ),
      ],
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    await pool.end();
  }
});
