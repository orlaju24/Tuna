# Threat Model

## Project Overview

Bitunix Futures Control Panel is a mobile-first single-user trading control plane built with a React frontend and an Express/TypeScript backend backed by PostgreSQL. The server holds Bitunix API credentials, proxies exchange actions, restores background watchers on startup, stores uploaded chart screenshots in Replit object storage, and invokes OpenAI vision analysis for trade-plan and hindsight workflows.

Production scope for security scans is `artifacts/api-server`, `artifacts/bitunix-control`, and shared libraries under `lib/`. `artifacts/mockup-sandbox` is development-only and should be ignored unless production reachability is later demonstrated.

The product is intentionally single-user and has no multi-tenant account model, but production deployments still expose an HTTP API to untrusted clients on the public internet unless an external access-control layer is added. All browser input, route parameters, request bodies, query strings, and uploaded files must therefore be treated as attacker-controlled.

## Assets

- **Bitunix trading authority** — `BITUNIX_API_KEY` and `BITUNIX_API_SECRET` let the server place, close, and manage real futures positions. Compromise or misuse directly affects funds.
- **Live account and position data** — balances, leverage, margin, liquidation context, position IDs, and trade state reveal highly sensitive financial information and enable precise abuse.
- **Automation state and strategy controls** — triggers, safeguards, auto-entry configuration, freeze/walk-away state, and import/export payloads control autonomous trading behavior and can materially change risk exposure.
- **Trade history and analytics** — journal entries, event logs, fingerprints, learning summaries, and hindsight examples expose proprietary strategy behavior and trading history.
- **Uploaded screenshots and AI-derived analysis** — chart images, notes, raw model output, and stored object paths may contain sensitive market context and private annotations.
- **Infrastructure-backed spend** — OpenAI vision calls, object storage writes, DB growth, and upstream Bitunix polling can all be abused to create cost or availability impact.

## Trust Boundaries

- **Browser / API boundary** — the frontend is untrusted. Every `/api` route must enforce server-side access control and input validation regardless of UI constraints.
- **API / Bitunix boundary** — the backend signs requests with privileged exchange credentials. Any route that reaches `bitunixGet` or `bitunixPost` is a high-impact control surface.
- **API / Database boundary** — the backend persists strategy state, event logs, trade history, and uploads metadata in Postgres. Overly broad reads or unauthorized writes expose sensitive operational data.
- **API / Object storage boundary** — screenshot upload and retrieval cross into private object storage. Stored objects and object identifiers must not become publicly enumerable.
- **API / OpenAI boundary** — upload endpoints can trigger paid AI analysis. These routes are sensitive to cost abuse, oversized input, and prompt/output leakage.
- **Production / Dev-only boundary** — mockup sandbox and local Docker proxying are not production surfaces unless explicitly deployed.

## Scan Anchors

- Production entry points: `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/app.ts`, `artifacts/bitunix-control/src/main.tsx`
- Highest-risk backend code: `artifacts/api-server/src/routes/`, `artifacts/api-server/src/lib/bitunix.ts`, `artifacts/api-server/src/lib/priceStream.ts`, `artifacts/api-server/src/lib/autoEntryWatcher.ts`, `artifacts/api-server/src/lib/safeguardWatcher.ts`, `artifacts/api-server/src/lib/objectStorage.ts`
- Public/auth boundary: there is currently no in-app auth middleware in `artifacts/api-server/src/app.ts`; all mounted `/api` routes should be treated as public until proven otherwise
- Dev-only area: `artifacts/mockup-sandbox/`

## Threat Categories

### Spoofing

This project has no per-user authentication layer, but it still exposes a privileged control-plane API. The system must ensure that only the intended operator can reach trading, automation, export/import, upload, and history endpoints. If a deployment is internet-reachable, relying on “single-user” intent alone is not a security control.

Required guarantee: all non-health production API routes that reveal account data, trigger paid operations, mutate strategy state, or execute Bitunix actions must require a strong server-side authentication layer or equivalent deployment-level access restriction that is enforced before route handlers run.

### Tampering

The client can submit leverage, margin, trigger, safeguard, trade-plan, and import-state parameters. The server must treat these as hostile and apply strict schema validation, range checking, and safe defaults before persisting them or forwarding them upstream.

Required guarantee: every state-changing route must validate request structure and semantics server-side, and no client input may directly alter privileged automation behavior without explicit authorization.

### Information Disclosure

Account data, positions, event logs, journal data, trade plans, screenshots, hindsight uploads, and learning summaries are sensitive operator data. Screenshot object identifiers and raw AI analysis are also sensitive. Returning these to any unauthenticated caller would expose private trading activity and strategy details.

Required guarantee: sensitive reads must be access-controlled and minimally scoped, and private screenshot storage must not be enumerable through public APIs.

### Denial of Service

The API exposes SSE price streaming, upload endpoints backed by memory storage, OpenAI-backed analysis, object storage writes, and upstream Bitunix polling. Attackers can abuse these to consume CPU, memory, bandwidth, DB rows, object storage, or third-party billing.

Required guarantee: public-facing endpoints must have practical abuse controls such as authentication, request-size limits, bounded fan-out, and rate limiting, especially for SSE and AI/storage-backed upload routes.

### Elevation of Privilege

Because the backend holds exchange credentials and autonomous trading controls, any missing authorization effectively becomes privilege escalation to full account control. Routes that open/close positions, toggle auto-entry, arm/disarm triggers or safeguards, or import state are especially sensitive.

Required guarantee: privileged Bitunix actions and automation controls must not be reachable from unauthenticated or unauthorized requests, and object retrieval routes must not bypass access checks for private uploads.
