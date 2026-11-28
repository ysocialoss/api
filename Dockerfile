FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN npm install --global pnpm@12.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS migrate
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY drizzle ./drizzle
COPY drizzle.config.ts ./
ENV NODE_ENV=production
USER node
CMD ["node", "src/db/migrate.ts"]

FROM base AS dependencies
RUN pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3100
# glibc raises its mmap threshold as large buffers are freed, then keeps them on the heap. With libvips
# that ratcheted pods from ~100 MiB to 400+ MiB. A fixed 128 KiB threshold returns large image buffers
# to the OS right away (measured: 239 -> 89 MiB resident after repeated 24 MP jobs, same speed).
ENV MALLOC_MMAP_THRESHOLD_=131072 MALLOC_TRIM_THRESHOLD_=131072
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
# Migrations run from this image: node src/db/migrate.ts.
COPY drizzle ./drizzle
USER node
EXPOSE 3100
CMD ["node", "src/app.ts"]
