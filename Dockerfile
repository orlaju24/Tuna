# ════════════════════════════════════════════════════════════════════════════
#  Bitunix Futures Control — Coolify / Hetzner (linux/amd64) compatible
# ════════════════════════════════════════════════════════════════════════════
#
#  Build-time ARGs (override in Coolify build settings if needed):
#    BUILD_PORT       — satisfies the Vite config PORT check (not runtime).
#                       Default: 3000
#    BUILD_BASE_PATH  — Vite base path. Use / when serving at the domain root.
#                       Default: /
#
#  Required runtime environment variables (set in Coolify → Service → Env):
#    PORT               — TCP port Express listens on        (default: 3000)
#    DATABASE_URL       — PostgreSQL connection string
#    APP_PASSWORD       — x-key header secret for API auth
#    BITUNIX_API_KEY    — Bitunix API key
#    BITUNIX_API_SECRET — Bitunix API secret
#
#  Optional runtime environment variables:
#    INTERNAL_TRIGGER_TOKEN — secret for the /api/trigger/close webhook
#    KILL_COOLDOWN          — kill-switch cooldown in seconds (default: 3)
#    DEFAULT_SYMBOL         — default trading pair            (default: BTCUSDT)
# ════════════════════════════════════════════════════════════════════════════

FROM --platform=linux/amd64 node:24-slim AS base
RUN corepack enable

# ─────────────────────────────────────────────────────────────────────────────
# STAGE 1 — builder
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

ARG BUILD_PORT=3000
ARG BUILD_BASE_PATH=/

# Manifests first — maximises Docker layer cache hit rate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml \
     tsconfig.json tsconfig.base.json ./

# All workspace package.json files must be present before `pnpm install`
COPY lib/api-spec/package.json              lib/api-spec/
COPY lib/api-zod/package.json               lib/api-zod/
COPY lib/api-client-react/package.json      lib/api-client-react/
COPY lib/db/package.json                    lib/db/
COPY scripts/package.json                   scripts/
COPY artifacts/api-server/package.json      artifacts/api-server/
COPY artifacts/bitunix-control/package.json artifacts/bitunix-control/
COPY artifacts/mockup-sandbox/package.json  artifacts/mockup-sandbox/

RUN pnpm install --frozen-lockfile

# Ensure per-package node_modules dirs exist (pnpm may hoist everything to root)
RUN mkdir -p \
      artifacts/api-server/node_modules \
      artifacts/bitunix-control/node_modules \
      artifacts/mockup-sandbox/node_modules

# Source after install — keeps the install layer cached independently
COPY lib/            lib/
COPY artifacts/      artifacts/
COPY attached_assets/ attached_assets/
COPY docker-entrypoint.sh ./

# Vite config throws at eval-time if PORT or BASE_PATH are absent
ENV PORT=${BUILD_PORT} \
    BASE_PATH=${BUILD_BASE_PATH} \
    NODE_ENV=production

# Build 1 — React/Vite frontend  →  artifacts/bitunix-control/dist/public/
RUN pnpm --filter @workspace/bitunix-control build

# Build 2 — Express API server   →  artifacts/api-server/dist/
RUN pnpm --filter @workspace/api-server build

# ─────────────────────────────────────────────────────────────────────────────
# STAGE 2 — production
#   Lean runtime image. No build tools. Runs as non-root `node` user.
# ─────────────────────────────────────────────────────────────────────────────
FROM --platform=linux/amd64 node:24-slim AS production
WORKDIR /app

# Compiled API server (esbuild bundle + pino worker scripts)
COPY --from=builder /app/artifacts/api-server/dist         ./dist/

# Pre-built frontend SPA (served by Express via STATIC_PATH)
COPY --from=builder /app/artifacts/bitunix-control/dist/public  ./public/

# Database schema source for drizzle-kit push at startup
COPY --from=builder /app/lib/db  ./lib/db/

# node_modules from builder — avoids re-running pnpm with workspace:* refs
COPY --from=builder /app/node_modules                          ./node_modules/
COPY --from=builder /app/artifacts/api-server/node_modules     ./artifacts/api-server/node_modules/

# Entrypoint
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Persistent log dir — mount a named volume at /app/logs in production
RUN mkdir -p /app/logs

# Security: non-root node user
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=3000 \
    STATIC_PATH=/app/public

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e " \
    const port = process.env.PORT || 3000; \
    fetch('http://localhost:' + port + '/api/healthz') \
      .then(r => process.exit(r.ok ? 0 : 1)) \
      .catch(() => process.exit(1));"

ENTRYPOINT ["./docker-entrypoint.sh"]
