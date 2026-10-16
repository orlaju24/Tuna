# ─────────────────────────────────────────────────────────────────────────────
# Bitunix Control Panel — Frontend (Vite → nginx)
#
# Builds the React/Vite app into static files, then serves them with nginx.
#
# Build from the repo root:
#   docker build -f docker/frontend.Dockerfile -t bitunix-frontend \
#     --build-arg BASE_PATH=/ .
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-bookworm AS build
WORKDIR /app
RUN npm install -g pnpm@10

ARG BASE_PATH=/

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY lib/db/package.json                   lib/db/
COPY lib/api-zod/package.json              lib/api-zod/
COPY artifacts/api-server/package.json     artifacts/api-server/
COPY artifacts/bitunix-control/package.json artifacts/bitunix-control/
COPY artifacts/mockup-sandbox/package.json  artifacts/mockup-sandbox/
COPY scripts/package.json                  scripts/
RUN pnpm config set ignored-builds false && pnpm install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
ENV BASE_PATH=${BASE_PATH}
# PORT is required by vite.config.ts at build time; any value is fine during build
ENV PORT=3000
# Ensure Replit-specific vite plugins are skipped (no REPL_ID in Docker)

RUN pnpm --filter @workspace/bitunix-control run build


# ── Runtime: nginx serving static files ──────────────────────────────────────
FROM nginx:1.27-bookworm AS runtime
COPY --from=build /app/artifacts/bitunix-control/dist/public /usr/share/nginx/html
COPY docker/nginx-frontend.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
