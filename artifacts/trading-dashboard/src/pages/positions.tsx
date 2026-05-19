import { useListPositions } from "@workspace/api-client-react";
import { formatCurrency, formatPercentage, cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useLivePrices } from "@/context/live-prices";
import { useMemo, useRef, useState, useEffect } from "react";
import { ArrowUpRight, ArrowDownRight, Wifi, WifiOff, TrendingUp } from "lucide-react";

interface LivePosition {
  id: number;
  symbol: string;
  assetType: string;
  quantity: number;
  avgCost: number;
  strikePrice?: number | null;
  optionType?: string | null;
  expirationDate?: string | null;
  livePrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  prevPnl: number | null;
}

function FlashCell({ value, formatted, prevValue }: { value: number; formatted: string; prevValue: number | null }) {
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const prevRef = useRef<number | null>(prevValue);

  useEffect(() => {
    if (prevRef.current === null) { prevRef.current = value; return; }
    if (value === prevRef.current) return;
    const dir = value > prevRef.current ? "up" : "down";
    setFlash(dir);
    const t = setTimeout(() => setFlash(null), 700);
    prevRef.current = value;
    return () => clearTimeout(t);
  }, [value]);

  return (
    <span className={cn(
      "tabular-nums font-medium transition-colors duration-300",
      flash === "up" && "text-success",
      flash === "down" && "text-destructive",
      !flash && (value >= 0 ? "text-success" : "text-destructive"),
    )}>
      {formatted}
    </span>
  );
}

export default function Positions() {
  const { data: positions, isLoading } = useListPositions();
  const { prices: livePrices, connected } = useLivePrices();

  // Track previous PnL values for flash detection
  const prevPnlRef = useRef<Record<number, number>>({});

  const livePositions: LivePosition[] = useMemo(() => {
    if (!positions) return [];
    return positions.map(pos => {
      const tick = livePrices[pos.symbol];
      const livePrice = tick?.price ?? pos.currentPrice;
      const marketValue = livePrice * pos.quantity;
      const costBasis = pos.avgCost * pos.quantity;
      const unrealizedPnl = marketValue - costBasis;
      const unrealizedPnlPercent = costBasis !== 0 ? (unrealizedPnl / costBasis) * 100 : 0;
      const prevPnl = prevPnlRef.current[pos.id] ?? null;
      return {
        id: pos.id,
        symbol: pos.symbol,
        assetType: pos.assetType,
        quantity: pos.quantity,
        avgCost: pos.avgCost,
        strikePrice: pos.strikePrice,
        optionType: pos.optionType,
        expirationDate: pos.expirationDate,
        livePrice,
        marketValue,
        unrealizedPnl,
        unrealizedPnlPercent,
        prevPnl,
      };
    });
  }, [positions, livePrices]);

  // Update prevPnlRef after each render
  useEffect(() => {
    for (const pos of livePositions) {
      prevPnlRef.current[pos.id] = pos.unrealizedPnl;
    }
  }, [livePositions]);

  const totals = useMemo(() => {
    const totalMarketValue = livePositions.reduce((s, p) => s + p.marketValue, 0);
    const totalCostBasis = livePositions.reduce((s, p) => s + p.avgCost * p.quantity, 0);
    const totalPnl = totalMarketValue - totalCostBasis;
    const totalPnlPct = totalCostBasis !== 0 ? (totalPnl / totalCostBasis) * 100 : 0;
    return { totalMarketValue, totalPnl, totalPnlPct };
  }, [livePositions]);

  const isTotalUp = totals.totalPnl >= 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Open Positions</h1>
          <p className="text-muted-foreground">Live P&amp;L updates every 2 seconds via real-time stream.</p>
        </div>
        <div className={cn("flex items-center gap-1.5 text-xs mt-1", connected ? "text-success" : "text-muted-foreground")}>
          {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
          {connected ? "Live" : "Connecting..."}
        </div>
      </div>

      {/* Summary bar */}
      {!isLoading && livePositions.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <Card className="bg-card border-border">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground uppercase mb-1">Positions</p>
              <p className="text-2xl font-bold">{livePositions.length}</p>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground uppercase mb-1">Market Value</p>
              <p className="text-2xl font-bold">{formatCurrency(totals.totalMarketValue)}</p>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground uppercase mb-1">Unrealized P&amp;L</p>
              <div className="flex items-center gap-2">
                <p className={cn("text-2xl font-bold", isTotalUp ? "text-success" : "text-destructive")}>
                  {isTotalUp ? "+" : ""}{formatCurrency(totals.totalPnl)}
                </p>
                <div className={cn("flex items-center text-sm", isTotalUp ? "text-success" : "text-destructive")}>
                  {isTotalUp ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                  {Math.abs(totals.totalPnlPct).toFixed(2)}%
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" /> All Positions
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : !livePositions.length ? (
            <div className="text-center py-12 text-muted-foreground">
              You don't have any open positions right now.
            </div>
          ) : (
            <div className="rounded-md border border-border overflow-hidden">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Asset</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Avg Cost</TableHead>
                    <TableHead className="text-right">Live Price</TableHead>
                    <TableHead className="text-right">Market Value</TableHead>
                    <TableHead className="text-right">Unrealized P&amp;L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {livePositions.map((pos) => {
                    const isUp = pos.unrealizedPnl >= 0;
                    const tick = livePrices[pos.symbol];
                    const flashDir = tick?.direction ?? null;
                    return (
                      <TableRow key={pos.id} className="group">
                        <TableCell className="font-medium">
                          {pos.symbol}
                          {pos.assetType === "option" && (
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              {pos.strikePrice} {pos.optionType?.toUpperCase()}{" "}
                              {pos.expirationDate ? new Date(pos.expirationDate).toLocaleDateString() : ""}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="uppercase text-[10px]">{pos.assetType}</Badge>
                        </TableCell>
                        <TableCell className="text-right">{pos.quantity}</TableCell>
                        <TableCell className="text-right">{formatCurrency(pos.avgCost)}</TableCell>
                        <TableCell className="text-right">
                          <span className={cn(
                            "tabular-nums font-medium transition-colors duration-300",
                            flashDir === "up" && "text-success",
                            flashDir === "down" && "text-destructive",
                          )}>
                            {formatCurrency(pos.livePrice)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatCurrency(pos.marketValue)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className={cn("font-medium tabular-nums", isUp ? "text-success" : "text-destructive")}>
                            <FlashCell
                              value={pos.unrealizedPnl}
                              formatted={`${isUp ? "+" : ""}${formatCurrency(pos.unrealizedPnl)}`}
                              prevValue={pos.prevPnl}
                            />
                          </div>
                          <div className={cn("text-xs tabular-nums", isUp ? "text-success/80" : "text-destructive/80")}>
                            {isUp ? "+" : ""}{formatPercentage(pos.unrealizedPnlPercent)}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
