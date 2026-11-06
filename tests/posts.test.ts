import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.SESSION_ENCRYPTION_KEY = "ab".repeat(32);

test("persistent text posts and cursor feed", async (t) => {
  const { app } = await import("../src/app.ts");
  const { pool } = await import("../src/db/index.ts");
  const { hash, encrypt } = await import("../src/auth/secrets.ts");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/posts`;
  const userIds: string[] = [];
  const identityIds: string[] = [];
  async function account(onboarded = true) {
    const id = randomUUID(),
      identity = randomUUID(),
      token = randomUUID();
    const handle = `post_${id.replaceAll("-", "").slice(0, 20)}`;
    if (onboarded) {
      await pool.query(
        "INSERT INTO users(id, handle, display_name) VALUES ($1,$2,'Post tester')",
        [id, handle],
      );
      userIds.push(id);
    }
    await pool.query(
      "INSERT INTO auth_identities(id, issuer, subject, user_id) VALUES ($1,'post-tests',$2,$3)",
      [identity, identity, onboarded ? id : null],
    );
    identityIds.push(identity);
    await pool.query(
      "INSERT INTO auth_sessions(token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1,$2,$3,now()+interval '1 day',now()+interval '2 days')",
      [
        hash(token),
        identity,
        encrypt({
          access_token: "test",
          refresh_token: "test",
          token_type: "Bearer",
          expires_in: 86400,
        }),
      ],
    );
    return { id, handle, cookie: `session=${token}` };
  }
  async function request(
    path = "",
    method = "GET",
    cookie = "",
    body?: unknown,
    origin = "http://localhost:3000",
  ) {
    return fetch(base + path, {
      method,
      headers: { cookie, origin, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  try {
    const alice = await account(),
      bob = await account(),
      pending = await account(false);
    let postId = "";
    await t.test(
      "public profiles expose local metadata and handle missing accounts",
      async () => {
        await pool.query(
          "UPDATE users SET bio='A plain text bio' WHERE id=$1",
          [bob.id],
        );
        const response = await fetch(
          `http://127.0.0.1:${address.port}/api/profiles/${bob.handle}`,
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.profile.id, bob.id);
        assert.equal(body.profile.bio, "A plain text bio");
        assert.deepEqual(body.posts, []);
        assert.deepEqual(Object.keys(body.profile).sort(), [
          "bio",
          "createdAt",
          "displayName",
          "handle",
          "id",
        ]);
        for (const handle of ["missing_" + randomUUID().slice(0, 8), "BAD!"]) {
          assert.equal(
            (
              await fetch(
                `http://127.0.0.1:${address.port}/api/profiles/${handle}`,
              )
            ).status,
            404,
          );
        }
      },
    );

    await t.test(
      "public reading, authentication, origin, and content validation",
      async () => {
        assert.equal((await request()).status, 200);
        assert.equal(
          (await request("", "POST", "", { content: "hello" })).status,
          401,
        );
        assert.equal(
          (await request("", "POST", pending.cookie, { content: "hello" }))
            .status,
          403,
        );
        assert.equal(
          (
            await request(
              "",
              "POST",
              alice.cookie,
              { content: "hello" },
              "https://attacker.example",
            )
          ).status,
          403,
        );
        for (const content of [
          "",
          " \n\t",
          "x".repeat(2001),
          "😀".repeat(2001),
          "hello\u0000world",
          123,
          null,
        ]) {
          assert.equal(
            (await request("", "POST", alice.cookie, { content })).status,
            400,
          );
        }
        assert.equal(
          (
            await request("", "POST", alice.cookie, {
              content: "hello",
              authorId: bob.id,
            })
          ).status,
          400,
        );
        const response = await request("", "POST", alice.cookie, {
          content: "  Hello\n<script>alert(1)</script>  ",
        });
        assert.equal(response.status, 201);
        const { post } = await response.json();
        postId = post.id;
        const publicPost = await request(`/${postId}`);
        assert.equal(publicPost.status, 200);
        assert.deepEqual((await publicPost.json()).post, post);
        assert.equal((await request(`/${randomUUID()}`)).status, 404);
        assert.equal((await request("/bad-id")).status, 400);
        assert.equal(post.content, "Hello\n<script>alert(1)</script>");
        assert.equal(post.author.id, alice.id);
        assert.equal(post.author.handle, alice.handle);
        assert.equal(
          Date.parse(post.editExpiresAt) - Date.parse(post.createdAt),
          900000,
        );
        const stored = await pool.query(
          "SELECT content FROM posts WHERE id=$1",
          [postId],
        );
        assert.equal(stored.rows[0].content, post.content);
        const emoji = await request("", "POST", alice.cookie, {
          content: "😀".repeat(2000),
        });
        assert.equal(emoji.status, 201);
      },
    );
    await t.test(
      "likes persist, are viewer-specific, and converge under retries",
      async () => {
        const path = `/${postId}/like`;
        assert.equal((await request(path, "PUT")).status, 401);
        assert.equal((await request(path, "DELETE")).status, 401);
        assert.equal((await request(path, "PUT", pending.cookie)).status, 403);
        assert.equal(
          (
            await request(
              path,
              "PUT",
              alice.cookie,
              undefined,
              "https://attacker.example",
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request(
              path,
              "DELETE",
              alice.cookie,
              undefined,
              "https://attacker.example",
            )
          ).status,
          403,
        );
        assert.equal(
          (await request(`/${randomUUID()}/like`, "PUT", alice.cookie)).status,
          404,
        );
        assert.equal(
          (await request(`/${randomUUID()}/like`, "DELETE", alice.cookie))
            .status,
          404,
        );
        assert.equal(
          (await request("/bad/like", "PUT", alice.cookie)).status,
          400,
        );
        const repeated = await Promise.all(
          Array.from({ length: 4 }, () => request(path, "PUT", bob.cookie)),
        );
        for (const response of repeated) {
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), { likes: 1, liked: true });
        }
        assert.deepEqual(
          await (await request(path, "PUT", alice.cookie)).json(),
          { likes: 2, liked: true },
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM post_likes WHERE post_id=$1",
              [postId],
            )
          ).rows[0].count,
          2,
        );
        const publicPost = (await (await request(`/${postId}`)).json()).post;
        assert.equal(publicPost.likes, 2);
        assert.equal(publicPost.liked, false);
        const signedPost = (
          await (await request(`/${postId}`, "GET", bob.cookie)).json()
        ).post;
        assert.equal(signedPost.liked, true);
        const feed = await (await request("", "GET", alice.cookie)).json();
        assert.equal(
          feed.posts.find((post: { id: string }) => post.id === postId).liked,
          true,
        );
        const profile = await (
          await fetch(
            `http://127.0.0.1:${address.port}/api/profiles/${alice.handle}`,
            { headers: { cookie: bob.cookie } },
          )
        ).json();
        assert.equal(
          profile.posts.find((post: { id: string }) => post.id === postId)
            .liked,
          true,
        );
        const unlikes = await Promise.all(
          Array.from({ length: 4 }, () => request(path, "DELETE", bob.cookie)),
        );
        for (const response of unlikes)
          assert.deepEqual(await response.json(), { likes: 1, liked: false });
        assert.deepEqual(
          await (await request(path, "DELETE", alice.cookie)).json(),
          { likes: 0, liked: false },
        );
        await Promise.all([
          request(path, "PUT", bob.cookie),
          request(path, "PUT", alice.cookie),
        ]);
        assert.equal(
          (await (await request(`/${postId}`)).json()).post.likes,
          2,
        );
      },
    );

    await t.test(
      "reply threads persist, paginate, and obey post permissions",
      async () => {
        const path = `/${postId}/replies`;
        assert.equal(
          (await request(path, "POST", "", { content: "Hello" })).status,
          401,
        );
        assert.equal(
          (await request(path, "POST", pending.cookie, { content: "Hello" }))
            .status,
          403,
        );
        assert.equal(
          (
            await request(
              path,
              "POST",
              bob.cookie,
              { content: "Hello" },
              "https://attacker.example",
            )
          ).status,
          403,
        );
        for (const content of ["", " ", "x".repeat(2001), "hello\u0000world"])
          assert.equal(
            (await request(path, "POST", bob.cookie, { content })).status,
            400,
          );
        assert.equal((await request("/bad/replies")).status, 400);
        assert.equal((await request(`/${randomUUID()}/replies`)).status, 404);
        assert.equal(
          (
            await request(`/${randomUUID()}/replies`, "POST", bob.cookie, {
              content: "Missing",
            })
          ).status,
          404,
        );
        assert.deepEqual((await (await request(path)).json()).posts, []);
        const response = await request(path, "POST", bob.cookie, {
          content: "  A reply 😀  ",
        });
        assert.equal(response.status, 201);
        const reply = (await response.json()).post;
        assert.equal(reply.parentId, postId);
        assert.equal(reply.content, "A reply 😀");
        assert.equal(reply.author.id, bob.id);
        assert.equal(reply.replies, 0);
        assert.equal(
          (
            await pool.query("SELECT parent_id FROM posts WHERE id=$1", [
              reply.id,
            ])
          ).rows[0].parent_id,
          postId,
        );
        assert.equal(
          (await (await request(`/${postId}`)).json()).post.replies,
          1,
        );
        const feed = await (await request()).json();
        assert.ok(
          !feed.posts.some((post: { id: string }) => post.id === reply.id),
        );
        assert.equal(
          (
            await request(`/${reply.id}`, "PATCH", alice.cookie, {
              content: "Wrong",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request(`/${reply.id}`, "PATCH", bob.cookie, {
              content: "Edited reply",
            })
          ).status,
          200,
        );
        assert.equal(
          (await request(`/${reply.id}/like`, "PUT", alice.cookie)).status,
          200,
        );
        assert.equal(
          (await (await request(path, "GET", alice.cookie)).json()).posts[0]
            .liked,
          true,
        );
        const nested = await request(
          `/${reply.id}/replies`,
          "POST",
          alice.cookie,
          { content: "Nested" },
        );
        assert.equal(nested.status, 201);
        const nestedId = (await nested.json()).post.id;
        const bobProfile = await (
          await fetch(
            `http://127.0.0.1:${address.port}/api/profiles/${bob.handle}`,
          )
        ).json();
        assert.ok(
          bobProfile.posts.every(
            (post: { parentId: string | null }) => post.parentId === null,
          ),
        );
        assert.equal(bobProfile.replies[0].post.id, reply.id);
        assert.deepEqual(
          bobProfile.replies[0].thread.map((post: { id: string }) => post.id),
          [postId],
        );
        const aliceProfile = await (
          await fetch(
            `http://127.0.0.1:${address.port}/api/profiles/${alice.handle}`,
          )
        ).json();
        const nestedEntry = aliceProfile.replies.find(
          (entry: { post: { id: string } }) => entry.post.id === nestedId,
        );
        assert.deepEqual(
          nestedEntry.thread.map((post: { id: string }) => post.id),
          [postId, reply.id],
        );

        assert.equal(
          (await (await request(`/${reply.id}`)).json()).post.replies,
          1,
        );
        // More than a page with identical timestamps exercises the UUID cursor tie-breaker.
        for (let i = 0; i < 22; i++)
          await pool.query(
            "INSERT INTO posts(author_id,parent_id,content,created_at) VALUES ($1,$2,'Page reply','2050-01-01')",
            [bob.id, postId],
          );
        const first = await (await request(path)).json();
        assert.equal(first.posts.length, 20);
        assert.ok(first.nextCursor);
        const second = await (
          await request(
            `${path}?cursor=${encodeURIComponent(first.nextCursor)}`,
          )
        ).json();
        assert.equal(second.posts.length, 3);
        assert.equal(second.nextCursor, null);
        assert.equal(
          new Set(
            [...first.posts, ...second.posts].map(
              (post: { id: string }) => post.id,
            ),
          ).size,
          23,
        );
        assert.equal(
          (await request(`/${reply.id}`, "DELETE", alice.cookie)).status,
          403,
        );
        assert.equal(
          (await request(`/${reply.id}`, "DELETE", bob.cookie)).status,
          204,
        );
        assert.equal((await request(`/${nestedId}`)).status, 404);
        assert.equal(
          (await (await request(`/${postId}`)).json()).post.replies,
          22,
        );
      },
    );

    await t.test(
      "reposts persist once per user, undo safely, and appear on profiles",
      async () => {
        const path = `/${postId}/repost`;
        for (const method of ["PUT", "DELETE"]) {
          assert.equal((await request(path, method)).status, 401);
          assert.equal(
            (await request(path, method, pending.cookie)).status,
            403,
          );
          assert.equal(
            (
              await request(
                path,
                method,
                bob.cookie,
                undefined,
                "https://attacker.example",
              )
            ).status,
            403,
          );
          assert.equal(
            (await request("/bad/repost", method, bob.cookie)).status,
            400,
          );
          assert.equal(
            (await request(`/${randomUUID()}/repost`, method, bob.cookie))
              .status,
            404,
          );
        }
        const repeated = await Promise.all(
          Array.from({ length: 4 }, () => request(path, "PUT", bob.cookie)),
        );
        for (const response of repeated) {
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), {
            reposts: 1,
            reposted: true,
          });
        }
        const stored = await pool.query(
          "SELECT created_at FROM post_reposts WHERE post_id=$1 AND user_id=$2",
          [postId, bob.id],
        );
        await request(path, "PUT", bob.cookie);
        const retried = await pool.query(
          "SELECT created_at FROM post_reposts WHERE post_id=$1 AND user_id=$2",
          [postId, bob.id],
        );
        assert.deepEqual(retried.rows, stored.rows);
        assert.deepEqual(
          await (await request(path, "PUT", alice.cookie)).json(),
          { reposts: 2, reposted: true },
        );
        const publicPost = (await (await request(`/${postId}`)).json()).post;
        assert.equal(publicPost.reposts, 2);
        assert.equal(publicPost.reposted, false);
        assert.equal(
          (await (await request(`/${postId}`, "GET", bob.cookie)).json()).post
            .reposted,
          true,
        );
        const feed = await (await request("", "GET", bob.cookie)).json();
        assert.equal(
          feed.posts.find((post: { id: string }) => post.id === postId)
            .reposted,
          true,
        );
        const profileUrl = `http://127.0.0.1:${address.port}/api/profiles/${bob.handle}`;
        const profile = await (
          await fetch(profileUrl, { headers: { cookie: bob.cookie } })
        ).json();
        assert.equal(profile.reposts.length, 1);
        assert.equal(profile.reposts[0].id, postId);
        assert.equal(profile.reposts[0].author.id, alice.id);
        assert.equal(profile.reposts[0].reposted, true);
        assert.ok(
          !profile.posts.some((post: { id: string }) => post.id === postId),
        );
        assert.equal(
          (await (await fetch(profileUrl)).json()).reposts[0].reposted,
          false,
        );
        const unposts = await Promise.all(
          Array.from({ length: 4 }, () => request(path, "DELETE", bob.cookie)),
        );
        for (const response of unposts)
          assert.deepEqual(await response.json(), {
            reposts: 1,
            reposted: false,
          });
        assert.deepEqual((await (await fetch(profileUrl)).json()).reposts, []);
        // Reposts are ordered by when they were shared, independently of publication time.
        await request(path, "PUT", bob.cookie);
        await pool.query(
          "UPDATE post_reposts SET created_at='2000-01-01' WHERE post_id=$1 AND user_id=$2",
          [postId, bob.id],
        );
        const another = (
          await (
            await request("", "POST", alice.cookie, {
              content: "Another original",
            })
          ).json()
        ).post;
        await request(`/${another.id}/repost`, "PUT", bob.cookie);
        assert.deepEqual(
          (await (await fetch(profileUrl)).json()).reposts.map(
            (post: { id: string }) => post.id,
          ),
          [another.id, postId],
        );
        await request(`/${another.id}`, "DELETE", alice.cookie);
        assert.deepEqual(
          (await (await fetch(profileUrl)).json()).reposts.map(
            (post: { id: string }) => post.id,
          ),
          [postId],
        );
        const temp = await account();
        await request(path, "PUT", temp.cookie);
        await pool.query("DELETE FROM users WHERE id=$1", [temp.id]);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM post_reposts WHERE user_id=$1",
              [temp.id],
            )
          ).rows[0].count,
          0,
        );
      },
    );

    await t.test(
      "author-only edits preserve publication and deadline; delete remains available",
      async () => {
        const before = await pool.query(
          "SELECT created_at FROM posts WHERE id=$1",
          [postId],
        );
        assert.equal(
          (
            await request(`/${postId}`, "PATCH", bob.cookie, {
              content: "wrong",
            })
          ).status,
          403,
        );
        assert.equal(
          (await request(`/${postId}`, "DELETE", bob.cookie)).status,
          403,
        );
        assert.equal(
          (
            await request(`/${postId}`, "PATCH", alice.cookie, {
              content: "   ",
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request(`/${postId}`, "PATCH", alice.cookie, {
              content: "hello\u0000world",
            })
          ).status,
          400,
        );
        const response = await request(`/${postId}`, "PATCH", alice.cookie, {
          content: "Updated",
        });
        assert.equal(response.status, 200);
        const { post } = await response.json();
        assert.equal(post.createdAt, before.rows[0].created_at.toISOString());
        assert.ok(post.editedAt);
        assert.equal(
          Date.parse(post.editExpiresAt) - Date.parse(post.createdAt),
          900000,
        );
        // Run the request while the row lock is held, then release it at the deadline.
        // This proves the deadline uses the actual update time rather than transaction start.
        await pool.query(
          "UPDATE posts SET created_at=clock_timestamp()-interval '15 minutes'+interval '500 milliseconds' WHERE id=$1",
          [postId],
        );
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT id FROM posts WHERE id=$1 FOR UPDATE", [
            postId,
          ]);
          const saving = request(`/${postId}`, "PATCH", alice.cookie, {
            content: "Too late",
          });
          await client.query("SELECT pg_sleep(0.6)");
          await client.query("COMMIT");
          assert.equal((await saving).status, 409);
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
        const unchanged = await pool.query(
          "SELECT content FROM posts WHERE id=$1",
          [postId],
        );
        assert.equal(unchanged.rows[0].content, "Updated");
        assert.equal(
          (await request(`/${postId}`, "DELETE", alice.cookie)).status,
          204,
        );
        assert.equal(
          (
            await request(`/${postId}`, "PATCH", alice.cookie, {
              content: "missing",
            })
          ).status,
          404,
        );
        assert.equal(
          (await request(`/${postId}`, "DELETE", alice.cookie)).status,
          404,
        );
        assert.equal(
          (await request("/bad-id", "DELETE", alice.cookie)).status,
          400,
        );
      },
    );
    await t.test(
      "stable cursor pages across equal timestamps, insertions, and deletions",
      async () => {
        const ids = Array.from({ length: 45 }, () => randomUUID())
          .sort()
          .reverse();
        for (const id of ids)
          await pool.query(
            "INSERT INTO posts(id, author_id, content, created_at) VALUES ($1,$2,'Page fixture','2050-01-01')",
            [id, alice.id],
          );
        const profile = await (
          await fetch(
            `http://127.0.0.1:${address.port}/api/profiles/${alice.handle}`,
          )
        ).json();
        assert.equal(profile.posts.length, 20);
        assert.ok(
          profile.posts.every(
            (post: { author: { id: string } }) => post.author.id === alice.id,
          ),
        );
        assert.deepEqual(
          profile.posts.map((post: { id: string }) => post.id),
          ids.slice(0, 20),
        );
        const first = await (await request()).json();
        assert.deepEqual(
          first.posts.map((p: { id: string }) => p.id),
          ids.slice(0, 20),
        );
        await pool.query(
          "INSERT INTO posts(author_id,content,created_at) VALUES ($1,'Newer','2050-01-02')",
          [alice.id],
        );
        // Deleting the cursor row must not invalidate the next page.
        await pool.query("DELETE FROM posts WHERE id=$1", [ids[19]]);
        const second = await (
          await request(`?cursor=${encodeURIComponent(first.nextCursor)}`)
        ).json();
        assert.deepEqual(
          second.posts.map((p: { id: string }) => p.id),
          ids.slice(20, 40),
        );
        const third = await (
          await request(`?cursor=${encodeURIComponent(second.nextCursor)}`)
        ).json();
        assert.deepEqual(
          third.posts.slice(0, 5).map((p: { id: string }) => p.id),
          ids.slice(40),
        );
        let tail = third;
        const seen = new Set(
          [...first.posts, ...second.posts, ...third.posts].map((p) => p.id),
        );
        while (tail.nextCursor !== null) {
          tail = await (
            await request(`?cursor=${encodeURIComponent(tail.nextCursor)}`)
          ).json();
          for (const post of tail.posts) {
            assert.ok(!seen.has(post.id), "cursor pages must not repeat posts");
            seen.add(post.id);
          }
        }
        for (const cursor of ["bad", Buffer.from("{}").toString("base64url")])
          assert.equal((await request(`?cursor=${cursor}`)).status, 400);
        const missing = await request(`/${postId}`);
        assert.equal(missing.status, 404);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM post_likes WHERE post_id=$1",
              [postId],
            )
          ).rows[0].count,
          0,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM post_reposts WHERE post_id=$1",
              [postId],
            )
          ).rows[0].count,
          0,
        );
        const emptyCursor = Buffer.from(
          JSON.stringify({
            createdAt: "1900-01-01T00:00:00.000Z",
            id: randomUUID(),
          }),
        ).toString("base64url");
        const empty = await (await request(`?cursor=${emptyCursor}`)).json();
        assert.deepEqual(empty.posts, []);
        assert.equal(empty.nextCursor, null);
      },
    );
  } finally {
    await pool.query("DELETE FROM auth_identities WHERE id=ANY($1::uuid[])", [
      identityIds,
    ]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});
