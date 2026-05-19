import { createContext, useContext, useEffect, useRef, useState, ReactNode, useCallback } from "react";

export interface PriceTick {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  direction: "up" | "down" | "flat";
}

export type LivePriceMap = Record<string, PriceTick>;

interface LivePricesContextValue {
  prices: LivePriceMap;
  flash: Record<string, "up" | "down" | null>;
  connected: boolean;
}

const LivePricesContext = createContext<LivePricesContextValue>({
  prices: {},
  flash: {},
  connected: false,
});

export function LivePricesProvider({ children }: { children: ReactNode }) {
  const [prices, setPrices] = useState<LivePriceMap>({});
  const [flash, setFlash] = useState<Record<string, "up" | "down" | null>>({});
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/ws`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      reconnectTimer.current = setTimeout(connect, 3000);
    };
    ws.onerror = () => ws.close();

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as { type: string; ticks?: PriceTick[] };
        if (msg.type === "ticks" && msg.ticks) {
          setPrices(prev => {
            const next = { ...prev };
            const newFlash: Record<string, "up" | "down" | null> = {};
            for (const tick of msg.ticks!) {
              next[tick.symbol] = tick;
              if (tick.direction !== "flat") newFlash[tick.symbol] = tick.direction;
            }
            setFlash(f => ({ ...f, ...newFlash }));
            // clear flash after 600ms
            setTimeout(() => {
              setFlash(f => {
                const cleared = { ...f };
                for (const tick of msg.ticks!) cleared[tick.symbol] = null;
                return cleared;
              });
            }, 600);
            return next;
          });
        }
      } catch {
        // ignore malformed messages
      }
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return (
    <LivePricesContext.Provider value={{ prices, flash, connected }}>
      {children}
    </LivePricesContext.Provider>
  );
}

export function useLivePrices() {
  return useContext(LivePricesContext);
}

export function useLivePrice(symbol: string) {
  const { prices, flash } = useContext(LivePricesContext);
  return { tick: prices[symbol] ?? null, flash: flash[symbol] ?? null };
}
