import { useState, useMemo, useRef, useEffect } from "react";
import { useListPositions, usePlaceOrder, getListPositionsQueryKey, getListOrdersQueryKey } from "@workspace/api-client-react";
import { formatCurrency, formatPercentage, cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useLivePrices } from "@/context/live-prices";
import {
  ArrowUpRight, ArrowDownRight, Wifi, WifiOff, TrendingUp,
  PlusCircle, XCircle, ChevronRight,
} from "lucide-react";

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

interface TradeTarget {
  pos: LivePosition;
  intent: "buy" | "sell";
}

// Flashing P&L cell
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
      flash === "up" ? "text-success" : flash === "down" ? "text-destructive" : value >= 0 ? "text-success" : "text-destructive",
    )}>
      {formatted}
    </span>
  );
}

// ─── Trade Panel ────────────────────────────────────────────────────────────
function TradePanel({ target, onClose }: { target: TradeTarget | null; onClose: () => void }) {
  const { prices: livePrices } = useLivePrices();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [qty, setQty] = useState("1");
  const [limitPrice, setLimitPrice] = useState("");

  // Reset fields whenever target changes
  useEffect(() => {
    if (!target) return;
    setSide(target.intent);
    setOrderType("market");
    setQty(target.intent === "sell" ? String(target.pos.quantity) : "1");
    const live = livePrices[target.pos.symbol]?.price ?? target.pos.livePrice;
    setLimitPrice(live.toFixed(2));
  }, [target?.pos.id, target?.intent]); // eslint-disable-line react-hooks/exhaustive-deps

  const placeOrder = usePlaceOrder({
    mutation: {
      onSuccess: () => {
        toast({ title: "Order placed", description: `${side.toUpperCase()} ${qty} ${target?.pos.symbol}` });
        queryClient.invalidateQueries({ queryKey: getListPositionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey() });
        onClose();
      },
      onError: () => toast({ title: "Order failed", variant: "destructive" }),
    },
  });

  if (!target) return null;

  const { pos } = target;
  const livePrice = livePrices[pos.symbol]?.price ?? pos.livePrice;
  const parsedQty = Math.max(1, parseInt(qty) || 1);
  const execPrice = orderType === "limit" && limitPrice ? parseFloat(limitPrice) : livePrice;
  const estTotal = parsedQty * execPrice;

  // Estimated P&L for sell orders
  const costBasis = pos.avgCost * parsedQty;
  const estPnl = side === "sell" ? estTotal - costBasis : null;
  const isPnlPos = (estPnl ?? 0) >= 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    placeOrder.mutate({
      data: {
        symbol: pos.symbol,
        assetType: pos.assetType as "stock" | "option",
        side,
        orderType,
        quantity: parsedQty,
        limitPrice: orderType === "limit" && limitPrice ? parseFloat(limitPrice) : undefined,
      },
    });
  };

  const isClose = side === "sell" && parsedQty >= pos.quantity;

  return (
    <Sheet open={!!target} onOpenChange={open => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-md bg-card border-border flex flex-col gap-0 p-0">
        <SheetHeader className="p-6 pb-4 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold">{pos.symbol}</span>
            <Badge variant="outline" className="uppercase text-[10px]">{pos.assetType}</Badge>
            {pos.assetType === "option" && pos.strikePrice && (
              <span className="text-xs text-muted-foreground">
                {pos.strikePrice} {pos.optionType?.toUpperCase()} {pos.expirationDate ? new Date(pos.expirationDate).toLocaleDateString() : ""}
              </span>
            )}
          </div>
          <SheetDescription className="text-left mt-1">
            {pos.quantity} shares @ {formatCurrency(pos.avgCost)} avg cost
          </SheetDescription>
        </SheetHeader>

        {/* Position snapshot */}
        <div className="grid grid-cols-3 gap-3 p-6 pb-4">
          <div>
            <p className="text-[10px] uppercase text-muted-foreground mb-0.5">Live Price</p>
            <p className="text-base font-semibold tabular-nums">{formatCurrency(livePrice)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground mb-0.5">Market Value</p>
            <p className="text-base font-semibold tabular-nums">{formatCurrency(pos.marketValue)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground mb-0.5">Unrealized P&amp;L</p>
            <p className={cn("text-base font-semibold tabular-nums", pos.unrealizedPnl >= 0 ? "text-success" : "text-destructive")}>
              {pos.unrealizedPnl >= 0 ? "+" : ""}{formatCurrency(pos.unrealizedPnl)}
            </p>
          </div>
        </div>

        <Separator />

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Side toggle */}
          <div className="space-y-2">
            <Label>Action</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={side === "buy" ? "default" : "outline"}
                className={cn("h-10 font-semibold", side === "buy" && "bg-success hover:bg-success/90 text-success-foreground border-success")}
                onClick={() => { setSide("buy"); setQty("1"); }}
              >
                Buy / Add
              </Button>
              <Button
                type="button"
                variant={side === "sell" ? "default" : "outline"}
                className={cn("h-10 font-semibold", side === "sell" && "bg-destructive hover:bg-destructive/90 text-destructive-foreground border-destructive")}
                onClick={() => { setSide("sell"); setQty(String(pos.quantity)); }}
              >
                Sell / Close
              </Button>
            </div>
          </div>

          {/* Order type */}
          <div className="space-y-2">
            <Label>Order Type</Label>
            <Select value={orderType} onValueChange={v => setOrderType(v as "market" | "limit")}>
              <SelectTrigger className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="market">Market — execute at best available price</SelectItem>
                <SelectItem value="limit">Limit — specify exact price</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Quantity */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="trade-qty">Quantity</Label>
              {side === "sell" && (
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => setQty(String(pos.quantity))}
                >
                  Max ({pos.quantity})
                </button>
              )}
            </div>
            <Input
              id="trade-qty"
              type="number"
              min="1"
              max={side === "sell" ? pos.quantity : undefined}
              value={qty}
              onChange={e => setQty(e.target.value)}
              className="h-10 tabular-nums"
            />
            {side === "sell" && parsedQty > pos.quantity && (
              <p className="text-xs text-destructive">Cannot sell more than {pos.quantity} shares held.</p>
            )}
          </div>

          {/* Limit price */}
          {orderType === "limit" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="trade-limit">Limit Price</Label>
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => setLimitPrice(livePrice.toFixed(2))}
                >
                  Use live ({formatCurrency(livePrice)})
                </button>
              </div>
              <Input
                id="trade-limit"
                type="number"
                step="0.01"
                min="0.01"
                value={limitPrice}
                onChange={e => setLimitPrice(e.target.value)}
                className="h-10 tabular-nums"
              />
            </div>
          )}

          <Separator />

          {/* Order preview */}
          <div className="rounded-lg bg-muted/40 border border-border p-4 space-y-2.5">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Order Preview</p>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">
                {side === "buy" ? "Buying" : "Selling"} {parsedQty} × {pos.symbol}
              </span>
              <span className="font-semibold tabular-nums">{formatCurrency(execPrice)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Estimated {side === "buy" ? "cost" : "proceeds"}</span>
              <span className="font-bold tabular-nums">{formatCurrency(estTotal)}</span>
            </div>
            {estPnl !== null && (
              <div className="flex justify-between text-sm pt-1 border-t border-border">
                <span className="text-muted-foreground">Estimated P&amp;L</span>
                <span className={cn("font-bold tabular-nums", isPnlPos ? "text-success" : "text-destructive")}>
                  {isPnlPos ? "+" : ""}{formatCurrency(estPnl)} ({isPnlPos ? "+" : ""}{((estPnl / costBasis) * 100).toFixed(2)}%)
                </span>
              </div>
            )}
            {isClose && (
              <p className="text-[11px] text-muted-foreground pt-1">This order will fully close your {pos.symbol} position.</p>
            )}
          </div>

          <Button
            type="submit"
            className={cn(
              "w-full h-11 font-semibold text-base",
              side === "buy" ? "bg-success hover:bg-success/90 text-success-foreground" : "bg-destructive hover:bg-destructive/90 text-destructive-foreground",
            )}
            disabled={placeOrder.isPending || (side === "sell" && parsedQty > pos.quantity)}
          >
            {placeOrder.isPending ? "Placing order…" : (
              <span className="flex items-center gap-2">
                {side === "buy" ? <PlusCircle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                {side === "buy" ? `Buy ${parsedQty} ${pos.symbol}` : isClose ? `Close Position` : `Sell ${parsedQty} ${pos.symbol}`}
              </span>
            )}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────
export default function Positions() {
  const { data: positions, isLoading } = useListPositions();
  const { prices: livePrices, connected } = useLivePrices();
  const [tradeTarget, setTradeTarget] = useState<TradeTarget | null>(null);

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
        id: pos.id, symbol: pos.symbol, assetType: pos.assetType,
        quantity: pos.quantity, avgCost: pos.avgCost,
        strikePrice: pos.strikePrice, optionType: pos.optionType, expirationDate: pos.expirationDate,
        livePrice, marketValue, unrealizedPnl, unrealizedPnlPercent, prevPnl,
      };
    });
  }, [positions, livePrices]);

  useEffect(() => {
    for (const pos of livePositions) prevPnlRef.current[pos.id] = pos.unrealizedPnl;
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
          <p className="text-muted-foreground">Live P&amp;L — click any row to trade.</p>
        </div>
        <div className={cn("flex items-center gap-1.5 text-xs mt-1", connected ? "text-success" : "text-muted-foreground")}>
          {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
          {connected ? "Live" : "Connecting…"}
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
            <span className="ml-auto text-xs font-normal text-muted-foreground">Click a row to trade</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : !livePositions.length ? (
            <div className="text-center py-12 text-muted-foreground">
              No open positions right now.
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
                    <TableHead className="w-[120px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {livePositions.map(pos => {
                    const isUp = pos.unrealizedPnl >= 0;
                    const flashDir = livePrices[pos.symbol]?.direction ?? null;
                    return (
                      <TableRow
                        key={pos.id}
                        className="group cursor-pointer hover:bg-muted/40 transition-colors"
                        onClick={() => setTradeTarget({ pos, intent: "sell" })}
                      >
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
                        <TableCell className="text-right tabular-nums">{pos.quantity}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(pos.avgCost)}</TableCell>
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
                        {/* Quick-action buttons */}
                        <TableCell onClick={e => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs text-success border-success/40 hover:bg-success/10 hover:border-success"
                              onClick={e => { e.stopPropagation(); setTradeTarget({ pos, intent: "buy" }); }}
                            >
                              <PlusCircle className="h-3 w-3 mr-1" /> Add
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs text-destructive border-destructive/40 hover:bg-destructive/10 hover:border-destructive"
                              onClick={e => { e.stopPropagation(); setTradeTarget({ pos, intent: "sell" }); }}
                            >
                              <XCircle className="h-3 w-3 mr-1" /> Close
                            </Button>
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

      <TradePanel target={tradeTarget} onClose={() => setTradeTarget(null)} />
    </div>
  );
}
