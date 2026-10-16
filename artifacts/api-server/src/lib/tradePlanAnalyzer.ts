import { openai } from "./openaiClient";
import { logger } from "./logger";

/**
 * Structured pre-trade chart analysis returned by the vision model.
 *
 * The model is constrained by a JSON schema so the server never has to
 * parse free-form text. All numeric fields are bounded; all enums are
 * lower-case strings. Anything the model is unsure about is set to
 * "unclear" / null rather than fabricated.
 *
 * Image-to-self-trade intelligence layer:
 *   returnToZonePct      — estimated retrace depth % before continuation
 *   returnToZoneNote     — plain-English return zone description (in $ if price known)
 *   entryZoneNote        — where to enter (in $ if price known)
 *   invalidationZoneNote — where the thesis breaks down (in $ if price known)
 *   confidenceLevel      — 0-100 composite confidence
 *   likelyAction         — enter | wait | stand-down
 *
 * Oracle Method directional bias (critical):
 *   The system prefers LONG entries when price is BELOW a whole-number level
 *   and SHORT entries when price is ABOVE a whole-number level. The vision
 *   model is explicitly instructed to apply this bias when assessing
 *   detectedBias, agreementScore, and likelyAction.
 *
 * When currentPrice is provided, the model expresses zone targets as actual
 * dollar levels ("around $81,000" not "~1.2% below"), making the output
 * directly usable by the retrace-progress meter and wait-resolution logic.
 */
export interface TradePlanAnalysis {
  channelZone: "lower" | "middle" | "upper" | "unknown";
  channelTilt: "up" | "down" | "flat" | "unknown";
  trendPosture: "continuation" | "mean-reversion" | "range" | "unclear";
  detectedBias: "long" | "short" | "mixed" | "unclear";
  agreementScore: number;              // -100..+100 (vs user-declared bias)
  continuationProbPct: number;         // 0..100
  pivotProximityNote: string | null;
  recommendedPatience: "tight" | "standard" | "patient" | "very-patient";
  recommendedTightening: "none" | "normal" | "aggressive";
  setupQuality: "weak" | "mixed" | "clean" | "strong";
  riskNote: string | null;
  summary: string;                     // 2-3 sentences, plain English
  // ── Image-to-self-trade intelligence ─────────────────────────────────────
  returnToZonePct: number | null;      // 0 = enter now; 0.3-5 = expected retrace %
  returnToZoneNote: string | null;     // "price may return to ~$81,000 before resuming"
  entryZoneNote: string | null;        // "$81,000–$81,200 on a reclaim"
  invalidationZoneNote: string | null; // "close below $80,500 invalidates the long"
  confidenceLevel: number;             // 0–100 composite plan confidence
  likelyAction: "enter" | "wait" | "stand-down" | "probe";
}

const SYSTEM_PROMPT = `You are a calm, experienced futures pilot reviewing a chart screenshot before
the user enters a leveraged trade. Speak with the brevity of an expert who has
seen thousands of these setups. You do NOT issue financial advice — you describe
the structure as it appears and score its quality for a specific trading method.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ORACLE METHOD — Whole-Number Directional Bias (CRITICAL, apply always)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

This system uses the Oracle Method. Whole-number price levels (e.g. $80,000,
$81,000, $82,000 for BTC) are gravitational magnets. The method applies a
specific directional rule:

  PRICE BELOW a whole-number level → preferred trade is LONG
    The level above is a magnet pulling price upward. The entry is made below
    the level, targeting the level as a first profit zone.
    Example: BTC at $80,200 (below $81,000) → LONG bias. The $81,000 level
    is the target.

  PRICE ABOVE a whole-number level → preferred trade is SHORT
    The level below is a magnet pulling price back down. The entry is made
    above the level, targeting the level below as a first profit zone.
    Example: BTC at $81,800 (above $81,000) → SHORT bias. The $81,000 level
    is the target.

  THE "MIDDLES ZONE" (30–70% between consecutive whole numbers) IS DANGEROUS:
    Price in the middle of a range (e.g., $80,400–$80,700) has no nearby
    magnet. Do NOT recommend entry here — recommend "wait" or "stand-down".

Apply this rule when scoring:
- detectedBias: if price is clearly below a key level → "long"; above → "short"
- agreementScore: if the user's declared bias MATCHES the whole-number position
  (long below, short above) → full positive score. If it OPPOSES it (long above,
  short below) → strong negative score.
- likelyAction: "enter" only if price is near a level in the correct direction.
  If price is in the middles zone or the user's bias opposes the level → "wait"
  or "stand-down".
- recommendedPatience: be "very-patient" or "patient" when price needs to
  return to the level first; "tight" if the setup opposes the whole-number bias.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANALYSIS CHECKLIST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Analyze:
- Where price sits in the visible channel (lower / middle / upper).
- The channel tilt and prevailing trend posture.
- Whole-number pivot proximity and position (above or below).
- Whether the move looks early, mature, or stretched.
- Whether the user's bias agrees with the whole-number position (Oracle Method rule).
- Whether price is ready to enter NOW, should WAIT for the zone, or STAND DOWN.
- Where price would likely return to before continuing (return-to-zone, in $).
- The best entry area and the invalidation level (in $ if price provided).

Output STRICTLY valid JSON matching the provided schema — no prose outside JSON.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SCORING RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- agreementScore: +100 = user bias matches whole-number position AND visible
  structure. 0 = mixed / neutral. -100 = user bias fights the whole-number
  position or the chart is clearly stretched against the bias.

- continuationProbPct: 0–100, conservative. Most setups land 35–65. 70+
  requires multiple strong confirmations (whole-number alignment + channel
  lower zone + clean structure + HTF tilt).

- recommendedPatience:
    "very-patient" — multiple strong agreements (correct zone + correct
                     whole-number side + matching bias + clean channel)
    "patient"      — structure looks clean, price near the right level
    "standard"     — mixed signals, but no clear contradiction
    "tight"        — stretched, wrong zone, bias opposes whole-number position

- confidenceLevel: 0–100 based on confluence of confirming factors. 80+
  requires: correct whole-number side + channel lower/upper zone + matching
  bias + HTF posture all agreeing. 50 = mixed. 30 = weak or unclear. NEVER
  above 90 for a single chart view. Be conservative — this score gates
  automated entry, so honesty here directly affects trade safety.

- returnToZonePct: expected retrace depth % before continuation. Use 0 if
  price is already at the correct level and ready. Typical: 0 (enter now),
  0.3–1.5 (minor pullback to the level), 1.5–4 (meaningful retrace needed).
  Never exceed 8. Set null only if the chart is completely unreadable.

- returnToZoneNote: if currentPrice is provided, express the zone as an actual
  dollar level ("price may return to ~$81,000" not "~1.2% below"). The system
  uses this string for display and measures actual retrace progress in $.

- entryZoneNote: specific price levels ("$81,000–$81,200 on a reclaim").
  Set null if likelyAction is "stand-down".

- invalidationZoneNote: specific price level where the thesis breaks.
  Set null only if structure is completely unclear.

- likelyAction:
    "enter"      — price is at the correct level (below for longs, above for
                   shorts), bias confirmed, structure clean enough for a
                   full-sized entry now.

    "probe"      — Oracle Method "toss a dwarf": price is very close to the
                   key level and the directional bias is partially aligned,
                   but the level has NOT yet been tested or broken — market
                   hasn't decided yet. Oracle recommends a tiny probe position
                   (~20% of normal size) to discover whether the level holds.
                   The probe expects to get stopped out frequently; the
                   stop-out itself provides information (level failed = wait).
                   Use "probe" when: price is within 0.3% of a whole-number
                   level, structure is mixed/unclear, but one direction is
                   slightly favored. NOT a full entry. Auto-entry will NOT
                   fire — the operator must manually size down and decide.

    "wait"       — structure supports the bias but price hasn't reached the
                   ideal zone yet; patience gets a better price and better R:R.
                   Return-to-zone retrace is expected before the real entry.

    "stand-down" — bias opposes the whole-number position, OR chart is too
                   stretched away from any key level, OR structure is too
                   unclear / contradictory to risk capital on even as a probe.

- summary: 2–3 sentences. Name the channel zone, the nearest whole-number
  level and which side of it price is on, the main risk, and the action.
  If likelyAction is "probe", include that this is a dwarf toss — tiny size,
  expect stop-outs, the stop-out proves whether the level holds.
  Include actual price levels if currentPrice was provided.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "channelZone",
    "channelTilt",
    "trendPosture",
    "detectedBias",
    "agreementScore",
    "continuationProbPct",
    "pivotProximityNote",
    "recommendedPatience",
    "recommendedTightening",
    "setupQuality",
    "riskNote",
    "summary",
    "returnToZonePct",
    "returnToZoneNote",
    "entryZoneNote",
    "invalidationZoneNote",
    "confidenceLevel",
    "likelyAction",
  ],
  properties: {
    channelZone:            { type: "string", enum: ["lower", "middle", "upper", "unknown"] },
    channelTilt:            { type: "string", enum: ["up", "down", "flat", "unknown"] },
    trendPosture:           { type: "string", enum: ["continuation", "mean-reversion", "range", "unclear"] },
    detectedBias:           { type: "string", enum: ["long", "short", "mixed", "unclear"] },
    agreementScore:         { type: "integer", minimum: -100, maximum: 100 },
    continuationProbPct:    { type: "integer", minimum: 0, maximum: 100 },
    pivotProximityNote:     { type: ["string", "null"] },
    recommendedPatience:    { type: "string", enum: ["tight", "standard", "patient", "very-patient"] },
    recommendedTightening:  { type: "string", enum: ["none", "normal", "aggressive"] },
    setupQuality:           { type: "string", enum: ["weak", "mixed", "clean", "strong"] },
    riskNote:               { type: ["string", "null"] },
    summary:                { type: "string", minLength: 10, maxLength: 600 },
    returnToZonePct:        { type: ["number", "null"], minimum: 0, maximum: 8 },
    returnToZoneNote:       { type: ["string", "null"] },
    entryZoneNote:          { type: ["string", "null"] },
    invalidationZoneNote:   { type: ["string", "null"] },
    confidenceLevel:        { type: "integer", minimum: 0, maximum: 100 },
    likelyAction:           { type: "string", enum: ["enter", "wait", "stand-down", "probe"] },
  },
} as const;

export interface AnalyzeArgs {
  imageBase64: string;
  contentType: string;
  symbol: string;
  currentPrice?: number | null;   // live price at upload — enables dollar-level zone notes
  side?: string | null;           // intended side (LONG | SHORT)
  userBias?: string | null;       // long | short | unclear (declared by user)
  userNote?: string | null;       // free text alongside the upload
}

export async function analyzeChartScreenshot(args: AnalyzeArgs): Promise<TradePlanAnalysis> {
  const { imageBase64, contentType, symbol, currentPrice, side, userBias, userNote } = args;

  const userText = [
    `Symbol: ${symbol}`,
    currentPrice != null
      ? `Current price: $${currentPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })} — use this to express ALL zone targets as specific dollar levels, not percentages`
      : null,
    side ? `Intended side: ${side}` : "Intended side: not declared",
    userBias ? `Declared bias: ${userBias}` : "Declared bias: not declared",
    userNote ? `User note: ${userNote}` : null,
    "Analyze the attached chart screenshot.",
    "Apply the Oracle Method whole-number directional rule: identify the nearest whole-number",
    "level and whether price is above or below it. This determines the preferred trade direction.",
    "If the user's declared bias aligns with this (long below, short above), score it positively.",
    "If it opposes it, score negatively and lean toward 'wait' or 'stand-down'.",
    "Express ALL zone targets in dollar levels if current price was provided.",
  ].filter(Boolean).join("\n");

  const completion = await openai.chat.completions.create({
    model: "gpt-5.4",
    max_completion_tokens: 1500,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          {
            type: "image_url",
            image_url: { url: `data:${contentType};base64,${imageBase64}` },
          },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "TradePlanAnalysis", schema: SCHEMA, strict: true },
    },
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    throw new Error("Vision model returned an empty response");
  }

  let parsed: TradePlanAnalysis;
  try {
    parsed = JSON.parse(raw) as TradePlanAnalysis;
  } catch (err) {
    logger.error({ err, raw }, "Failed to parse trade plan JSON from vision model");
    throw new Error("Vision model returned invalid JSON");
  }

  // Defensive clamps — in case schema enforcement slips on a non-strict model
  parsed.agreementScore      = Math.max(-100, Math.min(100, Math.round(parsed.agreementScore)));
  parsed.continuationProbPct = Math.max(0, Math.min(100, Math.round(parsed.continuationProbPct)));
  parsed.confidenceLevel     = Math.max(0, Math.min(100, Math.round(parsed.confidenceLevel)));
  if (parsed.returnToZonePct != null) {
    parsed.returnToZonePct = Math.max(0, Math.min(8, parsed.returnToZonePct));
  }

  return parsed;
}
