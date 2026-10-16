# Bitunix Futures Control Panel

A mobile-first remote control for a Bitunix Futures account, designed for quick state reading, risk adjustment, and position closing, with server-side trigger watching.

## Run & Operate

- **API Server:** `pnpm --filter @workspace/api-server run dev`
- **Frontend:** `pnpm --filter @workspace/bitunix-control run dev`
- **Typecheck:** `pnpm run typecheck` (all packages)
- **Generate code-reference PDF:** `pnpm --filter @workspace/scripts run generate-doc`

Required Environment Variables:
- `BITUNIX_API_KEY`: Bitunix Futures API key.
- `BITUNIX_API_SECRET`: Matching secret.
- `DATABASE_URL`: Postgres connection string.
- `PORT`: Backend listen port (set per-artifact by the proxy).
- `AI_INTEGRATIONS_OPENAI_BASE_URL`: Replit AI Integrations proxy for OpenAI vision.
- `AI_INTEGRATIONS_OPENAI_API_KEY`: Replit AI Integrations proxy API key.
- `DEFAULT_OBJECT_STORAGE_BUCKET_ID`: App Storage bucket for chart uploads.
- `PRIVATE_OBJECT_DIR`: Private object storage directory for screenshots.
- `OPERATOR_USER_ID`: **Required for access control.** Your Replit user ID (the `id` field from `GET /api/auth/user`). First-time setup: visit the app, log in, then call `GET /api/auth/user` to get your ID, set this env var to that value, and **restart the API server** (the value is read once at startup). Until set, all authenticated API requests return 503.

## Stack

- **Frontend:** React 18, Vite, TailwindCSS v4
- **Backend:** Express, TypeScript
- **Database:** PostgreSQL with Drizzle ORM
- **Validation:** Zod
- **API Client:** React Query (TanStack)
- **AI:** OpenAI vision (`gpt-5.4`) via Replit AI Integrations proxy
- **Build Tool:** Vite (frontend), tsx (scripts)

## Where things live

- `artifacts/api-server/src/lib/` — Core singletons: `priceStream`, `signalScore`, `edgeScore` (Oracle Entry Score engine), `safeguardWatcher`, `autoEntryWatcher`, `tradePlanAnalyzer`
- `artifacts/api-server/src/routes/` — Express routers (one file per domain)
- `artifacts/bitunix-control/src/components/` — UI cards (mobile-first dark theme)
- `artifacts/bitunix-control/src/hooks/` — React Query hooks
- `lib/db/src/schema/` — Drizzle ORM schema (`favorites`, `triggers`, `event_log`, `safeguards`, `trade_journal`, `trade_plans`, `auto_entry_config`, `auto_entry_log`)
- **DB push:** `pnpm --filter @workspace/db run push`
- **Code reference PDF:** `BitunixControlPanel_CodeDoc.pdf` (root) — re-run `generate-doc` after major changes

## Architecture decisions

- **Oracle Method trading system:** Whole-number pivot plays, 4-timeframe structure (3m/15m/1h/6h). Every algorithm weight is calibrated to this specific methodology.
- **Oracle Entry Score (not "edge score"):** 5 patience-centric components (0-100): structure alignment (25), patience quality (25), key level behavior (20), wallet readiness (15), time suitability (15). Derives an explicit oracle state: READY / WAIT MODE / LATE SETUP / NO SIGNAL.
- **Ninja stop (server-side safeguard):** Profit protection price is never sent to Bitunix as a stop order — held server-side and executed only on retrace, preventing stop-hunting.
- **Position-scoped stepped protection:** The dashboard lists and protects every open Bitunix position across symbols. Each safeguard requires a live `positionId`, uses exchange values for side/entry/size/leverage, closes only that position by ID, and confirms that same ID is gone. Never use close-all from the stepped-protection path; same-symbol positions must remain independent. Manually opened positions require an explicit arm action; auto-entry may arm only after matching the new position's side and ID.
- **Stateless writes, stateful watchers:** REST routes are stateless Bitunix proxies; safeguard manager, trigger watcher, and auto-entry watcher are stateful singletons restored from Postgres on restart.
- **Compute efficiency:** SWR caching on backend (signal 60s TTL, oracle score 30s), event-driven adaptive polling on frontend, SSE for prices, tab-visibility pause.
- **Wave pattern analysis:** 3m HA limit raised to 18 bars (17 closed) to give the wave classifier enough history for wave1 → pullback → wave2 detection. `computeWavePattern()` groups HA bars into direction runs and classifies the phase.

## Product

- **Real-time Account Overview:** Available margin, PnL, position details (size, entry, liquidation price), leverage.
- **Oracle Entry Score:** 0-100 composite with oracle state banner (READY / WAIT MODE / LATE SETUP / NO SIGNAL). Patience quality is the largest weighted component (25 pts), rewarding setups that waited for the zone rather than chasing. Score gates auto-entry and adjusts the safeguard trail (−2.0 to +1.5 pp). **Dynamic narration** — each state shows a specific WHY sentence derived from actual component scores (not a static template), replacing the old generic sub-text.
- **Risk Management:** Leverage control, margin adjustment, server-side profit safeguard ladder (v4 ratchet: 17%→19%→23%→29%→39%+). Four-layer adaptive trail formula: base structure + plan delta + oracle score delta + sub-level capture delta.
- **Automated Exit Triggers:** Price-cross triggers (above/below) auto-close via flash_close or close_all.
- **Image-to-Self-Trade Pipeline:** AI vision (gpt-5.4) analyses uploaded chart screenshots → returns channelZone, bias, agreementScore, continuationProbPct, recommendedPatience, returnToZonePct, entryZoneNote, invalidationZoneNote, confidenceLevel, likelyAction (enter/probe/wait/stand-down). Plan feeds auto-entry gate + safeguard trail bias. `probe` = "toss a dwarf" ~20% size test, auto-entry blocked. Two-phase resilient upload: Phase 1 (GCS store + DB row) is guaranteed; Phase 2 (vision analysis) is best-effort — chart is always saved even if AI call fails.
- **Oracle Sub-Level Targets (.888):** Break of $109,000 → $108,999 is immediately a confirmed break. First meaningful sub-target is always .888 of the new range ($108,888). When captured, safeguard trail tightens −1.0 pp; when the deeper whole number is also taken, −0.75 pp additional. UI shows a live progress bar entry→.888→next whole with "catch the extra" copy when .888 is captured.
- **Flat-Only Auto Entry:** 10 guardrails — flat, time window, whole-number proximity (always-on, within 20% of level), middles zone, oracle score ≥ min, liq gap ≥ min, HTF direction, plan gate (enter/wait/probe/stand-down). Smart wait resolution: auto-promotes when 80% of expected retrace depth achieved. Probe action blocks auto-entry — manual sizing required.
- **Governance states (PDF-compliant):** Session Freeze (hard kill-switch, DB-persisted, survives restart — `sessionFrozen` on `auto_entry_config`) + Walk Away (user-engaged stand-down after a close, requires manual Resume — `walkAwayMode`). Both block auto-entry at the watcher level and write human-readable events to the event log. Cooldown after every close is also now visible as a `cooldown_started` event in the log. API: `POST /api/auto-entry/freeze|unfreeze|walk-away|resume`.
- **Performance Tracking:** Trade journal (now labelled **Trade Memory** in UI) with MFE/MAE/giveback, oracle score at arm, plan outcome-vs-plan grade, 4TF structure snapshot, verdict + setup fingerprint. Weekly-grouped view (Mon–Sun buckets with win/loss count + avg ROI per week). Sort options: Newest / Best (highest ROI) / Economical (ROI÷MAE efficiency) / Easy (lowest MAE). Filter by All / Safeguard / Trigger / Manual. Limit: 100 entries.
- **Oracle Learning Panel** (above journal): Statistical digest of all completed trades — win rates by session (Asian/London/Overlap/NY), entry velocity, oracle score bucket, HTF alignment. Fingerprint quality distribution (high-conviction/clean/transitional/late/messy/forced). Actionable recommendations with confidence ratings: oracle threshold suggestions (20th-percentile floor of winning scores), best session, velocity preference, HTF alignment value, forced-trade discipline warnings. Data from `GET /api/journal/learning-digest`.
- **Wave Cycle Card:** Displays the current HA 3m wave phase below the Oracle Score — pressure_building → first_wave → pullback → resumption_forming → resumption_confirmed → extended. Shows Wave 1 vs Wave 2 body strength comparison bars and the wave2VsWave1Ratio (>1 = resumption is stronger than the initial move). Ideal entry zone is `resumption_forming` / `resumption_confirmed`. Source: `ResumptionCard.tsx`. Wave data from `structure.wavePhase` field of `/api/edge-score`.
- **Behavioral Governor:** Watches the system's own trading quality in real time. Computes a 0-100 score from 5 components: session discipline (trades/8h), entry quality (avg oracle score at entry), post-win discipline (re-entry gap after wins), loss recovery (current streak), near-miss rate. Grades: CLEAN (80+) / MONITOR (60-79) / CAUTION (40-59, floor +5) / WARNING (20-39, floor +10) / FREEZE (<20, auto-entry hard-blocked). Oracle floor penalty is applied additively on top of `minEdgeScore` in the auto-entry watcher. Cache: 60s TTL. API: `GET /api/governor`, `POST /api/governor/reset`. Frontend card: `BehaviorGovernor.tsx` with score gauge, component breakdown, and active penalties. Sits above the event log on the dashboard.
- **Wallet Growth Card:** Scoreboard above the journal — protected-trade win rate, avg exit ROI, avg ratchet count, image-guided vs unguided breakdown. Hidden until at least one protected trade exists. Data from `GET /api/journal/wallet-summary`.
- **Oracle-Voiced Auto-Entry Blocks:** Block reasons use calm oracle language ("Oracle score 62 — needs 70 before committing wallet. The 1h is bullish…") instead of technical strings.
- **Signal Awareness:** Multi-timeframe trend display, whole-number proximity, velocity state.
- **Edge Fingerprinting (Pattern Memory):** Every completed safeguard-exit trade is automatically fingerprinted (timeBucket, btcRegion, wholeNumberRelation, velocityFeel, oracleScoreBucket, htfAlignmentStr, haAligned, direction) and quality-labelled (clean/messy/forced/high-conviction/late/transitional). Live setups are matched against history for a 0-100 confidence score once ≥5 trades exist. Confidence ≥75 = +5 oracle score, ≥60 = +2, <28 = −3. Auto-entry blocked when confidence <28 (unfamiliar territory). Post-win humility activates 4h after a ≥30% ROI exit, capping oracle at 82 and raising auto-entry threshold by +8. Pattern Memory row shown in Oracle Score Card. Mentor examples addable via `POST /api/fingerprint`.

## User preferences

- The system should behave like a calm oracle — not a FOMO bot. Patience is rewarded over speed.
- "Edge Score" was the old name; the product name is now **Oracle Entry Score** / **Oracle Score**.
- Internal TypeScript/DB identifiers remain `edgeScore`/`EdgeContext` for back-compat; UI labels say "Oracle Score".

## Gotchas

- **Single-user:** No auth, no multi-tenancy. API keys are env vars.
- **Rename back-compat:** `EdgeScoreCard.tsx` exports both `OracleScoreCard` (primary) and `EdgeScoreCard` (alias). DB column `edgeScore` is unchanged.
- **Component names changed (not DB):** `entryTiming` → `patienceQuality`, `wholeNumberPlay` → `keyLevelBehavior`, `walletHealth` → `walletReadiness`, `velocityQuality` → `timeSuitability`.
- **No Direct WebSocket to browser:** Backend maintains single Bitunix WS connection; browser receives prices via SSE fan-out.
- **Limited Trigger Types:** Only price-cross (above/below). No trailing stops, no time-based, no percentage triggers.
- **Velocity scoring at key levels:** fast+nearPivot intentionally scores LOW (5 pts) in `timeSuitability` — this matches the Oracle Method: fast slam at a whole number = potential false break = WAIT. Slow patient arrival = 15 pts (oracle ideal).
- **3m streak in patienceQuality:** `threeMinStreak` counts consecutive closed 3m bars in the HTF direction. Streak 2 or 3 = +4 pts (oracle sweet spot). Streak 4+ = −3 pts (extended). Streak 1 = no adjustment (unproven).
- **Whole-number proximity gate (auto-entry):** `wholeNumberProximityOk` is always-on (not a toggle). Price must be within 20% of the nearest whole-number level — distinct from `avoidMiddles` which blocks 30-70%. Shown as a named CheckRow in the auto-entry card.
- **Whole-number direction gate (auto-entry):** `wholeNumberDirectionOk` checks which SIDE of the level price is on. LONG requires fraction ≥ 0.8 (approaching from below, e.g. BTC at $78,802 closing in on $79k). SHORT requires fraction ≤ 0.2 (approaching from above, e.g. BTC at $79,039 just above $79k). This is OPPOSITE to the naive intuition — confirmed against live trade data. Fixed verdict bug: `wholeNumberProximityOk` was previously evaluated but never included in the `result.allowed` condition.
- **Post-close revalidation (auto-entry):** After a safeguard or trigger confirms flat, auto-entry enters a hard block: 5 min for safeguard closes, 3 min for trigger closes. Signal flows via `postCloseNotifier.ts` bridge to avoid circular imports. Prevents same-level re-entry on residual momentum.
- **Stepped-protection isolation:** `GET /api/positions` without a symbol is the source for the all-position protection list. Use `positionId` as the identity through UI, validation, watcher restore, close request, and flat confirmation. A missing ID is an error, not permission to close all positions for that symbol.
- **Momentum gate (safeguard retrace):** When price retraces to the safeguard level after ≥1 ratchet, `checkMomentumIntact()` runs before firing. Three signals evaluated: signal score not flipped against trade, HTF not aligned against trade, velocity/pivot not showing fast reversal. If 2/3 pass → intact. Intact + allowance unused = 4-min hold window granted (ONE allowance per trade). During hold window: every tick re-checks; momentum crack → close immediately. Hold window expires → close unconditionally. Logged as: `safeguard_retrace_held`, `safeguard_momentum_failed`, `safeguard_hold_expired`.
- **Momentum gate (trigger vs safeguard):** When a trigger price is crossed AND a safeguard is protecting, `safeguardManager.handleTriggerTouch()` runs before firing. If momentum intact → trigger absorbed (logged as `trigger_absorbed_momentum_ok`), trigger stays alive with 3-min suppression window, one absorption allowed per trigger arm. If momentum fading → trigger fires normally (logged as `trigger_allowed_momentum_fading`). Implemented via `watcher.ts` → `safeguardWatcher.ts` one-directional import (no circular dep).

## Pointers

- **Drizzle ORM:** https://orm.drizzle.team/docs/overview
- **React Query:** https://tanstack.com/query/latest
- **OpenAI Vision:** https://platform.openai.com/docs/guides/vision
- **Code reference PDF:** `BitunixControlPanel_CodeDoc.pdf` — full algorithm doc for AI review
# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### Bitunix Futures Control Panel (`artifacts/kill-switch`)
- **URL**: `/` (root)
- **Purpose**: Multi-symbol futures execution dashboard — decision-first UI backed entirely by Bitunix REST + WebSocket
- **Tech**: React + Vite, dark monospace cockpit theme, mobile-first
- **Features**:
  - Password screen (localStorage `killswitch_password`)
  - Editable favorites strip (localStorage `ks_favorites_v1`): add/remove pairs in edit mode, persists across sessions
  - Multi-symbol prices via Bitunix WebSocket + REST fallback
  - **Combined position+chart card** (single scrolling card):
    - Header: pair name, FLAT/LONG/SHORT badge, leverage badge, margin mode badge
    - OPEN state: UNREALIZED PNL hero (text-4xl, +/- coloured) + 2-col grid (ENTRY / MARK PRICE / MARGIN USED / LEVERAGE / SIZE / LIQ PRICE)
    - FLAT state: clearly labelled MARK PRICE (text-3xl) + AVAILABLE / EQUITY account summary
    - Embedded Heikin Ashi chart: default **3min / 10 candles**; tabs for 3min · 1h · 2h · 6h; yellow forming candle; time labels at first, mid, last candle; "NOW" label on active bar
    - 1h countdown (seconds-precision) displayed alongside chart tabs
    - CLOSE POSITION + MARGIN buttons appear below chart only when position is open
  - Leverage selector: 71× / 77× / 81× / 85× (default 81×)
  - QTY input (base-asset-aware label)
  - LONG / SHORT market-order buttons
  - CLOSE ALL NOW with confirmation dialog
  - Collapsible account panel + audit log
  - Logout

### API Server (`artifacts/api-server`)
- **URL**: `/api`
- **Bitunix base**: `https://fapi.bitunix.com`
- **Signing**: SHA256(SHA256(`timestamp + nonce + body + secret`))
- **Routes**:
  - `GET /api/healthz` — health check
  - `POST /api/trade/long` — set leverage 81 → check no existing BTCUSDT position → place market BUY → log
  - `POST /api/trade/short` — set leverage 81 → check no existing BTCUSDT position → place market SELL → log
  - `GET /api/positions` — list open positions + detected positionMode
  - `POST /api/positions/:positionId/close` — flash close single position (per-position lock)
  - `POST /api/kill` — close ALL positions (cooldown lock, verify + retry, no blind retries)
  - `GET /api/logs` — last 50 audit entries
  - `POST /api/trigger/close` — external trigger endpoint (INTERNAL_TRIGGER_TOKEN auth, 10s staleness check)
- **Bitunix client** (`lib/bitunix.ts`):
  - `getPositionMode()` — detects ONE_WAY vs HEDGE, cached 5 min
  - `setLeverage(symbol, leverage)` — sets leverage, throws on failure
  - `placeMarketOrder(params)` — includes `tradeSide: "OPEN"` for HEDGE/UNKNOWN mode
  - `getOpenPositions()` — GET pending positions
  - `closeAllPositions()`, `flashClosePosition(positionId)`
- **Lock/cooldown** (`lib/cooldown.ts`):
  - `trade_entry` lock — 3s window prevents double-tap on entry
  - `__kill__` lock — 3s cooldown on CLOSE ALL
  - Per-position lock via `position:{id}` key

## Environment Variables

- `BITUNIX_API_KEY` — Bitunix futures API key (trade-only, no withdrawals)
- `BITUNIX_API_SECRET` — Bitunix futures API secret
- `APP_PASSWORD` — password sent as `x-key` header by the UI
- `DEFAULT_SYMBOL` — (optional, default BTCUSDT)
- `DEFAULT_LEVERAGE` — (optional, default 81)
- `KILL_COOLDOWN` — (optional, default 3) cooldown seconds between CLOSE ALL calls
- `INTERNAL_TRIGGER_TOKEN` — (optional) secret token for `/api/trigger/close` external endpoint

## Operational rules — Bitunix as source of truth
- All position state comes from Bitunix, never from local cache or button-click assumptions
- GET /api/positions filters by `symbol=BTCUSDT` and includes the query string in the signing payload (required for GET with query params)
- Position polling interval: 5s (frontend), burst-invalidated after any action
- Close All: polls Bitunix up to 8×700ms (~5.6s) before returning. If still open after first round, retries close and polls again. Returns `status: "CLOSED" | "STILL_OPEN"`
- Flash Close: polls Bitunix up to 6×600ms (~3.6s) for the specific positionId to disappear. Returns `status: "CLOSED" | "STILL_OPEN"`
- UI shows amber VERIFY warning when backend returns STILL_OPEN — never shows "Closed" without Bitunix confirmation
- Block new BTCUSDT entries if any BTCUSDT position already exists (returns 409)
- Set leverage before every entry order; abort if leverage set fails
- No blind retries: only retry CLOSE ALL if verification confirms positions still open
- Per-position lock prevents duplicate flash-close requests within 1 second
- All secrets stay server-side only — never exposed to browser
- Position mode detected lazily and cached; includes tradeSide: "OPEN" in hedge and unknown modes
- Position fields exposed: positionId, symbol, side, qty, marginMode, positionMode, leverage, entryPrice, markPrice, liqPrice, unrealisedPnl

## Chart feature
- Backend: `GET /api/klines?symbol=&interval=&limit=` proxies Bitunix `GET /api/v1/futures/market/kline`
- Supported intervals: `3min`, `1h`, `2h`, `6h` (Bitunix native intervals)
- Frontend: `useKlines` hook polls every 5s; `CandleChart` renders Heikin Ashi SVG candles
- Heikin Ashi: green = up, red = down, yellow = forming (last candle of fetch)
- 1h countdown ticker updates every second, computed from `Math.ceil(now / 3_600_000) * 3_600_000 - now`

## UI layout order (post-redesign)
1. Header: title + WS dot + refresh + exit
2. Favorites bar (collapsible PAIRS toggle)
3. Position card: when OPEN shows PnL hero → entry | mark → margin | leverage → size | liq; when FLAT shows live price + available/equity
4. Chart: interval tabs (3min/1h/2h/6h), 1h countdown, Heikin Ashi candles (last 10)
5. Leverage selector (4 buttons: 71×/77×/81×/85×)
6. Qty input (label auto-shows base asset: BTC, ETH, etc.)
7. LONG / SHORT buttons
8. CLOSE ALL (red)
9. Account (collapsible)
10. Audit log (collapsible)

## Mandatory workspace build baseline

This project has been manually tested end-to-end. The configuration below is the bare minimum known-good baseline, not optional cleanup. Future agents must preserve it unless the user explicitly asks to change the architecture.

For a complete rebuild or handoff to another coding agent, follow [`docs/AGENT_BUILD_GUIDE.md`](docs/AGENT_BUILD_GUIDE.md).

### Artifact routing

- `artifacts/bitunix-control` is the active production frontend and owns `/`.
- `artifacts/api-server` owns `/api` and is the shared backend.
- `artifacts/kill-switch` is the legacy frontend and owns `/kill-switch`; it must never be registered at `/`.
- Every artifact must have a unique `previewPath` and unique service path. Never create a second root web artifact or resolve a path collision by changing which frontend is built.
- Update artifact manifests through the artifact validation workflow, not by editing `.replit-artifact/artifact.toml` directly.

### Build and compatibility rules

- Preserve both the current session-authenticated Oracle Control Panel API contract and the legacy kill-switch API exports. A clean merge that removes either surface is broken.
- Preserve `artifacts/api-server/src/lib/bitunix.ts` as the compatibility boundary for positions, leverage, margin, orders, account data, tickers, and klines. Do not replace it with a partial generated-client rewrite.
- Apply the existing Drizzle schema with `pnpm --filter @workspace/db run push` when the development database is missing tables. Do not add startup DDL or replace the database setup.
- Keep all exchange credentials and application secrets server-side. Never expose, print, or commit them.

### Required verification before publishing

1. Run `pnpm run typecheck` across the workspace.
2. Build every deployable web artifact with the environment values its Vite config requires, for example:
   - `PORT=25574 BASE_PATH=/ NODE_ENV=production pnpm --filter @workspace/bitunix-control run build`
   - `PORT=18912 BASE_PATH=/kill-switch NODE_ENV=production pnpm --filter @workspace/kill-switch run build`
3. Confirm `GET /api/healthz` returns `status: "ok"` with both database and exchange checks reporting `ok: true`.
4. Refresh workflow logs and check for startup errors, repeated `401`/`403` responses, or failed data requests.
5. Run `git diff --check` and scan tracked project files for unresolved merge markers.
6. Preview `/` and confirm it is the Oracle Control Panel. Do not consider a legacy kill-switch screen at `/` a valid result.
7. Only after all checks pass, hand off the Publish action. Publishing is not complete until the user clicks Publish.
