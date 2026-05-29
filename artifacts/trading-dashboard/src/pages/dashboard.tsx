import { useGetPortfolio, useListPositions, useListOrders, useGetPerformance } from "@workspace/api-client-react";
import { formatCurrency, formatPercentage, cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { Badge } from "@/components/ui/badge";
import { ArrowUpRight, ArrowDownRight, Activity, Wifi, WifiOff, TrendingUp, Zap } from "lucide-react";
import { Link } from "wouter";
import { useLivePrices } from "@/context/live-prices";
import { useQuery } from "@tanstack/react-query";

function StatCard({ title, value, subValue, trend, accent, isLoading }: {
  title: string; value: string; subValue?: string;
  trend?: "up" | "down" | "neutral"; accent?: string; isLoading?: boolean;
}) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="p-5">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{title}</p>
        {isLoading ? <Skeleton className="h-8 w-32" /> : (
          <div className="flex items-baseline gap-2">
            <h3 className={cn("text-2xl font-bold", accent ?? "text-foreground")}>{value}</h3>
          </div>
        )}
        {subValue && !isLoading && (
          <div className="mt-1 flex items-center gap-1">
            {trend === "up" && <ArrowUpRight className="h-3.5 w-3.5 text-success" />}
            {trend === "down" && <ArrowDownRight className="h-3.5 w-3.5 text-destructive" />}
            <span className={cn("text-xs font-medium",
              trend === "up" ? "text-success" : trend === "down" ? "text-destructive" : "text-muted-foreground"
            )}>{subValue}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { data: portfolio, isLoading: isPortfolioLoading } = useGetPortfolio();
  const { data: performance, isLoading: isPerformanceLoading } = useGetPerformance(
    { period: "1w" }, { query: { queryKey: ["performance", "1w"] } }
  );
  const { data: positions, isLoading: isPositionsLoading } = useListPositions();
  const { data: orders, isLoading: isOrdersLoading } = useListOrders(
    { limit: 8 }, { query: { queryKey: ["orders", "limit8"] } }
  );
  const { data: summary } = useQuery({
    queryKey: ["analytics-summary"],
    queryFn: () => fetch("/api/analytics/summary").then(r => r.json()),
    refetchInterval: 30000,
  });
  const { data: optPerf } = useQuery({
    queryKey: ["options-performance"],
    queryFn: () => fetch("/api/analytics/options-performance").then(r => r.json()),
    refetchInterval: 30000,
  });
  const { prices: livePrices, connected } = useLivePrices();

  const isUp = (portfolio?.totalPnl || 0) >= 0;
  const optionPositions = positions?.filter(p => p.assetType === "option") ?? [];
  const stockPositions = positions?.filter(p => p.assetType === "stock") ?? [];
  const optPnl = optPerf?.summary?.totalPnl ?? 0;
  const optTrades = optPerf?.summary?.totalTrades ?? 0;
  const optWinRate = optPerf?.summary?.winRate ?? 0;

  const pieData = [
    { name: "Options P&L", value: Math.max(0, optPnl), color: "#8b5cf6" },
    { name: "Stock P&L", value: Math.max(0, (summary?.stockPnl ?? 0)), color: "#3b82f6" },
  ].filter(d => d.value > 0);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Aegis Terminal</h1>
          <p className="text-muted-foreground text-sm">AI-powered options & equity trading</p>
        </div>
        <div className={cn("flex items-center gap-1.5 text-xs mt-1", connected ? "text-success" : "text-muted-foreground")}>
          {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
          {connected ? "Live" : "Connecting..."}
        </div>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard title="Total Value" value={formatCurrency(portfolio?.totalValue || 0)} isLoading={isPortfolioLoading} />
        <StatCard
          title="Total P&L"
          value={formatCurrency(portfolio?.totalPnl || 0)}
          subValue={`${isUp ? "+" : ""}${formatPercentage(portfolio?.totalPnlPercent || 0)}`}
          trend={isUp ? "up" : "down"}
          accent={isUp ? "text-success" : "text-destructive"}
          isLoading={isPortfolioLoading}
        />
        <StatCard
          title="Options P&L"
          value={formatCurrency(optPnl)}
          subValue={`${optTrades} trades • ${optWinRate.toFixed(0)}% win`}
          trend={optPnl >= 0 ? "up" : "down"}
          accent={optPnl >= 0 ? "text-violet-400" : "text-destructive"}
          isLoading={false}
        />
        <StatCard title="Cash" value={formatCurrency(portfolio?.cashBalance || 0)} isLoading={isPortfolioLoading} />
      </div>

      {/* Options highlight bar */}
      {optTrades > 0 && (
        <Card className="border-violet-500/30 bg-violet-950/20">
          <CardContent className="p-4">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-violet-400" />
                <span className="text-sm font-semibold text-violet-300">Options Engine</span>
              </div>
              <div className="flex items-center gap-6 text-sm">
                <div>
                  <span className="text-muted-foreground">Positions: </span>
                  <span className="font-bold text-foreground">{optionPositions.length}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Trades: </span>
                  <span className="font-bold text-foreground">{optTrades}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Win Rate: </span>
                  <span className={cn("font-bold", optWinRate >= 50 ? "text-success" : "text-destructive")}>{optWinRate.toFixed(1)}%</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Total P&L: </span>
                  <span className={cn("font-bold", optPnl >= 0 ? "text-success" : "text-destructive")}>
                    {optPnl >= 0 ? "+" : ""}{formatCurrency(optPnl)}
                  </span>
                </div>
              </div>
              <Link href="/analytics" className="text-xs text-violet-400 hover:underline">View Options Analytics →</Link>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Equity curve */}
        <Card className="lg:col-span-2 border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base font-medium">Portfolio Performance (1W)</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isPerformanceLoading ? <Skeleton className="h-[260px] w-full" /> : (
              <div className="h-[260px] w-full mt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={performance?.dataPoints || []} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { weekday: "short" })}
                      stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis domain={["auto", "auto"]} tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`}
                      stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} width={55} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
                      formatter={(v: number) => [formatCurrency(v), "Value"]}
                      labelFormatter={(l) => new Date(l).toLocaleDateString()} />
                    <Area type="monotone" dataKey="portfolioValue" stroke="hsl(var(--primary))" strokeWidth={2} fillOpacity={1} fill="url(#colorValue)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* P&L breakdown */}
        <div className="flex flex-col gap-5">
          {pieData.length > 0 && (
            <Card className="border-border bg-card">
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-medium">P&L Breakdown</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col items-center gap-3 pb-4">
                <PieChart width={120} height={120}>
                  <Pie data={pieData} cx={55} cy={55} innerRadius={35} outerRadius={55} dataKey="value" strokeWidth={0}>
                    {pieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                </PieChart>
                <div className="flex flex-col gap-1.5 w-full">
                  {pieData.map(d => (
                    <div key={d.name} className="flex justify-between items-center text-xs">
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full" style={{ background: d.color }} />
                        {d.name}
                      </span>
                      <span className="font-semibold text-success">+{formatCurrency(d.value)}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="border-border bg-card flex-1">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex justify-between">
                <span>Positions ({(positions?.length ?? 0)})</span>
                <Link href="/positions" className="text-xs font-normal text-primary hover:underline">All →</Link>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {isPositionsLoading ? [1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />) :
                positions?.slice(0, 4).map(pos => {
                  const pnlUp = pos.unrealizedPnl >= 0;
                  const isOpt = pos.assetType === "option";
                  return (
                    <div key={pos.id} className="flex justify-between items-center py-1">
                      <div>
                        <div className="text-sm font-medium flex items-center gap-1.5">
                          {pos.symbol}
                          {isOpt && <Badge className="text-[9px] h-3.5 px-1 bg-violet-500/20 text-violet-300 border-0">OPT</Badge>}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {isOpt ? `${pos.strikePrice} ${pos.optionType?.toUpperCase()} • ${pos.quantity}c` : `${pos.quantity} shares`}
                        </div>
                      </div>
                      <div className={cn("text-sm font-semibold tabular-nums", pnlUp ? "text-success" : "text-destructive")}>
                        {pnlUp ? "+" : ""}{formatCurrency(pos.unrealizedPnl)}
                      </div>
                    </div>
                  );
                })}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Recent orders */}
      <Card className="border-border bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex justify-between">
            <span className="flex items-center gap-2"><TrendingUp className="h-4 w-4" /> Recent Activity</span>
            <Link href="/orders" className="text-xs font-normal text-primary hover:underline">All Orders →</Link>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isOrdersLoading ? <Skeleton className="h-32 w-full" /> : (
            <div className="divide-y divide-border">
              {orders?.slice(0, 6).map(order => {
                const isOpt = order.assetType === "option";
                return (
                  <div key={order.id} className="py-2.5 flex justify-between items-center first:pt-0 last:pb-0">
                    <div className="flex items-center gap-3">
                      <span className={cn("text-xs font-bold uppercase px-2 py-0.5 rounded",
                        order.side === "buy" ? "bg-success/20 text-success" : "bg-destructive/20 text-destructive"
                      )}>{order.side}</span>
                      <div>
                        <div className="text-sm font-medium flex items-center gap-1.5">
                          {order.symbol}
                          {isOpt && <Badge className="text-[9px] h-3.5 px-1 bg-violet-500/20 text-violet-300 border-0">OPT</Badge>}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {order.quantity} {isOpt ? "contracts" : "shares"} • {new Date(order.createdAt).toLocaleTimeString()}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-medium tabular-nums">
                        {order.filledPrice ? formatCurrency(order.filledPrice) : "—"}
                      </div>
                      <Badge className={cn("text-[9px] h-4 px-1.5",
                        order.status === "filled" ? "bg-success/20 text-success border-0" :
                        order.status === "simulated" ? "bg-violet-500/20 text-violet-300 border-0" :
                        "bg-muted text-muted-foreground border-0"
                      )}>{order.status}</Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
