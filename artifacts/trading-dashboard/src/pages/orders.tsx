import { useState, useRef, useEffect } from "react";
import {
  useListOrders, usePlaceOrder, useCancelOrder,
  getListOrdersQueryKey, getListPositionsQueryKey,
  getQuote, type MarketQuote,
} from "@workspace/api-client-react";
import { formatCurrency, formatDateTime, cn } from "@/lib/utils";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  PlusCircle, Search, TrendingUp, TrendingDown,
  ArrowUpRight, ArrowDownRight, Loader2, RefreshCw,
} from "lucide-react";

type OrderStatusFilter = "pending" | "filled" | "cancelled" | "all";

// ─── New Trade Sheet ──────────────────────────────────────────────────────────
function NewTradeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [symbolInput, setSymbolInput] = useState("");
  const [quote, setQuote] = useState<MarketQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"market" | "limit" | "stop">("market");
  const [qty, setQty] = useState("1");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");

  const symbolRef = useRef<HTMLInputElement>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setSymbolInput("");
      setQuote(null);
      setQuoteError(null);
      setSide("buy");
      setOrderType("market");
      setQty("1");
      setLimitPrice("");
      setStopPrice("");
      setTimeout(() => symbolRef.current?.focus(), 100);
    }
  }, [open]);

  async function lookupQuote(sym?: string) {
    const s = (sym ?? symbolInput).trim().toUpperCase();
    if (!s) return;
    setQuoteLoading(true);
    setQuoteError(null);
    setQuote(null);
    try {
      const data = await getQuote({ symbol: s });
      setQuote(data);
      setLimitPrice(data.price.toFixed(2));
      setStopPrice(data.price.toFixed(2));
    } catch {
      setQuoteError(`Could not find a quote for "${s}". Check the symbol.`);
    } finally {
      setQuoteLoading(false);
    }
  }

  const placeOrder = usePlaceOrder({
    mutation: {
      onSuccess: (data: any) => {
        const filled = data?.status === "filled";
        toast({
          title: filled ? "Order filled" : "Order placed",
          description: `${side.toUpperCase()} ${qty} ${quote?.symbol ?? symbolInput.toUpperCase()}${filled && data?.filledPrice ? ` @ ${formatCurrency(data.filledPrice)}` : ""}`,
        });
        queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListPositionsQueryKey() });
        onClose();
      },
      onError: (err: any) => {
        const msg = err?.response?.data?.error ?? err?.message ?? "Order rejected";
        toast({ title: "Order failed", description: msg, variant: "destructive" });
      },
    },
  });

  const parsedQty = Math.max(1, parseInt(qty) || 1);
  const execPrice = orderType === "market"
    ? (quote?.price ?? 0)
    : orderType === "limit"
      ? (parseFloat(limitPrice) || quote?.price || 0)
      : (parseFloat(stopPrice) || quote?.price || 0);
  const estTotal = parsedQty * execPrice;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const sym = (quote?.symbol ?? symbolInput).trim().toUpperCase();
    if (!sym || parsedQty < 1) return;
    placeOrder.mutate({
      data: {
        symbol: sym,
        assetType: "stock",
        side,
        orderType,
        quantity: parsedQty,
        limitPrice: orderType === "limit" && limitPrice ? parseFloat(limitPrice) : undefined,
        stopPrice: orderType === "stop" && stopPrice ? parseFloat(stopPrice) : undefined,
      },
    });
  }

  const isUp = (quote?.change ?? 0) >= 0;
  const canSubmit = !!quote && parsedQty >= 1 && !placeOrder.isPending;

  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-md bg-card border-border flex flex-col gap-0 p-0">
        <SheetHeader className="p-6 pb-4 border-b border-border">
          <SheetTitle className="flex items-center gap-2">
            <PlusCircle className="h-5 w-5" /> New Trade
          </SheetTitle>
          <SheetDescription className="text-left">
            Look up a symbol to get the live Alpaca price before placing your order.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Symbol Lookup */}
          <div className="space-y-2">
            <Label htmlFor="new-trade-symbol">Symbol</Label>
            <div className="flex gap-2">
              <Input
                id="new-trade-symbol"
                ref={symbolRef}
                placeholder="AAPL, MSFT, NVDA…"
                value={symbolInput}
                onChange={e => setSymbolInput(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === "Enter" && (e.preventDefault(), lookupQuote())}
                className="uppercase font-mono tracking-widest"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => lookupQuote()}
                disabled={quoteLoading || !symbolInput.trim()}
                className="shrink-0"
              >
                {quoteLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">Press Enter or click the search icon to fetch live price.</p>
          </div>

          {/* Quote card */}
          {quoteError && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive">
              {quoteError}
            </div>
          )}

          {quote && (
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xl font-bold font-mono">{quote.symbol}</p>
                  <p className="text-[11px] text-muted-foreground uppercase mt-0.5">
                    {(quote as any).source === "alpaca" ? "Live · Alpaca IEX" : "Simulated"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-bold tabular-nums">{formatCurrency(quote.price)}</p>
                  <div className={cn("flex items-center justify-end gap-1 text-sm font-medium", isUp ? "text-success" : "text-destructive")}>
                    {isUp ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                    {isUp ? "+" : ""}{formatCurrency(quote.change)} ({isUp ? "+" : ""}{quote.changePercent.toFixed(2)}%)
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 pt-1 border-t border-border text-center">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Open</p>
                  <p className="text-xs font-medium tabular-nums">{formatCurrency(quote.open)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">High</p>
                  <p className="text-xs font-medium tabular-nums text-success">{formatCurrency(quote.high)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Low</p>
                  <p className="text-xs font-medium tabular-nums text-destructive">{formatCurrency(quote.low)}</p>
                </div>
              </div>
              <button
                type="button"
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => lookupQuote(quote.symbol)}
              >
                <RefreshCw className="h-3 w-3" /> Refresh price
              </button>
            </div>
          )}

          {quote && (
            <form onSubmit={handleSubmit} className="space-y-5">
              <Separator />

              {/* Buy / Sell toggle */}
              <div className="space-y-2">
                <Label>Action</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant={side === "buy" ? "default" : "outline"}
                    className={cn("h-10 font-semibold", side === "buy" && "bg-success hover:bg-success/90 text-success-foreground border-success")}
                    onClick={() => setSide("buy")}
                  >
                    <TrendingUp className="h-4 w-4 mr-1.5" /> Buy
                  </Button>
                  <Button
                    type="button"
                    variant={side === "sell" ? "default" : "outline"}
                    className={cn("h-10 font-semibold", side === "sell" && "bg-destructive hover:bg-destructive/90 text-destructive-foreground border-destructive")}
                    onClick={() => setSide("sell")}
                  >
                    <TrendingDown className="h-4 w-4 mr-1.5" /> Sell
                  </Button>
                </div>
              </div>

              {/* Order type */}
              <div className="space-y-2">
                <Label>Order Type</Label>
                <Select value={orderType} onValueChange={v => setOrderType(v as typeof orderType)}>
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="market">Market — fill at best available price</SelectItem>
                    <SelectItem value="limit">Limit — specify a maximum price</SelectItem>
                    <SelectItem value="stop">Stop — trigger at a stop price</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Quantity */}
              <div className="space-y-2">
                <Label htmlFor="nt-qty">Quantity (shares)</Label>
                <Input
                  id="nt-qty"
                  type="number"
                  min="1"
                  value={qty}
                  onChange={e => setQty(e.target.value)}
                  className="h-10 tabular-nums"
                />
              </div>

              {/* Limit price */}
              {orderType === "limit" && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="nt-limit">Limit Price</Label>
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => setLimitPrice(quote.price.toFixed(2))}
                    >
                      Use live ({formatCurrency(quote.price)})
                    </button>
                  </div>
                  <Input
                    id="nt-limit"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={limitPrice}
                    onChange={e => setLimitPrice(e.target.value)}
                    className="h-10 tabular-nums"
                  />
                </div>
              )}

              {/* Stop price */}
              {orderType === "stop" && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="nt-stop">Stop Price</Label>
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => setStopPrice(quote.price.toFixed(2))}
                    >
                      Use live ({formatCurrency(quote.price)})
                    </button>
                  </div>
                  <Input
                    id="nt-stop"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={stopPrice}
                    onChange={e => setStopPrice(e.target.value)}
                    className="h-10 tabular-nums"
                  />
                </div>
              )}

              <Separator />

              {/* Order preview */}
              <div className="rounded-lg bg-muted/40 border border-border p-4 space-y-2.5">
                <p className="text-xs font-semibold uppercase text-muted-foreground">Order Preview</p>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{side === "buy" ? "Buying" : "Selling"} {parsedQty} × {quote.symbol}</span>
                  <span className="font-semibold tabular-nums">{formatCurrency(execPrice || 0)}</span>
                </div>
                {orderType === "market" && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Order type</span>
                    <span className="text-muted-foreground">Market (fills immediately)</span>
                  </div>
                )}
                <div className="flex justify-between text-sm pt-1 border-t border-border">
                  <span className="text-muted-foreground font-medium">Estimated {side === "buy" ? "cost" : "proceeds"}</span>
                  <span className="font-bold tabular-nums">{execPrice > 0 ? formatCurrency(estTotal) : "—"}</span>
                </div>
              </div>

              <Button
                type="submit"
                className={cn(
                  "w-full h-11 font-semibold text-base",
                  side === "buy"
                    ? "bg-success hover:bg-success/90 text-success-foreground"
                    : "bg-destructive hover:bg-destructive/90 text-destructive-foreground",
                )}
                disabled={!canSubmit}
              >
                {placeOrder.isPending
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Placing…</>
                  : <>{side === "buy" ? <TrendingUp className="h-4 w-4 mr-2" /> : <TrendingDown className="h-4 w-4 mr-2" />}
                    {side === "buy" ? "Buy" : "Sell"} {parsedQty} {quote.symbol}
                  </>
                }
              </Button>
            </form>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Orders() {
  const [filter, setFilter] = useState<OrderStatusFilter>("all");
  const [sheetOpen, setSheetOpen] = useState(false);

  const { data: orders, isLoading } = useListOrders(
    filter !== "all" ? { status: filter } : undefined,
    { query: { queryKey: ["orders", filter] } }
  );

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const cancelMutation = useCancelOrder({
    mutation: {
      onSuccess: () => {
        toast({ title: "Order cancelled" });
        queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Failed to cancel order", description: err.message, variant: "destructive" });
      },
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Order Management</h1>
          <p className="text-muted-foreground">Place trades and view your Alpaca order history.</p>
        </div>
        <Button
          className="shrink-0 bg-success hover:bg-success/90 text-success-foreground font-semibold gap-2 mt-1"
          onClick={() => setSheetOpen(true)}
        >
          <PlusCircle className="h-4 w-4" /> New Trade
        </Button>
      </div>

      {/* Order history */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle>Order History</CardTitle>
            <Tabs value={filter} onValueChange={v => setFilter(v as OrderStatusFilter)} className="w-auto">
              <TabsList className="grid grid-cols-4 h-9 w-auto">
                <TabsTrigger value="all" className="text-xs px-3">All</TabsTrigger>
                <TabsTrigger value="pending" className="text-xs px-3">Pending</TabsTrigger>
                <TabsTrigger value="filled" className="text-xs px-3">Filled</TabsTrigger>
                <TabsTrigger value="cancelled" className="text-xs px-3">Cancelled</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : !orders?.length ? (
            <div className="text-center py-16 text-muted-foreground">
              <p className="mb-3">No orders found.</p>
              <Button variant="outline" size="sm" onClick={() => setSheetOpen(true)}>
                <PlusCircle className="h-3.5 w-3.5 mr-1.5" /> Place your first trade
              </Button>
            </div>
          ) : (
            <div className="rounded-md border border-border overflow-auto max-h-[560px]">
              <Table>
                <TableHeader className="bg-muted/50 sticky top-0 z-10">
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Side / Qty</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map(order => (
                    <TableRow key={order.id}>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                        {formatDateTime(order.createdAt)}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{order.symbol}</div>
                        <div className="text-[10px] text-muted-foreground uppercase">{order.assetType}</div>
                      </TableCell>
                      <TableCell>
                        <span className={cn(
                          "font-bold uppercase text-sm",
                          order.side === "buy" ? "text-success" : "text-destructive"
                        )}>
                          {order.side}
                        </span>
                        <span className="text-sm font-medium ml-1.5">{order.quantity}</span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground uppercase">
                        {order.orderType}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {order.status === "filled" && order.filledPrice
                          ? <span className="font-medium">{formatCurrency(order.filledPrice)}</span>
                          : order.limitPrice
                            ? <span className="text-muted-foreground">{formatCurrency(order.limitPrice)} limit</span>
                            : <span className="text-muted-foreground text-xs">MKT</span>
                        }
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn(
                          "uppercase text-[10px] font-semibold",
                          order.status === "filled" ? "border-success text-success" :
                          order.status === "cancelled" || order.status === "rejected" ? "border-destructive/60 text-destructive" :
                          "border-primary text-primary"
                        )}>
                          {order.status}
                        </Badge>
                        {order.agentName && (
                          <div className="text-[10px] text-muted-foreground mt-0.5 truncate max-w-[90px]" title={`By ${order.agentName}`}>
                            {order.agentName}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {order.status === "pending" && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs text-destructive border-destructive/40 hover:bg-destructive/10 hover:border-destructive"
                            onClick={() => cancelMutation.mutate({ id: order.id })}
                            disabled={cancelMutation.isPending}
                          >
                            Cancel
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <NewTradeSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </div>
  );
}
