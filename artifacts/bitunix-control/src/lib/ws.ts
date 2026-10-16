type PriceCallback = (symbol: string, price: number) => void;

class PriceStreamClient {
  private es: EventSource | null = null;
  private subscribers = new Map<string, Set<PriceCallback>>();
  private latestPrices = new Map<string, number>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentSymbols: string = "";

  subscribe(symbol: string, cb: PriceCallback) {
    if (!this.subscribers.has(symbol)) {
      this.subscribers.set(symbol, new Set());
    }
    this.subscribers.get(symbol)!.add(cb);
    // Replay latest known price immediately
    const last = this.latestPrices.get(symbol);
    if (last !== undefined) cb(symbol, last);
    this.refreshConnection();
  }

  unsubscribe(symbol: string, cb: PriceCallback) {
    this.subscribers.get(symbol)?.delete(cb);
    if (this.subscribers.get(symbol)?.size === 0) {
      this.subscribers.delete(symbol);
      this.refreshConnection();
    }
  }

  private refreshConnection() {
    const symbols = Array.from(this.subscribers.keys()).sort();
    const symbolsStr = symbols.join(",");
    if (symbolsStr === this.currentSymbols && this.es && this.es.readyState !== EventSource.CLOSED) {
      return;
    }
    this.currentSymbols = symbolsStr;

    if (this.es) {
      this.es.close();
      this.es = null;
    }
    if (symbols.length === 0) return;

    const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
    const url = `${base}/api/prices/stream?symbols=${encodeURIComponent(symbolsStr)}`;

    try {
      this.es = new EventSource(url);
      this.es.onmessage = (ev) => {
        try {
          const { symbol, price } = JSON.parse(ev.data);
          if (typeof symbol === "string" && typeof price === "number") {
            this.latestPrices.set(symbol, price);
            this.subscribers.get(symbol)?.forEach((cb) => cb(symbol, price));
          }
        } catch (_) {}
      };
      this.es.onerror = () => {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          this.currentSymbols = "";
          this.refreshConnection();
        }, 3000);
      };
    } catch (_) {}
  }
}

export const bitunixWS = new PriceStreamClient();
