import { Router } from "express";
import { bitunixGet } from "../lib/bitunix";
import { priceStream } from "../lib/priceStream";
import { cacheGet } from "../lib/apiCache";

const router = Router();

// Signal data is built from 6 candles per timeframe (3m/15m/1h/6h).
// Shortest bar is 3m, so caching for 55 s preserves accuracy while
// collapsing repeated browser polls into a single Bitunix burst.
const SIGNAL_TTL_MS = 55_000;

interface KlineEntry {
  open: string;
  high: string;
  low: string;
  close: string;
  time: string;
}

type Direction = "up" | "down" | "mixed";

interface TfRead {
  direction: Direction;
  score: number;
  lastCandlePct: number;
  windowPct: number;
}

interface VerdictData {
  label: string;
  confidence: "low" | "medium" | "high";
  score: number;
}

function wholeNumberStep(price: number): number {
  const abs = Math.abs(price);
  if (abs >= 10000) return 1000;
  if (abs >= 1000) return 100;
  if (abs >= 100) return 10;
  if (abs >= 10) return 1;
  if (abs >= 1) return 0.1;
  return 0.01;
}

function pctChange(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0 || !Number.isFinite(to)) return 0;
  return ((to - from) / from) * 100;
}

function scoreTimeframe(candles: KlineEntry[], livePrice: number): TfRead {
  if (candles.length === 0) {
    return { direction: "mixed", score: 0, lastCandlePct: 0, windowPct: 0 };
  }

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

    if (idx === lastIdx && Number.isFinite(livePrice)) {
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
  let direction: Direction = "mixed";
  if (normalized >= 0.18) direction = "up";
  else if (normalized <= -0.18) direction = "down";

  const newest = ordered[ordered.length - 1];
  const lastOpen = parseFloat(newest.open);
  const refClose = Number.isFinite(livePrice) ? livePrice : parseFloat(newest.close);
  const oldest = ordered[0];

  return {
    direction,
    score: Number(normalized.toFixed(3)),
    lastCandlePct: Number(pctChange(lastOpen, refClose).toFixed(3)),
    windowPct: Number(pctChange(parseFloat(oldest.open), refClose).toFixed(3)),
  };
}

function computeVerdict(reads: { tf: string; weight: number; read: TfRead }[]): VerdictData {
  let score = 0;
  for (const { weight, read } of reads) {
    if (read.direction === "up") score += weight;
    else if (read.direction === "down") score -= weight;
  }

  let label: string;
  let confidence: "low" | "medium" | "high";

  if (score >= 6) {
    label = "Bullish — all aligned";
    confidence = "high";
  } else if (score >= 3) {
    label = "Mixed but bullish";
    confidence = "medium";
  } else if (score <= -6) {
    label = "Bearish — all aligned";
    confidence = "high";
  } else if (score <= -3) {
    label = "Mixed but bearish";
    confidence = "medium";
  } else {
    label = "Mixed — wait";
    confidence = "low";
  }

  return { label, confidence, score };
}

const TIMEFRAMES = [
  { tf: "3m", weight: 1, limit: 6 },
  { tf: "15m", weight: 2, limit: 6 },
  { tf: "1h", weight: 3, limit: 6 },
  { tf: "6h", weight: 2, limit: 6 },
] as const;

// Core computation extracted so it can be wrapped in cacheGet.
async function computeSignalData(symbol: string) {
  const settled = await Promise.allSettled(
    TIMEFRAMES.map((t) =>
      bitunixGet<KlineEntry[]>("/api/v1/futures/market/kline", {
        symbol,
        interval: t.tf,
        limit: String(t.limit),
      }),
    ),
  );

  const tfData = settled.map((s, i) => {
    const t = TIMEFRAMES[i];
    if (s.status === "fulfilled" && Array.isArray(s.value.data) && s.value.data.length > 0) {
      return { tf: t.tf, weight: t.weight, candles: s.value.data, ok: true };
    }
    return { tf: t.tf, weight: t.weight, candles: [] as KlineEntry[], ok: false };
  });

  if (tfData.every((t) => !t.ok)) {
    throw new Error(`Bitunix returned no kline data for ${symbol} on any timeframe`);
  }

  const cached = priceStream.status().cachedPrices as Record<string, number>;
  const livePrice = cached[symbol];
  const firstAvailable = tfData.find((t) => t.ok);
  const fallbackClose = firstAvailable ? parseFloat(firstAvailable.candles[0].close) : NaN;
  const price = Number.isFinite(livePrice) ? livePrice : fallbackClose;

  const tfReads = tfData.map((t) => ({
    tf: t.tf,
    weight: t.weight,
    ok: t.ok,
    read: t.ok
      ? scoreTimeframe(t.candles, price)
      : { direction: "mixed" as Direction, score: 0, lastCandlePct: 0, windowPct: 0 },
  }));

  const verdict = computeVerdict(tfReads.filter((t) => t.ok));

  const step = wholeNumberStep(price);
  const lower = Math.floor(price / step) * step;
  const upper = lower + step;
  const distLower = Math.abs(price - lower);
  const distUpper = Math.abs(upper - price);
  const nearestLevel = distLower <= distUpper ? lower : upper;
  const distance = Math.min(distLower, distUpper);
  const distancePct = price > 0 ? (distance / price) * 100 : 0;

  return {
    symbol,
    price,
    verdict,
    timeframes: tfReads.reduce<Record<string, TfRead & { weight: number; ok: boolean }>>(
      (acc, t) => {
        acc[t.tf] = { ...t.read, weight: t.weight, ok: t.ok };
        return acc;
      },
      {},
    ),
    wholeNumber: {
      nearby: distancePct <= 0.3,
      level: nearestLevel,
      distancePct: Number(distancePct.toFixed(3)),
      step,
    },
  };
}

router.get("/signal/:symbol", async (req, res) => {
  const symbol = String(req.params.symbol || "").toUpperCase();
  if (!symbol) {
    res.status(400).json({ code: -1, msg: "symbol path param required", data: null });
    return;
  }

  try {
    const data = await cacheGet(
      `signal:${symbol}`,
      SIGNAL_TTL_MS,
      () => computeSignalData(symbol),
    );
    res.json({ code: 0, msg: "ok", data });
  } catch (err) {
    req.log.error({ err, symbol }, "Signal compute failed");
    res.status(502).json({ code: -1, msg: String(err), data: null });
  }
});

export default router;
