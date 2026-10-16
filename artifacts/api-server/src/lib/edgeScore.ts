/**
 * Oracle Entry Score engine.
 *
 * Combines market-structure context with wallet exposure to produce a
 * 0-100 composite setup quality score — the Oracle Entry Score.
 *
 * Design philosophy (Oracle Method): the score rewards PATIENCE over speed.
 * A setup that waited for price to return to a meaningful zone beats a
 * fast chase. The scoring reflects this:
 *
 *   1. Structure alignment   0-25  (HTF consensus + 4-bar streak bonus)
 *   2. Patience quality      0-25  (LTF timing + return-to-zone behavior;
 *                                   rewards waiting, penalises chasing)
 *   3. Key level behavior    0-20  (whole-number play type at a pivot)
 *   4. Wallet readiness      0-15  (position margin as % of wallet equity)
 *   5. Time suitability      0-15  (velocity quality relative to structure)
 *
 * Score interpretation:
 *   80-100  exceptional — safeguard allows +1.5 trail room
 *   65-79   good        — safeguard allows +0.75 trail room
 *   45-64   moderate    — standard safeguard behavior
 *   25-44   weak        — safeguard tightens -0.75
 *   0-24    poor        — safeguard aggressive, -2.0
 *
 * Oracle state (layered on top of score):
 *   ready      — structure confirmed, price at the right level, act now
 *   wait_mode  — interesting setup but price hasn't reached the ideal zone
 *   late_setup — the move has already happened; don't chase
 *   no_signal  — HTF has no consensus direction
 *
 * Nothing here reaches Bitunix — all logic is app-side.
 */

import type { StructureContext, WholeNumberPlayType } from "./signalScore";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EdgeScoreComponent {
  score: number;
  max: number;
  label: string;
}

export type EdgeGrade = "exceptional" | "good" | "moderate" | "weak" | "poor";

/** The oracle's current read on whether the setup is actionable. */
export type OracleState = "ready" | "wait_mode" | "late_setup" | "no_signal";

export interface EdgeContext {
  edgeScore: number;
  grade: EdgeGrade;
  reason: string;
  /** Current oracle state — the primary display concept for the UI. */
  oracleState: OracleState;
  /** Short human-readable oracle state label. */
  oracleStateLabel: string;
  /**
   * Specific, plain-English explanation of WHY the oracle is in its current state.
   * Dynamic — derived from the actual component scores and market context.
   * Not a static template: it tells the user exactly what the oracle is seeing.
   */
  oracleNarration: string;
  safeguardDelta: number;   // pp applied to trailWidth via applyEdgeToContext in safeguardWatcher
  safeguardNote: string;
  components: {
    structureAlignment: EdgeScoreComponent;
    patienceQuality:    EdgeScoreComponent;
    keyLevelBehavior:   EdgeScoreComponent & { playType: WholeNumberPlayType };
    walletReadiness:    EdgeScoreComponent & { exposurePct: number };
    timeSuitability:    EdgeScoreComponent;
  };
}

export interface WalletSnapshot {
  available: number;       // free USDT margin
  positionMargin: number;  // margin locked in open positions
}

// ── Computation ──────────────────────────────────────────────────────────────

export function computeEdgeScore(
  ctx: StructureContext,
  wallet: WalletSnapshot,
): EdgeContext {

  // ── 1. Structure alignment (0-25) ──────────────────────────────────────────
  // Base: map signalScore -8..+8 to 0-20. Bonus: +5 for 4-bar rule.
  // HA cleanliness bonus: a clean 6h HA streak is the strongest directional
  // signal. "No-tail" candles (noDissent) imply pure conviction with zero
  // counter-pressure — the highest-quality directional clue per the spec.
  // Symmetric: equally rewards clean bearish 6h (short setups) and clean
  // bullish 6h (long setups). Removes any hidden long-only bias.
  const alignBase = Math.round(((ctx.signalScore + 8) / 16) * 20);
  const alignFourBar = ctx.fourBarRule ? 5 : 0;
  // +3 when 6h HA is clean (≥2 bars, body ≥ 60%) and aligned with htfDirection.
  // Extra +1 when no-tail candles (noDissent): the cleanest possible HA edge.
  const ha6hAligned = ctx.ha6hBias !== 0 && ctx.ha6hBias === ctx.htfDirection;
  const ha6hBonus = ctx.ha6hClean && ha6hAligned
    ? (ctx.haNoDissent6h ? 4 : 3)   // no-tail = +4; body-clean = +3
    : 0;
  const comp1 = Math.min(25, alignBase + alignFourBar + ha6hBonus);

  // ── 2. Patience quality (0-25) ─────────────────────────────────────────────
  // The Oracle Method's most important concept: reward setups that waited
  // for price to come to the right zone rather than chasing the breakout.
  //
  // Base timing layer (mirrors old "entry timing" logic):
  let comp2Base: number;
  if (ctx.fifteenMinConfirms) comp2Base = 18;   // all TFs aligned = patient, confirmed
  else if (ctx.threeMinLeads) comp2Base = 12;   // leading (good timing, not yet full confirm)
  else                        comp2Base = 5;    // early / unclear

  // Patience adjustments — these are the key differentiators:
  if (ctx.resumption) {
    // Best patience signal: price pulled back against HTF then resumed.
    // Reward scales with the QUALITY of the return move — not just that it happened.
    //   strong   = HA confirms + fast velocity → richest patience reward (+7)
    //   moderate = partial confirmation         → standard reward (+5)
    //   weak     = price flipped but uncertain  → minimal credit (+2)
    if      (ctx.resumptionStrength === "strong")   comp2Base = Math.min(25, comp2Base + 7);
    else if (ctx.resumptionStrength === "moderate") comp2Base = Math.min(25, comp2Base + 5);
    else                                            comp2Base = Math.min(25, comp2Base + 2);
  }
  if (ctx.nearPivot && ctx.velocityState === "slow") {
    // Slow, patient approach to a whole-number level — price is seeking
    // the zone, not running past it. Classic Oracle entry setup.
    comp2Base = Math.min(25, comp2Base + 4);
  }
  if (ctx.counterMove) {
    // Penalty scales with retrace depth — a shallow breath is different from
    // a deep giveback that may signal a genuine character change.
    //   shallow (<38%) = just breathing — smaller penalty
    //   normal  (38-62%) = standard corrective pause
    //   deep    (>62%) = potentially changing character — full penalty
    if      (ctx.retraceQuality === "shallow") comp2Base = Math.max(0, comp2Base - 4);
    else if (ctx.retraceQuality === "normal")  comp2Base = Math.max(0, comp2Base - 6);
    else                                       comp2Base = Math.max(0, comp2Base - 8);
  }
  if (ctx.velocityState === "fast" && ctx.htfDirection === 0) {
    // Fast move with no directional consensus = FOMO signal. Penalise.
    comp2Base = Math.max(0, comp2Base - 4);
  }

  // ── Wave pattern strength bonus ────────────────────────────────────────────
  // Core insight from the Oracle Method: "The strongest entry comes from the
  // RESUMPTION after the pullback, not from the initial move itself. Favor
  // entries where the second wave is stronger than the first — it means the
  // market has genuinely absorbed the pullback and is restarting with force."
  //
  // wave2VsWave1Ratio = wave2BodyAvg / wave1BodyAvg:
  //   ≥ 1.3 — wave 2 clearly stronger → market restarting with real momentum (+5)
  //   ≥ 1.1 — wave 2 marginally stronger → good resumption quality (+3)
  //   ≥ 0.9 — similar strength → move is real, continuation holding (+1)
  //   < 0.8 in resumption → weaker follow-through → early caution (−2)
  //
  // Only applied when there is valid wave comparison data (wave2VsWave1Ratio > 0)
  // and the phase is a resumption (not extended, not pullback, not first wave).
  const isResumptionPhase =
    ctx.wavePhase === "resumption_forming" ||
    ctx.wavePhase === "resumption_confirmed";
  if (ctx.wave2VsWave1Ratio > 0 && isResumptionPhase) {
    if      (ctx.wave2VsWave1Ratio >= 1.3) comp2Base = Math.min(25, comp2Base + 5);
    else if (ctx.wave2VsWave1Ratio >= 1.1) comp2Base = Math.min(25, comp2Base + 3);
    else if (ctx.wave2VsWave1Ratio >= 0.9) comp2Base = Math.min(25, comp2Base + 1);
    else if (ctx.wave2VsWave1Ratio  < 0.8) comp2Base = Math.max(0,  comp2Base - 2);
  }
  // Extended wave penalty: when the move is already 5+ bars long, the entry is
  // late — the obvious candle has already expanded. Reduce patience score.
  if (ctx.wavePhase === "extended") {
    comp2Base = Math.max(0, comp2Base - 4);
  }

  // ── HA cross-timeframe wave quality adjustments ────────────────────────────
  // These two checks apply the 6h/1h HA directional logic to the wave cycle
  // itself — not just to the general bias layer above.
  //
  // 1. Resumption against the 6h HA bias:
  //    A resumption is in the HTF consensus direction but the 6h HA is pointing
  //    the OTHER way (or is mixed). The market structure signal and the HA master
  //    bias disagree — this resumption may be a counter-trend bounce rather than
  //    a genuine continuation. Reduce confidence.
  //    Only penalise when ha6hBias has a definite opinion (≠ 0) — if 6h HA is
  //    simply undecided we don't penalise; we just don't get the HA bonus.
  if (isResumptionPhase && !ctx.waveAlignedWithHa6h && ctx.ha6hBias !== 0) {
    comp2Base = Math.max(0, comp2Base - 3);
  }

  // 2. Double exhaustion flag:
  //    Extended on 3m (5+ HA bars) AND 4+ clean 1h HA bars. Two timeframes are
  //    simultaneously overextended — the probability of an imminent pullback or
  //    reversal is significantly elevated. This is the oracle's compound
  //    "do not enter" signal, stronger than either flag alone.
  if (ctx.waveExhaustionFlag) {
    comp2Base = Math.max(0, comp2Base - 3);
  }

  // ── 3m continuation quality — regular candles ─────────────────────────────
  // Oracle Method: "usually the 2nd or 3rd continuation on the 3-minute helps
  // for entries." The 1st continuation is unproven — wait for follow-through.
  // Streak 4+ means the move is getting extended — approaching late territory.
  const streak3mDir = ctx.threeMinStreak > 0 ? 1 : ctx.threeMinStreak < 0 ? -1 : 0;
  const streak3mAbs = Math.abs(ctx.threeMinStreak);
  if (ctx.htfDirection !== 0 && streak3mDir === ctx.htfDirection && streak3mAbs >= 1) {
    if (streak3mAbs === 2 || streak3mAbs === 3) {
      comp2Base = Math.min(25, comp2Base + 4); // Oracle sweet spot: 2nd or 3rd continuation
    } else if (streak3mAbs >= 4) {
      comp2Base = Math.max(0, comp2Base - 3);  // Getting extended — don't chase
    }
    // streak3mAbs === 1: first continuation — wait to see follow-through, no adjustment
  }

  // ── Heikin Ashi 3m trend confirmation layer (stacks on top of regular streak) ─
  // HA filters out price noise: consecutive same-color HA candles with big
  // bodies = the trend has real momentum behind it. No opposing wicks (noDissent)
  // means bears/bulls are fully in control with zero counter-pressure.
  //
  // "The bigger the candle, the bigger the move" — Oracle Method HA principle.
  //
  // Scoring (additive, capped at 25):
  //   HA 2-3 candle run aligned with HTF = +3  (confirmed HA momentum)
  //   + no opposing wicks on that run    = +2  (clean, pure trend — very strong signal)
  //   HA 4+ candles aligned              = -2  (extended — likely late)
  //   HA running AGAINST HTF (2+)        = -3  (HA confirms counter-move is real)
  const haDir = ctx.haStreak3m > 0 ? 1 : ctx.haStreak3m < 0 ? -1 : 0;
  const haAbs = Math.abs(ctx.haStreak3m);
  if (ctx.htfDirection !== 0 && haDir === ctx.htfDirection && haAbs >= 2) {
    if (haAbs <= 3) {
      comp2Base = Math.min(25, comp2Base + 3);
      if (ctx.haNoDissent3m) {
        comp2Base = Math.min(25, comp2Base + 2); // no opposing wicks = the cleanest possible HA trend
      }
    } else {
      comp2Base = Math.max(0, comp2Base - 2); // HA also extended — double confirmation to wait
    }
  } else if (ctx.htfDirection !== 0 && haDir !== 0 && haDir !== ctx.htfDirection && haAbs >= 2) {
    // HA is running AGAINST the HTF — stronger counter-move signal than regular candles alone.
    comp2Base = Math.max(0, comp2Base - 3);
  }

  // ── 1h HA confirmation bonus ───────────────────────────────────────────────
  // When the last 2 closed 1h HA bars are clean (body ≥ 60%) AND aligned with
  // the 6h bias, the mid-level structure confirms the directional move.
  // This is the spec's "mid-level confirmation layer" — clean and aligned.
  // No-tail 1h (haNoDissent1h) is the strongest form of this confirmation.
  if (ctx.ha1hConfirms6h) {
    const bonus = ctx.haNoDissent1h ? 4 : 3; // no-tail 1h = +4; body-clean 1h = +3
    comp2Base = Math.min(25, comp2Base + bonus);
  }

  // ── 1h exhaustion warning penalty ─────────────────────────────────────────
  // 4+ consecutive clean 1h HA bars = possible 6h trend exhaustion forming.
  // The spec: "reduce confidence in late continuation entries and force closer
  // scrutiny of the next resumption." This is a warning — not a reversal — so
  // the penalty is moderate. The oracle narration will call it out explicitly.
  if (ctx.ha1hExhaustionWarning) {
    comp2Base = Math.max(0, comp2Base - 4);
  }

  const comp2 = Math.min(25, Math.max(0, comp2Base));

  // ── 3. Key level behavior (0-20) ───────────────────────────────────────────
  // Oracle Method directional rule applied here:
  //
  //   LONG below a whole-number level  = Oracle-aligned  (level is the target above)
  //   SHORT above a whole-number level = Oracle-aligned  (level is the target below)
  //   LONG above / SHORT below         = against Oracle preference
  //
  // This means over_key and under_key are scored relative to htfDirection:
  //   over_key  + SHORT direction (htfDir -1) → aligned   → 15 pts
  //   under_key + LONG  direction (htfDir +1) → aligned   → 15 pts
  //   over_key  + LONG  direction (htfDir +1) → unaligned →  7 pts
  //   under_key + SHORT direction (htfDir -1) → unaligned →  7 pts
  //   either    + no consensus   (htfDir  0)  → neutral   → 10 pts
  //
  // Strong play types (rejection / transition) score 20 regardless of direction
  // because they describe a confirmed structural event at the level.
  const playType = ctx.wholeNumberPlayType;
  const htfDir3  = ctx.htfDirection;
  let comp3: number;
  switch (playType) {
    case "clean_rejection":
    case "over_under_transition":
    case "under_over_transition": comp3 = 20; break;
    case "clean_retest":          comp3 = 15; break;
    case "over_key":
      // Price is above the level — Oracle prefers SHORT here
      comp3 = htfDir3 === -1 ? 15 : htfDir3 === 1 ? 7 : 10;
      break;
    case "under_key":
      // Price is below the level — Oracle prefers LONG here
      comp3 = htfDir3 === 1 ? 15 : htfDir3 === -1 ? 7 : 10;
      break;
    default: comp3 = 0;
  }

  // ── Zone memory modifier (applied after play-type base) ────────────────────
  // The oracle now knows whether price has accepted or rejected this level
  // in the last 4 hours. Use that memory to sharpen the score:
  //   'accepting'  — level has been proven (clean breaks) → +2 confidence
  //   'rejecting'  — level is a reliable wall; if we're trading that wall → +2
  //   'contested'  — mixed record, messy zone → −2 (wait for resolution)
  //   'untested'   — no history → neutral
  if (ctx.nearPivot) {
    if (ctx.levelAcceptanceState === "accepting") {
      comp3 = Math.min(20, comp3 + 2);
    } else if (ctx.levelAcceptanceState === "rejecting") {
      // Bonus when this trade is aligned WITH the rejection (trading the bounce
      // or the confirmed break back through the level that rejected before).
      const rejAligned =
        playType === "clean_rejection" ||
        playType === "over_under_transition" ||
        playType === "under_over_transition";
      if (rejAligned) comp3 = Math.min(20, comp3 + 2);
    } else if (ctx.levelAcceptanceState === "contested") {
      comp3 = Math.max(0, comp3 - 2);
    }
  }

  // ── 4. Wallet readiness (0-15) ─────────────────────────────────────────────
  // Renamed from "wallet health". Scaled to 15 pts (was 20) — wallet state
  // matters but patience / structure carry more weight in this system.
  const totalWallet = wallet.available + wallet.positionMargin;
  const exposurePct = totalWallet > 0
    ? (wallet.positionMargin / totalWallet) * 100
    : 0;
  let comp4: number;
  if (wallet.positionMargin === 0)  comp4 = 11; // no position yet, neutral slot available
  else if (exposurePct < 15)        comp4 = 15; // very healthy exposure
  else if (exposurePct < 25)        comp4 = 12;
  else if (exposurePct < 40)        comp4 =  8;
  else if (exposurePct < 60)        comp4 =  4;
  else                              comp4 =  0; // overextended

  // ── 5. Time suitability (0-15) ─────────────────────────────────────────────
  // Oracle Method velocity rule (from the Velocity image):
  //   "HIGH VELOCITY — if price slams back over the whole number by several
  //    hundred dollars, it could be ready to run further. If so, wait."
  //   "LOW VELOCITY — if price barely climbs over or touches the whole number
  //    with low velocity, it could break back down again soon."
  //
  // Translation: SLOW patient arrival at the key level = oracle ideal (15 pts).
  // FAST slam at the level = potential false break = REDUCE score (5 pts).
  // This fixes the previous error where fast+nearPivot scored maximum.
  const htfDir = ctx.htfDirection;
  const velAligned = htfDir !== 0 && !ctx.counterMove;
  let comp5: number;
  // Ideal: slow patient arrival at the zone, HTF aligned — the oracle entry
  if      (ctx.velocityState === "slow"   && ctx.nearPivot && velAligned)  comp5 = 15;
  // Slow at the level, no HTF consensus yet — still a patient approach
  else if (ctx.velocityState === "slow"   && ctx.nearPivot)                comp5 = 12;
  // Normal pace arriving at the zone, aligned — acceptable entry speed
  else if (ctx.velocityState === "normal" && ctx.nearPivot && velAligned)  comp5 = 11;
  // Normal aligned, no level yet
  else if (ctx.velocityState === "normal" && velAligned)                   comp5 = 9;
  // Fast in direction, not at a level — decent momentum but wait for the zone
  else if (ctx.velocityState === "fast"   && velAligned && !ctx.nearPivot) comp5 = 9;
  // WARNING: Fast velocity AT the key level — potential false break per Oracle Method
  // "If price slams back over by several hundred dollars — wait."
  else if (ctx.velocityState === "fast"   && ctx.nearPivot)                comp5 = 5;
  // Slow, no level, no consensus
  else if (ctx.velocityState === "slow")                                   comp5 = 6;
  // Fast with no alignment — counter-move or mixed
  else if (ctx.velocityState === "fast")                                   comp5 = 2;
  else                                                                     comp5 = 5;

  // ── HA body strength boost on time suitability ─────────────────────────────
  // "The bigger the candle, the bigger the move." High HA body/range ratio on
  // the 3m streak means momentum is strong and directional. Reward it when
  // the HA direction agrees with the HTF direction (confirming, not chasing).
  if (ctx.haBodyStrength3m >= 0.80 && haDir === ctx.htfDirection && ctx.htfDirection !== 0) {
    comp5 = Math.min(15, comp5 + 2); // big HA bodies + aligned direction = strong momentum
  } else if (ctx.haBodyStrength3m >= 0.65 && haDir === ctx.htfDirection && ctx.htfDirection !== 0) {
    comp5 = Math.min(15, comp5 + 1);
  }

  // ── Follow-through confirmation ─────────────────────────────────────────────
  // 3 of the last 3 closed 3m bars in HTF direction = strong continuation (+1).
  // 0 of 3 in HTF direction despite alignment = stalling market (−1).
  if (velAligned) {
    if (ctx.followThroughScore >= 10) comp5 = Math.min(15, comp5 + 1);
    else if (ctx.followThroughScore === 0) comp5 = Math.max(0, comp5 - 1);
  }

  // ── Indecision bar penalty ──────────────────────────────────────────────────
  // A wide-range bar with a tiny body = price is fighting both directions with
  // no commitment. Most dangerous when velocity reads "fast" (looks like
  // momentum but the bodies are actually small — a classic stop-hunt pattern).
  if (
    ctx.candleDepthPct > 0 &&
    ctx.threeMinBodyPct > 0 &&
    ctx.threeMinBodyPct / ctx.candleDepthPct < 0.30 &&
    ctx.velocityState === "fast"
  ) {
    comp5 = Math.max(0, comp5 - 1); // wide range, tiny body, fast wick = indecision
  }

  // ── Total (raw) ────────────────────────────────────────────────────────────
  let edgeScore = Math.min(100, Math.max(0, comp1 + comp2 + comp3 + comp4 + comp5));

  // ── Pattern memory modifier ────────────────────────────────────────────────
  // The oracle adjusts the score based on whether this setup resembles prior
  // high-quality patterns. Familiar, clean setups earn bonus confidence.
  // Unfamiliar setups (no match in history) earn a small penalty.
  // Post-win humility caps the score to prevent overconfidence after a gain.
  const fpc = ctx.fingerprintConfidence;
  if (fpc !== null && ctx.fingerprintSampleCount >= 5) {
    if      (fpc >= 75) edgeScore = Math.min(100, edgeScore + 5);
    else if (fpc >= 60) edgeScore = Math.min(100, edgeScore + 2);
    else if (fpc < 28)  edgeScore = Math.max(0,   edgeScore - 3);
  }
  // After a strong win, the oracle becomes more selective for 4 hours.
  // Caps at 82 to prevent the score from overriding the humility gate
  // in autoEntryWatcher, which requires minEdge+8 during this window.
  if (ctx.postWinHumility) {
    edgeScore = Math.min(82, edgeScore);
  }

  // ── Grade ──────────────────────────────────────────────────────────────────
  let grade: EdgeGrade;
  if      (edgeScore >= 80) grade = "exceptional";
  else if (edgeScore >= 65) grade = "good";
  else if (edgeScore >= 45) grade = "moderate";
  else if (edgeScore >= 25) grade = "weak";
  else                      grade = "poor";

  // ── Oracle state + narration ───────────────────────────────────────────────
  // The oracle state is the primary display concept.
  // The narration is WHY — specific to the current component scores.
  const oracleState = deriveOracleState(ctx, edgeScore);
  const oracleStateLabel = oracleStateText(oracleState);
  const oracleNarration = buildOracleNarration(oracleState, ctx, comp1, comp2, comp3, comp4, comp5);

  // ── Safeguard delta ────────────────────────────────────────────────────────
  const safeguardDelta = edgeScoreDelta(edgeScore);

  // ── Human-readable reason ──────────────────────────────────────────────────
  const reasons: string[] = [];
  if (ctx.htfAligned) {
    reasons.push(`HTF ${ctx.htfDirection > 0 ? "bullish" : "bearish"} aligned`);
  } else if (ctx.htfDirection !== 0) {
    reasons.push("partial HTF direction");
  } else {
    reasons.push("no HTF consensus");
  }
  if (ctx.fifteenMinConfirms)  reasons.push("all timeframes confirmed");
  else if (ctx.threeMinLeads)  reasons.push("3m leading the move");
  if (ctx.resumption) {
    const resTag = ctx.resumptionStrength !== "none" ? ` (${ctx.resumptionStrength})` : "";
    reasons.push(`resumption${resTag} — waited through pullback`);
  }
  if (ctx.counterMove) {
    const retTag = ctx.retraceQuality !== "none" ? ` · ${ctx.retraceQuality} retrace` : "";
    reasons.push(`counter-move active${retTag} — wait`);
  }
  if (ctx.levelAcceptanceState === "accepting")  reasons.push("zone accepting — proven level");
  if (ctx.levelAcceptanceState === "rejecting")  reasons.push("zone rejecting — reliable wall");
  if (ctx.levelAcceptanceState === "contested")  reasons.push("zone contested — messy level");
  if (ctx.fourBarRule)         reasons.push(`${Math.abs(ctx.fourBarStreak)}-bar 6h streak`);
  if (playType !== "none") {
    const playLabels: Record<string, string> = {
      clean_rejection:       "clean whole-number rejection",
      over_under_transition: "over-to-under break",
      under_over_transition: "under-to-over break",
      clean_retest:          "whole-number retest hold",
      over_key:              "positioned over key level",
      under_key:             "positioned under key level",
    };
    reasons.push(playLabels[playType] ?? playType);
  }
  if (ctx.nearPivot && ctx.velocityState === "slow") reasons.push("patient zone approach");
  if (comp4 >= 12)     reasons.push("healthy wallet");
  else if (comp4 <= 4) reasons.push("heavy wallet exposure");
  if (ctx.velocityState === "fast" && velAligned) reasons.push("strong velocity aligned");

  const reason = reasons.join(", ");

  const safeguardNote = edgeScore >= 80
    ? "High-quality setup — safeguard allows extra trail room"
    : edgeScore >= 65
      ? "Good setup — safeguard slightly more patient"
      : edgeScore >= 45
        ? "Moderate setup — standard safeguard behavior"
        : edgeScore >= 25
          ? "Weak setup — safeguard tightened"
          : "Poor setup — safeguard aggressive protection";

  return {
    edgeScore,
    grade,
    reason,
    oracleState,
    oracleStateLabel,
    oracleNarration,
    safeguardDelta,
    safeguardNote,
    components: {
      structureAlignment: {
        score: comp1,
        max: 25,
        label: (() => {
          if (!ctx.htfAligned) return "HTF mixed";
          const arrow = ctx.htfDirection > 0 ? "↑" : "↓";
          if (ctx.ha6hClean && ctx.haNoDissent6h) return `HTF ${arrow} · 6h HA no-tail ✓✓`;
          if (ctx.ha6hClean)                      return `HTF ${arrow} · 6h HA clean ✓`;
          return `HTF aligned ${arrow}`;
        })(),
      },
      patienceQuality: {
        score: comp2,
        max: 25,
        label: ctx.resumptionStrength === "strong"   ? "Strong resumption ✓✓"
            : ctx.resumptionStrength === "moderate"  ? "Resumption — confirmed ✓"
            : ctx.resumptionStrength === "weak"      ? "Resumption — confirming..."
            : ctx.retraceQuality === "shallow"       ? "Shallow pull — oracle patient"
            : ctx.retraceQuality === "deep"          ? "Deep retrace — wait for confirm"
            : ctx.resumption                         ? "Waited through pullback ✓"
            : ctx.fifteenMinConfirms                 ? "All TF confirmed"
            : ctx.threeMinLeads                      ? "3m leading"
            : ctx.counterMove                        ? "Counter-move — wait"
            : ctx.nearPivot && ctx.velocityState === "slow" ? "Patient zone approach"
            : "Neutral",
      },
      keyLevelBehavior: {
        score: comp3,
        max: 20,
        label: (() => {
          if (playType === "none") return "No level play";
          if (playType === "over_key") {
            return htfDir3 === -1 ? "Above level — Short aligned ✓"
              : htfDir3 === 1  ? "Above level — Long unaligned ✗"
              : "Above key level";
          }
          if (playType === "under_key") {
            return htfDir3 === 1  ? "Below level — Long aligned ✓"
              : htfDir3 === -1 ? "Below level — Short unaligned ✗"
              : "Below key level";
          }
          return playType.replace(/_/g, " ");
        })(),
        playType,
      },
      walletReadiness: {
        score: comp4,
        max: 15,
        label: wallet.positionMargin === 0
          ? "No position"
          : `${exposurePct.toFixed(0)}% exposed`,
        exposurePct,
      },
      timeSuitability: {
        score: comp5,
        max: 15,
        label: ctx.nearPivot && ctx.velocityState === "slow" ? "Patient level approach"
            : ctx.resumptionStrength === "strong"            ? "Strong resumption velocity"
            : ctx.retraceQuality === "shallow" && velAligned ? "Shallow pull — velocity fine"
            : ctx.retraceQuality === "deep"                  ? "Deep retrace — velocity uncertain"
            : ctx.followThroughScore >= 10 && velAligned     ? "Strong follow-through"
            : ctx.followThroughScore === 0  && velAligned    ? "No follow-through — stalling"
            : ctx.velocityState === "fast" && velAligned     ? "Fast aligned"
            : ctx.velocityState === "fast"                   ? "Fast — chasing"
            : ctx.velocityState === "slow"                   ? "Slow drift"
            : velAligned                                     ? "Normal aligned"
            : "Mixed",
      },
    },
  };
}

// ── Oracle narration ─────────────────────────────────────────────────────────
// Generates a specific, dynamic explanation of WHY the oracle is in its current
// state. This is the "voice of the system" — calm, precise, never generic.
// The narration is shown in the oracle state banner in place of the old static
// sub-text, giving the user actionable context rather than boilerplate.

function buildOracleNarration(
  state: OracleState,
  ctx: StructureContext,
  comp1: number,
  comp2: number,
  comp3: number,
  comp4: number,
  comp5: number,
): string {
  switch (state) {

    case "no_signal": {
      const ha6hState = ctx.ha6hBias > 0 ? "bullish" : ctx.ha6hBias < 0 ? "bearish" : "mixed";
      const ha6hCleanNote = ctx.ha6hClean
        ? ` The 6h HA is ${ha6hState} and clean (${Math.abs(ctx.haStreak6h)} bars${ctx.haNoDissent6h ? ", no opposing wicks" : ""}), but the 1h regular candles haven't confirmed yet.`
        : " The 6h HA is tailed or indecisive — no clean directional conviction on either side.";
      return `The higher timeframes disagree on direction.${ha6hCleanNote} The oracle stands aside until the 6h HA and 1h align cleanly.`;
    }

    case "late_setup":
      if (ctx.counterMove && ctx.velocityState === "fast") {
        return "A fast counter-move is running against the HTF direction. The oracle waits for it to resolve before re-evaluating the entry zone.";
      }
      return `Price has already moved significantly from the key level — the ${Math.abs(ctx.fourBarStreak)}-bar streak suggests the impulse is mature. The oracle does not chase. Waiting for a fresh return to zone.`;

    case "ready": {
      const parts: string[] = [];
      if (ctx.resumption)         parts.push("waited through the pullback");
      if (ctx.fifteenMinConfirms) parts.push("all timeframes confirmed");
      else if (ctx.threeMinLeads) parts.push("3m leading at the level");
      if (ctx.nearPivot)          parts.push("price at the key zone");
      if (ctx.fourBarRule)        parts.push(`${Math.abs(ctx.fourBarStreak)}-bar HTF streak`);
      const haDir = ctx.haStreak3m > 0 ? 1 : ctx.haStreak3m < 0 ? -1 : 0;
      const haAbs = Math.abs(ctx.haStreak3m);
      if (haAbs >= 2 && haDir === ctx.htfDirection) {
        const cleanTag = ctx.haNoDissent3m ? " with no opposing wicks" : "";
        parts.push(`${haAbs}-bar 3m HA trend${cleanTag}`);
      }
      // 6h HA master bias — call out clean structure
      if (ctx.ha6hClean && ctx.ha6hBias !== 0) {
        const biasWord = ctx.ha6hBias > 0 ? "bullish" : "bearish";
        const cleanTag = ctx.haNoDissent6h ? " no-tail" : " clean";
        parts.push(`${Math.abs(ctx.haStreak6h)}-bar${cleanTag} 6h HA ${biasWord}`);
      }
      // 1h HA confirmation layer
      if (ctx.ha1hConfirms6h) {
        const noTailTag = ctx.haNoDissent1h ? " (no-tail)" : "";
        parts.push(`1h HA confirms 6h bias${noTailTag}`);
      }
      const fpc2 = ctx.fingerprintConfidence;
      if (fpc2 !== null && fpc2 >= 65 && ctx.fingerprintSampleCount >= 5) {
        parts.push(`pattern match ${fpc2}/100 across ${ctx.fingerprintSampleCount} historical setups`);
      }
      if (ctx.postWinHumility) {
        return `Structure aligned${parts.length ? " — " + parts.join(", ") : ""}. Setup is valid — but the oracle is applying post-win caution after a recent strong gain. ${ctx.postWinMinutesLeft}m of selective mode remaining.`;
      }
      return `Structure aligned${parts.length ? " — " + parts.join(", ") : ""}. The oracle sees a valid setup at the right zone. This is the opportunity.`;
    }

    case "wait_mode":
    default: {
      // Most specific reason first — walk through the chain that isn't satisfied
      if (ctx.counterMove) {
        return "A counter-move is active against the HTF direction. The oracle watches for it to resolve back before committing — entering into a counter-move is the definition of chasing.";
      }
      if (!ctx.nearPivot) {
        return `Price is ${ctx.pivotProximityPct.toFixed(1)}% from the nearest key level (${ctx.nearestPivot.toLocaleString()}). The oracle waits for price to return to the zone — patience here is the edge.`;
      }
      if (comp2 < 10) {
        if (ctx.velocityState === "fast") {
          return "Price arrived at the zone too fast. The oracle wants to see a slow, patient approach — rapid arrivals often produce a brief test then reversal, not a sustained entry.";
        }
        return "The approach to the zone lacks patience quality. A setup that drifts in slowly and holds the level scores much higher than one that spikes into it.";
      }
      if (!ctx.htfAligned) {
        const dir1h = ctx.oneHourDirection > 0 ? "bullish" : ctx.oneHourDirection < 0 ? "bearish" : "flat";
        const dir6h = ctx.sixHourDirection > 0 ? "bullish" : ctx.sixHourDirection < 0 ? "bearish" : "flat";
        return `The 1h is ${dir1h} and the 6h is ${dir6h} — the oracle needs both to agree before committing wallet. Watching for the higher timeframe to align.`;
      }
      if (comp4 <= 4) {
        return "Wallet exposure is heavy. The oracle protects what's already on the line and will not add risk while the position-to-equity ratio is this high.";
      }
      if (!ctx.fifteenMinConfirms && !ctx.threeMinLeads) {
        return "HTF structure is aligned and price is at the zone, but the lower timeframes haven't confirmed yet. The oracle watches for 3m or 15m to join before opening.";
      }
      const s3mAbs = Math.abs(ctx.threeMinStreak);
      const s3mDir = ctx.threeMinStreak > 0 ? 1 : ctx.threeMinStreak < 0 ? -1 : 0;
      const s3mAligned = ctx.htfDirection !== 0 && s3mDir === ctx.htfDirection;
      if (s3mAligned && s3mAbs === 1) {
        return "First 3m continuation in the HTF direction — the Oracle Method waits for the 2nd or 3rd before opening. Letting the move prove itself.";
      }
      if (s3mAligned && s3mAbs >= 4) {
        return `${s3mAbs} consecutive 3m candles in the HTF direction — the move is getting extended. The oracle waits for a reset before the next entry.`;
      }
      // 1h exhaustion warning — 4+ clean 1h HA bars after a completed move
      if (ctx.ha1hExhaustionWarning) {
        const dirWord = ctx.htfDirection > 0 ? "bullish" : ctx.htfDirection < 0 ? "bearish" : "directional";
        return `${Math.abs(ctx.haStreak1h)} consecutive clean 1h HA bars ${dirWord} — the move may be maturing toward 6h exhaustion. The oracle looks for a controlled pullback before the next 3m resumption. This is a warning, not a reversal.`;
      }
      // 6h HA tailed / indecisive — structure not clean enough
      if (!ctx.ha6hClean && ctx.ha6hBias !== 0) {
        return `The 6h Heikin Ashi shows directional intent but tailed candles — price is meeting resistance or absorption at the current zone. The oracle waits for clean, no-tail 6h candles before committing.`;
      }
      // HA counter-signal: HA streak is running against HTF (stronger than regular candle counter-move)
      const haDir = ctx.haStreak3m > 0 ? 1 : ctx.haStreak3m < 0 ? -1 : 0;
      const haAbs = Math.abs(ctx.haStreak3m);
      if (ctx.htfDirection !== 0 && haDir !== 0 && haDir !== ctx.htfDirection && haAbs >= 2) {
        return `Heikin Ashi shows ${haAbs} consecutive candles against the HTF direction — the smoothed trend confirms the pullback is real. The oracle waits for HA to flip back before committing.`;
      }
      // Post-win humility — override with caution message
      if (ctx.postWinHumility) {
        return `The oracle is in caution mode after a strong recent win — it's being more selective for the next ${ctx.postWinMinutesLeft} minutes. A very clean setup (score above ${comp1 + comp2 + comp3 + comp4 + comp5 + 8}) can still pass through.`;
      }
      // Low pattern confidence — setup doesn't resemble historical trades
      const fpc3 = ctx.fingerprintConfidence;
      if (fpc3 !== null && fpc3 < 28 && ctx.fingerprintSampleCount >= 5) {
        return `Pattern memory doesn't strongly recognize this setup (${fpc3}/100 match across ${ctx.fingerprintSampleCount} historical trades). The oracle waits for a familiar, proven setup before committing.`;
      }
      const total = comp1 + comp2 + comp3 + comp4 + comp5;
      return `Setup quality ${total}/100 — building but not yet at the entry threshold. Weakest component: ${
        comp2 / 25 <= comp1 / 25 && comp2 / 25 <= comp3 / 20 ? "patience quality" :
        comp3 / 20 <= comp1 / 25 ? "key level confirmation" : "structure alignment"
      }. The oracle holds.`;
    }
  }
}

// ── Oracle state derivation ───────────────────────────────────────────────────

/**
 * Derives the oracle's current read of the setup.
 *
 * Priority order:
 *   1. no_signal   — HTF has no consensus (don't know which direction)
 *   2. late_setup  — move is running without the oracle (don't chase)
 *   3. ready       — structure confirmed, price at the zone, act now
 *   4. wait_mode   — interesting but price hasn't proven itself yet
 */
function deriveOracleState(ctx: StructureContext, score: number): OracleState {
  // ── No consensus ──────────────────────────────────────────────────────────
  if (ctx.htfDirection === 0) return "no_signal";

  // ── Late setup: the move is running away, don't chase ─────────────────────
  // Conditions: price is moving fast in HTF direction but is NOT near any
  // key level, NOT confirmed by 15m yet (impulsive breakout phase), AND
  // the 6h has been trending for a while (streak ≥ 3). This describes a
  // "chase" setup — everything is already in motion without a clean zone.
  const runningAway =
    ctx.velocityState === "fast" &&
    ctx.htfAligned &&
    !ctx.nearPivot &&             // away from any level to anchor to
    !ctx.fifteenMinConfirms &&    // 15m hasn't confirmed yet (impulse move)
    Math.abs(ctx.fourBarStreak) >= 3; // been trending for several 6h bars

  if (runningAway) return "late_setup";

  // ── Also late if counterMove is very fast against us ─────────────────────
  // Don't re-enter a position if a fast counter-move is actively happening.
  if (ctx.counterMove && ctx.velocityState === "fast") return "late_setup";

  // ── Ready: all conditions aligned to open now ──────────────────────────────
  // The oracle says act when:
  //   • HTF is fully aligned (both 1h and 6h agree)
  //   • LTF confirms (15m confirmed OR 3m leading at a key level)
  //   • No active counter-move
  //   • Score is good enough to justify the entry (not a weak setup)
  const readyToOpen =
    ctx.htfAligned &&
    !ctx.counterMove &&
    (ctx.fifteenMinConfirms ||
      (ctx.threeMinLeads && ctx.nearPivot)) && // 3m lead is only "ready" at a level
    score >= 55;

  if (readyToOpen) return "ready";

  // ── Wait mode: setup is interesting but not yet at the right place ─────────
  return "wait_mode";
}

function oracleStateText(state: OracleState): string {
  switch (state) {
    case "ready":      return "READY";
    case "wait_mode":  return "WAIT MODE";
    case "late_setup": return "LATE SETUP";
    case "no_signal":  return "NO SIGNAL";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** pp to add to patienceBoost in the safeguard watcher. Clamped later to 2..12. */
export function edgeScoreDelta(score: number): number {
  if (score >= 80) return  1.5;
  if (score >= 65) return  0.75;
  if (score >= 45) return  0;
  if (score >= 25) return -0.75;
  return -2.0;
}

export function edgeGradeLabel(grade: EdgeGrade): string {
  switch (grade) {
    case "exceptional": return "EXCEPTIONAL";
    case "good":        return "GOOD";
    case "moderate":    return "MODERATE";
    case "weak":        return "WEAK";
    case "poor":        return "POOR";
  }
}
