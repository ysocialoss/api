## Run the backend locally

The backend uses Drizzle ORM and PostgreSQL. Start the database from the project root with `docker compose up -d --wait`.

From `api/`, install dependencies and prepare configuration:

```bash
pnpm install
cp -n env.sample .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Save the generated value as `SESSION_ENCRYPTION_KEY` in `.env`, then run:

```bash
pnpm db:migrate
pnpm dev
```

A local encryption key is already configured in this working copy. Keep it private and stable across restarts. Changing it invalidates stored encrypted tokens. `.env` is ignored by Git.

Run the web app separately with `cd web && pnpm dev` from the project root, then open `http://localhost:3000`. Sign in through the account control or `/auth/login`.

## CNS login configuration

The October 31 OAuth guide is authoritative where the other CNS documents disagree. This implementation requires an ID token, verifies RS256, issuer, audience, expiry and nonce, and never falls back to unverified identity or password collection.

| Setting | Local default / purpose |
| --- | --- |
| `APP_ORIGIN` | `http://localhost:3000`; production uses `https://ysocial.cc` |
| `CNS_CLIENT_ID` | `ysocial`, a public PKCE client with no client secret |
| `SESSION_ENCRYPTION_KEY` | 32 random bytes encoded as 64 hex characters |
| `CNS_DISCOVERY_URL` | CNS discovery metadata; override only for a trusted test provider |
| `CNS_LOGIN_URL` | CNS hosted login page |
| `CNS_API_ORIGIN` | CNS API origin for refresh, logout, and directory requests |
| `NODE_ENV` | Set `production` for deployment; HTTPS and encryption key are required |

Register `http://localhost:3000/auth/callback` and `https://ysocial.cc/auth/callback` exactly with CNS, with scopes `openid profile users:read`. The server exchanges codes as JSON. Tokens remain encrypted in PostgreSQL; browsers receive only opaque HttpOnly cookies. Production must use HTTPS. Set `API_URL` in the web server environment if Express is not at `http://127.0.0.1:3100`.

The web server forwards `/auth/*` to Express without following redirects or dropping cookies. First-time users choose a unique local handle on `/onboarding`. Identity matching uses CNS issuer and subject, never usernames. Existing users are not automatically linked. The migration removes prototype session tables and requires those users to sign in again.

`GET /auth/me` returns anonymous status or local account/onboarding information. `POST /auth/profile` completes onboarding. `POST /auth/logout` revokes the local session and attempts CNS logout. Both mutations require the configured Origin. Public browsing remains available. The test page and sample-user endpoints have been removed.

Sessions expire after 30 days. Refreshes are serialized per session in PostgreSQL. A refresh 401 clears the session; temporary failures retain it and apply exponential backoff. Logout always clears local credentials, including when CNS cannot be reached.

## Profile synchronization and webhooks

Run `pnpm auth:reconcile` daily through your scheduler to refresh cached CNS profiles in batches of at most 100 IDs. It requires a live stored session granted `users:read`; without one it reports a skip. Directory responses are expected to be arrays of public profiles. A response-contract mismatch fails visibly. Missing directory IDs never delete local users. This command does not change chosen local handles or display names.

`POST /webhooks/cns` deliberately returns 503. CNS has not supplied its timestamp header, full event envelope, signed example, or signing secret. Signature verification, event deduplication, out-of-order handling, and deletion processing remain pending that contract; no events are acknowledged or trusted. Register the production webhook only after those pieces are implemented. Directory reconciliation does not substitute for deletion events.

## Verification

```bash
pnpm typecheck
pnpm test
```

Tests require a migrated local PostgreSQL database. They use a local HTTP provider with signed RSA tokens, never the live CNS API, and remove the accounts they create. They cover PKCE, callback state and replay, token validation, onboarding races, returning accounts, encrypted tokens, concurrent refreshes, temporary provider failure, revocation, and logout.

From `web/`, run `pnpm build`, `pnpm check:routes`, and `pnpm check:auth`. The auth checks use a local mock backend. Live CNS login and provider contract verification are left to the operator.

After changing `src/db/schema.ts`, generate and apply migrations with `pnpm db:generate` and `pnpm db:migrate`.

---

what do we need?

- auth
  - we looove cns accounts
- user profiles
  - customization (colour, banner gif + img, avatar gif + img)
- communities
  - seperated from main feed
  - tags (similar to discord)
~- posts
~    - types (voice, live irc type shi, images, video, *streams*)
- *chats
  - dm & group messages ENCRYPTION

api brainstorm
base: ysocial.cc/api/

POST /post
```json 
{
  "content": "message",
  "type": "text" || "image" || "gif" || "video" || "voice" || "live" || "streams",
  "scheduled": "unixtimestamp" // must be at least 10min from now
}
```
example of a live post scheduled to post on Wed, 28 Oct 2026 23:00:00 GMT:
```json 
{
  "content": "This is a post!",
  "type": "live",
  "scheduled": "1793228400" // Wed, 28 Oct 2026 23:00:00 GMT
}
```

GET /post/<uuid>
response:
```json
{
  "date": "unixtimestamp",
  "author": "string",   // uuid from user
  "likes": "int",
  "dislikes": "int",
  "reposts": "int",
  "content": "string",  // allowed empty
  "image": "uuid",      // optional
  "gif": "uuid",        // optional
  "video": "uuid",      // optional
  "voice": "uuid",      // optional
  "realtime": "uuid",   // optional
  "stream": "uuid",     // optional
}
```
example:
```json
{
  "date": "1793228400",                               // Posted on Wed, 28 Oct 2026 23:00:00 GMT
  "author": "3ee7adf2-bb29-4b3f-998e-464dc8d307b9",   // uuid of user @whz
  "likes": "2",
  "dislikes": "9",
  "reposts": "1",
  "content": "This is my Post!",  // allowed empty
  "image": "ca9e94a0-5ff0-4bb8-9f7a-ff020d5d80cb",      // optional
  // "gif": "uuid",        // optional
  // "video": "uuid",      // optional
  // "voice": "uuid",      // optional
  // "realtime": "uuid",   // optional
  // "stream": "uuid",     // optional
}
```

GET /communities/create
request:
```json
{
  "name": "string",
  "avatar": "file",
  "banner": "file",
  ""
}
```
response:
```json
{
  "uuid": "uuid",
  "name": "string"
  "avatar": "uuid",
  "banner": "uuid",
}
```

GET /communities/feed/<uuid>
response:
```json
{
  "uuid": {
    {
      "date": "unixtimestamp",
      "author": "string",   // uuid of user
      "likes": "int",
      "dislikes": "int",
      "reposts": "int",
      "content": "string",  // allowed empty
      "image": "uuid",      // optional
      "gif": "uuid",        // optional
      "video": "uuid",      // optional
      "voice": "uuid",      // optional
      "realtime": "uuid",   // optional
      "stream": "uuid",     // optional
    }
  }
}
```
example:
```json
{
  "ac8d7b9a-d677-4cae-a9b1-f5abc400fac9": {
    "date": "1793314800", // Thu, 29 Oct 2026 23:00:00 GMT
    "author": "3e4b6dd3-255b-455c-a374-7f40df52a4b1",
    "likes": "1",
    "dislikes": "0",
    "reposts": "0",
    "content": "What's a community?",
  },
  "c578a641-264d-4a9d-bd46-104cc60befe4": {
    "date": "1793401200", // Fri, 30 Oct 2026 23:00:00 GMT
    "author": "54617a84-d930-45d3-b5f7-a608a3dc2230",
    "likes": "0",
    "dislikes": "0",
    "reposts": "0",
    "content": "a",
  }
}
```
