# Bitunix Futures Control — Agent Build Guide

This is the workspace-specific build and recovery guide for Replit Agent, GitHub Copilot, or another coding agent. Follow it when rebuilding, repairing, merging, or publishing this project.

The project has been manually tested end-to-end. The state described here is the bare minimum known-good baseline. Do not simplify the architecture or replace working compatibility layers without explicit user approval.

## 1. Workspace map

| Component | Directory | Runtime path | Purpose |
| --- | --- | --- | --- |
| Active frontend | `artifacts/bitunix-control` | `/` | Oracle Control Panel used in production |
| Shared API | `artifacts/api-server` | `/api` | Express API, database access, Bitunix integration, watchers |
| Legacy frontend | `artifacts/kill-switch` | `/kill-switch` | Older kill-switch UI kept for compatibility |
| Mockup server | `artifacts/mockup-sandbox` | `/__mockup` | Design preview only; not production data |
| Database package | `lib/db` | — | Drizzle schema and database push command |
| Generated API packages | `lib/api-spec`, `lib/api-client-react`, `lib/api-zod` | — | OpenAPI source and generated contracts |

### Routing invariants

- Only `artifacts/bitunix-control` may own `/`.
- `artifacts/kill-switch` must remain at `/kill-switch`; never register both web artifacts at `/`.
- `artifacts/api-server` owns `/api`.
- Every artifact must have a unique `previewPath` and service path.
- A duplicate root path can cause the deployment router to serve the legacy frontend. The API may still be healthy while the user sees stale or unauthorized data requests.
- Artifact manifests are `.replit-artifact/artifact.toml`. Update them through the artifact validation workflow; do not edit them directly.

## 2. Required environment

Use Replit Secrets/environment tooling for values. Never print, commit, or place secret values in source, logs, documentation, screenshots, or client-side code.

The API requires:

- `DATABASE_URL`
- `BITUNIX_API_KEY`
- `BITUNIX_API_SECRET`
- `SESSION_SECRET`

The application may also use the optional values documented in `.env.example`, including `APP_PASSWORD`, `OPERATOR_USER_ID`, object storage settings, AI integration settings, and trigger settings.

Frontend Vite builds require:

- `PORT`
- `BASE_PATH`

The managed artifact workflows inject those values automatically. Standalone build commands must provide them explicitly.

## 3. Build order for a new agent

### Step 1 — Inspect before changing

1. Read this guide and `replit.md`.
2. Check the registered artifacts and existing workflows.
3. Confirm the artifact paths above before making UI or deployment changes.
4. Search for existing routes, hooks, and generated clients before adding replacements.
5. Preserve the existing package structure and shared API server.

Do not create a new app for this product, do not create a second root frontend, and do not replace the database with another database.

### Step 2 — Install and prepare dependencies

Use pnpm and the existing workspace configuration:

```bash
pnpm install
```

Do not bypass the workspace package manager with ad hoc global installs or a second package manager.

### Step 3 — Apply the development database schema

If tables are missing or the API reports database relation errors, apply the existing Drizzle schema:

```bash
pnpm --filter @workspace/db run push
```

This is the intended development setup. Do not add startup-time DDL, silently create tables from route code, or migrate to a different database.

The schema includes the tables used by favorites, triggers, event logs, safeguards, trade journals, trade plans, auto-entry configuration, and auto-entry logs.

### Step 4 — Regenerate API clients only when the spec changes

The source of truth is:

```text
lib/api-spec/openapi.yaml
```

If the OpenAPI contract changes, regenerate all generated clients before using the new types:

```bash
pnpm --filter @workspace/api-spec run codegen
```

Do not hand-edit generated files as a substitute for updating the OpenAPI contract. The legacy kill-switch compatibility module is an intentional exception because those routes are not fully represented by the current generated spec:

```text
lib/api-client-react/src/legacy-killswitch.ts
```

## 4. Compatibility rules that must not be lost

### Backend

Keep `artifacts/api-server/src/lib/bitunix.ts` as the compatibility boundary for:

- authenticated Bitunix GET and POST signing
- account information
- position mode detection
- leverage and margin operations
- market orders
- open positions
- close-all and flash-close operations
- ticker prices
- klines

Do not replace this with a partial generated-client rewrite. The current frontend and legacy kill-switch routes depend on these exports.

### Frontends

There are two different auth/data contracts:

1. **Current Oracle Control Panel**
   - Uses `/api/auth/status` and `/api/auth/login`.
   - Uses the session cookie with `credentials: "include"`.
   - Reads current routes such as `/api/account`, `/api/positions`, `/api/prices`, `/api/klines`, `/api/events`, and `/api/edge-score/:symbol`.

2. **Legacy kill-switch**
   - Lives at `/kill-switch`.
   - Uses the legacy `x-key`/`APP_PASSWORD` contract.
   - Uses legacy compatibility hooks and routes such as `/api/ticker`, `/api/symbol/:symbol/info`, and `/api/logs`.

Do not mix these auth contracts. Do not move the legacy frontend back to `/`.

### Data correctness invariants

- All position state comes from Bitunix, not from button-click assumptions or stale local state.
- A successful mutation must invalidate or refresh every affected React Query view.
- Price streams and polling must recover after disconnects.
- Loading, empty, `204`, and partial API responses must render safely.
- Secrets stay on the server.

### Stepped protection is scoped to one exchange position

- `GET /api/positions` without a `symbol` query returns all open positions. The dashboard must show an independent stepped-protection control for each open position, including positions on other symbols and multiple positions on one symbol.
- A safeguard must have a Bitunix `positionId`. Before arming, the API re-reads Bitunix positions and derives the current direction, entry price, quantity, and leverage from the matching live position. Do not arm from stale client-only state.
- Match positions and existing safeguards by `positionId`, not by symbol alone. Symbol and side are not unique position identifiers.
- Every stepped-protection exit must use the attached `positionId` for its flash close and verify that same ID disappeared. Never use `close_all_position` from the stepped safeguard path; it can close unrelated positions on the same symbol.
- Legacy armed safeguards without a `positionId` must not be restored or fired. Auto-entry may auto-arm only after it finds the newly opened position with the expected side and its exchange `positionId`; otherwise leave the position open and report the missing safeguard clearly.
- Manually opened positions are visible and individually armable; they are not silently auto-armed. Keep the explicit user action unless the user requests a different policy.

## 5. Start the managed workflows

Use the existing artifact-owned workflows. Do not create replacement workflows with similar names:

```text
artifacts/api-server: API Server
artifacts/bitunix-control: web
artifacts/kill-switch: web
artifacts/mockup-sandbox: Component Preview Server
```

The API server must be running before checking data requests. After backend, package, workflow, or artifact-manifest changes, restart the affected managed workflow and inspect its logs.

## 6. Required verification

Run the full workspace typecheck:

```bash
pnpm run typecheck
```

Build the deployable frontends with the required Vite environment:

```bash
PORT=25574 BASE_PATH=/ NODE_ENV=production \
  pnpm --filter @workspace/bitunix-control run build

PORT=18912 BASE_PATH=/kill-switch NODE_ENV=production \
  pnpm --filter @workspace/kill-switch run build
```

The builds may emit source-map or chunk-size warnings. They must still finish successfully.

Check the API health endpoint:

```bash
curl -sS http://localhost:80/api/healthz
```

Expected shape:

```json
{
  "status": "ok",
  "checks": {
    "database": { "ok": true },
    "exchange": { "ok": true }
  }
}
```

Also verify:

```bash
git diff --check
git grep -n -E '^(<<<<<<<|=======|>>>>>>>)' -- ':!*.lock'
```

The conflict-marker scan should return no tracked project files. Ignore examples inside skills or package caches when doing broader searches; the tracked-project scan is the relevant check.

For stepped protection, additionally verify the all-symbol position response, one independent safeguard card per open `positionId`, server-side live-position validation, and position-specific close/poll behavior. Do not test by placing or closing a live trade; use mocked exchange responses or tests.

Use the app preview to check both:

- `/` shows the Oracle Control Panel passcode screen or dashboard.
- `/kill-switch/` shows the legacy kill-switch screen.

Refresh workflow and browser logs. Repeated `401`/`403` responses, failed `/api` requests, or a legacy `SYSTEM LOCKED` screen at `/` indicate a routing or auth regression.

## 7. Publish handoff

Do not claim that publishing is complete until the user clicks Publish.

Before handing off:

1. Confirm artifact paths are unique.
2. Confirm the API health response has both database and exchange checks green.
3. Confirm both deployable frontend builds pass.
4. Confirm the active root preview is `bitunix-control`.
5. Present `artifacts/bitunix-control`.
6. Suggest the Publish action.

If a new code or manifest change is made after the handoff, repeat the relevant build and runtime checks before suggesting Publish again.

## 8. Failure diagnosis

### The root app shows the legacy kill-switch screen

Inspect all web artifact manifests for duplicate `previewPath = "/"` or `paths = [ "/" ]`. The active root must be `artifacts/bitunix-control`; move the legacy artifact back to `/kill-switch`.

### The API is healthy but dashboard data is unauthorized

Inspect the browser/deployment logs for request paths:

- `/api/ticker`, `/api/prices`, `/api/klines` together with `401` usually means the legacy frontend is being served at the wrong path.
- Current session-authenticated requests should have a valid login session and use the current frontend's auth flow.

### The API reports a database failure

Run the Drizzle push command against the development database, then restart the API workflow. Do not add route-level table creation.

### The API reports an exchange failure

Check that the Bitunix secrets exist in the Replit Secrets manager and restart the API workflow. Never print their values or put them in a diagnostic response.

### Vite says `PORT` or `BASE_PATH` is missing

Run the build with the artifact's values shown above, or use the managed workflow. Do not weaken the Vite config by adding silent defaults that can produce incorrect deployment paths.

### The live site still serves the old frontend

The current deployment may still be serving its previous build. Republish after the route/build checks pass; do not infer that a local preview change has already reached production.