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
