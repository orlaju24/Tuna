# Changelog

All notable changes to the Bitunix Futures Control Panel are recorded here.
Each entry follows the template requested in the project spec:

> **Change** — what changed
> **Date** — when
> **Reason** — why
> **Frontend modules affected**
> **Backend modules affected**
> **Bitunix endpoint(s) touched**

The project uses Bitunix as the **single source of truth** for everything: every
write is followed by a verification read; nothing is faked.

---

## [0.1.0] — 2026-05-02 — Initial build

**Change** — First end-to-end version of the Bitunix Futures remote control panel.

**Reason** — Build the mobile-first remote control described in the spec PDF: live
favorites strip, account / position / leverage state cards, flash close + close all
with post-action verification, margin adjustment, and a private server-side
trigger watcher that fires once when price crosses a threshold.

### What was built

- **Monorepo layout** — `artifacts/api-server` (Express + TypeScript backend)
  and `artifacts/bitunix-control` (React + Vite frontend) wired through the
  shared reverse proxy. Postgres via Drizzle ORM with `favorites`, `triggers`,
  `event_log` tables.
- **Bitunix signing** (`bitunix.ts`) — Implements the official double-SHA-256
  algorithm: `sign = SHA256( SHA256(nonce + ts + apiKey + sortedQs + body) + secret )`
  with query params concatenated as `key1value1key2value2`.
- **Read endpoints** — Account, positions, leverage all proxied 1:1 from the
  backend to Bitunix, returning the upstream `{code, msg, data}` envelope as-is.
- **Write endpoints** — Leverage change, margin adjust, flash close, close all,
  and open order. Every mutation is followed by a verification read against the
  same symbol; the response includes a `status` of `confirmed_flat`,
  `still_open`, or the verified new state.
- **Live price stream** — Backend holds one shared WebSocket to Bitunix's
  public futures stream (`wss://fapi.bitunix.com/public/`, `ticker` channel)
  and fans tick-resolution prices to browsers via SSE. A 5 s REST poll
  acts as a safety net only while the WS is disconnected or stale.
  The browser exposes the same `usePrice(symbol)` hook regardless of
  the underlying transport.
- **Trigger watcher** (`watcher.ts`) — Full 9-state machine:
  `draft → armed → watching → triggered → closing → verifying → completed/failed/cancelled`.
  Watcher subscribes to the same shared price stream, fires once on first cross,
  closes via `flash_close` or `close_all`, then polls until flat. Armed
  triggers are restored on server restart.
- **Frontend dashboard** — Mobile-first dark UI with collapsible favorites
  strip, pair summary card with live price, account card, position card with
  realized PnL and margin ratio, leverage control with presets and custom
  input, margin adjust modal, trade actions (long/short/flash close/close all)
  with confirmation status, trigger panel (create/arm/disarm/delete), and
  event log feed. Default favorites BTCUSDT / ETHUSDT / SOLUSDT seeded.

### Frontend modules affected

`pages/Dashboard.tsx`, `components/{FavoritesStrip,PairSummaryCard,AccountCard,
PositionCard,LeverageControl,MarginModal,TradeActions,TriggerPanel,EventLog}.tsx`,
`hooks/{useAccount,usePositions,useLeverage,usePrice,useFavorites,useTriggers,
useEventLog}.ts`, `lib/{api,ws}.ts`.

### Backend modules affected

`routes/{account,positions,leverage,margin,trade,favorites,triggers,eventlog,
prices}.ts` (the eventlog route is exposed as `/api/events`),
`lib/{bitunix,priceStream,watcher,db,logger}.ts`, `index.ts`.

### Bitunix endpoints touched

| Purpose | Endpoint | Method |
|---|---|---|
| Account snapshot | `/api/v1/futures/account` | GET |
| Open positions | `/api/v1/futures/position/get_pending_positions` | GET |
| Leverage / margin mode | `/api/v1/futures/account/get_leverage_margin_mode` | GET |
| Change leverage | `/api/v1/futures/account/change_leverage` | POST |
| Adjust position margin | `/api/v1/futures/account/adjust_position_margin` | POST |
| Place order | `/api/v1/futures/trade/place_order` | POST |
| Flash close | `/api/v1/futures/trade/flash_close_position` | POST |
| Close all | `/api/v1/futures/trade/close_all_position` | POST |
| Public tickers (price stream) | `/api/v1/futures/market/tickers?symbols=` | GET |

---

## [0.1.7] — 2026-05-04 — Profit Safeguard (walk-away stop-loss upgrade)

**Change** — Added a server-side profit safeguard that watches a position's
unrealized ROI while walk-away mode is active and automatically trails a
private close trigger forward as the trade improves, converting near-wins
into protected exits.

**Reason** — The existing walk-away system could miss the chance to convert
a near-win into a real win: price approaches the target, fails to close,
drifts back toward entry. The safeguard adds a ratcheting layer on top of
the flash-close trigger so that once a trade proves itself (17% ROI), the
close zone follows it upward instead of sitting at a static level.

### Key rules (per PDF spec)

| Rule | Value |
|---|---|
| First protection milestone | 17% ROI on margin (configurable) |
| Fee-aware defend zone | 23% ROI target (displayed in config) |
| Trail step | 3% ROI behind high-water mark (configurable: 2–4%) |
| DB write throttle | every 0.5% ROI advance (avoids write storms) |
| Bitunix exposure | **none** until the close fires |

### Three UI states

- **DORMANT** — no open position, or no safeguard armed. Shows "Arm" button.
- **ARMED** (blue shield) — watching for 17% ROI. Shows live ROI vs threshold.
- **PROTECTED** (green shield) — ROI crossed threshold; shows internal
  safeguard close price and high-water ROI. Trailing updates every 0.5%
  advance.

### "Ninja" handling

The safeguardPrice is stored in the DB and shown in the UI, but
**Bitunix receives no API call** until the retrace fires the close. The
exchange sees only a standard flash_close or close_all at execution time,
identical to what the regular trigger system sends.

### Formulas

For a SHORT at entry E, leverage L, high-water ROI H, trail step T:
`safeguardClose = E × (1 − (H−T) / L / 100)`

For a LONG:
`safeguardClose = E × (1 + (H−T) / L / 100)`

Fire condition: SHORT fires when `livePrice ≥ safeguardClose`.
LONG fires when `livePrice ≤ safeguardClose`.

### Files added

- `lib/db/src/schema/safeguards.ts` — DB table (migrated via drizzle push)
- `artifacts/api-server/src/lib/safeguardWatcher.ts` — server-side watcher
- `artifacts/api-server/src/routes/safeguard.ts` — REST routes
- `artifacts/bitunix-control/src/hooks/useSafeguard.ts` — client hook
- `artifacts/bitunix-control/src/components/ProfitSafeguardCard.tsx` — UI card

### Files modified

- `lib/db/src/schema/index.ts` — export safeguards schema
- `artifacts/api-server/src/routes/index.ts` — mount safeguard router
- `artifacts/api-server/src/index.ts` — restore armed safeguards on restart
- `artifacts/bitunix-control/src/pages/Dashboard.tsx` — add card to layout

### Bitunix endpoints used (on fire only)

- `POST /api/v1/futures/trade/flash_close_position`
- `POST /api/v1/futures/trade/close_all_position`
- `GET /api/v1/futures/position/get_pending_positions` (flat-check)

---

## [0.1.6] — 2026-05-02 — Cost-aware ET schedule for awareness gauge

**Change** — Implemented the cost-aware scheduling spec from the PDF: the
Signal Awareness gauge now polls the backend **only during the user's
critical ET (Toronto) windows**. Outside those windows it goes fully quiet —
no fetches, no polling, no credit cost. Walk-away, triggers, position, live
price, and protection state remain live always per spec.

**Reason** — Awareness was running its 4-timeframe kline scan every 15
seconds, 24/7. Most of those reads were wasted credits during hours the
user isn't actively trading. The PDF is explicit: "Awareness is only active
when the schedule says it is needed. The rest of the time, the app should
preserve credits and keep the dashboard lightweight."

### How the scheduler works

- **Default ET windows**: London open (03:00–05:00), NY open (09:00–11:00),
  NY PM/close (14:00–16:00), Asia open (20:00–21:30). All editable via the
  settings gear in the awareness card header.
- **Inside a window**: the gauge polls hourly per spec ("one clean update
  per hour is enough unless a trigger or protection event happens first")
  instead of the old 15-second cadence.
- **Outside windows**: query is fully disabled — `enabled: false`,
  `refetchInterval: false`, `refetchOnWindowFocus: false`. Zero backend
  calls until the next window opens.
- **Wake now button**: outside windows, a "Wake now" button forces a
  one-shot manual refresh for on-demand reads (e.g. before placing an
  order during quiet hours).
- **Schedule status strip**: always visible at the top of the awareness
  card. Green "LIVE · NY open · 1h 23m left" inside windows; muted
  "QUIET · next 14:00 ET (NY PM / close)" outside.
- **Master switch**: cost-aware mode can be turned OFF entirely from the
  settings modal, falling back to legacy always-on 15s polling.
- **DST-safe**: ET time is read via `Intl.DateTimeFormat` with
  `timeZone: "America/Toronto"` — no naive offset math.
- **Wrap-around windows**: a window like 22:00 → 02:00 is handled
  explicitly so the second half isn't accidentally excluded.

### What stays live always (per PDF spec)

- Walk-away mode toggle
- Trigger close panel + armed-state polling (`useTriggers`)
- Server-side filled-close watcher (backend, untouched)
- Selected pair + live WebSocket price stream
- Protection state ("SET" / "NONE" badge) — moved out of the schedule-gated
  section so it's visible even in quiet mode

### Frontend modules added/changed

- `src/lib/schedule.ts` (new) — Pure schedule logic: window storage,
  ET-time evaluation, status computation. Fully testable.
- `src/hooks/useScheduleStatus.ts` (new) — Reactive hook that re-evaluates
  every 30s and on settings change.
- `src/hooks/useSignal.ts` — Now accepts `enabled` and `refetchIntervalMs`
  options; defaults preserved for back-compat.
- `src/components/SignalAwareness.tsx` — Schedule strip, Wake-now button,
  settings gear, pause-aware UI ("Last read at HH:MM — gauge is paused.").
- `src/components/ScheduleSettingsModal.tsx` (new) — Edit windows
  (HH:MM start/end + label), add/remove rows, master switch toggle,
  reset-to-defaults.

### Backend modules affected

None — all gating happens client-side. The server route `/signal/:symbol`
is unchanged and only invoked when the schedule allows.

### Bitunix endpoint(s) touched

None — this is purely a polling-cadence change for an existing route.

### Verified

```
Sat 14:29 ET → inside "NY PM / close" window:
  Strip shows: LIVE · NY PM / close · 1h 31m left
  Awareness loaded: verdict, 4 timeframes, whole-number, all rendered.

Outside any window (logic test):
  Strip shows: QUIET · next 20:00 ET (Asia open)
  Wake-now button visible. No background fetches.
  Walk-away + Protection rows still rendered.
```

---

## [0.1.5] — 2026-05-02 — USDT-denominated order entry

**Change** — The Open Position input now takes a **USDT amount** instead of a
raw base-asset contract size. Users type `100`, see a live preview
(`≈ 0.00127 BTC @ 78,435.30`), and the app converts to base-asset size at the
live WebSocket price right before submitting to Bitunix. The Trigger Price
input also gained a visible **USDT** suffix for consistency.

**Reason** — Users think in dollars, not in 0.001 BTC contract increments.
Asking for "Size (contracts)" forced mental math at every entry and made it
easy to type a wrong-magnitude number on a leveraged position. USDT-first
input matches how every other field on the dashboard is already denominated
(account balance, margin, PnL, trigger price).

### How the conversion works

- Input is a USDT notional (e.g. `100`).
- Live WS-cached price drives the conversion: `size = usdt / livePrice`.
- Base-asset precision auto-scales: BTC ($78k) → 4 dp, ETH ($2k) → 3 dp,
  SOL/BNB ($10–$1k) → 2 dp, sub-$1 assets → 0 dp. Rounded to nearest step
  (not floor) so a $5 order doesn't silently vanish to size 0.
- If the entered USDT amount is below the contract step at the current price
  (e.g. $5 on BTC where the step is ~$7.80), the form shows an explicit
  "Amount too small — needs at least ≈ X USDT" message instead of leaving
  the buttons mysteriously disabled.
- Long/Short buttons are disabled until a valid converted size > 0 exists.
- If the WebSocket has not ticked yet, the button click is rejected with
  "Waiting on live price — try again in a moment" rather than guessing.
- The submit POST to `/trade/open` still sends `size` in the base asset
  (Bitunix's `place_order` expects qty in contracts) — only the user-facing
  input is USDT.

### Frontend modules affected

- `src/components/TradeActions.tsx` — Replaced size input with USDT notional
  input + live preview line + size-precision helpers.
- `src/components/TriggerPanel.tsx` — Added USDT suffix to the trigger
  price input for visual consistency.

### Backend modules affected

None — `/trade/open` contract unchanged.

### Bitunix endpoint(s) touched

None — conversion happens client-side using the existing live WS price feed.

### Verified

```
Input: 100 USDT @ BTCUSDT $78,435 → ≈ 0.0012 BTC, Long button enabled
Input: empty                       → both Long/Short buttons disabled
WS not ticked yet                  → submission blocked with clear message
```

---

## [0.1.4] — 2026-05-02 — Multi-timeframe direction (3m / 15m / 1h / 6h)

**Change** — Replaced the single 1H bias + 3m velocity rows with a four-timeframe
direction read: short pulse (3m), mid pulse (15m), main trend (1h), higher bias
(6h). Each timeframe gets a simple **UP / DOWN / MIXED** label, and a combined
verdict banner ("Bullish — all aligned", "Mixed but bullish", "Mixed — wait",
"Mixed but bearish", "Bearish — all aligned") with **low / medium / high**
confidence. The whole-number, protection and walk-away rows are unchanged.

**Reason** — User wants context across timeframes without turning the panel
into a prediction engine. 3m and 15m give immediate directional pressure; 1h
is the main structural read; 6h is a background filter. If they line up, the
verdict says so plainly. If they don't, it says "Mixed — wait". No forecasting,
no confidence-laundering — just a multi-timeframe mirror so the user can
double-check what they think they're seeing.

### How the math works

- Per timeframe: fetch the 6 most-recent candles. Each candle contributes
  `direction × bodyStrength × recencyWeight` to a weighted sum, then normalize
  to `-1..+1`. A dead-zone of ±0.18 keeps the read on **MIXED** when the
  signal is noisy — that "allow a few shallow opposing candles" rule.
- Combined verdict weights timeframes: `3m=1, 15m=2, 1h=3, 6h=2` (range
  `-8..+8`). Mapping: `≥+6 → Bullish all aligned (high)`, `+3..+5 → Mixed
  but bullish (medium)`, `-2..+2 → Mixed wait (low)`, mirrored on the bear
  side.
- The most recent candle's "close" is replaced with the live cached WS price
  so the read reflects right now, not 60 s ago.
- Per-timeframe failures are tolerated via `Promise.allSettled` — if Bitunix
  blips on one interval, that row shows **NO DATA** and the verdict is
  computed from the remaining timeframes (no artificial confidence drag).
  The endpoint only 502s when **every** timeframe is empty (truly invalid pair).

### Frontend modules affected

- `src/hooks/useSignal.ts` — New `Direction` / `Confidence` / `TimeframeRead`
  types; 15 s react-query refresh.
- `src/components/SignalAwareness.tsx` — `VerdictBanner` + four
  `TimeframeRow`s; renders **NO DATA** for any timeframe with `ok:false`.

### Backend modules affected

- `src/routes/signal.ts` — Rewrote scoring around four timeframes in parallel,
  added `scoreTimeframe`, `computeVerdict`, `Promise.allSettled` resilience,
  and per-TF weights.

### Bitunix endpoint(s) touched

- `GET /api/v1/futures/market/kline` — called four times per signal request
  (`interval=3m|15m|1h|6h`, `limit=6`). Public, unsigned. Live cached price
  preferred over the latest 1m close.

### Verified live

```
BTCUSDT $78,341 → 3m MIXED · 15m MIXED · 1h MIXED · 6h MIXED → "Mixed — wait" / LOW (score 0)
ETHUSDT  $2,306 → 3m MIXED · 15m MIXED · 1h MIXED · 6h MIXED → "Mixed — wait" / LOW (score 0)
SOLUSDT     $84 → 3m MIXED · 15m MIXED · 1h MIXED · 6h MIXED → "Mixed — wait" / LOW (score 0)
DOGEUSDT  $0.11 → 3m MIXED · 15m MIXED · 1h UP · 6h NO DATA  → "Mixed but bullish" / MEDIUM (score +3)
INVALIDSYM       → 502 "no kline data on any timeframe"
```

(Sideways tape across BTC/ETH/SOL → all MIXED is correct, not a bug. The
verdict only fires UP/DOWN labels when the candles actually agree.)

---

## [0.1.3] — 2026-05-02 — Signal Awareness section

**Change** — Added a "Signal Awareness" card to the dashboard between the
selected pair and the account block. It is a guide layer (not advice) that
surfaces five at-a-glance cues from the trading lessons:

1. **1H bias** — up / down / neutral, derived from the current 1h candle's
   open vs the live cached price (Bitunix kline interval=1h, limit=2).
2. **Velocity (3m)** — high / low, derived from the % change across the last
   three 1m candles (Bitunix kline interval=1m, limit=3).
3. **Whole number nearby** — yes / no, plus the nearest round level. The
   "step" auto-scales with price magnitude (BTC ≈ 1000, ETH ≈ 100, SOL ≈ 1,
   DOGE ≈ 0.01); "nearby" means within 0.3 %.
4. **Protection set** — yes / no, computed from the existing triggers list
   (any armed trigger for the selected symbol).
5. **Walk-away mode** — local toggle persisted to `localStorage`. When ON
   alongside an armed trigger, the card prompts "Walk away — the trigger
   will close on cross." When ON without protection, it warns to set a
   trigger first.

**Reason** — User asked for a thinking-helper layer that reflects the lesson
mindset without replacing charts or pretending to predict the market. All
data is Bitunix-sourced; nothing is faked.

**Frontend modules affected**
- `bitunix-control/src/components/SignalAwareness.tsx` — new card.
- `bitunix-control/src/hooks/useSignal.ts` — react-query hook (15 s refresh).
- `bitunix-control/src/pages/Dashboard.tsx` — slot the card in.

**Backend modules affected**
- `api-server/src/routes/signal.ts` — new `GET /api/signal/:symbol` endpoint
  that fetches both kline series in parallel and computes the cues.
- `api-server/src/routes/index.ts` — register the new router.

**Bitunix endpoints touched**
- `GET /api/v1/futures/market/kline?symbol=…&interval=1h&limit=2`
- `GET /api/v1/futures/market/kline?symbol=…&interval=1m&limit=3`

Both are public market endpoints — no signing required, but they go through
the same `bitunixGet` helper for consistency. The live cached price from the
existing WebSocket stream is preferred over the kline close when available.

---

## [0.1.2] — 2026-05-02 — Stress-test fixes: no_position guard + WS reconnect race

**Change** — Two bugs found during the stress-test pass:

1. `POST /api/trade/close-all` and `/api/trade/flash-close` now do a pre-check
   read of `get_pending_positions` before submitting. If there is no matching
   position, the route short-circuits with `status:"no_position"` instead of
   forwarding to Bitunix. Reason: `close_all_position` returns `code:0 Success`
   even when nothing was closed; the post-action poll then trivially observed
   "no positions" and reported `confirmed_flat` — a misleading fake success.
2. `priceStream.closeWS()` now resets `wsConnecting = false`. Without this,
   rapid disarm→arm cycles left an in-flight socket stranded: its later `open`
   event saw `isActive() === false` and returned early without clearing the
   flag, so the next `ensureWS()` call would skip opening a fresh socket
   forever. The REST fallback masked it (prices kept flowing every 5s) but the
   WebSocket itself was dead.

**Reason** — The user's review correctly called out that "the app must verify
live state before and after every action" and "must not pretend success". The
`no_position` guard makes that contract explicit; the wsConnecting fix keeps
the live WS feed alive across user thrash.

**Frontend modules affected**
- `bitunix-control/src/components/TradeActions.tsx` — new `no_position` status
  type with a neutral warning chip ("Nothing to close — no live position on
  Bitunix") instead of a green checkmark.

**Backend modules affected**
- `api-server/src/routes/trade.ts` — added `readPositions()` helper and
  pre-checks in both close routes.
- `api-server/src/lib/priceStream.ts` — `closeWS()` clears `wsConnecting`.

**Bitunix endpoints touched** — None new; the pre-check uses the same
`/api/v1/futures/position/get_pending_positions` we already call.

**Verification** — See `STRESS_TEST.md` for the full pass/fail matrix.

---

## [0.1.1] — 2026-05-02 — WebSocket price feed

**Change** — Replaced the 1.5 s REST poll with a real Bitunix WebSocket
as the primary live-price source. REST poll is retained but only runs as
a fallback when the WS is disconnected or stale (>8 s without a tick).

**Reason** — Per spec: the trigger watcher must react to crosses in real
time, not on a 1.5 s schedule. The WS feed delivers tick-resolution
updates so a price cross fires the close request within milliseconds.

**Frontend modules affected** — None (the SSE contract and `usePrice`
hook are unchanged).

**Backend modules affected** — `lib/priceStream.ts` (full rewrite),
`routes/prices.ts` (added `GET /api/prices/status` diagnostic).

**Bitunix endpoint(s) touched** —
`wss://fapi.bitunix.com/public/` (`ticker` channel),
`/api/v1/futures/market/tickers` (REST fallback only).

### Notes / known limitations

- Browser WebSocket directly to Bitunix is not used; we proxy prices via SSE
  for environment portability.
- Single-user app: the Bitunix API key/secret come from process env, not
  per-user.
- Trigger types: only price cross (above / below). No time, percent, or
  trailing triggers in v0.1.
- No charts, no order book, no K-lines (explicitly excluded by the spec).
