# ─────────────────────────────────────────────────────────────────────────────
# Bitunix Control Panel — API Server
#
# Multi-stage build:
#   1. deps    — install all workspace dependencies
#   2. build   — compile TypeScript → ESM bundle
#   3. runtime — minimal image with only production runtime
#
# Build from the repo root:
#   docker build -f docker/api.Dockerfile -t bitunix-api .
# ─────────────────────────────────────────────────────────────────────────────

FROM node:24-alpine AS base
WORKDIR /app
RUN npm install -g pnpm@10


# ── Stage 1: install all dependencies ────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY lib/db/package.json                   lib/db/
COPY lib/api-zod/package.json              lib/api-zod/
COPY artifacts/api-server/package.json     artifacts/api-server/
COPY artifacts/bitunix-control/package.json artifacts/bitunix-control/
COPY artifacts/mockup-sandbox/package.json  artifacts/mockup-sandbox/
COPY scripts/package.json                  scripts/
RUN pnpm install --frozen-lockfile


# ── Stage 2: build ───────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN pnpm --filter @workspace/api-server run build


# ── Stage 3: minimal runtime ─────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

# Only the pg client and pino (externalised from the bundle) are needed at runtime
RUN apk add --no-cache dumb-init
RUN npm install -g pnpm@10

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY lib/db/package.json                   lib/db/
COPY lib/api-zod/package.json              lib/api-zod/
COPY artifacts/api-server/package.json     artifacts/api-server/
COPY artifacts/bitunix-control/package.json artifacts/bitunix-control/
COPY artifacts/mockup-sandbox/package.json  artifacts/mockup-sandbox/
COPY scripts/package.json                  scripts/

RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/artifacts/api-server/dist artifacts/api-server/dist

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# dumb-init: prevents zombie processes and handles SIGTERM correctly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
