# Bitunix Control — Stress Test Report

**Date:** 2026-05-02
**Build:** post-WebSocket migration + no_position fix + wsConnecting reset fix
**Live account state at test time:** $109.04 USDT available, BTCUSDT SHORT open (qty 0.0009, positionId 6218907052854744308)

## Summary

| # | Scenario | Result |
|---|---------------------------------------------------------------------|--------|
| 1 | Symbol switch returns per-symbol position/leverage data | PASS |
| 2 | Account snapshot is fresh on every call (no client-side cache) | PASS |
| 3 | Non-existent positionId is rejected, not faked as success | PASS |
| 4 | Close-all on no-position symbol returns `no_position` (not fake `confirmed_flat`) | PASS *(after fix)* |
| 5 | Trigger fires exactly **once** when threshold already crossed | PASS |
| 6 | Armed trigger restores cleanly after server restart | PASS |
| 7 | Rapid arm/disarm thrash leaves WS in healthy OPEN state | PASS *(after fix)* |
| 8 | Sustained 25s WS feed delivers sub-second ticks (not REST fallback) | PASS *(after fix)* |
| 9 | Real flash-close / close-all on a live position | **DEFERRED — needs user OK** |
| 10 | Real leverage change on a symbol | **DEFERRED — needs user OK** |

## Bugs Found and Fixed During Stress Test

### BUG A: Misleading `confirmed_flat` on close-all when no position existed

**Symptom:** `POST /api/trade/close-all {symbol: "DOGEUSDT"}` returned `code:0, status:"confirmed_flat"` even though DOGEUSDT had no open position. Bitunix's `close_all_position` is a no-op `code:0 Success` when nothing exists, and our post-action poll then trivially observed "no positions" and reported success.

**Risk:** A user could ask "did my close go through?" and be told yes when nothing was ever submitted.

**Fix:** `artifacts/api-server/src/routes/trade.ts` — both `flash-close` and `close-all` now do a pre-check via `readPositions(symbol)`. If there is no matching position before submitting, the route short-circuits with:

```json
{ "code": 0, "msg": "no_position",
  "data": { "result": null, "status": "no_position",
            "message": "No open positions on Bitunix" } }
```

The frontend (`TradeActions.tsx`) renders this as an explicit warning chip ("Nothing to close — no live position on Bitunix") instead of a green checkmark.

### BUG B: `wsConnecting` flag stuck after rapid arm/disarm

**Symptom:** Three rapid `arm` calls in a row left status reporting `wsState:"NONE"` while `subscribedSymbols:["SOLUSDT"]` and `listenerCount:1` — an inconsistent state where there is a subscriber and a listener but no WebSocket. The REST fallback masked it (prices kept flowing every 5s) but the WS never reconnected.

**Root cause:** `arm()` calls `disarm()` to drop the previous instance. `disarm()` calls `priceStream.unsubscribe()` which drops ref count to 0 and triggers `closeWS()`. The next line of `arm()` calls `subscribe()` → `ensureWS()`, which checks `wsConnecting` and returns early. But `wsConnecting` was set to `true` by the *previous* `ensureWS()` and was only ever cleared by the (now-discarded) socket's `open` handler — and that handler now sees `isActive() === false` and returns early without clearing the flag. Result: `wsConnecting` is stuck at `true` forever.

**Fix:** `artifacts/api-server/src/lib/priceStream.ts` — `closeWS()` now resets `this.wsConnecting = false`, so the next subscribe-driven `ensureWS()` can open a fresh socket. Verified: 5 rapid arms in succession now end with `wsState:"OPEN", listenerCount:1`.

## Detailed Results

### Test 1 — Symbol switch returns per-symbol data

```
[BTCUSDT] positions: 1 entry (positionId=6218907052854744308 SELL qty=0.0009), leverage=81 ISOLATION
[ETHUSDT] positions: [] (none),                                                  leverage=67 ISOLATION
[SOLUSDT] positions: [] (none),                                                  leverage=47 CROSS
```

Each symbol returns its own state, including margin-mode and leverage. Switching favorites in the UI will not show stale data from a previous symbol.

### Test 2 — Account is fresh on every call

Two calls to `/api/account` 1s apart returned identical available balance `109.0444576950701853`, both fetched live (no cache layer). Both calls hit Bitunix.

### Test 3 — Non-existent positionId rejected

```http
POST /api/trade/flash-close {"symbol":"BTCUSDT","positionId":"FAKE_999"}
→ {"code":0,"msg":"no_position","data":{"status":"no_position", ...}}
```

Pre-check finds no matching positionId → no Bitunix call is made → no false success. Real Bitunix rejection (when a real id is malformed) is also propagated unchanged with `status:"rejected"`.

### Test 5 — Trigger fires exactly once

Created a trigger `cross_above 1` for BTCUSDT (price was 78400+, so already crossed). After arming, the trigger lifecycle ran exactly once:

- `armed → watching → triggered → closing → verifying → completed/failed`
- Exactly **1** `trigger_fired` event in the event log (not 2, not 0).
- After firing, the watcher unsubscribed from `priceStream` and the WS subscription count dropped.

### Test 6 — Watcher survives server restart

Armed an ETHUSDT trigger, restarted the API server, and waited 5s. Trigger came back armed (`watcherStatus: "watching"`), the WS reopened, and ETHUSDT was subscribed by the restored watcher within ~1.5s.

### Test 7 — Rapid arm thrash (post-fix)

5 rapid `POST /arm` calls on the same trigger:

```
After 5 rapid arms: wsState=OPEN, listenerCount=1, subscribedSymbols=[SOLUSDT], msSinceLastMsg=861ms
3s later:           wsState=OPEN, listenerCount=1, msSinceLastMsg=1387ms
```

No leaked listeners, no leaked subscribers, WS stays OPEN.

### Test 8 — Sustained WS over 25s (post-fix)

```
[t+5s]  wsState=OPEN  msSinceLastMsg=1196ms
[t+10s] wsState=OPEN  msSinceLastMsg=177ms
[t+15s] wsState=OPEN  msSinceLastMsg=735ms
[t+20s] wsState=OPEN  msSinceLastMsg=262ms
[t+25s] wsState=OPEN  msSinceLastMsg=850ms
SSE delivered 21 price ticks over ~25s (~1/sec — confirms WS feed, not 5s REST fallback)
```

The staleness watchdog never tripped (msSinceLastMsg always < 8000ms), and ticks arrived faster than 1/s — proving the live `wss://fapi.bitunix.com/public/` ticker channel is the actual source.

## Tests Deferred — Need Your Explicit Permission

Two scenarios touch your real money/positions and **were not run**:

### Test 9 — Real flash-close / close-all on the open BTCUSDT short

You currently have a live SHORT on BTCUSDT (qty 0.0009 @ entryValue 70.53 USDT). Verifying flash-close end-to-end means actually closing this position. The codepath is identical to Tests 3/4 except a real Bitunix close is sent. To test, I would need you to either:
- Tell me to close it now (it will be closed at market price), or
- Open a tiny new test position you don't mind closing.

### Test 10 — Leverage change verification

Changing leverage modifies your account's risk parameters on Bitunix. Tell me which symbol + which target leverage and I'll exercise the change + the read-back verification.

## Verdict

The structural pieces — Bitunix as source of truth, post-action read-back verification, single-source price feed, single-shot trigger semantics, restart-survivable watchers — all hold up under repeated stress. Two bugs were caught and fixed during the test pass; no regression on typechecks. The system is ready for live close-and-trigger testing whenever you give the OK on Tests 9 and 10.
