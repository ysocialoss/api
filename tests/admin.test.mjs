import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("staff sessions can read admin data and role changes take effect on the next request", async (t) => {
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
      "INSERT INTO users (handle, approved_at) VALUES ('staff_test', now()) RETURNING id, role",
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
    const paths = ["/session", "/overview", "/users", "/waitlist", "/activity", `/user/${user.id}`, `/post/${post.id}`];

    for (const path of paths) {
      const response = await fetch(base + "/api/admin" + path, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 401);
    }

    for (const role of ["user", "admin", "moderator", "og"]) {
      await database.pool.query("UPDATE users SET role = $1 WHERE id = $2", [role, user.id]);
      const allowed = role === "admin" || role === "moderator";
      if (allowed) {
        for (const path of ["/users", `/user/${user.id}`]) {
          const permission = await fetch(base + "/api/admin" + path, { headers });
          assert.equal(permission.status, 200);
          assert.equal((await permission.json()).canEditBadges, role === "admin");
        }
        const options = await fetch(base + "/api/admin/badge-options", { headers });
        assert.equal(options.status, role === "admin" ? 200 : 403);
        if (role === "moderator") assert.deepEqual(await options.json(), { error: "admin_required" });
      }
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
    const onboard = (token, handle = "ytest", pronouns) => fetch(base + "/auth/profile", {
      method: "POST",
      headers: {
        Cookie: `session=${token}`,
        Origin: env.APP_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ handle, pronouns, acceptTerms: true, ageConfirmed: true }),
    });
    const regularToken = await onboardingSession("different");
    const withoutTerms = await fetch(base + "/auth/profile", {
      method: "POST",
      headers: { Cookie: `session=${regularToken}`, Origin: env.APP_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "ytest" }),
    });
    assert.equal(withoutTerms.status, 400);
    assert.equal((await withoutTerms.json()).error, "terms_required");
    const regular = await onboard(regularToken);
    assert.equal(regular.status, 201);
    const { user: regularUser } = await regular.json();
    assert.equal(regularUser.pronouns, "");
    assert.equal((await fetch(base + "/api/admin/session", {
      headers: { Cookie: `session=${regularToken}` },
    })).status, 403);
    await database.pool.query("DELETE FROM users WHERE id = $1", [regularUser.id]);

    const newToken = await onboardingSession("ytest");
    assert.equal((await onboard(newToken, "ytest", "a".repeat(81))).status, 400);
    const joinedYtest = await onboard(newToken, "ytest", "  hän  ");
    assert.equal(joinedYtest.status, 201);
    const { user: ytest } = await joinedYtest.json();
    assert.equal(ytest.pronouns, "hän");
    const staffHeaders = { Cookie: `session=${newToken}` };
    assert.equal((await fetch(base + "/api/admin/session", {
      headers: staffHeaders,
    })).status, 403);
    const ytestSession = await fetch(base + "/auth/me", { headers: staffHeaders }).then(response => response.json());
    assert.equal(ytestSession.pendingApproval, true);
    assert.equal(ytestSession.user.role, "user");
    assert.equal(ytestSession.user.pronouns, "hän");
    await database.pool.query("UPDATE users SET role = 'admin', approved_at = now() WHERE id = $1", [ytest.id]);

    const applicantToken = await onboardingSession("waitlist_test");
    const joined = await onboard(applicantToken, "waitlist_test");
    assert.equal(joined.status, 201);
    const { user: applicant } = await joined.json();
    const applicantHeaders = { Cookie: `session=${applicantToken}` };
    assert.equal((await fetch(base + "/auth/approval/live")).status, 401);
    assert.equal((await fetch(base + "/api/admin/waitlist/live", { headers: applicantHeaders })).status, 403);
    const applicantSession = () => fetch(base + "/auth/me", { headers: applicantHeaders }).then(response => response.json());
    assert.equal((await applicantSession()).pendingApproval, true);
    assert.equal((await onboard(applicantToken, "another_handle")).status, 409);
    assert.equal((await fetch(base + "/api/posts/" + post.id, { headers: applicantHeaders })).status, 200);
    assert.equal((await fetch(base + "/api/notifications", { headers: applicantHeaders })).status, 200);
    const like = () => fetch(base + "/api/posts/" + post.id + "/like", {
      method: "PUT", headers: { ...applicantHeaders, Origin: env.APP_ORIGIN },
    });
    const blocked = await like();
    assert.equal(blocked.status, 403);
    assert.deepEqual(await blocked.json(), { error: "approval_required" });
    const blockedProfile = await fetch(base + "/api/profiles/me", {
      method: "PATCH", headers: { ...applicantHeaders, Origin: env.APP_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Not approved" }),
    });
    assert.equal(blockedProfile.status, 403);
    const waitlist = () => fetch(base + "/api/admin/waitlist?q=waitlist_test", { headers: staffHeaders }).then(response => response.json());
    assert.deepEqual((await waitlist()).users.map(item => item.id), [applicant.id]);
    const approve = (cookie = staffHeaders, origin = env.ADMIN_ORIGIN) =>
      fetch(base + "/api/admin/waitlist/" + applicant.id + "/approve", {
        method: "POST", headers: { ...cookie, Origin: origin },
      });
    await database.pool.query("UPDATE users SET role = 'moderator' WHERE id = $1", [user.id]);
    assert.equal((await approve(headers)).status, 403);
    await database.pool.query("UPDATE users SET role = 'og' WHERE id = $1", [user.id]);
    assert.equal((await approve(staffHeaders, env.ADMIN_ORIGIN + "-invalid")).status, 403);
    assert.equal((await approve()).status, 204);
    assert.equal((await approve()).status, 204);
    assert.equal((await applicantSession()).pendingApproval, false);
    const recommendations = await fetch(base + "/api/profiles/pronouns/recommendations");
    assert.equal(recommendations.status, 200);
    const { languages, general } = await recommendations.json();
    assert.ok(languages.de.includes("er/ihm"));
    assert.ok(languages.fi.includes("hän"));
    assert.ok(general.includes("Use my name"));
    const setPronouns = (pronouns) => fetch(base + "/api/profiles/me", {
      method: "PATCH",
      headers: { ...applicantHeaders, Origin: env.APP_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ pronouns }),
    });
    assert.equal((await setPronouns("they\u0000them")).status, 400);
    const updatedPronouns = await setPronouns("  ze/zir, 她  ");
    assert.equal(updatedPronouns.status, 200);
    assert.equal((await updatedPronouns.json()).pronouns, "ze/zir, 她");
    for (const path of ["waitlist_test", "waitlist_test/card"]) {
      const profile = await fetch(base + "/api/profiles/" + path);
      assert.equal((await profile.json()).profile.pronouns, "ze/zir, 她");
    }
    assert.equal((await applicantSession()).user.pronouns, "ze/zir, 她");
    assert.equal((await waitlist()).users.length, 0);
    assert.equal((await like()).status, 200);
    const { rows: [approvalLog] } = await database.pool.query(
      "SELECT count(*)::int AS count FROM moderation_activity WHERE action = 'approveUser' AND target_id = $1",
      [applicant.id],
    );
    assert.equal(approvalLog.count, 1);
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
      "INSERT INTO users (handle, display_name, approved_at) SELECT 'bulk_' || n, 'Bulk user ' || n, now() FROM generate_series(1, 26) AS n",
    );
    const first = await list("q=bulk+user");
    const second = await list("q=bulk+user&page=2");
    assert.equal(first.users.length, 25);
    assert.equal(first.hasNextPage, true);
    assert.equal(second.users.length, 1);
    assert.equal(second.hasNextPage, false);
    assert.ok(first.users.every((row) => row.canEditRole && row.id !== second.users[0].id));
    const ids = [user.id, second.users[0].id];
    const badgePath = base + "/api/admin/users/" + user.id + "/badges";
    const changeBadge = (change, cookie = staffHeaders) => fetch(badgePath, {
      method: "PATCH",
      headers: { ...cookie, Origin: env.ADMIN_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify(change),
    });
    const publicBadgeProfile = async (handle) => {
      const response = await fetch(base + "/api/profiles/" + handle);
      assert.equal(response.status, 200);
      return (await response.json()).profile;
    };
    const adminProfile = await publicBadgeProfile("ytest");
    assert.equal(Object.hasOwn(adminProfile, "isAdmin"), false);
    assert.equal(adminProfile.isOg, false);
    assert.deepEqual(adminProfile.badges, []);
    const optionsResponse = await fetch(base + "/api/admin/badge-options", { headers: staffHeaders });
    assert.equal(optionsResponse.status, 200);
    const options = await optionsResponse.json();
    assert.ok(options.presets.every(({ icon }) => options.icons.includes(icon)));
    const developerPreset = options.presets.find(({ label }) => label === "Developer");
    assert.deepEqual(developerPreset, { label: "Developer", icon: "terminal", tooltip: "Developed this" });
    assert.ok(options.icons.includes("bike"));
    const icon = await fetch(base + "/api/profiles/badge-icons/bike");
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get("content-type"), /^image\/svg\+xml/);
    assert.match(await icon.text(), /lucide-bike/);

    const add = { action: "add", icon: "bike", tooltip: "Organized a group ride" };
    assert.equal((await changeBadge(add, headers)).status, 403);
    assert.equal((await changeBadge({ ...add, icon: "unknown-icon" })).status, 400);
    assert.equal((await changeBadge({ ...add, tooltip: " " })).status, 400);
    const assigned = await changeBadge(add);
    assert.equal(assigned.status, 200);
    const { badges: [badge] } = await assigned.json();
    assert.equal(badge.tooltip, add.tooltip);
    assert.equal(badge.icon, add.icon);
    assert.deepEqual((await changeBadge(add).then(response => response.json())).badges, [badge]);
    const decorated = await publicBadgeProfile("staff_test");
    assert.equal(Object.hasOwn(decorated, "isAdmin"), false);
    assert.equal(decorated.isOg, true);
    assert.deepEqual(decorated.badges, [badge]);
    assert.deepEqual((await list("q=staff_test")).users[0].badges, [badge]);
    const removed = await changeBadge({ action: "remove", id: badge.id });
    assert.equal(removed.status, 200);
    assert.deepEqual((await publicBadgeProfile("staff_test")).badges, []);
    const badgeActivity = await fetch(base + "/api/admin/activity", { headers: staffHeaders });
    assert.equal(badgeActivity.status, 200);
    const { entries: badgeEntries } = await badgeActivity.json();
    assert.deepEqual(
      badgeEntries.filter(({ action }) => action === "addBadge" || action === "removeBadge")
        .map(({ action, detail }) => [action, detail]).sort(),
      [["addBadge", "bike: Organized a group ride"], ["removeBadge", "bike: Organized a group ride"]],
    );

    const developerBadge = await changeBadge({
      action: "add", icon: developerPreset.icon, tooltip: developerPreset.tooltip,
    });
    assert.equal(developerBadge.status, 200);
    const { badges: assignedDeveloperBadges } = await developerBadge.json();
    assert.deepEqual((await publicBadgeProfile("staff_test")).badges, assignedDeveloperBadges);
    assert.equal(assignedDeveloperBadges[0].tooltip, "Developed this");

    for (let number = 1; number <= 8; number++) {
      assert.equal((await changeBadge({ ...add, tooltip: "Badge " + number })).status, 200);
    }
    const finalAdds = ["Final badge A", "Final badge B"].map((tooltip) => ({ ...add, tooltip }));
    const results = await Promise.all(finalAdds.map((change) => changeBadge(change)));
    assert.deepEqual(results.map(({ status }) => status).sort(), [200, 400]);
    const rejected = results.findIndex(({ status }) => status === 400);
    assert.deepEqual(await results[rejected].json(), { error: "badge_limit_reached" });
    const fullProfile = await publicBadgeProfile("staff_test");
    assert.equal(fullProfile.badges.length, 10);
    assert.ok(!fullProfile.badges.some(({ tooltip }) => tooltip === finalAdds[rejected].tooltip));
    assert.equal((await changeBadge(finalAdds[1 - rejected])).status, 200);

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
        body: JSON.stringify({ action, value, ground: { type: "terms", ref: "5.7", facts: "Test decision" } }),
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
    assert.equal((await editProfile(user.id, "changeBio", "a".repeat(161))).status, 400);
    assert.equal((await editProfile(user.id, "changeBio", "Updated bio")).status, 200);
    assert.equal((await details()).bio, "Updated bio");
    assert.equal((await editProfile(user.id, "changePronouns", "they/them")).status, 200);
    assert.equal((await details()).pronouns, "they/them");
    assert.equal((await list("q=renamed")).users[0].pronouns, "they/them");
    assert.equal((await editProfile(user.id, "changePronouns", "")).status, 200);
    assert.equal((await details()).pronouns, "");
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
    const gif = { url: "https://static.klipy.com/test.gif", title: "Moderation GIF" };
    const { rows: [quote] } = await database.pool.query(
      "INSERT INTO posts (author_id, content, is_quote, quoted_post_id, gif) VALUES ($1, 'Quote', true, $2, $3) RETURNING id",
      [developmentAdmin.id, post.id, gif],
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

    const bulkProfiles = (targetIds, action, value, cookie = staffHeaders) =>
      fetch(base + "/api/admin/users/profiles", {
        method: "PATCH",
        headers: { ...cookie, Origin: env.ADMIN_ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: targetIds, action, value }),
      });
    assert.equal((await bulkProfiles(ids, "changeBio", "Shared bio", headers)).status, 403);
    assert.equal((await bulkProfiles([...ids, randomUUID()], "changeBio", "Shared bio")).status, 404);
    assert.equal((await details()).bio, "");
    for (const [action, value, field] of [
      ["changeBio", "Shared bio", "bio"],
      ["changeName", "Shared name", "name"],
    ]) {
      const response = await bulkProfiles(ids, action, value);
      assert.equal(response.status, 200);
      const { users: saved } = await response.json();
      assert.deepEqual(new Set(saved.map(item => item.id)), new Set(ids));
      assert.ok(saved.every(item => item[field] === value));
      const repeated = await bulkProfiles(ids, action, value);
      assert.deepEqual(await repeated.json(), { users: [] });
    }

    const voiceKey = `voices/${randomUUID()}.m4a`;
    const voice = { key: voiceKey, url: "/api/" + voiceKey, durationMs: 2000, bytes: 1024, waveform: [] };
    const { rows: [reply] } = await database.pool.query(
      "INSERT INTO posts (author_id, parent_id, content, voice) VALUES ($1, $2, 'Reviewable reply', $3) RETURNING id",
      [user.id, quote.id, voice],
    );
    const contentPath = base + "/api/admin/posts";
    assert.equal((await fetch(contentPath)).status, 401);
    const matching = await fetch(contentPath + "?type=reply&q=reviewable", { headers });
    assert.equal(matching.status, 200);
    assert.deepEqual((await matching.json()).posts.map(item => [item.id, item.voiceUrl]), [[reply.id, voice.url]]);
    await database.pool.query("UPDATE posts SET created_at = now() - interval '8 days' WHERE id = $1", [quote.id]);
    async function contentIds(query) {
      const response = await fetch(contentPath + "?" + query, { headers });
      assert.equal(response.status, 200);
      return (await response.json()).posts.map(item => item.id);
    }
    assert.deepEqual(await contentIds("author=%40YTEST"), [quote.id]);
    const gifList = await fetch(contentPath + "?author=ytest", { headers });
    assert.deepEqual((await gifList.json()).posts[0].gif, gif);
    const gifDetail = await fetch(base + "/api/admin/post/" + quote.id, { headers });
    assert.deepEqual((await gifDetail.json()).gif, gif);
    assert.deepEqual(new Set(await contentIds("authorId=" + user.id)), new Set([post.id, reply.id]));
    assert.equal((await fetch(contentPath + "?authorId=invalid", { headers })).status, 400);
    assert.deepEqual(await contentIds("author=ytest&period=7d"), []);
    assert.equal((await contentIds("sort=oldest"))[0], quote.id);
    assert.equal((await contentIds("sort=author_desc"))[0], quote.id);
    assert.equal((await fetch(contentPath + "?sort=unknown", { headers })).status, 400);
    const detail = await fetch(base + "/api/admin/post/" + reply.id, { headers: staffHeaders });
    assert.equal(detail.status, 200);
    const detailData = await detail.json();
    assert.equal(detailData.parentId, quote.id);
    assert.equal(detailData.voiceUrl, voice.url);
    const detach = (id, kind, cookie = staffHeaders) => fetch(contentPath + "/" + id + "/attachments/" + kind, {
      method: "DELETE",
      headers: { ...cookie, Origin: env.ADMIN_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ ground: { type: "terms", ref: "5.7", facts: "Test decision" } }),
    });
    const { rows: [gifOnly] } = await database.pool.query(
      "INSERT INTO posts (author_id, parent_id, content, gif) VALUES ($1, $2, '', $3) RETURNING id",
      [user.id, quote.id, gif],
    );
    assert.equal((await detach(gifOnly.id, "gif")).status, 409);
    assert.equal((await detach(gifOnly.id, "all")).status, 409);
    assert.equal((await detach(quote.id, "gif", headers)).status, 403);
    assert.equal((await detach(quote.id, "gif")).status, 204);
    assert.equal((await detach(quote.id, "gif")).status, 204);
    assert.equal((await detach(reply.id, "voice")).status, 204);
    const { rows: [preserved] } = await database.pool.query("SELECT content, voice FROM posts WHERE id = $1", [reply.id]);
    assert.deepEqual(preserved, { content: "Reviewable reply", voice: null });
    await database.pool.query("UPDATE posts SET gif = $2, voice = $3, poll = $4 WHERE id = $1",
      [reply.id, gif, voice, { title: "Pick one", options: ["One", "Two"], anonymous: false }]);
    await database.pool.query("INSERT INTO poll_votes (post_id, user_id, option_index) VALUES ($1, $2, 0)", [reply.id, user.id]);
    assert.equal((await detach(reply.id, "all")).status, 204);
    assert.equal((await detach(reply.id, "all")).status, 204);
    const cleared = await database.pool.query("SELECT content, gif, voice, poll FROM posts WHERE id = $1", [reply.id]);
    assert.deepEqual(cleared.rows[0], { content: "Reviewable reply", gif: null, voice: null, poll: null });
    assert.equal((await database.pool.query("SELECT 1 FROM poll_votes WHERE post_id = $1", [reply.id])).rowCount, 0);
    const remove = (cookie, origin = env.ADMIN_ORIGIN) => fetch(contentPath + "/" + quote.id, {
      method: "DELETE",
      headers: { ...cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ ground: { type: "terms", ref: "5.7", facts: "Test decision" } }),
    });
    assert.equal((await remove(headers)).status, 403);
    assert.equal((await remove(staffHeaders, "https://other.invalid")).status, 403);
    assert.equal((await remove(staffHeaders)).status, 204);
    assert.equal((await fetch(base + "/api/admin/post/" + reply.id, { headers })).status, 404);
    assert.equal((await fetch(base + "/api/admin/post/" + post.id, { headers })).status, 200);
    const activity = await fetch(base + "/api/admin/activity", { headers });
    assert.equal(activity.status, 200);
    const { entries } = await activity.json();
    assert.deepEqual(entries.filter(entry => entry.action === "removePost").map(entry => ({
      actorId: entry.actorId, targetId: entry.targetId, targetHandle: entry.targetHandle,
    })), [{ actorId: developmentAdmin.id, targetId: quote.id, targetHandle: "ytest" }]);
    assert.ok(entries.some(entry => entry.action === "clearAvatar" && entry.targetId === user.id));
    assert.ok(entries.some(entry => entry.action === "changeBio" && entry.targetId === user.id && entry.detail === null));
    assert.ok(entries.some(entry => entry.action === "changePronouns" && entry.targetId === user.id && entry.detail === null));
    assert.equal(entries.filter(entry => entry.action === "removeGif" && entry.targetId === quote.id).length, 1);
    assert.equal(entries.filter(entry => entry.action === "removeVoice" && entry.targetId === reply.id).length, 1);
    assert.equal(entries.filter(entry => entry.action === "clearAttachments" && entry.targetId === reply.id).length, 1);
    for (const action of ["changeBio", "changeName"]) {
      assert.equal(entries.filter(entry => entry.action === action && entry.targetId === ids[1]).length, 1);
    }
    assert.ok(entries.some(entry => entry.action === "changeRole" && entry.targetId === user.id && entry.detail === "og → moderator"));

    const fetchHttp = globalThis.fetch;
    const tokenEndpoint = "https://provider.test/token";
    const jwksEndpoint = "https://provider.test/jwks";
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    let loginNonce;
    const redirectUris = [];
    t.mock.method(globalThis, "fetch", async (input, options) => {
      if (String(input) === env.CNS_DISCOVERY_URL) return Response.json({
        issuer: "https://test.invalid", token_endpoint: tokenEndpoint, jwks_uri: jwksEndpoint,
      });
      if (String(input) === jwksEndpoint) return Response.json({ keys: [jwk] });
      if (String(input) === tokenEndpoint) {
        const body = JSON.parse(options.body);
        redirectUris.push(body.redirect_uri);
        if (body.code === "moderation-login" || body.code === "ytest-login") {
          const username = body.code === "ytest-login" ? "ytest" : "waitlist_test";
          const idToken = await new SignJWT({ nonce: loginNonce, preferred_username: username })
            .setProtectedHeader({ alg: "RS256" })
            .setIssuer("https://test.invalid").setAudience(env.CNS_CLIENT_ID)
            .setSubject(username).setIssuedAt().setExpirationTime("5m").sign(privateKey);
          return Response.json({
            access_token: "test-access", refresh_token: "test-refresh", token_type: "Bearer",
            expires_in: 3600, id_token: idToken,
          });
        }
        return new Response(null, { status: 400 });
      }
      return fetchHttp(input, options);
    });
    for (const [loginPath, origin, errorPath] of [
      ["/auth/admin/login", env.ADMIN_ORIGIN, "/"],
      ["/auth/login", env.APP_ORIGIN, "/login"],
    ]) {
      const login = await fetch(base + loginPath, { redirect: "manual" });
      assert.equal(login.status, 302);
      const authorise = new URL(login.headers.get("location"));
      assert.equal(authorise.searchParams.get("redirect_uri"), origin + "/auth/callback");
      const state = authorise.searchParams.get("state");
      const browser = login.headers.get("set-cookie").split(";")[0];
      const callbackPath = base + `/auth/callback?state=${state}&code=unused`;
      const invalid = await fetch(callbackPath, { headers: { Cookie: "oauth_browser=wrong" }, redirect: "manual" });
      assert.equal(invalid.headers.get("location"), "/login?error=invalid_login_state");
      const callback = await fetch(callbackPath, { headers: { Cookie: browser }, redirect: "manual" });
      assert.equal(callback.headers.get("location"), errorPath + "?error=login_failed");
      const replay = await fetch(callbackPath, { headers: { Cookie: browser }, redirect: "manual" });
      assert.equal(replay.headers.get("location"), "/login?error=invalid_login_state");
    }
    assert.deepEqual(redirectUris, [env.ADMIN_ORIGIN + "/auth/callback", env.APP_ORIGIN + "/auth/callback"]);

    await database.pool.query("UPDATE users SET role = 'user', approved_at = NULL WHERE id = $1", [ytest.id]);
    const adminLogin = await fetch(base + "/auth/admin/login", { redirect: "manual" });
    const adminLoginParams = new URL(adminLogin.headers.get("location")).searchParams;
    loginNonce = adminLoginParams.get("nonce");
    const adminCallback = await fetch(base + `/auth/callback?state=${adminLoginParams.get("state")}&code=ytest-login`, {
      headers: { Cookie: adminLogin.headers.get("set-cookie").split(";")[0] }, redirect: "manual",
    });
    assert.equal(adminCallback.headers.get("location"), "/");
    const signedInHeaders = { Cookie: adminCallback.headers.getSetCookie().find(cookie => cookie.startsWith("session=")).split(";")[0] };
    const signedInYtest = await fetch(base + "/auth/me", { headers: signedInHeaders }).then(response => response.json());
    assert.equal(signedInYtest.pendingApproval, true);
    assert.equal(signedInYtest.user.role, "user");
    await database.pool.query("UPDATE users SET role = 'admin', approved_at = now() WHERE id = $1", [ytest.id]);

    async function signInApplicant() {
      const login = await fetch(base + "/auth/login", { redirect: "manual" });
      const params = new URL(login.headers.get("location")).searchParams;
      loginNonce = params.get("nonce");
      const cookie = login.headers.get("set-cookie").split(";")[0];
      return fetch(base + `/auth/callback?state=${params.get("state")}&code=moderation-login`, {
        headers: { Cookie: cookie }, redirect: "manual",
      });
    }
    const moderate = (action, id = applicant.id, cookie = staffHeaders) =>
      fetch(base + "/api/admin/users/" + id + "/account", {
        method: "PATCH",
        headers: { ...cookie, Origin: env.ADMIN_ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify(action === "ban" ? { action, reason: "Spam", ground: { type: "terms", ref: "5.7", facts: "Test decision" } } : { action }),
      });
    const { rows: [applicantPost] } = await database.pool.query(
      "INSERT INTO posts (author_id, content) VALUES ($1, 'Account removal test') RETURNING id", [applicant.id],
    );
    const { rows: [otherReply] } = await database.pool.query(
      "INSERT INTO posts (author_id, parent_id, content) VALUES ($1, $2, 'Reply to removed account') RETURNING id",
      [user.id, applicantPost.id],
    );
    const avatar = "avatars/" + randomUUID() + ".avif";
    await database.pool.query("INSERT INTO avatar_history (key, user_id) VALUES ($1, $2)", [avatar, applicant.id]);
    assert.equal((await moderate("ban", applicant.id, headers)).status, 403);
    assert.equal((await moderate("remove", developmentAdmin.id)).status, 409);
    assert.equal((await moderate("ban")).status, 204);
    assert.equal((await moderate("ban")).status, 204);
    const bannedSession = await applicantSession();
    assert.equal(bannedSession.authenticated, true);
    assert.equal(bannedSession.ban.reason, "Spam");
    assert.equal(bannedSession.ban.by, "@ytest");
    assert.ok(Number.isFinite(Date.parse(bannedSession.ban.at)));
    const bannedWrite = await like();
    assert.equal(bannedWrite.status, 403);
    assert.deepEqual(await bannedWrite.json(), { error: "account_banned" });
    assert.equal((await signInApplicant()).headers.get("location"), "/");
    assert.equal((await fetch(base + "/api/posts/" + applicantPost.id)).status, 404);
    const publicProfile = () => fetch(base + "/api/profiles/waitlist_test").then(response => response.json());
    const bannedProfile = await publicProfile();
    assert.equal(bannedProfile.profile.banReason, "Spam");
    assert.equal(bannedProfile.profile.bannedAt, bannedSession.ban.at);
    assert.equal(bannedProfile.profile.bannedBy, "@ytest");
    assert.equal(bannedProfile.profile.bannedByProfileHandle, "ytest");
    assert.deepEqual(bannedProfile.posts, []);
    const publicFeed = await fetch(base + "/api/posts").then(response => response.json());
    assert.ok(publicFeed.posts.every(item => item.id !== applicantPost.id));
    const publicStates = await fetch(base + "/api/posts/states?ids=" + applicantPost.id).then(response => response.json());
    assert.deepEqual(publicStates.hiddenIds, [applicantPost.id]);
    assert.deepEqual(publicStates.posts, []);
    assert.equal((await fetch(base + "/api/admin/post/" + applicantPost.id, { headers: staffHeaders })).status, 200);
    assert.equal((await moderate("unban")).status, 204);
    assert.equal((await publicProfile()).profile.banReason, null);
    assert.equal((await fetch(base + "/api/posts/" + applicantPost.id)).status, 200);
    assert.equal((await applicantSession()).ban, null);
    assert.equal((await like()).status, 200);
    const renewed = await signInApplicant();
    assert.equal(renewed.headers.get("location"), "/");
    const renewedCookie = renewed.headers.get("set-cookie").split(";")[0];
    const renewedSession = () => fetch(base + "/auth/me", { headers: { Cookie: renewedCookie } }).then(response => response.json());
    assert.equal((await renewedSession()).authenticated, true);
    assert.equal((await moderate("remove")).status, 204);
    assert.equal((await moderate("remove")).status, 204);
    assert.equal((await renewedSession()).authenticated, false);
    const rejoined = await signInApplicant();
    assert.equal(rejoined.headers.get("location"), "/onboarding");
    const rejoinedCookie = rejoined.headers.get("set-cookie").split(";")[0];
    const rejoinedToken = rejoinedCookie.slice("session=".length);
    const rejoinedSession = () => fetch(base + "/auth/me", { headers: { Cookie: rejoinedCookie } }).then(response => response.json());
    assert.equal((await rejoinedSession()).needsOnboarding, true);
    assert.equal((await renewedSession()).authenticated, false);
    assert.equal((await onboard(renewedCookie.slice("session=".length), "stale_handle")).status, 401);
    const recreated = await onboard(rejoinedToken, "waitlist_test");
    assert.equal(recreated.status, 201);
    const { user: newApplicant } = await recreated.json();
    assert.notEqual(newApplicant.id, applicant.id);
    const joinedAgain = await rejoinedSession();
    assert.equal(joinedAgain.user.role, "user");
    assert.equal(joinedAgain.pendingApproval, true);
    assert.equal(joinedAgain.ban, null);
    assert.deepEqual((await waitlist()).users.map(item => item.id), [newApplicant.id]);
    assert.equal((await renewedSession()).authenticated, false);
    for (const { id } of [applicantPost, otherReply]) {
      assert.equal((await fetch(base + "/api/posts/" + id)).status, 404);
    }
    assert.equal((await database.pool.query("SELECT 1 FROM media_deletions WHERE key = $1", [avatar])).rowCount, 1);
    const { rows: accountHistory } = await database.pool.query(
      "SELECT action FROM moderation_activity WHERE target_id = $1 AND action IN ('banUser', 'unbanUser', 'removeUser') ORDER BY action",
      [applicant.id],
    );
    assert.deepEqual(accountHistory.map(item => item.action), ["banUser", "removeUser", "unbanUser"]);

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
