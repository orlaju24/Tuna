import { useEffect, useState } from "react";
import { bitunixWS } from "@/lib/ws";

export function usePrice(symbol: string) {
  const [price, setPrice] = useState<number | null>(null);

  useEffect(() => {
    if (!symbol) return;
    setPrice(null);
    const cb = (_sym: string, p: number) => setPrice(p);
    bitunixWS.subscribe(symbol, cb);
    return () => bitunixWS.unsubscribe(symbol, cb);
  }, [symbol]);

  return price;
}
