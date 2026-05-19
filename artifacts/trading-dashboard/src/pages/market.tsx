import { useState } from "react";
import { useGetQuote, useGetWatchlist, useAddToWatchlist, useRemoveFromWatchlist, getGetWatchlistQueryKey, getGetQuoteQueryKey } from "@workspace/api-client-react";
import { formatCurrency, formatNumber, cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Search, Plus, Trash2, ArrowUpRight, ArrowDownRight, TrendingUp } from "lucide-react";

export default function Market() {
  const [searchSymbol, setSearchSymbol] = useState("");
  const [activeSymbol, setActiveSymbol] = useState<string | undefined>(undefined);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: quote, isLoading: isQuoteLoading } = useGetQuote(
    { symbol: activeSymbol ?? "" },
    { query: { enabled: !!activeSymbol, queryKey: getGetQuoteQueryKey({ symbol: activeSymbol ?? "" }) } }
  );

  const { data: watchlist, isLoading: isWatchlistLoading } = useGetWatchlist();

  const addToWatchlist = useAddToWatchlist({
    mutation: {
      onSuccess: () => {
        toast({ title: "Added to watchlist" });
        queryClient.invalidateQueries({ queryKey: getGetWatchlistQueryKey() });
      },
      onError: () => toast({ title: "Failed to add to watchlist", variant: "destructive" }),
    }
  });

  const removeFromWatchlist = useRemoveFromWatchlist({
    mutation: {
      onSuccess: () => {
        toast({ title: "Removed from watchlist" });
        queryClient.invalidateQueries({ queryKey: getGetWatchlistQueryKey() });
      },
    }
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchSymbol.trim()) setActiveSymbol(searchSymbol.trim().toUpperCase());
  };

  const inWatchlist = watchlist?.some(w => w.symbol === activeSymbol);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Market Data</h1>
        <p className="text-muted-foreground">Search for quotes and manage your watchlist.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Search + Quote Panel */}
        <div className="lg:col-span-2 space-y-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Symbol Lookup</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <form onSubmit={handleSearch} className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="pl-9 uppercase"
                    placeholder="AAPL, MSFT, SPY..."
                    value={searchSymbol}
                    onChange={e => setSearchSymbol(e.target.value.toUpperCase())}
                    data-testid="input-symbol-search"
                  />
                </div>
                <Button type="submit" data-testid="button-search-symbol">
                  Get Quote
                </Button>
              </form>

              {isQuoteLoading && <Skeleton className="h-40 w-full" />}

              {quote && !isQuoteLoading && (
                <div className="rounded-lg border border-border bg-muted/30 p-5">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-2xl font-bold">{quote.symbol}</h2>
                        {!inWatchlist ? (
                          <Button
                            size="sm" variant="outline" className="h-7 text-xs gap-1"
                            onClick={() => addToWatchlist.mutate({ data: { symbol: quote.symbol } })}
                            disabled={addToWatchlist.isPending}
                            data-testid="button-add-watchlist"
                          >
                            <Plus className="h-3 w-3" /> Watchlist
                          </Button>
                        ) : (
                          <Badge variant="outline" className="text-[10px] border-primary text-primary">In Watchlist</Badge>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-3xl font-bold">{formatCurrency(quote.price)}</p>
                      <div className={cn("flex items-center justify-end gap-1 mt-1", quote.change >= 0 ? "text-success" : "text-destructive")}>
                        {quote.change >= 0 ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                        <span className="font-medium">{quote.change >= 0 ? "+" : ""}{formatCurrency(quote.change)} ({Math.abs(quote.changePercent).toFixed(2)}%)</span>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {[
                      { label: "Open", value: formatCurrency(quote.open) },
                      { label: "High", value: formatCurrency(quote.high) },
                      { label: "Low", value: formatCurrency(quote.low) },
                      { label: "Prev Close", value: formatCurrency(quote.previousClose) },
                      { label: "Volume", value: formatNumber(quote.volume, 0) },
                      { label: "Change %", value: `${quote.changePercent >= 0 ? "+" : ""}${quote.changePercent.toFixed(2)}%` },
                    ].map(item => (
                      <div key={item.label}>
                        <p className="text-[11px] text-muted-foreground uppercase">{item.label}</p>
                        <p className="text-sm font-semibold mt-0.5">{item.value}</p>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-3">
                    Last updated: {new Date(quote.timestamp).toLocaleTimeString()}
                  </p>
                </div>
              )}

              {!activeSymbol && !isQuoteLoading && (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  Enter a symbol above to look up a real-time quote.
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Watchlist */}
        <div>
          <Card className="bg-card border-border h-full">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="h-4 w-4" /> Watchlist
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isWatchlistLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-12 w-full" />)}
                </div>
              ) : watchlist?.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  No items. Search for a symbol and add it to your watchlist.
                </div>
              ) : (
                <div className="space-y-2">
                  {watchlist?.map(item => {
                    const isUp = (item.change ?? 0) >= 0;
                    return (
                      <div
                        key={item.id}
                        className="flex items-center justify-between p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors cursor-pointer group"
                        onClick={() => { setActiveSymbol(item.symbol); setSearchSymbol(item.symbol); }}
                        data-testid={`watchlist-item-${item.symbol}`}
                      >
                        <div>
                          <p className="font-medium text-sm">{item.symbol}</p>
                          <div className={cn("flex items-center gap-0.5 text-xs", isUp ? "text-success" : "text-destructive")}>
                            {isUp ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                            {Math.abs(item.changePercent ?? 0).toFixed(2)}%
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="text-right">
                            <p className="text-sm font-semibold">{item.currentPrice ? formatCurrency(item.currentPrice) : "—"}</p>
                            <p className={cn("text-xs", isUp ? "text-success" : "text-destructive")}>
                              {isUp ? "+" : ""}{formatCurrency(item.change ?? 0)}
                            </p>
                          </div>
                          <Button
                            variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                            onClick={e => { e.stopPropagation(); removeFromWatchlist.mutate({ symbol: item.symbol }); }}
                            data-testid={`button-remove-watchlist-${item.symbol}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
