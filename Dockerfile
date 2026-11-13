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
CMD ["node", "node_modules/drizzle-kit/bin.cjs", "migrate"]

FROM base AS dependencies
RUN pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3100
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
USER node
EXPOSE 3100
CMD ["node", "src/app.ts"]
