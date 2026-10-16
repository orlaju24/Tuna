/**
 * Market-structure awareness module.
 *
 * Computes a rich `StructureContext` per symbol from four timeframes
 * (3m / 15m / 1h / 6h) and the live price. Used by the safeguard watcher
 * to size the adaptive trail beyond the simple -8..+8 alignment score.
 *
 * Layers:
 *   - HTF regime: 1h + 6h consensus = the ocean and the current.
 *   - LTF timing: 3m + 15m = entry timing tools.
 *     - 3m may lead the 15m before larger confirmation arrives.
 *   - 4-bar rule: 4+ consecutive same-direction CLOSED 6h bars = credible
 *     structural shift; trust the trade more.
 *   - Velocity: 3m body % per bar. Fast = patient (allow continuation);
 *     slow at a pivot = tighten (likely rejection).
 *   - Whole-number pivot proximity: combined with velocity decides
 *     pivot state (approach / stall / bounce / break / clear).
 *   - Counter-move / resumption: when LTFs flip against an aligned HTF
 *     and then flip back, the safeguard should be patient through the
 *     dip and reward the resumption.
 *
 * The cached context is refreshed every 60s in the background. The
 * `prev` map is used to detect counter-move → resumption transitions
 * across refresh cycles.
 */

import { bitunixGet } from "./bitunix";
import { logger } from "./logger";
import { priceStream } from "./priceStream";
import { buildLiveFingerprint, queryPatternMatch, type TopMatch } from "./fingerprintEngine";

// ── Types ────────────────────────────────────────────────────────────────────

interface KlineEntry {
  open: string;
  high: string;
  low: string;
  close: string;
}

interface HeikinAshiCandle {
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Direction = -1 | 0 | 1;
export type VelocityState = "fast" | "slow" | "normal";
export type PivotState = "clear" | "approach" | "stall" | "bounce" | "break";

/**
 * Whole-number play type — classifies the specific structural opportunity
 * around a key price level (whole number / major pivot).
 *
 *  over_key              — price is above the level, HTF bullish continuation
 *  under_key             — price is below the level, HTF bearish continuation
 *  over_under_transition — fast break DOWN through the level (bearish break)
 *  under_over_transition — fast break UP through the level (bullish break)
 *  clean_rejection       — sharp bounce back from the level (counter-move resolved)
 *  clean_retest          — slow return to a previously-broken level (stall = retest)
 *  none                  — not near a meaningful level
 */
export type WholeNumberPlayType =
  | "over_key"
  | "under_key"
  | "over_under_transition"
  | "under_over_transition"
  | "clean_rejection"
  | "clean_retest"
  | "none";

export type RetraceQuality = 'shallow' | 'normal' | 'deep' | 'none';
export type ResumptionStrength = 'strong' | 'moderate' | 'weak' | 'none';
export type LevelAcceptanceState = 'accepting' | 'rejecting' | 'contested' | 'untested';

/**
 * Wave phase state machine — tracks where in the wave cycle the market is.
 *
 * Sequence: pressure_building → first_wave → pullback → resumption_forming
 *           → resumption_confirmed → extended
 *
 * The ideal entry zone is resumption_forming / resumption_confirmed —
 * catching the restart of the move BEFORE the obvious expansion candle.
 *
 * 'extended' means the move is already too far along — the oracle waits for
 * a reset rather than chasing an exhausted wave.
 */
export type WavePhase =
  | 'pressure_building'    // 1-3 HA bars in HTF direction, no prior pullback yet
  | 'first_wave'           // 4+ HA bars in HTF direction, no pullback yet
  | 'pullback'             // HA running against HTF (counter-move active)
  | 'resumption_forming'   // 1-2 HA bars back in HTF direction after pullback ← CATCH IT HERE
  | 'resumption_confirmed' // 3-4 HA bars back in HTF direction ← still ideal entry zone
  | 'extended'             // 5+ HA bars — profit wave when already in a trade; avoid for new entry
  | 'mixed';               // no clear pattern or no HTF consensus

/**
 * Health of the extension wave — only meaningful when wavePhase === 'extended'.
 * When FLAT: extension = "do not enter". When IN A TRADE: extension = profit wave.
 * The system holds through the extension and closes only as the extension DIES.
 *
 *   alive   (≥70) — extension expanding, bodies growing, wicks small → hold
 *   peaking (≥50) — early fatigue signals, slight body softening → watch closely
 *   dying   (≥30) — bodies shrinking, wicks growing → tighten protection now
 *   dead    (<30)  — extension collapsed → aggressive safeguard, prepare exit
 */
export type ExtensionPhase = 'alive' | 'peaking' | 'dying' | 'dead';

export interface StructureContext {
  // Aggregate alignment score (-8..+8) — kept for back-compat with existing UI.
  signalScore: number;

  // HTF regime (1h + 6h).
  oneHourDirection: Direction;
  sixHourDirection: Direction;
  htfDirection: Direction;     // consensus direction; 0 = mixed/unknown
  htfAligned: boolean;         // 1h and 6h same non-zero direction

  // LTF (3m + 15m).
  threeMinDirection: Direction;
  fifteenMinDirection: Direction;
  threeMinLeads: boolean;      // 3m matches HTF, 15m doesn't yet
  fifteenMinConfirms: boolean; // both 3m and 15m match HTF

  // 3m continuation streak (signed: +N = N consecutive bullish closed 3m bars).
  // Oracle Method: 2nd or 3rd continuation is the entry zone; 1st is risky.
  threeMinStreak: number;

  // 4-bar 6h rule (signed: +N = N up bars, -N = N down bars).
  fourBarStreak: number;
  fourBarRule: boolean;        // |streak| >= 4

  // Velocity from current 3m bar body.
  velocityState: VelocityState;
  threeMinBodyPct: number;     // |body| as % of price

  // Candle depth — 3m bar high-low range as % of price.
  // Broader than body alone: captures total price volatility in the bar.
  // A wide-range bar with a small body = indecision; wide body = conviction.
  candleDepthPct: number;

  // Follow-through score (0–10): how many of the last 3 closed 3m bars
  // align with HTF direction. 10 = all 3 match (strong continuation),
  // 0 = none match (stall or reversal brewing).
  followThroughScore: number;

  // Whole-number pivot proximity.
  nearestPivot: number;
  pivotProximityPct: number;   // distance to nearest pivot, % of price
  nearPivot: boolean;          // within 0.4%
  pivotState: PivotState;

  // Counter-move / resumption around the HTF direction.
  counterMove: boolean;        // 3m direction opposite to aligned HTF
  resumption: boolean;         // counter-move just resolved back into HTF

  // Retrace depth quality — how deep was the counter-move pullback?
  //   'shallow' — retrace < ~38% of the impulse move (healthy breath)
  //   'normal'  — 38–62% retrace (standard corrective pause)
  //   'deep'    — > 62% retrace (potentially changing character)
  //   'none'    — no counter-move or resumption detected in this window
  retraceQuality: RetraceQuality;

  // Resumption strength — quality of the return move after a counter-move.
  //   'strong'   — HA confirms in HTF direction with good body strength + fast velocity
  //   'moderate' — HA partially confirms or 3m streak resuming
  //   'weak'     — price flipped back to HTF direction but without conviction
  //   'none'     — no resumption detected (counterMove or no-signal window)
  resumptionStrength: ResumptionStrength;

  // Whole-number play classification (derived from pivotState + price position).
  wholeNumberPlayType: WholeNumberPlayType;

  // Whole-number zone memory — how has price historically behaved at this level?
  // Refreshed every 60s; looks back up to 4 hours of compute cycles.
  //   'accepting'  — 2+ decisive breaks through this level → market is committing
  //   'rejecting'  — 2+ clean rejections → level is a reliable wall
  //   'contested'  — mixed record of breaks and rejections → messy, wait
  //   'untested'   — fewer than 2 decisive events → treat as neutral
  levelAcceptanceState: LevelAcceptanceState;
  levelTouchCount:    number;   // total near-pivot visits in last 4h
  levelRejectionCount: number;  // confirmed rejection events in last 4h
  levelAcceptedCount:  number;  // confirmed break-through events in last 4h

  // Heikin Ashi trend confirmation (3m and 15m).
  // Bigger HA candle bodies = stronger momentum per Oracle Method.
  // "The bigger the candle, the bigger the move" — HA filters out noise
  // and makes consecutive trend direction more legible.
  haStreak3m: number;          // signed: +N = N consecutive bullish 3m HA bars, -N bearish
  haStreak15m: number;         // signed: +N = N consecutive bullish 15m HA bars
  haBodyStrength3m: number;    // 0–1: avg HA body / HA range ratio across 3m streak candles
  haBodyStrength15m: number;   // 0–1: avg HA body / HA range ratio across 15m streak candles
  haNoDissent3m: boolean;      // true if streak candles have no opposing wicks (pure trend)

  // ── 6h Heikin Ashi — Master Bias Layer ───────────────────────────────────
  // The 6h HA defines the broad directional bias. Clean candles with no tails
  // are the strongest directional clue — they signal conviction with no absorption
  // pressure. Red and clean 6h HA = short bias preferred. Green and clean = long.
  // Mixed, indecisive, or heavily-tailed 6h HA = lower confidence, wait.
  haStreak6h:            number;    // signed: +N = N bullish, -N = N bearish closed 6h HA bars
  haBodyStrength6h:      number;    // 0–1 avg HA body/range across the 6h streak
  haNoDissent6h:         boolean;   // no opposing wicks — the cleanest directional signal
  ha6hBias:              Direction; // HA-derived 6h bias: +1 clean bull, -1 clean bear, 0 mixed/tailed
  ha6hClean:             boolean;   // ≥2 bars + bodyStrength ≥ 0.60 (directional, not tailed)

  // ── 1h Heikin Ashi — Confirmation Layer ──────────────────────────────────
  // The last two 1h HA candles must be clean (body ≥ 60% of HA range) and
  // aligned with the 6h bias before the system upgrades confidence.
  // If those candles are not clean, reduce conviction and wait for structure.
  haStreak1h:            number;    // signed: +N = N bullish, -N = N bearish closed 1h HA bars
  haBodyStrength1h:      number;    // 0–1 avg HA body/range across the 1h streak
  haNoDissent1h:         boolean;   // no opposing wicks on 1h HA streak
  ha1hLastTwoClean:      boolean;   // last 2 closed 1h HA bars: clean + aligned with 6h bias
  ha1hConfirms6h:        boolean;   // 1h HA actively confirms the 6h bias (direction + clean)
  ha1hExhaustionWarning: boolean;   // 4+ clean 1h HA bars = possible 6h trend exhaustion forming

  // Wave direction quality — derived from HA cross-timeframe alignment.
  // These three flags let edgeScore and the UI reason about WHETHER the wave is
  // happening in the right HA context, not just whether a wave is happening at all.
  waveAlignedWithHa6h: boolean;   // wave direction matches 6h HA bias (higher-conviction setup)
  pullbackControlled:  boolean;   // pullback on 3m but 1h HA still holds trade direction (shallow counter)
  waveExhaustionFlag:  boolean;   // extended phase + 1h HA exhaustion = double "do not enter" signal

  // Wave pattern analysis — tracks the wave cycle for resumption entry timing.
  // Derived from the HA 3m candle sequence. Updated every 60s with the cache.
  //
  // The core insight: the strongest entry is in the RESUMPTION, not the initial
  // wave or after the big candle is obvious. wave2VsWave1Ratio > 1.1 means the
  // market absorbed the pullback and is restarting with more force than the
  // first push — the highest-quality resumption signal in the Oracle Method.
  wavePhase:         WavePhase;
  wave1BodyAvg:      number;   // 0-1: avg HA body/range ratio of wave 1
  wave1Length:       number;   // HA bar count in wave 1
  pullbackLength:    number;   // counter-move HA bar count
  wave2BodyAvg:      number;   // 0-1: avg HA body/range ratio of wave 2 (resumption)
  wave2Length:       number;   // HA bar count in wave 2
  wave2VsWave1Ratio: number;   // wave2 / wave1 body ratio; >1 = resumption stronger than wave 1

  // Extension health — only populated when wavePhase === 'extended'.
  // When flat: extension = danger (chasing). When in trade: extension = profit wave.
  // The safeguard trail widens when the extension is alive and tightens as it dies.
  extensionScore:  number | undefined;    // 0-100 composite health of the extension wave
  extensionPhase:  ExtensionPhase | undefined; // alive | peaking | dying | dead

  // Pattern memory — fingerprint similarity against historical trade setups.
  // Null = fewer than 5 fingerprints exist (system is still learning).
  // 0-100 when active: high = setup resembles prior clean patterns.
  fingerprintConfidence:  number | null;
  fingerprintSampleCount: number;
  postWinHumility:        boolean;   // true = 4-hour caution after strong win
  postWinMinutesLeft:     number;
  patternTopMatches:      TopMatch[];

  // Adaptive output for the safeguard.
  patienceBoost: number;       // -2..+4 added to base trail (clamped via trailWidth)
  trailWidth: number;          // final trail % to use (2..12)
  patienceLevel: string;       // tight | standard | good | strong | exceptional
}

// ── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
// `resumptionServed` makes resumption a true one-shot pulse: the first read
// after a fresh compute that produced `resumption=true` returns it as-is, then
// subsequent reads in the same TTL window see resumption cleared.
const cache = new Map<
  string,
  { ctx: StructureContext; updatedAt: number; resumptionServed: boolean }
>();
const prev = new Map<string, StructureContext>();
const pending = new Set<string>();

// ── Whole-number zone memory ──────────────────────────────────────────────────
// Tracks how price has historically interacted with each whole-number level.
// Updated every time fetchAndCompute detects nearPivot === true.
// Persists in-process memory (survives 60 s refresh cycles; resets on restart).
//
// Outcome classification per visit:
//   'accepted' — clean break through the level (under_over or over_under transition)
//   'rejected' — confirmed bounce / rejection (clean_rejection)
//   'testing'  — price is exploring the zone but not committing (approach/stall/retest)

interface WnVisit {
  at: number;
  outcome: "accepted" | "rejected" | "testing";
}
interface WnZoneEntry { level: number; visits: WnVisit[] }

const wnZoneMemory = new Map<string, WnZoneEntry>();
const WN_MEMORY_MAX_VISITS = 20;
const WN_MEMORY_WINDOW_MS  = 4 * 60 * 60 * 1_000; // 4-hour rolling window

function recordWnVisit(symbol: string, level: number, playType: WholeNumberPlayType): void {
  if (level <= 0 || playType === "none") return;
  const key = `${symbol}:${level}`;
  const entry = wnZoneMemory.get(key) ?? { level, visits: [] };

  const outcome: WnVisit["outcome"] =
    playType === "under_over_transition" || playType === "over_under_transition"
      ? "accepted"
      : playType === "clean_rejection"
        ? "rejected"
        : "testing";

  const now = Date.now();
  entry.visits.push({ at: now, outcome });
  entry.visits = entry.visits
    .filter(v => v.at >= now - WN_MEMORY_WINDOW_MS)
    .slice(-WN_MEMORY_MAX_VISITS);
  wnZoneMemory.set(key, entry);
}

function getWnAcceptance(
  symbol: string,
  level: number,
): { state: LevelAcceptanceState; touchCount: number; rejections: number; accepted: number } {
  if (level <= 0) return { state: "untested", touchCount: 0, rejections: 0, accepted: 0 };
  const entry = wnZoneMemory.get(`${symbol}:${level}`);
  if (!entry || entry.visits.length === 0) {
    return { state: "untested", touchCount: 0, rejections: 0, accepted: 0 };
  }
  const now = Date.now();
  const recent   = entry.visits.filter(v => v.at >= now - WN_MEMORY_WINDOW_MS);
  const decisive = recent.filter(v => v.outcome !== "testing");
  const accepted  = decisive.filter(v => v.outcome === "accepted").length;
  const rejections = decisive.filter(v => v.outcome === "rejected").length;

  let state: LevelAcceptanceState;
  if (decisive.length < 2)                      state = "untested";
  else if (accepted >= 2 && rejections === 0)    state = "accepting";
  else if (rejections >= 2 && accepted === 0)    state = "rejecting";
  else                                           state = "contested";

  return { state, touchCount: recent.length, rejections, accepted };
}

const TIMEFRAMES = [
  { tf: "3m",  weight: 1, limit: 18 }, // 18 so we have 17 closed bars — enough to see wave1→pullback→wave2
  { tf: "15m", weight: 2, limit: 6 },
  { tf: "1h",  weight: 3, limit: 6 },
  { tf: "6h",  weight: 6, limit: 6 }, // limit is 6 so we have 5 closed bars for the 4-bar rule
] as const;

// ── Heikin Ashi computation ───────────────────────────────────────────────────

/**
 * Converts regular OHLC candles to Heikin Ashi candles.
 *
 * Input: Bitunix format (most-recent-first). Internally reverses to oldest-first
 * for the HA_Open carry-forward formula, then reverses the result back so that
 * index 0 = most recent (in-progress) — matching the Bitunix convention used
 * elsewhere in this module.
 *
 * HA_Close  = (O + H + L + C) / 4
 * HA_Open   = (prev_HA_Open + prev_HA_Close) / 2  (seed: (O₀ + C₀) / 2)
 * HA_High   = max(H, HA_Open, HA_Close)
 * HA_Low    = min(L, HA_Open, HA_Close)
 */
function computeHeikinAshi(candles: KlineEntry[]): HeikinAshiCandle[] {
  if (candles.length === 0) return [];
  // Bitunix returns newest-first; we need oldest-first for the seed carry.
  const chronological = [...candles].reverse();

  const ha: HeikinAshiCandle[] = [];
  for (let i = 0; i < chronological.length; i++) {
    const c = chronological[i];
    const o = parseFloat(c.open);
    const h = parseFloat(c.high);
    const l = parseFloat(c.low);
    const cl = parseFloat(c.close);
    if (!Number.isFinite(o) || !Number.isFinite(cl)) {
      ha.push({ open: o, high: h, low: l, close: cl });
      continue;
    }
    const haClose = (o + h + l + cl) / 4;
    const haOpen = i === 0
      ? (o + cl) / 2
      : (ha[i - 1].open + ha[i - 1].close) / 2;
    const haHigh = Math.max(h, haOpen, haClose);
    const haLow  = Math.min(l, haOpen, haClose);
    ha.push({ open: haOpen, high: haHigh, low: haLow, close: haClose });
  }
  // Reverse back to newest-first (matches Bitunix convention).
  return ha.reverse();
}

/**
 * Compute Heikin Ashi streak statistics from a set of HA candles.
 *
 * Returns:
 *   streak       — signed count of consecutive same-direction CLOSED HA bars
 *                  (skips index 0 = in-progress bar, same as compute3mStreak)
 *   bodyStrength — avg HA body / HA range ratio across the streak candles (0–1)
 *                  "bigger body = stronger momentum"
 *   noDissent    — true if no opposing wick on any streak candle (pure trend)
 *                  bearish: HA_High == max(HA_Open,HA_Close) (no upper wick)
 *                  bullish: HA_Low  == min(HA_Open,HA_Close) (no lower wick)
 */
function computeHaStats(haCandles: HeikinAshiCandle[]): {
  streak: number;
  bodyStrength: number;
  noDissent: boolean;
} {
  if (haCandles.length < 2) return { streak: 0, bodyStrength: 0, noDissent: false };

  let streak = 0;
  let signSeen: -1 | 0 | 1 = 0;
  const streakCandles: HeikinAshiCandle[] = [];

  // Index 0 = in-progress bar (Bitunix newest-first); skip it.
  for (let i = 1; i < haCandles.length; i++) {
    const c = haCandles[i];
    if (!Number.isFinite(c.open) || !Number.isFinite(c.close)) break;
    const dir: -1 | 0 | 1 = c.close > c.open ? 1 : c.close < c.open ? -1 : 0;
    if (dir === 0) break;
    if (signSeen === 0) {
      signSeen = dir;
      streak = 1;
      streakCandles.push(c);
    } else if (dir === signSeen) {
      streak++;
      streakCandles.push(c);
    } else {
      break;
    }
  }

  if (streakCandles.length === 0) return { streak: 0, bodyStrength: 0, noDissent: false };

  let totalBodyRatio = 0;
  let noDissent = true;
  const EPSILON = 0.01; // price units; any wick < this is treated as absent

  for (const c of streakCandles) {
    const range = c.high - c.low;
    const body  = Math.abs(c.close - c.open);
    totalBodyRatio += range > 0 ? body / range : 1;

    // Bearish streak: no upper wick means HA_High ≈ max(open, close)
    // Bullish streak: no lower wick means HA_Low  ≈ min(open, close)
    if (signSeen === -1) {
      const upperWick = c.high - Math.max(c.open, c.close);
      if (upperWick > EPSILON) noDissent = false;
    } else {
      const lowerWick = Math.min(c.open, c.close) - c.low;
      if (lowerWick > EPSILON) noDissent = false;
    }
  }

  return {
    streak: streak * (signSeen as number),
    bodyStrength: Number((totalBodyRatio / streakCandles.length).toFixed(3)),
    noDissent,
  };
}

/**
 * Checks the last two CLOSED 1h HA candles for cleanliness and alignment
 * relative to the 6h HA bias.
 *
 * A candle is "clean" when its HA body is ≥ 60% of its HA range — meaning
 * no significant opposing tail. Clean candles with minimal tails express
 * pure directional conviction; tailed candles imply absorption or indecision.
 *
 * Both bars must be clean AND aligned with ha6hBias for confirmation.
 */
function checkHa1hLastTwoClean(
  ha1h: HeikinAshiCandle[],
  ha6hBias: Direction,
): { lastTwoClean: boolean; confirms6h: boolean } {
  if (ha1h.length < 3 || ha6hBias === 0) return { lastTwoClean: false, confirms6h: false };
  const CLEAN_THRESHOLD = 0.60;
  const isClean = (c: HeikinAshiCandle): boolean => {
    const range = c.high - c.low;
    if (range < 1e-6) return false;
    return Math.abs(c.close - c.open) / range >= CLEAN_THRESHOLD;
  };
  const bar1 = ha1h[1]; // most recent closed 1h HA bar
  const bar2 = ha1h[2]; // second most recent closed 1h HA bar
  if (!bar1 || !bar2) return { lastTwoClean: false, confirms6h: false };
  const dir1 = haCandleDir(bar1);
  const dir2 = haCandleDir(bar2);
  const lastTwoClean =
    dir1 === ha6hBias && isClean(bar1) &&
    dir2 === ha6hBias && isClean(bar2);
  return { lastTwoClean, confirms6h: lastTwoClean };
}

// ── Per-timeframe scoring (mirrors signal.ts logic) ──────────────────────────

function scoreCandles(candles: KlineEntry[], livePrice?: number): Direction {
  if (candles.length === 0) return 0;
  const ordered = [...candles].reverse();
  let weightedSum = 0;
  let totalWeight = 0;
  const lastIdx = ordered.length - 1;

  ordered.forEach((c, idx) => {
    const open = parseFloat(c.open);
    let close = parseFloat(c.close);
    let high = parseFloat(c.high);
    let low = parseFloat(c.low);
    if (!Number.isFinite(open) || !Number.isFinite(close)) return;

    if (idx === lastIdx && livePrice && Number.isFinite(livePrice)) {
      close = livePrice;
      if (livePrice > high) high = livePrice;
      if (livePrice < low) low = livePrice;
    }

    const range = Math.max(high - low, 1e-9);
    const body = close - open;
    const strength = Math.min(1, Math.abs(body) / range);
    const dir = body > 0 ? 1 : body < 0 ? -1 : 0;
    const recency = idx + 1;
    weightedSum += dir * recency * strength;
    totalWeight += recency;
  });

  const normalized = totalWeight > 0 ? weightedSum / totalWeight : 0;
  if (normalized >= 0.18) return 1;
  if (normalized <= -0.18) return -1;
  return 0;
}

// Direction of a single closed candle (no live-price substitution).
function closedCandleDirection(c: KlineEntry): Direction {
  const open = parseFloat(c.open);
  const close = parseFloat(c.close);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return 0;
  if (close > open) return 1;
  if (close < open) return -1;
  return 0;
}

/**
 * Count consecutive same-direction CLOSED 3m bars from the most recent.
 * Bitunix returns klines most-recent-first; idx 0 is the in-progress bar
 * and is intentionally skipped.
 *
 * The Oracle Method: "the 2nd or 3rd continuation on the 3-minute helps for
 * entries." This count is used in patienceQuality scoring.
 * Returns a signed count: +N = N consecutive bullish 3m bars, -N = bearish.
 */
function compute3mStreak(candles3m: KlineEntry[]): number {
  if (candles3m.length < 2) return 0;
  let streak = 0;
  let signSeen: Direction = 0;
  for (let i = 1; i < candles3m.length; i++) {
    const d = closedCandleDirection(candles3m[i]);
    if (d === 0) break;
    if (signSeen === 0) {
      signSeen = d;
      streak = 1;
    } else if (d === signSeen) {
      streak++;
    } else {
      break;
    }
  }
  return streak * (signSeen as number);
}

/**
 * Count consecutive same-direction CLOSED 6h bars from the most recent.
 * Bitunix returns klines most-recent-first; idx 0 is the in-progress bar
 * and is intentionally skipped — the rule is about completed structure.
 * Returns a signed count: +N for up streak, -N for down streak.
 */
function compute6hStreak(candles6h: KlineEntry[]): number {
  if (candles6h.length < 2) return 0;
  let streak = 0;
  let signSeen: Direction = 0;
  for (let i = 1; i < candles6h.length; i++) {
    const d = closedCandleDirection(candles6h[i]);
    if (d === 0) break;
    if (signSeen === 0) {
      signSeen = d;
      streak = 1;
    } else if (d === signSeen) {
      streak++;
    } else {
      break;
    }
  }
  return streak * (signSeen as number);
}

/**
 * Velocity = current 3m bar body magnitude as % of live price.
 * Reflects "how hard price is moving right now" — directly matches
 * the velocity diagram concept (fast slam through a level vs slow creep).
 */
function computeVelocity(
  candles3m: KlineEntry[],
  livePrice: number
): { bodyPct: number; state: VelocityState } {
  if (candles3m.length === 0 || !Number.isFinite(livePrice) || livePrice <= 0) {
    return { bodyPct: 0, state: "normal" };
  }
  const c = candles3m[0]; // most recent (in-progress)
  const open = parseFloat(c.open);
  if (!Number.isFinite(open) || open <= 0) return { bodyPct: 0, state: "normal" };
  const body = livePrice - open;
  const bodyPct = (Math.abs(body) / livePrice) * 100;
  let state: VelocityState = "normal";
  if (bodyPct > 0.15) state = "fast";
  else if (bodyPct < 0.05) state = "slow";
  return { bodyPct: Number(bodyPct.toFixed(3)), state };
}

// Whole-number step scaled to the asset's price magnitude.
function wholeNumberStep(price: number): number {
  const abs = Math.abs(price);
  if (abs >= 10000) return 1000;
  if (abs >= 1000) return 100;
  if (abs >= 100) return 10;
  if (abs >= 10) return 1;
  if (abs >= 1) return 0.1;
  return 0.01;
}

/**
 * Classify the structural opportunity type around the nearest whole-number level.
 * Requires `nearPivot === true`; returns "none" otherwise.
 *
 *  break  + price above level  → under_over_transition (bullish break UP)
 *  break  + price below level  → over_under_transition (bearish break DOWN)
 *  bounce                      → clean_rejection (bounced back from the level)
 *  stall                       → clean_retest (slow creep, potential retest)
 *  approach + price above      → over_key (above the level, holding support)
 *  approach + price below      → under_key (below the level, holding resistance)
 */
function classifyWholeNumberPlay(
  price: number,
  nearestPivot: number,
  pivotState: PivotState,
  nearPivot: boolean,
): WholeNumberPlayType {
  if (!nearPivot) return "none";
  const overKey = price >= nearestPivot;
  switch (pivotState) {
    case "break":    return overKey ? "under_over_transition" : "over_under_transition";
    case "bounce":   return "clean_rejection";
    case "stall":    return "clean_retest";
    case "approach": return overKey ? "over_key" : "under_key";
    default:         return "none";
  }
}

function computePivot(price: number): {
  nearest: number;
  distancePct: number;
  near: boolean;
} {
  if (!Number.isFinite(price) || price <= 0) {
    return { nearest: 0, distancePct: 0, near: false };
  }
  const step = wholeNumberStep(price);
  const lower = Math.floor(price / step) * step;
  const upper = lower + step;
  const distLower = Math.abs(price - lower);
  const distUpper = Math.abs(upper - price);
  const nearest = distLower <= distUpper ? lower : upper;
  const distance = Math.min(distLower, distUpper);
  const distancePct = (distance / price) * 100;
  return {
    nearest,
    distancePct: Number(distancePct.toFixed(3)),
    near: distancePct <= 0.4,
  };
}

// ── Velocity enrichment ───────────────────────────────────────────────────────

/**
 * 3m in-progress bar's high-low range as % of price (candle depth).
 * Broader than body alone — captures total volatility within the bar.
 * Wide range + small body = indecision; wide range + big body = conviction.
 */
function computeCandleDepthPct(candles3m: KlineEntry[], livePrice: number): number {
  if (candles3m.length === 0 || livePrice <= 0) return 0;
  const c = candles3m[0]; // most-recent (in-progress)
  const high = Math.max(parseFloat(c.high), livePrice);
  const low  = Math.min(parseFloat(c.low),  livePrice);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return 0;
  return Number(((high - low) / livePrice * 100).toFixed(3));
}

/**
 * Follow-through score (0–10): how many of the last 3 CLOSED 3m bars
 * align with HTF direction.
 *   10 = all 3 match (strong continuation)
 *    0 = none match (stall or counter-move building)
 * Skips index 0 (in-progress); reads idx 1, 2, 3.
 */
function computeFollowThrough(candles3m: KlineEntry[], htfDirection: Direction): number {
  if (htfDirection === 0 || candles3m.length < 4) return 5; // neutral when insufficient data
  let matchCount = 0;
  for (let i = 1; i <= 3; i++) {
    if (closedCandleDirection(candles3m[i]) === htfDirection) matchCount++;
  }
  return Math.round((matchCount / 3) * 10);
}

// ── Wave pattern analysis ────────────────────────────────────────────────────

/**
 * Direction of a single Heikin Ashi candle.
 */
function haCandleDir(c: HeikinAshiCandle): -1 | 0 | 1 {
  if (!Number.isFinite(c.open) || !Number.isFinite(c.close)) return 0;
  if (c.close > c.open) return 1;
  if (c.close < c.open) return -1;
  return 0;
}

/**
 * Average HA body/range ratio across a set of candles (0–1).
 * "The bigger the candle body relative to its range, the stronger the momentum."
 */
function avgBodyStrength(candles: HeikinAshiCandle[]): number {
  if (candles.length === 0) return 0;
  let total = 0;
  for (const c of candles) {
    const range = c.high - c.low;
    const body  = Math.abs(c.close - c.open);
    total += range > 0 ? body / range : 1;
  }
  return Number((total / candles.length).toFixed(3));
}

/**
 * Classify the current wave phase from the HA 3m candle sequence.
 *
 * The ideal entry zone is resumption_forming / resumption_confirmed:
 * the first 1-4 bars of the second wave, BEFORE the obvious expansion candle.
 *
 * Algorithm (HA candles newest-first):
 *   1. Skip index 0 (in-progress bar) and reverse to chronological order.
 *   2. Group consecutive same-direction candles into runs.
 *   3. Analyze the last three runs to detect wave1 → pullback → wave2.
 */
function computeWavePattern(
  ha3m: HeikinAshiCandle[],
  htfDirection: Direction,
  ha6hBias: Direction,
  ha1hConfirms6h: boolean,
  ha1hExhaustionWarning: boolean,
): {
  wavePhase:           WavePhase;
  wave1BodyAvg:        number;
  wave1Length:         number;
  pullbackLength:      number;
  wave2BodyAvg:        number;
  wave2Length:         number;
  wave2VsWave1Ratio:   number;
  waveAlignedWithHa6h: boolean;
  pullbackControlled:  boolean;
  waveExhaustionFlag:  boolean;
} {
  const NONE = {
    wavePhase: "mixed" as WavePhase,
    wave1BodyAvg: 0, wave1Length: 0,
    pullbackLength: 0,
    wave2BodyAvg: 0, wave2Length: 0,
    wave2VsWave1Ratio: 0,
    waveAlignedWithHa6h: false,
    pullbackControlled:  false,
    waveExhaustionFlag:  false,
  };
  if (htfDirection === 0 || ha3m.length < 3) return NONE;

  // Pre-compute: does the wave direction agree with the 6h HA master bias?
  // When ha6hBias === 0 (mixed/tailed) this is false — we can't claim alignment.
  const waveAlignedWithHa6h = ha6hBias !== 0 && ha6hBias === htfDirection;

  // Skip in-progress bar (idx 0), reverse to chronological order.
  const closed = ha3m.slice(1).reverse();
  if (closed.length < 2) return NONE;

  // Group into direction runs (consecutive same-direction HA bars).
  type Run = { dir: -1 | 0 | 1; candles: HeikinAshiCandle[] };
  const runs: Run[] = [];
  for (const c of closed) {
    const d = haCandleDir(c);
    if (d === 0) continue; // skip doji — don't break runs on neutral bars
    if (runs.length === 0 || runs[runs.length - 1].dir !== d) {
      runs.push({ dir: d, candles: [c] });
    } else {
      runs[runs.length - 1].candles.push(c);
    }
  }
  if (runs.length === 0) return NONE;

  const currentRun = runs[runs.length - 1];
  const currentLen = currentRun.candles.length;

  // ── Current run is against HTF → PULLBACK ──────────────────────────────────
  if (currentRun.dir !== htfDirection) {
    const wave1Run = runs.length >= 2 ? runs[runs.length - 2] : null;
    return {
      wavePhase: "pullback",
      wave1BodyAvg:   wave1Run ? avgBodyStrength(wave1Run.candles) : 0,
      wave1Length:    wave1Run ? wave1Run.candles.length : 0,
      pullbackLength: currentLen,
      wave2BodyAvg: 0,
      wave2Length: 0,
      wave2VsWave1Ratio: 0,
      waveAlignedWithHa6h,
      // Controlled pullback: 3m is counter but 1h HA still confirms trade direction.
      // Means the pullback is shallow — 1h hasn't flipped. Good setup forming.
      pullbackControlled: ha1hConfirms6h,
      waveExhaustionFlag: false,
    };
  }

  // ── Current run in HTF direction ───────────────────────────────────────────

  // Full wave1 → pullback → wave2 pattern (3+ runs, prior run against HTF).
  if (runs.length >= 3) {
    const pullbackRun = runs[runs.length - 2];
    const wave1Run    = runs[runs.length - 3];
    if (pullbackRun.dir !== htfDirection && wave1Run.dir === htfDirection) {
      const w1Avg = avgBodyStrength(wave1Run.candles);
      const w2Avg = avgBodyStrength(currentRun.candles);
      const ratio = w1Avg > 0 ? Number((w2Avg / w1Avg).toFixed(3)) : 0;

      let wavePhase: WavePhase;
      if      (currentLen >= 5) wavePhase = "extended";
      else if (currentLen >= 3) wavePhase = "resumption_confirmed";
      else                      wavePhase = "resumption_forming";

      return {
        wavePhase,
        wave1BodyAvg:   w1Avg,
        wave1Length:    wave1Run.candles.length,
        pullbackLength: pullbackRun.candles.length,
        wave2BodyAvg:   w2Avg,
        wave2Length:    currentLen,
        wave2VsWave1Ratio: ratio,
        waveAlignedWithHa6h,
        pullbackControlled: false,
        // Extended + 1h exhaustion = both timeframes are stretched simultaneously.
        waveExhaustionFlag: wavePhase === "extended" && ha1hExhaustionWarning,
      };
    }
  }

  // Two-run case: [pullback][current=wave2] where prior run was against HTF.
  if (runs.length === 2) {
    const priorRun = runs[runs.length - 2];
    if (priorRun.dir !== htfDirection) {
      // Short pattern — no wave 1 data, but we're in a resumption.
      const w2Avg = avgBodyStrength(currentRun.candles);
      let wavePhase: WavePhase;
      if      (currentLen >= 5) wavePhase = "extended";
      else if (currentLen >= 3) wavePhase = "resumption_confirmed";
      else                      wavePhase = "resumption_forming";
      return {
        wavePhase,
        wave1BodyAvg: 0, wave1Length: 0,
        pullbackLength: priorRun.candles.length,
        wave2BodyAvg: w2Avg,
        wave2Length: currentLen,
        wave2VsWave1Ratio: 0, // no wave1 data for comparison
        waveAlignedWithHa6h,
        pullbackControlled: false,
        waveExhaustionFlag: wavePhase === "extended" && ha1hExhaustionWarning,
      };
    }
  }

  // Only one run in HTF direction (no prior pullback detected).
  let wavePhase: WavePhase;
  if      (currentLen >= 5) wavePhase = "extended";
  else if (currentLen >= 4) wavePhase = "first_wave";
  else                      wavePhase = "pressure_building";

  return {
    wavePhase,
    wave1BodyAvg:   avgBodyStrength(currentRun.candles),
    wave1Length:    currentLen,
    pullbackLength: 0,
    wave2BodyAvg: 0, wave2Length: 0,
    wave2VsWave1Ratio: 0,
    waveAlignedWithHa6h,
    pullbackControlled: false,
    waveExhaustionFlag: wavePhase === "extended" && ha1hExhaustionWarning,
  };
}

// ── Extension health ──────────────────────────────────────────────────────────

/**
 * Measures the health of an extension wave (5+ consecutive HA bars in HTF direction).
 * Called only when wavePhase === 'extended'. Returns a 0-100 score and phase label.
 *
 * Five components (matching the PDF spec):
 *   1. Body expansion    (0-25) — recent bar bodies vs early bar bodies in the run
 *   2. Wick compression  (0-20) — opposing wicks in the last 3 bars (small = healthy)
 *   3. Consistency       (0-20) — fraction of bars with minimal opposing shadow
 *   4. Momentum          (0-20) — recent body strength vs older strength in the run
 *   5. Room to level     (0-15) — distance to nearest whole-number pivot
 *
 * Interpretation (bidirectional — works identically for longs and shorts):
 *   ≥70 → alive   (extension strong — hold the trade, widen trail)
 *   ≥50 → peaking (early fatigue — watch closely, slight trail room)
 *   ≥30 → dying   (extension weakening — tighten protection)
 *   <30  → dead    (extension collapsed — aggressive protection, prepare exit)
 */
function computeExtensionHealth(
  ha3m: HeikinAshiCandle[],
  htfDirection: Direction,
  pivotProximityPct: number,
): { extensionScore: number; extensionPhase: ExtensionPhase } {
  if (htfDirection === 0 || ha3m.length < 3) {
    return { extensionScore: 50, extensionPhase: "peaking" };
  }

  // Rebuild the current run — same logic as computeWavePattern.
  const closed = ha3m.slice(1).reverse();
  type Run = { dir: -1 | 0 | 1; candles: HeikinAshiCandle[] };
  const runs: Run[] = [];
  for (const c of closed) {
    const d = haCandleDir(c);
    if (d === 0) continue;
    if (runs.length === 0 || runs[runs.length - 1].dir !== d) {
      runs.push({ dir: d, candles: [c] });
    } else {
      runs[runs.length - 1].candles.push(c);
    }
  }
  const currentRun = runs[runs.length - 1];
  if (!currentRun || currentRun.dir !== htfDirection) {
    return { extensionScore: 50, extensionPhase: "peaking" };
  }

  const candles = currentRun.candles;
  const n = candles.length;

  // 1. Body expansion (0-25): are later bars in the run wider than earlier bars?
  const earlySlice  = candles.slice(0, Math.min(2, n));
  const recentSlice = candles.slice(Math.max(0, n - 2));
  const earlyAvg    = avgBodyStrength(earlySlice);
  const recentAvg   = avgBodyStrength(recentSlice);
  const expRatio    = earlyAvg > 0 ? recentAvg / earlyAvg : 1;
  const bodyPts     = expRatio >= 1.15 ? 25 : expRatio >= 0.9 ? 17 : expRatio >= 0.7 ? 9 : 3;

  // 2. Wick compression (0-20): avg opposing wick / range across last 3 bars.
  //    For longs: opposing wick = lower shadow (open - low).
  //    For shorts: opposing wick = upper shadow (high - open).
  const forWick    = candles.slice(Math.max(0, n - 3));
  const avgOppWick = forWick.reduce((sum, c) => {
    const range = c.high - c.low;
    if (range < 0.001) return sum;
    const opp = htfDirection > 0 ? Math.max(0, c.open - c.low) : Math.max(0, c.high - c.open);
    return sum + opp / range;
  }, 0) / Math.max(1, forWick.length);
  const wickPts = avgOppWick <= 0.12 ? 20 : avgOppWick <= 0.25 ? 14 : avgOppWick <= 0.40 ? 7 : 2;

  // 3. Consistency (0-20): fraction of ALL bars in the run with small opposing shadow.
  const cleanCount = candles.filter(c => {
    const range = c.high - c.low;
    if (range < 0.001) return true;
    const opp = htfDirection > 0 ? Math.max(0, c.open - c.low) : Math.max(0, c.high - c.open);
    return opp / range < 0.18;
  }).length;
  const consistency    = cleanCount / n;
  const consistencyPts = consistency >= 0.8 ? 20 : consistency >= 0.6 ? 13 : consistency >= 0.4 ? 6 : 2;

  // 4. Momentum trajectory (0-20): recent body strength vs older bars in the run.
  const olderSlice   = n > 3 ? candles.slice(0, n - 3) : earlySlice;
  const recentMomAvg = avgBodyStrength(recentSlice);
  const olderMomAvg  = avgBodyStrength(olderSlice);
  const momRatio     = olderMomAvg > 0 ? recentMomAvg / olderMomAvg : 1;
  const momentumPts  = momRatio >= 1.0 ? 20 : momRatio >= 0.8 ? 13 : momRatio >= 0.6 ? 6 : 2;

  // 5. Room to level (0-15): distance to nearest whole-number pivot in trade direction.
  const roomPts = pivotProximityPct >= 0.5 ? 15 : pivotProximityPct >= 0.2 ? 10 : 4;

  const extensionScore = Math.min(100, bodyPts + wickPts + consistencyPts + momentumPts + roomPts);
  const extensionPhase: ExtensionPhase =
    extensionScore >= 70 ? "alive"   :
    extensionScore >= 50 ? "peaking" :
    extensionScore >= 30 ? "dying"   : "dead";

  return { extensionScore, extensionPhase };
}

// ── Retrace depth and resumption quality ──────────────────────────────────────

/**
 * Assess the depth of the counter-move (pullback) relative to the prior impulse.
 *
 * We use the Heikin Ashi streak's bar count + body strength as a proxy for
 * Fibonacci retrace depth, since we only have ~30 min of 3m candles (not enough
 * for precise Fib levels against the prior swing).
 *
 * When `counterMove === true` — infer from CURRENT HA running against HTF.
 * When `resumption  === true` — infer from PREVIOUS cycle's HA (when it was
 *   running against HTF), because the current HA has already flipped back.
 */
function computeRetraceQuality(
  counterMove: boolean,
  resumption: boolean,
  htfDirection: Direction,
  prevCtx: StructureContext | undefined,
  currentHaStreak3m: number,
  currentHaBodyStrength3m: number,
): RetraceQuality {
  if (!counterMove && !resumption) return "none";

  let counterHaAbs: number;
  let counterBodyStrength: number;

  if (resumption && prevCtx) {
    // Previous cycle's HA was the counter-move — read its direction and strength.
    const prevHaDir = prevCtx.haStreak3m > 0 ? 1 : prevCtx.haStreak3m < 0 ? -1 : 0;
    const wasAgainst = htfDirection !== 0 && prevHaDir !== 0 && prevHaDir !== htfDirection;
    counterHaAbs       = wasAgainst ? Math.abs(prevCtx.haStreak3m) : 1;
    counterBodyStrength = wasAgainst ? prevCtx.haBodyStrength3m : 0.4;
  } else {
    // Currently in the counter-move; current HA describes its depth.
    counterHaAbs       = Math.abs(currentHaStreak3m);
    counterBodyStrength = currentHaBodyStrength3m;
  }

  if (counterHaAbs >= 4 && counterBodyStrength >= 0.70) return "deep";
  if (counterHaAbs >= 3 && counterBodyStrength >= 0.55) return "deep";
  if (counterHaAbs >= 2 && counterBodyStrength >= 0.55) return "normal";
  if (counterHaAbs >= 2)                               return "shallow";
  return "shallow"; // 1-bar counter = minimal retrace
}

/**
 * Assess how convincingly price returned to the HTF direction after a pullback.
 * Only meaningful when `resumption === true`.
 *
 *  'strong'   — HA ≥ 2 bars aligned with HTF + high body strength + fast velocity
 *  'moderate' — HA partially confirms, OR 3m streak ≥ 2 bars back in HTF direction
 *  'weak'     — price flipped back but no HA/velocity confirmation yet
 *  'none'     — not in a resumption window
 */
function computeResumptionStrength(
  resumption: boolean,
  htfDirection: Direction,
  haStreak3m: number,
  haBodyStrength3m: number,
  velocityState: VelocityState,
  threeMinStreak: number,
): ResumptionStrength {
  if (!resumption || htfDirection === 0) return "none";

  const haDir = haStreak3m > 0 ? 1 : haStreak3m < 0 ? -1 : 0;
  const haAbs = Math.abs(haStreak3m);
  const haAligned = haDir === htfDirection;

  if (haAligned && haAbs >= 2 && haBodyStrength3m >= 0.65 && velocityState === "fast") {
    return "strong";
  }

  const streakDir = threeMinStreak > 0 ? 1 : threeMinStreak < 0 ? -1 : 0;
  const streakAbs = Math.abs(threeMinStreak);
  if ((haAligned && haAbs >= 1) || (streakDir === htfDirection && streakAbs >= 2)) {
    return "moderate";
  }

  return "weak";
}

// ── Main compute ─────────────────────────────────────────────────────────────

async function fetchAndCompute(symbol: string): Promise<StructureContext> {
  const settled = await Promise.allSettled(
    TIMEFRAMES.map((t) =>
      bitunixGet<KlineEntry[]>("/api/v1/futures/market/kline", {
        symbol,
        interval: t.tf,
        limit: String(t.limit),
      })
    )
  );

  const tfMap: Record<string, KlineEntry[]> = {};
  TIMEFRAMES.forEach((t, i) => {
    const s = settled[i];
    tfMap[t.tf] =
      s.status === "fulfilled" && Array.isArray(s.value.data) ? s.value.data : [];
  });

  const livePrice =
    priceStream.getLatest(symbol) ??
    (tfMap["3m"][0] ? parseFloat(tfMap["3m"][0].close) : 0);

  // Per-timeframe direction scores.
  const threeMinDirection   = scoreCandles(tfMap["3m"],  livePrice);
  const fifteenMinDirection = scoreCandles(tfMap["15m"], livePrice);
  const oneHourDirection    = scoreCandles(tfMap["1h"],  livePrice);
  const sixHourDirection    = scoreCandles(tfMap["6h"],  livePrice);

  // Aggregate -8..+8 alignment score (3m=1, 15m=2, 1h=3, 6h=2).
  const signalScore =
    threeMinDirection * 1 +
    fifteenMinDirection * 2 +
    oneHourDirection * 3 +
    sixHourDirection * 2;

  // ── Heikin Ashi computation for all four timeframes ──────────────────────
  // Computed BEFORE htfDirection derivation so the 6h HA can act as a
  // tiebreaker when regular candle scoring produces no consensus.
  // 3m + 15m: existing entry-timing logic.
  // 1h: confirmation layer — last 2 clean bars must align with 6h bias.
  // 6h: master bias layer — defines the broad directional preference.
  const ha3m  = computeHeikinAshi(tfMap["3m"]);
  const ha15m = computeHeikinAshi(tfMap["15m"]);
  const ha1h  = computeHeikinAshi(tfMap["1h"]);
  const ha6h  = computeHeikinAshi(tfMap["6h"]);
  const haStats3m  = computeHaStats(ha3m);
  const haStats15m = computeHaStats(ha15m);
  const haStats1h  = computeHaStats(ha1h);
  const haStats6h  = computeHaStats(ha6h);

  // ── 6h HA master bias ──────────────────────────────────────────────────────
  // A clean 6h HA streak (≥2 bars, body ≥ 60% of range) defines the broad
  // directional bias. "No-tail" candles (noDissent) are the strongest edge.
  // Symmetric: rewards clean bearish 6h equally to clean bullish 6h.
  const ha6hDir: Direction = haStats6h.streak > 0 ? 1 : haStats6h.streak < 0 ? -1 : 0;
  const ha6hAbs = Math.abs(haStats6h.streak);
  // Bias fires when at least 1 closed bar with body ≥ 50% of range exists.
  const ha6hBias: Direction = ha6hAbs >= 1 && haStats6h.bodyStrength >= 0.50 ? ha6hDir : 0;
  // "Clean" requires ≥2 bars with body ≥ 60% — directional conviction.
  const ha6hClean = ha6hAbs >= 2 && haStats6h.bodyStrength >= 0.60;

  // ── 1h HA confirmation ─────────────────────────────────────────────────────
  // The last two closed 1h HA bars must be clean (body ≥ 60%) AND aligned
  // with the 6h bias before the oracle upgrades confidence for the entry.
  const ha1hCheck         = checkHa1hLastTwoClean(ha1h, ha6hBias);
  const ha1hLastTwoClean  = ha1hCheck.lastTwoClean;
  const ha1hConfirms6h    = ha1hCheck.confirms6h;

  // ── 1h exhaustion warning ──────────────────────────────────────────────────
  // 4+ consecutive clean 1h HA bars after a move = possible 6h trend change.
  // WARNING only: reduce late-continuation confidence, demand scrutiny.
  const ha1hAbs               = Math.abs(haStats1h.streak);
  const ha1hExhaustionWarning = ha1hAbs >= 4 && haStats1h.bodyStrength >= 0.60;

  // ── HTF consensus (regular candle scoring) ───────────────────────────────
  const htfAligned =
    oneHourDirection !== 0 && oneHourDirection === sixHourDirection;
  let htfDirection: Direction = 0;
  if (htfAligned) htfDirection = oneHourDirection;
  else if (oneHourDirection !== 0 && sixHourDirection === 0) htfDirection = oneHourDirection;
  else if (sixHourDirection !== 0 && oneHourDirection === 0) htfDirection = sixHourDirection;

  // ── HA-informed htfDirection refinement ──────────────────────────────────
  // When regular candle scoring produces no consensus (htfDirection = 0),
  // a clean 6h HA signal acts as a tiebreaker. This removes the implicit
  // "wait for a regular candle bullish close" bias — a clean HA streak is a
  // smoothed, noise-filtered read that is equally valid for shorts and longs.
  // We do NOT override an existing htfDirection consensus (HA is additive).
  if (htfDirection === 0 && ha6hBias !== 0 && ha6hClean) {
    htfDirection = ha6hBias;
  }

  // LTF lead / confirm logic.
  const threeMinLeads =
    htfDirection !== 0 &&
    threeMinDirection === htfDirection &&
    fifteenMinDirection !== htfDirection;
  const fifteenMinConfirms =
    htfDirection !== 0 &&
    threeMinDirection === htfDirection &&
    fifteenMinDirection === htfDirection;

  // 3m continuation streak.
  const threeMinStreak = compute3mStreak(tfMap["3m"]);

  // 4-bar 6h rule.
  const fourBarStreak = compute6hStreak(tfMap["6h"]);
  const fourBarRule = Math.abs(fourBarStreak) >= 4;

  // Velocity + pivot.
  const velocity = computeVelocity(tfMap["3m"], livePrice);
  const pivot = computePivot(livePrice);

  // Counter-move: HTF aligned but the 3m has flipped against it.
  const counterMove =
    htfAligned &&
    threeMinDirection !== 0 &&
    threeMinDirection === ((-htfDirection) as Direction);

  // Resumption: previous cycle was a counter-move and we've now flipped back.
  const prevCtx = prev.get(symbol);
  const resumption =
    !!prevCtx?.counterMove &&
    !counterMove &&
    htfDirection !== 0 &&
    threeMinDirection === htfDirection;

  // Pivot state — combines proximity, velocity, and direction agreement.
  let pivotState: PivotState = "clear";
  if (pivot.near) {
    if (counterMove) pivotState = "bounce";
    else if (velocity.state === "slow") pivotState = "stall";
    else if (velocity.state === "fast" && fifteenMinConfirms) pivotState = "break";
    else pivotState = "approach";
  }

  // Whole-number play classification — derived from pivot state + price position.
  const wholeNumberPlayType = classifyWholeNumberPlay(
    livePrice, pivot.nearest, pivotState, pivot.near,
  );

  // ── Velocity enrichment ────────────────────────────────────────────────────
  const candleDepthPct     = computeCandleDepthPct(tfMap["3m"], livePrice);
  const followThroughScore = computeFollowThrough(tfMap["3m"], htfDirection);

  // ── Retrace depth and resumption quality ───────────────────────────────────
  const retraceQuality = computeRetraceQuality(
    counterMove, resumption, htfDirection, prevCtx,
    haStats3m.streak, haStats3m.bodyStrength,
  );
  const resumptionStrength = computeResumptionStrength(
    resumption, htfDirection,
    haStats3m.streak, haStats3m.bodyStrength, velocity.state, threeMinStreak,
  );

  // ── Wave pattern analysis ──────────────────────────────────────────────────
  // Derived from the full HA 3m candle sequence (now 17 closed bars available).
  // Classifies the current wave phase and computes wave1/wave2 body strength
  // for the resumption quality score modifier in edgeScore.ts.
  const wavePattern = computeWavePattern(ha3m, htfDirection, ha6hBias, ha1hConfirms6h, ha1hExhaustionWarning);

  // ── Extension health (only when wavePhase === 'extended') ─────────────────
  // When flat: extension = chasing danger. When in a trade: extension = profit
  // wave — the system should hold through it and close only as it DIES.
  // The score drives a 5th trail-width layer in safeguardWatcher (±2 pp).
  let extensionScore: number | undefined;
  let extensionPhase: ExtensionPhase | undefined;
  if (wavePattern.wavePhase === "extended") {
    const ext = computeExtensionHealth(ha3m, htfDirection, pivot.distancePct);
    extensionScore = ext.extensionScore;
    extensionPhase = ext.extensionPhase;
  }

  // ── Whole-number zone memory ───────────────────────────────────────────────
  // Record this near-pivot interaction and read acceptance state.
  if (pivot.near) {
    recordWnVisit(symbol, pivot.nearest, wholeNumberPlayType);
  }
  const wnAcc = getWnAcceptance(symbol, pivot.nearest);

  // Patience boost — encodes the "let it breathe" / "tighten now" rules
  // from the market-structure spec and the velocity diagram.
  let boost = 0;
  // Best case from the PDF: HTF aligned + 3m leading + fast velocity.
  if (htfAligned && threeMinLeads && velocity.state === "fast") boost += 2;
  else if (htfAligned && fifteenMinConfirms) boost += 1;
  if (fourBarRule) boost += 1;
  if (counterMove) boost -= 1;
  if (resumption) boost += 1;
  // Slow creep into pivot = likely rejection (matches LOW VELOCITY image).
  if (pivot.near && velocity.state === "slow" && !threeMinLeads) boost -= 1;

  const baseTrail = adaptiveTrail(signalScore);
  const trailWidth = Math.max(2, Math.min(12, baseTrail + boost));

  // ── Rough oracle score bucket (for fingerprint matching before full compute) ─
  // We approximate the oracle score bucket from the alignment score alone so we
  // can query pattern memory without a full edgeScore run (avoids coupling).
  const roughBucket =
    signalScore >= 6 ? "exceptional" as const
    : signalScore >= 3 ? "good" as const
    : signalScore >= 0 ? "moderate" as const
    : "poor" as const;

  const fpDirection: "LONG" | "SHORT" | "unknown" =
    htfDirection === 1 ? "LONG" : htfDirection === -1 ? "SHORT" : "unknown";

  const liveFingerprint = buildLiveFingerprint({
    velocityState:     velocity.state,
    htfAligned,
    htfDirection,
    haStreak3m:        haStats3m.streak,
    price:             livePrice,
    direction:         fpDirection,
    oracleScoreBucket: roughBucket,
  });

  // ── Pattern memory query ───────────────────────────────────────────────────
  // Query happens in fetchAndCompute (background refresh, already async).
  // Result is baked into the ctx so computeEdgeScore gets it synchronously.
  let patternMatch: {
    confidence:         number | null;
    totalSamples:       number;
    topMatches:         TopMatch[];
    postWinHumility:    boolean;
    postWinMinutesLeft: number;
    dominantQuality:    import("./fingerprintEngine").QualityLabel | null;
  } = {
    confidence:         null,
    totalSamples:       0,
    topMatches:         [],
    postWinHumility:    false,
    postWinMinutesLeft: 0,
    dominantQuality:    null,
  };
  try {
    patternMatch = await queryPatternMatch(symbol, liveFingerprint);
  } catch (err) {
    logger.warn({ err }, "Pattern memory query failed (non-fatal)");
  }

  let ctx: StructureContext = {
    signalScore,
    oneHourDirection,
    sixHourDirection,
    htfDirection,
    htfAligned,
    threeMinDirection,
    fifteenMinDirection,
    threeMinLeads,
    fifteenMinConfirms,
    threeMinStreak,
    fourBarStreak,
    fourBarRule,
    velocityState: velocity.state,
    threeMinBodyPct: velocity.bodyPct,
    nearestPivot: pivot.nearest,
    pivotProximityPct: pivot.distancePct,
    nearPivot: pivot.near,
    pivotState,
    counterMove,
    resumption,
    // Retrace depth + resumption quality
    retraceQuality,
    resumptionStrength,
    wholeNumberPlayType,
    // Velocity enrichment
    candleDepthPct,
    followThroughScore,
    // Whole-number zone memory
    levelAcceptanceState: wnAcc.state,
    levelTouchCount:      wnAcc.touchCount,
    levelRejectionCount:  wnAcc.rejections,
    levelAcceptedCount:   wnAcc.accepted,
    // Heikin Ashi — 3m and 15m (existing entry-timing fields)
    haStreak3m:        haStats3m.streak,
    haStreak15m:       haStats15m.streak,
    haBodyStrength3m:  haStats3m.bodyStrength,
    haBodyStrength15m: haStats15m.bodyStrength,
    haNoDissent3m:     haStats3m.noDissent,
    // Heikin Ashi — 6h master bias layer
    haStreak6h:            haStats6h.streak,
    haBodyStrength6h:      haStats6h.bodyStrength,
    haNoDissent6h:         haStats6h.noDissent,
    ha6hBias,
    ha6hClean,
    // Heikin Ashi — 1h confirmation layer
    haStreak1h:            haStats1h.streak,
    haBodyStrength1h:      haStats1h.bodyStrength,
    haNoDissent1h:         haStats1h.noDissent,
    ha1hLastTwoClean,
    ha1hConfirms6h,
    ha1hExhaustionWarning,
    // Wave pattern
    wavePhase:           wavePattern.wavePhase,
    wave1BodyAvg:        wavePattern.wave1BodyAvg,
    wave1Length:         wavePattern.wave1Length,
    pullbackLength:      wavePattern.pullbackLength,
    wave2BodyAvg:        wavePattern.wave2BodyAvg,
    wave2Length:         wavePattern.wave2Length,
    wave2VsWave1Ratio:   wavePattern.wave2VsWave1Ratio,
    waveAlignedWithHa6h: wavePattern.waveAlignedWithHa6h,
    pullbackControlled:  wavePattern.pullbackControlled,
    waveExhaustionFlag:  wavePattern.waveExhaustionFlag,
    // Extension health
    extensionScore,
    extensionPhase,
    // Pattern memory
    fingerprintConfidence:  patternMatch.confidence,
    fingerprintSampleCount: patternMatch.totalSamples,
    postWinHumility:        patternMatch.postWinHumility,
    postWinMinutesLeft:     patternMatch.postWinMinutesLeft,
    patternTopMatches:      patternMatch.topMatches,
    patienceBoost: boost,
    trailWidth,
    patienceLevel: patienceLabel(signalScore),
  };

  // Save current as prev for the next refresh cycle's resumption detection.
  prev.set(symbol, ctx);
  return ctx;
}

async function refresh(symbol: string): Promise<void> {
  if (pending.has(symbol)) return;
  pending.add(symbol);
  try {
    const ctx = await fetchAndCompute(symbol);
    cache.set(symbol, { ctx, updatedAt: Date.now(), resumptionServed: false });
  } catch (err) {
    logger.warn({ err, symbol }, "Market structure refresh failed");
  } finally {
    pending.delete(symbol);
  }
}

const NEUTRAL: StructureContext = {
  signalScore: 0,
  oneHourDirection: 0,
  sixHourDirection: 0,
  htfDirection: 0,
  htfAligned: false,
  threeMinDirection: 0,
  fifteenMinDirection: 0,
  threeMinLeads: false,
  fifteenMinConfirms: false,
  threeMinStreak: 0,
  fourBarStreak: 0,
  fourBarRule: false,
  velocityState: "normal",
  threeMinBodyPct: 0,
  nearestPivot: 0,
  pivotProximityPct: 0,
  nearPivot: false,
  pivotState: "clear",
  counterMove: false,
  resumption: false,
  retraceQuality: "none",
  resumptionStrength: "none",
  wholeNumberPlayType: "none",
  candleDepthPct: 0,
  followThroughScore: 5,
  levelAcceptanceState: "untested",
  levelTouchCount: 0,
  levelRejectionCount: 0,
  levelAcceptedCount: 0,
  haStreak3m: 0,
  haStreak15m: 0,
  haBodyStrength3m: 0,
  haBodyStrength15m: 0,
  haNoDissent3m: false,
  // 6h HA master bias
  haStreak6h: 0,
  haBodyStrength6h: 0,
  haNoDissent6h: false,
  ha6hBias: 0 as Direction,
  ha6hClean: false,
  // 1h HA confirmation
  haStreak1h: 0,
  haBodyStrength1h: 0,
  haNoDissent1h: false,
  ha1hLastTwoClean: false,
  ha1hConfirms6h: false,
  ha1hExhaustionWarning: false,
  waveAlignedWithHa6h: false,
  pullbackControlled: false,
  waveExhaustionFlag: false,
  wavePhase: "mixed",
  wave1BodyAvg: 0,
  wave1Length: 0,
  pullbackLength: 0,
  wave2BodyAvg: 0,
  wave2Length: 0,
  wave2VsWave1Ratio: 0,
  extensionScore:  undefined,
  extensionPhase:  undefined,
  fingerprintConfidence: null,
  fingerprintSampleCount: 0,
  postWinHumility: false,
  postWinMinutesLeft: 0,
  patternTopMatches: [],
  patienceBoost: 0,
  trailWidth: 3,
  patienceLevel: "standard",
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the cached structure context, refreshing in the background if stale.
 *
 * Resumption is exposed as a one-shot pulse: the first call after a fresh
 * compute that produced `resumption=true` sees it; later calls in the same
 * cache window see `resumption=false`. This prevents the safeguard tick from
 * applying the resumption boost on every tick for the full 60 s TTL window.
 */
export function getStructureContext(symbol: string): StructureContext {
  const cached = cache.get(symbol);
  if (!cached) {
    refresh(symbol).catch(() => {});
    return NEUTRAL;
  }
  if (Date.now() - cached.updatedAt > CACHE_TTL_MS) {
    refresh(symbol).catch(() => {});
  }
  if (cached.ctx.resumption && !cached.resumptionServed) {
    cached.resumptionServed = true;
    return cached.ctx;
  }
  if (cached.ctx.resumption) {
    // Already served — return a derived copy with resumption cleared and the
    // boost / trail recomputed without the +1 resumption contribution.
    const adjustedBoost = cached.ctx.patienceBoost - 1;
    const baseTrail = adaptiveTrail(cached.ctx.signalScore);
    return {
      ...cached.ctx,
      resumption: false,
      patienceBoost: adjustedBoost,
      trailWidth: Math.max(2, Math.min(12, baseTrail + adjustedBoost)),
    };
  }
  return cached.ctx;
}

/** Back-compat: just the -8..+8 alignment score. */
export function getSignalScore(symbol: string): number {
  return getStructureContext(symbol).signalScore;
}

/** Prime the cache immediately (call once on arm). */
export function primeSignalScore(symbol: string): void {
  refresh(symbol).catch(() => {});
}

/** Base trail width derived from the alignment score. */
export function adaptiveTrail(score: number): number {
  if (score >= 6) return 8;
  if (score >= 4) return 6;
  if (score >= 2) return 4;
  if (score >= -1) return 3;
  return 2;
}

export function patienceLabel(score: number): string {
  if (score >= 6) return "exceptional";
  if (score >= 4) return "strong";
  if (score >= 2) return "good";
  if (score >= -1) return "standard";
  return "tight";
}

/** Human-readable HTF alignment string for journal entries. */
export function htfAlignmentLabel(ctx: StructureContext): string {
  if (ctx.htfAligned) return ctx.htfDirection > 0 ? "aligned-up" : "aligned-down";
  if (ctx.htfDirection > 0) return "1h-up";
  if (ctx.htfDirection < 0) return "1h-down";
  return "mixed";
}

/**
 * Momentum integrity check — used by the safeguard and trigger watchers to decide
 * whether a retrace / trigger touch is a healthy pullback in a still-live trend
 * or a genuine reversal that deserves a full exit.
 *
 * Three independent signals are evaluated for the position side:
 *   1. Signal score  — should not have flipped strongly against the trade direction
 *   2. HTF alignment — higher timeframes must not be aligned against the position
 *   3. Velocity/pivot — fast price slamming in the opposite direction at a key level
 *      is a reversal warning, not a continuation
 *
 * At least 2/3 must pass for momentum to be considered "intact".
 * Confidence is "high" when all 3 pass, "medium" when 2 pass.
 */
export function checkMomentumIntact(
  symbol: string,
  side: string,
): { intact: boolean; confidence: "high" | "medium" | "low"; reason: string } {
  const ctx = getStructureContext(symbol);
  const isShort = side === "SHORT" || side === "SELL";

  // Signal score: for SHORT, intact means not strongly net-bullish (score ≤ 1).
  // For LONG, not strongly net-bearish (score ≥ −1).
  const signalOk = isShort ? ctx.signalScore <= 1 : ctx.signalScore >= -1;

  // HTF: intact means the higher timeframes have not flipped against the position.
  const htfLabel = htfAlignmentLabel(ctx);
  const htfOk = isShort
    ? htfLabel !== "aligned-up"
    : htfLabel !== "aligned-down";

  // Velocity: fast price at a key level bouncing or stalling in the wrong direction
  // = potential false-break / reversal. Slow arrival = continuation signal.
  const velocityOk = !(
    ctx.velocityState === "fast" &&
    (ctx.pivotState === "bounce" || ctx.pivotState === "stall")
  );

  const passes = [signalOk, htfOk, velocityOk].filter(Boolean).length;
  const intact     = passes >= 2;
  const confidence: "high" | "medium" | "low" =
    passes === 3 ? "high" : passes === 2 ? "medium" : "low";

  const arrow  = isShort ? "↓" : "↑";
  const status = intact ? `${arrow} intact` : "⚠ fading";
  const reason = `signal ${ctx.signalScore > 0 ? "+" : ""}${ctx.signalScore} · ${htfLabel} · ${ctx.velocityState} — ${status}`;

  return { intact, confidence, reason };
}
