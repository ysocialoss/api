# Run the API with Docker

Run these commands from the parent directory:

```sh
docker build -t ysocial-api ./api
docker build --target migrate -t ysocial-api-migrate ./api
docker network create ysocial
```

Prepare a runtime environment file using `env.sample`. Set `NODE_ENV=production`,
an HTTPS `APP_ORIGIN`, and a persistent 64-character hex `SESSION_ENCRYPTION_KEY`.
Set `DATABASE_URL` to a PostgreSQL address reachable from the container.
Container localhost refers to the container itself.

Run migrations before starting the API, using the same environment for both:

```sh
docker run --rm --network ysocial --env-file ./api/.env ysocial-api-migrate
docker run -d --name api --network ysocial --env-file ./api/.env ysocial-api
```

The API listens on port 3100 and runs as the unprivileged `node` user. The runtime
image contains production dependencies only. The separate `migrate` target
includes Drizzle Kit and migration files. Environment files stay outside both
images. Supply secrets at runtime.

The web image can reach this container at `api:3100` on the `ysocial` network.
Keep the API port private when Caddy handles public requests.

# Error codes

The API responds with a machine-readable error string, such as `invalid_content`
with HTTP 400. The web client turns that string into a trace code shown to users
in parentheses, for example `Something went wrong ... (YS-2004)`.

The code-to-string mapping lives in `ysocial_web/src/lib/api.ts` (`traceCodes`).
When you add an API error string, add it there too, in the matching range.

| Code | Error string | Meaning |
| --- | --- | --- |
| YS-0001 | (none) | The server could not be reached (network failure, offline, or status 0). |
| YS-0002 | (none) | The response did not match the expected schema. |
| YS-0003 | (none) | Any other client-side failure that is not an API error. |

## 1xxx: Auth

| Code | Error string | Meaning |
| --- | --- | --- |
| YS-1001 | `invalid_origin` | The request came from an origin the API does not accept. |
| YS-1002 | `sign_in_required` | No valid session was sent with the request. |
| YS-1003 | `onboarding_required` | The account has no handle yet and must choose one. |
| YS-1004 | `account_deleted` | The account has been deleted. |
| YS-1005 | `already_onboarded` | Onboarding was attempted for an account that is already set up. |
| YS-1006 | `invalid_login_state` | The sign-in state check failed, for example an expired or tampered login attempt. |
| YS-1007 | `invalid_provider_identity` | The identity returned by the sign-in provider was not valid. |
| YS-1008 | `login_not_configured` | The sign-in provider is not configured on the server. |
| YS-1009 | `provider_unavailable` | The sign-in provider could not be reached. |

## 2xxx: Posts

| Code | Error string | Meaning |
| --- | --- | --- |
| YS-2001 | `post_not_found` | The post does not exist or is no longer available. |
| YS-2002 | `not_post_author` | The caller tried to change a post they did not write. |
| YS-2003 | `edit_window_expired` | The post is past its edit window. |
| YS-2004 | `invalid_content` | The post body failed validation (see `src/posts.ts`). |
| YS-2005 | `invalid_post_id` | The post ID is malformed. |
| YS-2006 | `post_id_conflict` | A retried post reused an ID with different content. |
| YS-2007 | `invalid_topic` | The topic is not valid. |
| YS-2008 | `poll_not_found` | The poll does not exist. |
| YS-2009 | `invalid_poll_option` | The chosen poll option does not belong to this poll. |
| YS-2011 | `poll_is_anonymous` | The request needed poll voter identity, but the poll is anonymous. |
| YS-2012 | `invalid_repost` | The repost target is not valid. |

## 3xxx: Profiles

| Code | Error string | Meaning |
| --- | --- | --- |
| YS-3001 | `profile_not_found` | The profile does not exist. |
| YS-3002 | `invalid_profile` | The profile details failed validation. |
| YS-3003 | `invalid_handle` | The handle is malformed or unavailable. |
| YS-3004 | `cannot_follow_self` | The caller tried to follow their own profile. |

## 4xxx: Paging, inbox and push

| Code | Error string | Meaning |
| --- | --- | --- |
| YS-4001 | `invalid_cursor` | The pagination cursor is malformed or stale. |
| YS-4002 | `invalid_activity_query` | The activity query parameters are not valid. |
| YS-4003 | `invalid_notification_id` | The notification ID is malformed. |
| YS-4004 | `invalid_notification_query` | The notification query parameters are not valid. |
| YS-4005 | `invalid_push_mute` | The push mute request is not valid. |
| YS-4006 | `push_not_configured` | Push notifications are not configured on the server. |
| YS-4007 | `invalid_push_subscription` | The push subscription is malformed. |
| YS-4008 | `notification_not_found` | The notification does not exist. |
| YS-4009 | `push_subscription_not_found` | The push subscription does not exist. |
| YS-4010 | `invalid_feed_events` | A batch of feed activity events failed validation. |
| YS-4011 | `invalid_feed_preferences` | The feed preferences update is not valid. |

## 5xxx: Media

| Code | Error string | Meaning |
| --- | --- | --- |
| YS-5001 | `invalid_avatar` | The avatar image could not be read or is not allowed. |
| YS-5002 | `avatar_png_required` | The avatar must be sent as PNG. |
| YS-5003 | `avatar_not_found` | The avatar does not exist. |
| YS-5004 | `avatar_storage_not_configured` | Avatar storage is not configured on the server. |
| YS-5005 | `avatar_storage_unavailable` | Avatar storage could not be reached. |
| YS-5006 | `invalid_banner` | The banner image could not be read or is not allowed. |
| YS-5007 | `invalid_banner_crop` | The banner crop values are not valid. |
| YS-5008 | `banner_not_found` | The banner does not exist. |
| YS-5009 | `avatar_in_use` | The avatar is still referenced and cannot be removed. |
| YS-5010 | `invalid_voice` | The voice recording could not be read. |
| YS-5011 | `voice_too_short` | The voice recording is shorter than 2 seconds. |
| YS-5012 | `voice_too_long` | The voice recording is longer than 2 minutes. |
| YS-5013 | `invalid_voice_selection` | The voice recording expired or was already used. |
| YS-5014 | `voice_audio_required` | The request did not include audio. |
| YS-5015 | `voice_not_found` | The voice message does not exist. |
| YS-5016 | `voice_processing_unavailable` | Voice processing is unavailable. |
| YS-5017 | `voice_processing_busy` | Voice processing is at capacity. The client retries this automatically. |
| YS-5018 | `voice_not_configured` | Voice processing is not configured on the server. |

## 6xxx: GIFs

| Code | Error string | Meaning |
| --- | --- | --- |
| YS-6001 | `invalid_gif_selection` | The GIF selection expired or is not valid. |
| YS-6002 | `invalid_search` | The search query is not valid. |
| YS-6003 | `gif_search_limit` | The GIF search rate limit was reached. |
| YS-6004 | `gif_search_unavailable` | The GIF provider could not be reached. |
| YS-6005 | `klipy_not_configured` | The GIF provider is not configured on the server. |

## 7xxx: API plumbing

| Code | Error string | Meaning |
| --- | --- | --- |
| YS-7001 | `route_not_found` | No route matches the request (HTTP 404). |
| YS-7002 | `unexpected_response` | The API response did not match what the client expected. |

## 9xxx: Unlisted errors

An error string that is not in `traceCodes` gets a code from 9000 to 9999. The
number is a hash of the HTTP status and error string, so the same error always
gets the same code. The number itself carries no meaning. To find the cause,
search the codebase for the error string shown in the request or logs.
