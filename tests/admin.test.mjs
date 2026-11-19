import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("staff sessions can read admin data and role changes take effect on the next request", async () => {
  const connection = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_admin_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  let database;
  let server;
  try {
    await connection.query(`CREATE DATABASE ${name}`);
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      NODE_ENV: "development",
      ADMIN_ORIGIN: "http://localhost:3200",
      SESSION_ENCRYPTION_KEY: "a".repeat(64),
    });
    database = await import("../src/db/index.ts");
    const { app } = await import("../src/app.ts");
    const { hash } = await import("../src/auth/secrets.ts");
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    const { rows: [user] } = await database.pool.query(
      "INSERT INTO users (handle) VALUES ('staff_test') RETURNING id, role",
    );
    assert.equal(user.role, "user");
    const { rows: [post] } = await database.pool.query(
      "INSERT INTO posts (author_id, content) VALUES ($1, 'Example') RETURNING id",
      [user.id],
    );
    const { rows: [identity] } = await database.pool.query(
      "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', 'staff', $1) RETURNING id",
      [user.id],
    );
    const token = randomUUID();
    await database.pool.query(
      "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
      [hash(token), identity.id],
    );
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Cookie: `session=${token}` };
    const paths = ["/session", "/overview", "/users", `/user/${user.id}`, `/post/${post.id}`];

    for (const path of paths) {
      const response = await fetch(base + "/api/admin" + path, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 401);
    }

    for (const role of ["user", "admin", "moderator", "og"]) {
      await database.pool.query("UPDATE users SET role = $1 WHERE id = $2", [role, user.id]);
      const allowed = role === "admin" || role === "moderator";
      for (const path of paths) {
        const response = await fetch(base + "/api/admin" + path, { headers });
        assert.equal(response.status, allowed ? (path === "/session" ? 204 : 200) : 403, `${role} ${path}`);
        assert.match(response.headers.get("cache-control"), /no-store/);
        if (allowed && path === "/overview") {
          const overview = await response.json();
          assert.equal(overview.recentUsers[0].role, role);
          assert.equal(overview.recentPosts[0].id, post.id);
          assert.equal(overview.metrics[0].detail, "1 in the last 24 hours");
        }
      }
    }

    const { env } = await import("../src/config.ts");
    async function onboardingSession(username) {
      const { rows: [identity] } = await database.pool.query(
        "INSERT INTO auth_identities (issuer, subject, username) VALUES ('https://test.invalid', $1, $1) RETURNING id",
        [username],
      );
      const token = randomUUID();
      await database.pool.query(
        "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
        [hash(token), identity.id],
      );
      return token;
    }
    const onboard = (token) => fetch(base + "/auth/profile", {
      method: "POST",
      headers: {
        Cookie: `session=${token}`,
        Origin: env.APP_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ handle: "ytest" }),
    });
    const regularToken = await onboardingSession("different");
    const regular = await onboard(regularToken);
    assert.equal(regular.status, 201);
    const { user: regularUser } = await regular.json();
    assert.equal((await fetch(base + "/api/admin/session", {
      headers: { Cookie: `session=${regularToken}` },
    })).status, 403);
    await database.pool.query("DELETE FROM users WHERE id = $1", [regularUser.id]);

    const newToken = await onboardingSession("ytest");
    assert.equal((await onboard(newToken)).status, 201);
    assert.equal((await fetch(base + "/api/admin/session", {
      headers: { Cookie: `session=${newToken}` },
    })).status, 204);

    const staffHeaders = { Cookie: `session=${newToken}` };
    const list = async (search, cookie = staffHeaders) => {
      const response = await fetch(base + "/api/admin/users?" + search, { headers: cookie });
      assert.equal(response.status, 200);
      return response.json();
    };
    const update = (ids, role, cookie = staffHeaders, origin = env.ADMIN_ORIGIN) =>
      fetch(base + "/api/admin/users/roles", {
        method: "PATCH",
        headers: { ...cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ ids, role }),
      });
    const { users: [developmentAdmin] } = await list("q=%40ytest");
    assert.equal(developmentAdmin.canEditRole, false);
    await database.pool.query(
      "INSERT INTO users (handle, display_name) SELECT 'bulk_' || n, 'Bulk user ' || n FROM generate_series(1, 26) AS n",
    );
    const first = await list("q=bulk+user");
    const second = await list("q=bulk+user&page=2");
    assert.equal(first.users.length, 25);
    assert.equal(first.hasNextPage, true);
    assert.equal(second.users.length, 1);
    assert.equal(second.hasNextPage, false);
    assert.ok(first.users.every((row) => row.canEditRole && row.id !== second.users[0].id));
    const ids = [user.id, second.users[0].id];
    assert.equal((await update(ids, "moderator", staffHeaders, "https://other.invalid")).status, 403);
    assert.equal((await update(ids, "unknown")).status, 400);
    assert.equal((await update([...ids, randomUUID()], "moderator")).status, 404);
    assert.equal((await update([...ids, developmentAdmin.id], "moderator")).status, 409);
    assert.equal((await list("q=staff_test")).users[0].role, "og");
    const changed = await update(ids, "moderator");
    assert.equal(changed.status, 200);
    const changedUsers = (await changed.json()).users;
    assert.equal(changedUsers.length, 2);
    assert.ok(changedUsers.every((row) => row.role === "moderator"));
    assert.ok((await list("q=bulk", headers)).users.every((row) => !row.canEditRole));
    assert.equal((await update([ids[1]], "admin", headers)).status, 403);
    assert.equal((await update([user.id], "admin")).status, 200);
    const protectSelf = await update([user.id], "og", headers);
    assert.equal((await protectSelf.json()).error, "own_role_protected");
    assert.equal((await update([developmentAdmin.id], "moderator", headers)).status, 200);
    assert.equal((await update([developmentAdmin.id], "admin", headers)).status, 200);

    const avatarKey = "avatars/" + randomUUID() + ".avif";
    const bannerKey = "banners/" + randomUUID() + ".avif";
    await database.pool.query("UPDATE auth_identities SET picture = $1 WHERE user_id = $2",
      ["https://test.invalid/cns-avatar.png", user.id]);
    await database.pool.query(
      "UPDATE users SET bio = 'Sample bio', avatar_key = $1, banner_key = $2, banner_crop = $3 WHERE id = $4",
      [avatarKey, bannerKey, { x: 0, y: 0.25, width: 1, height: 0.5 }, user.id],
    );
    await database.pool.query("INSERT INTO avatar_history (key, user_id) VALUES ($1, $2)", [avatarKey, user.id]);
    const details = async () => {
      const response = await fetch(base + "/api/admin/user/" + user.id, { headers: staffHeaders });
      assert.equal(response.status, 200);
      return response.json();
    };
    const editProfile = (id, action, value, cookie = staffHeaders) =>
      fetch(base + "/api/admin/users/" + id + "/profile", {
        method: "PATCH",
        headers: { ...cookie, Origin: env.ADMIN_ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ action, value }),
      });
    const listed = await list("q=staff_test");
    assert.equal(listed.users[0].bio, "Sample bio");
    assert.equal(listed.users[0].avatarUrl, "/api/" + avatarKey);
    assert.equal((await details()).bannerCrop.y, 0.25);
    assert.equal((await details()).bannerUrl, "/api/" + bannerKey);
    assert.equal((await editProfile(developmentAdmin.id, "changeUsername", "renamed_test")).status, 200);
    assert.equal((await editProfile(developmentAdmin.id, "changeUsername", "ytest")).status, 200);
    assert.equal((await editProfile(user.id, "changeUsername", "bulk_1")).status, 409);
    assert.equal((await editProfile(user.id, "changeUsername", "renamed")).status, 200);
    const oldProfileResponse = await fetch(base + "/api/profiles/staff_test");
    assert.equal(oldProfileResponse.status, 200);
    const oldProfile = await oldProfileResponse.json();
    assert.equal(oldProfile.profile.handle, "renamed");
    assert.equal(oldProfile.posts[0].id, post.id);
    assert.equal(oldProfile.posts[0].author.handle, "renamed");
    const existingPost = await fetch(base + "/api/posts/" + post.id).then(res => res.json());
    assert.equal(existingPost.post.author.handle, "renamed");
    assert.equal((await editProfile(developmentAdmin.id, "changeUsername", "staff_test")).status, 409);
    assert.equal((await editProfile(user.id, "changeName", "New Name")).status, 200);
    assert.equal((await editProfile(user.id, "clearBio")).status, 200);
    assert.equal((await editProfile(user.id, "clearAvatar")).status, 200);
    assert.equal((await editProfile(user.id, "clearBanner")).status, 200);
    assert.equal((await editProfile(user.id, "clearBanner")).status, 200);
    const changedProfile = await details();
    assert.equal(changedProfile.handle, "@renamed");
    assert.equal(changedProfile.name, "New Name");
    assert.equal(changedProfile.bio, "");
    assert.equal(changedProfile.avatarUrl, null);
    assert.equal(changedProfile.bannerUrl, null);
    assert.equal(changedProfile.bannerCrop, null);
    const currentSession = await fetch(base + "/auth/me", { headers }).then(res => res.json());
    assert.equal(currentSession.avatarUrl, null);
    const { rows: [quote] } = await database.pool.query(
      "INSERT INTO posts (author_id, content, is_quote, quoted_post_id) VALUES ($1, 'Quote', true, $2) RETURNING id",
      [developmentAdmin.id, post.id],
    );
    await database.pool.query(
      "INSERT INTO user_follows (follower_id, following_id) VALUES ($1, $2), ($2, $1)",
      [developmentAdmin.id, user.id],
    );
    await database.pool.query(
      "INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2)",
      [quote.id, user.id],
    );
    const quoteResponse = await fetch(base + "/api/posts/" + quote.id, { headers: staffHeaders });
    assert.equal(quoteResponse.status, 200);
    const { post: quotedPreview } = await quoteResponse.json();
    assert.equal(quotedPreview.quote.post.author.avatarUrl, null);
    assert.equal(quotedPreview.friendLikers[0].id, user.id);
    assert.equal(quotedPreview.friendLikers[0].avatarUrl, null);
    const { rows: queued } = await database.pool.query("SELECT key FROM media_deletions");
    assert.deepEqual(new Set(queued.map(row => row.key)), new Set([avatarKey, bannerKey]));
    await database.pool.query("UPDATE users SET role = 'moderator' WHERE id = $1", [user.id]);
    assert.equal((await editProfile(user.id, "clearBio", undefined, headers)).status, 403);

    const login = await fetch(base + "/auth/admin/login", { redirect: "manual" });
    assert.equal(login.status, 302);
    const authorise = new URL(login.headers.get("location"));
    assert.equal(authorise.searchParams.get("redirect_uri"), "http://localhost:3200/auth/admin/callback");
    const state = authorise.searchParams.get("state");
    const browser = login.headers.get("set-cookie").split(";")[0];
    const callback = await fetch(base + `/auth/callback?state=${state}&code=unused`, {
      headers: { Cookie: browser },
      redirect: "manual",
    });
    assert.equal(callback.headers.get("location"), "/login?error=invalid_login_state");

    const deniedLogout = await fetch(base + "/auth/admin/logout", { method: "POST", headers });
    assert.equal(deniedLogout.status, 403);
    const logout = await fetch(base + "/auth/admin/logout", {
      method: "POST",
      headers: { ...headers, Origin: "http://localhost:3200" },
    });
    assert.equal(logout.status, 204);
    assert.equal((await fetch(base + "/api/admin/session", { headers })).status, 401);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.pool.end();
    await connection.query(`DROP DATABASE IF EXISTS ${name}`);
    await connection.end();
  }
});
