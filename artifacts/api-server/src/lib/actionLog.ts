import fs from "fs";
import path from "path";

export interface LogEntry {
  ts: number;
  action: string;
  source: string;
  status: string;
  exchangeEndpoint?: string;
  remaining?: number;
  durationMs?: number;
  error?: string;
  verification?: string;
  positionId?: string;
  triggerPrice?: number;
  triggerSymbol?: string;
  // Trade entry fields
  symbol?: string;
  amount?: string;
  leverageTarget?: number;
  positionMode?: string;
}

const LOG_DIR = path.resolve("logs");
const LOG_FILE = path.join(LOG_DIR, "actions.jsonl");

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

export function logEvent(entry: LogEntry): void {
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // never let logging crash the hot path
  }
}

export function readLogs(limit = 50): LogEntry[] {
  try {
    ensureLogDir();
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs
      .readFileSync(LOG_FILE, "utf8")
      .split("\n")
      .filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => JSON.parse(l) as LogEntry)
      .reverse();
  } catch {
    return [];
  }
}
