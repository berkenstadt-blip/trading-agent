import { useGetPortfolio, useListPositions, useListOrders, useGetWatchlist, useGetPerformance } from "@workspace/api-client-react";
import { formatCurrency, formatPercentage, cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Badge } from "@/components/ui/badge";
import { ArrowUpRight, ArrowDownRight, Activity, Wifi, WifiOff } from "lucide-react";
import { Link } from "wouter";
import { useLivePrices } from "@/context/live-prices";

function StatCard({ title, value, subValue, trend, isLoading }: { title: string, value: string, subValue?: string, trend?: "up" | "down" | "neutral", isLoading?: boolean }) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="p-6">
        <p className="text-sm font-medium text-muted-foreground mb-1">{title}</p>
        {isLoading ? (
          <Skeleton className="h-8 w-32" />
        ) : (
          <div className="flex items-baseline gap-2">
            <h3 className="text-2xl font-bold text-foreground">{value}</h3>
          </div>
        )}
        {subValue && !isLoading && (
          <div className="mt-1 flex items-center gap-1">
            {trend === "up" && <ArrowUpRight className="h-4 w-4 text-success" />}
            {trend === "down" && <ArrowDownRight className="h-4 w-4 text-destructive" />}
            <span className={cn(
              "text-sm font-medium",
              trend === "up" ? "text-success" : trend === "down" ? "text-destructive" : "text-muted-foreground"
            )}>
              {subValue}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { data: portfolio, isLoading: isPortfolioLoading } = useGetPortfolio();
  const { data: performance, isLoading: isPerformanceLoading } = useGetPerformance({ period: "1w" }, { query: { queryKey: ["performance", "1w"] } });
  const { data: positions, isLoading: isPositionsLoading } = useListPositions();
  const { data: orders, isLoading: isOrdersLoading } = useListOrders({ limit: 5 }, { query: { queryKey: ["orders", "limit5"] } });
  const { data: watchlist, isLoading: isWatchlistLoading } = useGetWatchlist();
  const { prices: livePrices, flash, connected } = useLivePrices();

  const isUp = (portfolio?.dayPnl || 0) >= 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">Welcome back. Here's your portfolio overview.</p>
        </div>
        <div className={cn("flex items-center gap-1.5 text-xs mt-1", connected ? "text-success" : "text-muted-foreground")}>
          {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
          {connected ? "Live" : "Connecting..."}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Value"
          value={formatCurrency(portfolio?.totalValue || 0)}
          isLoading={isPortfolioLoading}
        />
        <StatCard
          title="Day P&L"
          value={formatCurrency(portfolio?.dayPnl || 0)}
          subValue={`${isUp ? '+' : ''}${formatPercentage(portfolio?.dayPnlPercent || 0)}`}
          trend={isUp ? "up" : "down"}
          isLoading={isPortfolioLoading}
        />
        <StatCard
          title="Total P&L"
          value={formatCurrency(portfolio?.totalPnl || 0)}
          subValue={`${(portfolio?.totalPnl || 0) >= 0 ? '+' : ''}${formatPercentage(portfolio?.totalPnlPercent || 0)}`}
          trend={(portfolio?.totalPnl || 0) >= 0 ? "up" : "down"}
          isLoading={isPortfolioLoading}
        />
        <StatCard
          title="Cash Balance"
          value={formatCurrency(portfolio?.cashBalance || 0)}
          isLoading={isPortfolioLoading}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base font-medium">Performance (1W)</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isPerformanceLoading ? (
              <Skeleton className="h-[300px] w-full" />
            ) : (
              <div className="h-[300px] w-full mt-4">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={performance?.dataPoints || []} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis 
                      dataKey="date" 
                      tickFormatter={(val) => new Date(val).toLocaleDateString(undefined, { weekday: 'short' })}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis 
                      domain={['auto', 'auto']}
                      tickFormatter={(val) => `$${(val / 1000).toFixed(1)}k`}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                      width={60}
                    />
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                      itemStyle={{ color: 'hsl(var(--foreground))' }}
                      formatter={(val: number) => [formatCurrency(val), "Value"]}
                      labelFormatter={(label) => new Date(label).toLocaleString()}
                    />
                    <Area type="monotone" dataKey="portfolioValue" stroke="hsl(var(--primary))" strokeWidth={2} fillOpacity={1} fill="url(#colorValue)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium flex justify-between">
              <span>Watchlist</span>
              <Link href="/market" className="text-sm font-normal text-primary hover:underline">View All</Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isWatchlistLoading ? (
              <div className="space-y-4 mt-2">
                {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : watchlist?.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No items in watchlist.
              </div>
            ) : (
              <div className="space-y-4 mt-2">
                {watchlist?.map(item => {
                  const live = livePrices[item.symbol];
                  const price = live?.price ?? item.currentPrice ?? 0;
                  const change = live?.change ?? item.change ?? 0;
                  const changePct = live?.changePercent ?? item.changePercent ?? 0;
                  const isPositive = change >= 0;
                  const flashDir = flash[item.symbol];
                  return (
                    <div key={item.id} className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{item.symbol}</div>
                      </div>
                      <div className="text-right">
                        <div className={cn(
                          "font-medium tabular-nums transition-colors duration-300",
                          flashDir === "up" && "text-success",
                          flashDir === "down" && "text-destructive",
                          !flashDir && "text-foreground"
                        )}>
                          {formatCurrency(price)}
                        </div>
                        <div className={cn("text-xs flex items-center justify-end gap-1", isPositive ? "text-success" : "text-destructive")}>
                          {isPositive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                          {Math.abs(changePct).toFixed(2)}%
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium flex justify-between">
              <span>Active Positions</span>
              <Link href="/positions" className="text-sm font-normal text-primary hover:underline">View All</Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isPositionsLoading ? (
              <div className="space-y-4 mt-2">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : positions?.length === 0 ? (
               <div className="text-center py-8 text-muted-foreground text-sm">
                 No open positions.
               </div>
            ) : (
              <div className="mt-2 divide-y divide-border">
                {positions?.slice(0, 5).map(pos => {
                  const pnlUp = pos.unrealizedPnl >= 0;
                  return (
                    <div key={pos.id} className="py-3 flex justify-between items-center first:pt-0 last:pb-0">
                      <div>
                        <div className="font-medium flex items-center gap-2">
                          {pos.symbol}
                          <Badge variant="outline" className="text-[10px] h-4 px-1 uppercase">{pos.assetType}</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">{pos.quantity} @ {formatCurrency(pos.avgCost)}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-medium">{formatCurrency(pos.marketValue)}</div>
                        <div className={cn("text-sm", pnlUp ? "text-success" : "text-destructive")}>
                          {pnlUp ? '+' : ''}{formatCurrency(pos.unrealizedPnl)} ({formatPercentage(pos.unrealizedPnlPercent)})
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium flex justify-between">
              <span>Recent Orders</span>
              <Link href="/orders" className="text-sm font-normal text-primary hover:underline">View All</Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isOrdersLoading ? (
              <div className="space-y-4 mt-2">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : orders?.length === 0 ? (
               <div className="text-center py-8 text-muted-foreground text-sm">
                 No recent orders.
               </div>
            ) : (
              <div className="mt-2 divide-y divide-border">
                {orders?.map(order => (
                  <div key={order.id} className="py-3 flex justify-between items-center first:pt-0 last:pb-0">
                    <div>
                      <div className="font-medium flex items-center gap-2">
                        <span className={order.side === 'buy' ? 'text-success uppercase' : 'text-destructive uppercase'}>{order.side}</span>
                        {order.quantity} {order.symbol}
                      </div>
                      <div className="text-xs text-muted-foreground uppercase">{order.orderType} • {new Date(order.createdAt).toLocaleTimeString()}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium">
                        {order.status === 'filled' && order.filledPrice ? formatCurrency(order.filledPrice) : order.limitPrice ? formatCurrency(order.limitPrice) : 'MKT'}
                      </div>
                      <Badge variant="secondary" className={cn(
                        "text-[10px] h-5 mt-1",
                        order.status === 'filled' ? 'bg-success/20 text-success' : 
                        order.status === 'cancelled' || order.status === 'rejected' ? 'bg-destructive/20 text-destructive' : 'bg-muted'
                      )}>
                        {order.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
