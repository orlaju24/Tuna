/**
 * Behavioral Governor — watches the trading system's own quality over time
 * and automatically tightens requirements when it detects aggression, sloppiness,
 * or loss-chasing patterns.
 *
 * Score is 0–100 (100 = perfectly disciplined). Five components:
 *   1. Session Discipline  (25) — how many trades in the last 8 h
 *   2. Entry Quality       (25) — mean oracle score at entry, recent trades
 *   3. Post-Win Discipline (20) — was the next entry too quick after a win?
 *   4. Loss Recovery       (15) — current loss streak depth
 *   5. Near-Miss Rate      (15) — how often did entries land in adverse territory
 *
 * Grades and oracle floor adjustments:
 *   CLEAN   80-100  → no penalty
 *   MONITOR 60-79   → show warning only
 *   CAUTION 40-59   → oracle floor +5
 *   WARNING 20-39   → oracle floor +10
 *   FREEZE  <20     → oracle floor +15 + auto-entry hard-blocked
 */

import { db } from "./db";
import { tradeJournalTable } from "@workspace/db/schema";
import { desc, gte } from "drizzle-orm";
import { logger } from "./logger";

export type GovernorGrade = "clean" | "monitor" | "caution" | "warning" | "freeze";

export interface GovernorPenalty {
  label: string;
  points: number;
  detail: string;
}

export interface GovernorComponent {
  score: number;
  max: number;
  label: string;
}

export interface GovernorState {
  score: number;
  grade: GovernorGrade;
  penalties: GovernorPenalty[];
  adjustments: {
    oracleFloorDelta: number;
    autoBlocked: boolean;
    label: string;
  };
  components: {
    sessionDiscipline: GovernorComponent;
    entryQuality: GovernorComponent;
    postWinDiscipline: GovernorComponent;
    lossRecovery: GovernorComponent;
    nearMissRate: GovernorComponent;
  };
  computedAt: string;
  tradesAnalyzed: number;
}

// ── Cache ────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60_000; // recompute once per minute
let cachedState: GovernorState | null = null;
let cachedAt = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────
function gradeFromScore(score: number): GovernorGrade {
  if (score >= 80) return "clean";
  if (score >= 60) return "monitor";
  if (score >= 40) return "caution";
  if (score >= 20) return "warning";
  return "freeze";
}

function adjustmentsForGrade(grade: GovernorGrade): GovernorState["adjustments"] {
  switch (grade) {
    case "clean":   return { oracleFloorDelta: 0,  autoBlocked: false, label: "No adjustments — discipline is good." };
    case "monitor": return { oracleFloorDelta: 0,  autoBlocked: false, label: "Watching — no gate changes yet." };
    case "caution": return { oracleFloorDelta: 5,  autoBlocked: false, label: "Oracle floor raised +5 pts — tighten up before the next entry." };
    case "warning": return { oracleFloorDelta: 10, autoBlocked: false, label: "Oracle floor raised +10 pts — system is being too aggressive." };
    case "freeze":  return { oracleFloorDelta: 15, autoBlocked: true,  label: "Auto-entry hard-blocked — behavioral score too low. Review and reset." };
  }
}

// ── Main computation ─────────────────────────────────────────────────────────
async function computeGovernorState(): Promise<GovernorState> {
  const penalties: GovernorPenalty[] = [];
  const now = new Date();

  // Pull last 10 completed trades for quality analysis
  const recent10 = await db
    .select()
    .from(tradeJournalTable)
    .orderBy(desc(tradeJournalTable.createdAt))
    .limit(10);

  // Pull trades in the last 8h for session discipline
  const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60_000);
  const session8h = recent10.filter(
    (t) => t.createdAt && new Date(t.createdAt) >= eightHoursAgo,
  );

  const tradesAnalyzed = recent10.length;

  // ── Component 1: Session Discipline (25 pts) ─────────────────────────────
  const sessionCount = session8h.length;
  let sessionScore = 25;
  let sessionLabel = `${sessionCount} trades this session — disciplined`;
  if (sessionCount >= 5) {
    sessionScore = 0;
    sessionLabel = `${sessionCount} trades in 8 h — churning`;
    penalties.push({ label: "Over-trading", points: 25, detail: `${sessionCount} trades in the last 8 h (max 4).` });
  } else if (sessionCount === 4) {
    sessionScore = 8;
    sessionLabel = `${sessionCount} trades this session — overactive`;
    penalties.push({ label: "Overactive session", points: 17, detail: "4 trades in 8 h — oracle prefers ≤3." });
  } else if (sessionCount === 3) {
    sessionScore = 16;
    sessionLabel = `${sessionCount} trades this session — busy`;
    penalties.push({ label: "Busy session", points: 9, detail: "3 trades in 8 h — approaching limit." });
  }
  const sessionDiscipline: GovernorComponent = { score: sessionScore, max: 25, label: sessionLabel };

  // ── Component 2: Entry Quality (25 pts) ──────────────────────────────────
  const last5WithScore = recent10.filter((t) => t.edgeScore != null).slice(0, 5);
  let entryScore = 20; // neutral if no data
  let entryLabel = "No entries yet";
  if (last5WithScore.length > 0) {
    const avgOracle = last5WithScore.reduce((s, t) => s + (t.edgeScore ?? 0), 0) / last5WithScore.length;
    if (avgOracle >= 65) {
      entryScore = 25;
      entryLabel = `Avg oracle ${avgOracle.toFixed(0)} at entry — clean setups`;
    } else if (avgOracle >= 55) {
      entryScore = 18;
      entryLabel = `Avg oracle ${avgOracle.toFixed(0)} at entry — acceptable`;
    } else if (avgOracle >= 45) {
      entryScore = 10;
      entryLabel = `Avg oracle ${avgOracle.toFixed(0)} at entry — below ideal`;
      penalties.push({ label: "Low entry quality", points: 15, detail: `Avg oracle score at entry is ${avgOracle.toFixed(0)} (target ≥55).` });
    } else {
      entryScore = 3;
      entryLabel = `Avg oracle ${avgOracle.toFixed(0)} at entry — forced entries`;
      penalties.push({ label: "Poor entry quality", points: 22, detail: `Avg oracle score at entry is ${avgOracle.toFixed(0)} (target ≥55). Entries are below the patience threshold.` });
    }
  }
  const entryQuality: GovernorComponent = { score: entryScore, max: 25, label: entryLabel };

  // ── Component 3: Post-Win Discipline (20 pts) ────────────────────────────
  // After a winning trade, was the next entry too quick (< 30 min)?
  let postWinScore = 20;
  let postWinLabel = "No consecutive win/entry pair";
  if (recent10.length >= 2) {
    for (let i = 0; i < recent10.length - 1; i++) {
      const curr = recent10[i]!;
      const prev = recent10[i + 1]!;
      const prevRoi = prev.exitRoiPct != null ? parseFloat(String(prev.exitRoiPct)) : null;
      if (prevRoi != null && prevRoi > 0) {
        // prev was a win — how quickly did the next entry (curr) follow?
        const prevExit = prev.exitAt ? new Date(prev.exitAt).getTime() : null;
        const currArm  = curr.armedAt ? new Date(curr.armedAt).getTime() : null;
        if (prevExit != null && currArm != null) {
          const gapMin = (currArm - prevExit) / 60_000;
          if (gapMin < 30) {
            postWinScore = 0;
            postWinLabel = `Re-entered ${gapMin.toFixed(0)} min after a win — aggression spike`;
            penalties.push({
              label: "Post-win aggression",
              points: 20,
              detail: `Entered only ${gapMin.toFixed(0)} min after a winning trade (ROI +${prevRoi.toFixed(1)}%). Oracle needs ≥30 min of cooling.`,
            });
            break;
          } else {
            postWinLabel = `${gapMin.toFixed(0)} min gap after last win — disciplined`;
            break;
          }
        }
      }
    }
  }
  const postWinDiscipline: GovernorComponent = { score: postWinScore, max: 20, label: postWinLabel };

  // ── Component 4: Loss Recovery (15 pts) ──────────────────────────────────
  let lossStreak = 0;
  for (const t of recent10) {
    const roi = t.exitRoiPct != null ? parseFloat(String(t.exitRoiPct)) : null;
    if (roi != null && roi < 0) {
      lossStreak++;
    } else {
      break; // streak broken
    }
  }
  let lossScore = 15;
  let lossLabel = "No loss streak";
  if (lossStreak >= 3) {
    lossScore = 0;
    lossLabel = `${lossStreak} consecutive losses — stop and review`;
    penalties.push({ label: "Loss streak", points: 15, detail: `${lossStreak} losing trades in a row. Conditions may have changed.` });
  } else if (lossStreak === 2) {
    lossScore = 6;
    lossLabel = "2 losses in a row — caution";
    penalties.push({ label: "Double loss", points: 9, detail: "Two consecutive losing trades. The edge may be compressing." });
  } else if (lossStreak === 1) {
    lossScore = 11;
    lossLabel = "1 recent loss — watching";
  }
  const lossRecovery: GovernorComponent = { score: lossScore, max: 15, label: lossLabel };

  // ── Component 5: Near-Miss Rate (15 pts) ─────────────────────────────────
  const last5 = recent10.slice(0, 5);
  const nearMissCount = last5.filter((t) => t.nearMiss === true).length;
  let nearMissScore = 15;
  let nearMissLabel = "No near-misses";
  if (nearMissCount >= 3) {
    nearMissScore = 0;
    nearMissLabel = `${nearMissCount}/5 entries flagged near-miss`;
    penalties.push({ label: "Repeated near-misses", points: 15, detail: `${nearMissCount} of last 5 entries entered too close to the stop zone.` });
  } else if (nearMissCount === 2) {
    nearMissScore = 6;
    nearMissLabel = `${nearMissCount}/5 entries near-miss`;
    penalties.push({ label: "Near-miss pattern", points: 9, detail: `${nearMissCount} of last 5 entries were near-misses — entries are too aggressive.` });
  } else if (nearMissCount === 1) {
    nearMissScore = 10;
    nearMissLabel = "1 recent near-miss — tolerable";
  }
  const nearMissRate: GovernorComponent = { score: nearMissScore, max: 15, label: nearMissLabel };

  // ── Final score ──────────────────────────────────────────────────────────
  const score = Math.max(0, Math.min(100,
    sessionDiscipline.score +
    entryQuality.score +
    postWinDiscipline.score +
    lossRecovery.score +
    nearMissRate.score,
  ));

  const grade = gradeFromScore(score);
  const adjustments = adjustmentsForGrade(grade);

  logger.debug({ score, grade, tradesAnalyzed }, "Behavioral governor computed");

  return {
    score,
    grade,
    penalties,
    adjustments,
    components: {
      sessionDiscipline,
      entryQuality,
      postWinDiscipline,
      lossRecovery,
      nearMissRate,
    },
    computedAt: now.toISOString(),
    tradesAnalyzed,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getGovernorState(): Promise<GovernorState> {
  if (cachedState && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedState;
  }
  try {
    cachedState = await computeGovernorState();
    cachedAt = Date.now();
    return cachedState;
  } catch (err) {
    logger.error({ err }, "Behavioral governor computation failed — returning neutral state");
    return {
      score: 100,
      grade: "clean",
      penalties: [],
      adjustments: { oracleFloorDelta: 0, autoBlocked: false, label: "Governor offline — no adjustments applied." },
      components: {
        sessionDiscipline:  { score: 25, max: 25, label: "Unknown" },
        entryQuality:       { score: 25, max: 25, label: "Unknown" },
        postWinDiscipline:  { score: 20, max: 20, label: "Unknown" },
        lossRecovery:       { score: 15, max: 15, label: "Unknown" },
        nearMissRate:       { score: 15, max: 15, label: "Unknown" },
      },
      computedAt: new Date().toISOString(),
      tradesAnalyzed: 0,
    };
  }
}

/** Synchronous fast-path used inside the auto-entry hot loop. */
export function getCachedGovernorAdjustments(): {
  oracleFloorDelta: number;
  autoBlocked: boolean;
} {
  if (!cachedState) return { oracleFloorDelta: 0, autoBlocked: false };
  return {
    oracleFloorDelta: cachedState.adjustments.oracleFloorDelta,
    autoBlocked:      cachedState.adjustments.autoBlocked,
  };
}

/** Force a cache flush (e.g. after a manual reset request). */
export function invalidateGovernorCache(): void {
  cachedState = null;
  cachedAt = 0;
}
