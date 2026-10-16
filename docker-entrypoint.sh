#!/bin/sh
# ════════════════════════════════════════════════════════════════════════════
#  Bitunix Kill Switch — container entrypoint
#  Runs before the Node server starts on every deploy.
# ════════════════════════════════════════════════════════════════════════════
set -e

echo "[entrypoint] NODE_ENV    = ${NODE_ENV}"
echo "[entrypoint] PORT        = ${PORT}"
echo "[entrypoint] STATIC_PATH = ${STATIC_PATH}"

# ── Schema sync (drizzle-kit push) ────────────────────────────────────────
# Runs automatically on every deploy so database tables always match the
# schema defined in lib/db/src/schema/.
# Safe to run against an empty schema (no-op) and idempotent on re-deploys.
if [ -n "$DATABASE_URL" ]; then
  echo "[entrypoint] Running drizzle-kit push..."
  # drizzle-kit bundles the config internally so __dirname resolves correctly.
  # The schema source is available at lib/db/ (copied into the image).
  if node_modules/.bin/drizzle-kit push --config lib/db/drizzle.config.ts; then
    echo "[entrypoint] Schema sync complete."
  else
    echo "[entrypoint] WARNING: drizzle-kit push failed — server will still start."
    echo "[entrypoint] Check DATABASE_URL and postgres connectivity."
  fi
else
  echo "[entrypoint] WARNING: DATABASE_URL not set — skipping schema sync."
fi

echo "[entrypoint] Starting server..."
exec node --enable-source-maps ./dist/index.mjs
