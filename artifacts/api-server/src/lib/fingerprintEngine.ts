/**
 * Edge Fingerprint Engine.
 *
 * Builds compact, comparable fingerprints of every trade setup and provides
 * weighted similarity scoring against historical examples.
 *
 * Design intent ("The Unusual Edge" PDF):
 *   Quality memory  — every fingerprint carries a quality label (clean, messy,
 *                     forced, high-conviction, late, transitional), not just win/loss.
 *   Anti-noise gate — similarity must be consistent across several examples;
 *                     a single lucky match doesn't raise confidence.
 *   Post-win humility — after a strong gain, the oracle becomes briefly more
 *                       selective to prevent overconfidence on the next trade.
 *   Mentor examples — stores ideal entries, near-misses, false breakouts, and
 *                     regret samples alongside live trades.
 */

import { db } from "./db";
import { edgeFingerprintsTable, autoEntryConfigTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import { logger } from "./logger";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Compact, serialisable fingerprint of one trade setup context. */
export interface FingerprintVector {
  timeBucket:          "asian" | "london" | "ny" | "overlap";
  btcRegion:           number;   // price floored to nearest 5000 bracket
  wholeNumberRelation: "above" | "below" | "at";
  wholeNumberFraction: number;   // 0.0–1.0 position within the 1000-pt step
  direction:           "LONG" | "SHORT" | "unknown";
  velocityFeel:        "slow" | "normal" | "fast";
  oracleScoreBucket:   "poor" | "moderate" | "good" | "exceptional";
  htfAlignmentStr:     "aligned-up" | "aligned-down" | "mixed";
  haAligned:           boolean;  // HA streak confirming HTF direction?
}

export type QualityLabel =
  | "clean"
  | "messy"
  | "forced"
  | "high-conviction"
  | "late"
  | "transitional";

export interface TopMatch {
  qualityLabel:    QualityLabel;
  outcome:         string;
  roiPct:          number | null;
  similarity:      number;   // 0-100
  isMentorExample: boolean;
  exampleType:     string | null;
}

export interface PatternMatchResult {
  /** 0-100 confidence. null = fewer than MIN_SAMPLES (system is still learning). */
  confidence:          number | null;
  totalSamples:        number;
  topMatches:          TopMatch[];
  postWinHumility:     boolean;
  postWinMinutesLeft:  number;
  dominantQuality:     QualityLabel | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_SAMPLES             = 5;
const POST_WIN_HUMILITY_MS    = 4 * 60 * 60 * 1000; // 4 hours
const STRONG_WIN_ROI_PCT      = 30;

// ── Session time bucket ───────────────────────────────────────────────────────

function getTimeBucket(nowMs = Date.now()): FingerprintVector["timeBucket"] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "12", 10);
  if (h >= 9  && h < 12) return "overlap";  // London/NY overlap
  if (h >= 12 && h < 16) return "ny";
  if (h >= 3  && h < 9)  return "london";
  return "asian";
}

// ── Fingerprint builder ───────────────────────────────────────────────────────

/**
 * Build a compact FingerprintVector from current market conditions.
 *
 * Uses buckets rather than raw values so that small numeric differences don't
 * prevent meaningful pattern matching. The oracle is pattern-matching, not
 * number-crunching.
 */
export function buildLiveFingerprint(opts: {
  velocityState:     "slow" | "normal" | "fast";
  htfAligned:        boolean;
  htfDirection:      -1 | 0 | 1;
  haStreak3m:        number;
  price:             number;
  direction:         "LONG" | "SHORT" | "unknown";
  oracleScoreBucket: "poor" | "moderate" | "good" | "exceptional";
}): FingerprintVector {
  const { price } = opts;
  const step     = price >= 10000 ? 1000 : price >= 1000 ? 100 : 10;
  const fraction = (price % step) / step;

  // Relation: "at" = within 5% of a level; "above" = lower half of range;
  // "below" = upper half approaching the next level from below.
  const wholeNumberRelation: FingerprintVector["wholeNumberRelation"] =
    fraction <= 0.05 || fraction >= 0.95 ? "at"
    : fraction <= 0.5 ? "above"
    : "below";

  const htfAlignmentStr: FingerprintVector["htfAlignmentStr"] =
    opts.htfAligned
      ? opts.htfDirection > 0 ? "aligned-up" : "aligned-down"
      : "mixed";

  const haDir    = opts.haStreak3m > 0 ? 1 : opts.haStreak3m < 0 ? -1 : 0;
  const haAligned = haDir !== 0 && haDir === opts.htfDirection;

  return {
    timeBucket:          getTimeBucket(),
    btcRegion:           Math.floor(price / 5000) * 5000,
    wholeNumberRelation,
    wholeNumberFraction: Math.round(fraction * 100) / 100,
    direction:           opts.direction,
    velocityFeel:        opts.velocityState,
    oracleScoreBucket:   opts.oracleScoreBucket,
    htfAlignmentStr,
    haAligned,
  };
}

// ── Quality auto-labelling ────────────────────────────────────────────────────

/**
 * Classify trade quality from journal data.
 * Labels are ordered by priority — first match wins.
 *
 *   forced        — oracle < 55 or walk-away active (the trade wasn't justified)
 *   messy         — large adverse excursion or excessive giveback
 *   late          — 4+ 6h bars at entry (move was already extended before opening)
 *   high-conviction — safeguard exit, high ROI, minimal giveback, strong oracle
 *   clean         — safeguard exit with decent ROI and controlled giveback
 *   transitional  — everything else
 */
export function autoLabelQuality(fields: {
  edgeScore:     number | null;
  safeguardUsed: boolean;
  exitRoiPct:    number;
  givebackPct:   number;
  maePct:        number | null;
  fourBarStreak: number;
  walkAwayActive: boolean;
}): QualityLabel {
  const oracle  = fields.edgeScore ?? 0;
  const maeAbs  = Math.abs(fields.maePct ?? 0);
  const streakAbs = Math.abs(fields.fourBarStreak);

  if (fields.walkAwayActive || oracle < 55) return "forced";
  if (maeAbs > 20 || fields.givebackPct > 15) return "messy";
  if (streakAbs >= 4) return "late";
  if (oracle >= 80 && fields.safeguardUsed && fields.exitRoiPct > 20 && fields.givebackPct < 5)
    return "high-conviction";
  if (fields.safeguardUsed && fields.exitRoiPct > 10 && fields.givebackPct < 10)
    return "clean";
  return "transitional";
}

// ── Similarity scoring ────────────────────────────────────────────────────────

/** Quality multiplier — cleaner trades lift confidence more; noisy ones drag it. */
function qualityWeight(label: QualityLabel): number {
  switch (label) {
    case "high-conviction": return 1.0;
    case "clean":           return 0.9;
    case "transitional":    return 0.6;
    case "late":            return 0.5;
    case "messy":           return 0.35;
    case "forced":          return 0.2;
  }
}

/**
 * Weighted field-by-field similarity between two fingerprint vectors.
 * Returns 0.0–1.0.
 *
 * Direction mismatch is a hard veto (returns 0 immediately) — a LONG setup
 * is never similar to a SHORT setup regardless of other conditions.
 *
 * Field weights:
 *   timeBucket          20%  session personality (NY vs London vs Asian)
 *   btcRegion           15%  same 5k price territory
 *   wholeNumberRelation 15%  structural context (above/below/at the level)
 *   velocityFeel        15%  pace of market movement
 *   oracleScoreBucket   15%  quality of structural conditions
 *   htfAlignmentStr     10%  higher-timeframe consensus
 *   haAligned           10%  Heikin Ashi trend confirmation
 */
export function computeSimilarity(a: FingerprintVector, b: FingerprintVector): number {
  if (
    a.direction !== "unknown" && b.direction !== "unknown" &&
    a.direction !== b.direction
  ) return 0;

  let score = 0;
  score += a.timeBucket          === b.timeBucket          ? 0.20 : 0;
  score += a.btcRegion           === b.btcRegion           ? 0.15
         : Math.abs(a.btcRegion - b.btcRegion) <= 5000    ? 0.07 : 0;
  score += a.wholeNumberRelation === b.wholeNumberRelation ? 0.15 : 0;
  score += a.velocityFeel        === b.velocityFeel        ? 0.15 : 0;
  score += a.oracleScoreBucket   === b.oracleScoreBucket   ? 0.15 : 0;
  score += a.htfAlignmentStr     === b.htfAlignmentStr     ? 0.10 : 0;
  score += a.haAligned           === b.haAligned           ? 0.10 : 0;
  return Math.min(1, score);
}

// ── Pattern matching ──────────────────────────────────────────────────────────

/**
 * Compare a live setup fingerprint against all stored historical fingerprints.
 *
 * Confidence = quality-weighted average similarity of top-5 matches.
 * Quality weights ensure noisy/forced trades drag confidence down while
 * clean/high-conviction examples lift it.
 */
export async function queryPatternMatch(
  _symbol: string,
  live: FingerprintVector,
): Promise<PatternMatchResult> {
  const rows = await db
    .select()
    .from(edgeFingerprintsTable)
    .orderBy(desc(edgeFingerprintsTable.createdAt))
    .limit(200);

  const [cfg] = await db.select().from(autoEntryConfigTable).limit(1);
  const humilityUntil    = cfg?.postWinHumilityUntil
    ? (cfg.postWinHumilityUntil instanceof Date
        ? cfg.postWinHumilityUntil
        : new Date(String(cfg.postWinHumilityUntil))
      ).getTime()
    : 0;
  const postWinHumility    = Date.now() < humilityUntil;
  const postWinMinutesLeft = postWinHumility
    ? Math.ceil((humilityUntil - Date.now()) / 60_000)
    : 0;

  const totalSamples = rows.length;
  if (totalSamples < MIN_SAMPLES) {
    return { confidence: null, totalSamples, topMatches: [], postWinHumility, postWinMinutesLeft, dominantQuality: null };
  }

  const scored = rows
    .map((row) => {
      const fp  = row.fingerprint as FingerprintVector;
      const sim = computeSimilarity(live, fp);
      const ql  = (row.qualityLabel ?? "transitional") as QualityLabel;
      return {
        sim,
        ql,
        qw:  qualityWeight(ql),
        outcome:         row.outcome,
        roiPct:          row.roiPct != null ? parseFloat(String(row.roiPct)) : null,
        isMentorExample: row.isMentorExample,
        exampleType:     row.exampleType,
      };
    })
    .sort((a, b) => b.sim - a.sim);

  const top5    = scored.slice(0, 5);
  const totalW  = top5.reduce((s, x) => s + x.qw, 0);
  const wSim    = totalW > 0 ? top5.reduce((s, x) => s + x.qw * x.sim, 0) / totalW : 0;

  // Non-linear stretch: 0.6 sim → ~66 confidence, 0.8 → ~88, 1.0 → 100.
  const confidence = Math.round(Math.min(100, wSim * 110));

  const top3     = scored.slice(0, 3);
  const qCounts: Record<string, number> = {};
  top3.forEach((x) => { qCounts[x.ql] = (qCounts[x.ql] ?? 0) + 1; });
  const dominantQuality = (
    Object.entries(qCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  ) as QualityLabel | null;

  return {
    confidence,
    totalSamples,
    topMatches: top5.slice(0, 3).map((x) => ({
      qualityLabel:    x.ql,
      outcome:         x.outcome,
      roiPct:          x.roiPct,
      similarity:      Math.round(x.sim * 100),
      isMentorExample: x.isMentorExample,
      exampleType:     x.exampleType,
    })),
    postWinHumility,
    postWinMinutesLeft,
    dominantQuality,
  };
}

// ── Auto-promote from journal ─────────────────────────────────────────────────

/**
 * Called after every journal entry is written. Builds a fingerprint from the
 * closed trade and stores it. Also activates post-win humility after a strong
 * exit (≥30% ROI).
 *
 * Best-effort — never throws. Fingerprint failure must not disrupt trading.
 */
export async function promoteFingerprintFromJournal(fields: {
  id:           number;
  symbol:       string;
  side:         string;
  edgeScore:    number | null;
  safeguardUsed: boolean;
  exitRoiPct:   number;
  givebackPct:  number;
  maePct:       number | null;
  fourBarStreak: number;
  walkAwayActive: boolean;
  velocityState: string | null;
  htfAlignment:  string | null;
  haStreak3m:    number;
  price:         number;
}): Promise<void> {
  try {
    const qualityLabel = autoLabelQuality({
      edgeScore:      fields.edgeScore,
      safeguardUsed:  fields.safeguardUsed,
      exitRoiPct:     fields.exitRoiPct,
      givebackPct:    fields.givebackPct,
      maePct:         fields.maePct,
      fourBarStreak:  fields.fourBarStreak,
      walkAwayActive: fields.walkAwayActive,
    });

    const direction: FingerprintVector["direction"] =
      fields.side === "LONG"  ? "LONG"
      : fields.side === "SHORT" ? "SHORT"
      : "unknown";

    const oracle = fields.edgeScore ?? 0;
    const oracleScoreBucket: FingerprintVector["oracleScoreBucket"] =
      oracle >= 80 ? "exceptional"
      : oracle >= 65 ? "good"
      : oracle >= 45 ? "moderate"
      : "poor";

    const htfAlignmentStr: FingerprintVector["htfAlignmentStr"] =
      fields.htfAlignment?.includes("aligned-up")   ? "aligned-up"
      : fields.htfAlignment?.includes("aligned-down") ? "aligned-down"
      : "mixed";

    const velocity = (fields.velocityState ?? "normal") as FingerprintVector["velocityFeel"];

    const step     = fields.price >= 10000 ? 1000 : fields.price >= 1000 ? 100 : 10;
    const fraction = (fields.price % step) / step;
    const wholeNumberRelation: FingerprintVector["wholeNumberRelation"] =
      fraction <= 0.05 || fraction >= 0.95 ? "at"
      : fraction <= 0.5 ? "above"
      : "below";

    const haDir    = fields.haStreak3m > 0 ? 1 : fields.haStreak3m < 0 ? -1 : 0;
    const haAligned =
      haDir !== 0 && (
        (haDir > 0 && htfAlignmentStr === "aligned-up")  ||
        (haDir < 0 && htfAlignmentStr === "aligned-down")
      );

    const fp: FingerprintVector = {
      timeBucket: getTimeBucket(),
      btcRegion:  Math.floor(fields.price / 5000) * 5000,
      wholeNumberRelation,
      wholeNumberFraction: Math.round(fraction * 100) / 100,
      direction,
      velocityFeel:        velocity,
      oracleScoreBucket,
      htfAlignmentStr,
      haAligned,
    };

    const outcome =
      fields.exitRoiPct >  0.5 ? "win"
      : fields.exitRoiPct < -0.5 ? "loss"
      : "breakeven";

    await db.insert(edgeFingerprintsTable).values({
      journalId:       fields.id,
      symbol:          fields.symbol,
      source:          "auto",
      fingerprint:     fp,
      qualityLabel,
      outcome,
      roiPct:          String(fields.exitRoiPct),
      isMentorExample: false,
    });

    // Post-win humility: activate 4-hour caution window after a strong exit.
    if (fields.exitRoiPct >= STRONG_WIN_ROI_PCT) {
      const humilityUntil = new Date(Date.now() + POST_WIN_HUMILITY_MS);
      const [cfg] = await db.select().from(autoEntryConfigTable).limit(1);
      if (cfg) {
        await db
          .update(autoEntryConfigTable)
          .set({ postWinHumilityUntil: humilityUntil, updatedAt: new Date() })
          .where(eq(autoEntryConfigTable.id, cfg.id));
      }
      logger.info(
        { roi: fields.exitRoiPct, until: humilityUntil },
        "Post-win humility activated — oracle more selective for 4h after strong gain",
      );
    }
  } catch (err) {
    logger.warn({ err }, "Edge fingerprint promotion failed (non-fatal)");
  }
}
