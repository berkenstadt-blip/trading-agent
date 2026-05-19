import { useState } from "react";
import { useGetPerformance, useGetAnalyticsSummary, useGetAgentPerformance, getGetPerformanceQueryKey } from "@workspace/api-client-react";
import { formatCurrency, formatNumber, cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { TrendingUp, TrendingDown, Activity, Target } from "lucide-react";

const PERIODS = ["1d", "1w", "1m", "3m", "1y"] as const;
type Period = typeof PERIODS[number];

export default function Analytics() {
  const [period, setPeriod] = useState<Period>("1m");

  const { data: performance, isLoading: isPerformanceLoading } = useGetPerformance(
    { period },
    { query: { queryKey: getGetPerformanceQueryKey({ period }) } }
  );
  const { data: summary, isLoading: isSummaryLoading } = useGetAnalyticsSummary();
  const { data: agentPerf, isLoading: isAgentPerfLoading } = useGetAgentPerformance();

  const isReturn = (performance?.totalReturnPercent ?? 0) >= 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground">Portfolio performance and trading statistics.</p>
      </div>

      {/* Performance Chart */}
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4" /> Equity Curve
            </CardTitle>
            <Tabs value={period} onValueChange={(v) => setPeriod(v as Period)}>
              <TabsList className="h-8">
                {PERIODS.map(p => <TabsTrigger key={p} value={p} className="text-xs px-3 h-7 uppercase">{p}</TabsTrigger>)}
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent>
          {isPerformanceLoading ? (
            <Skeleton className="h-[300px] w-full" />
          ) : (
            <>
              <div className="flex items-center gap-6 mb-4">
                <div>
                  <p className="text-xs text-muted-foreground uppercase">Total Return</p>
                  <p className={cn("text-2xl font-bold", isReturn ? "text-success" : "text-destructive")}>
                    {isReturn ? "+" : ""}{formatCurrency(performance?.totalReturn ?? 0)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase">Return %</p>
                  <p className={cn("text-2xl font-bold", isReturn ? "text-success" : "text-destructive")}>
                    {isReturn ? "+" : ""}{(performance?.totalReturnPercent ?? 0).toFixed(2)}%
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase">Max Drawdown</p>
                  <p className="text-2xl font-bold text-destructive">
                    -{((performance?.maxDrawdown ?? 0) * 100).toFixed(2)}%
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase">Sharpe Ratio</p>
                  <p className="text-2xl font-bold">
                    {(performance?.sharpeRatio ?? 0).toFixed(2)}
                  </p>
                </div>
              </div>
              <div className="h-[280px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={performance?.dataPoints ?? []} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorEquity" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={val => {
                        const d = new Date(val);
                        return period === "1d" ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
                      }}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tickFormatter={val => `$${(val / 1000).toFixed(1)}k`}
                      domain={["auto", "auto"]}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      width={60}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
                      itemStyle={{ color: "hsl(var(--foreground))" }}
                      formatter={(val: number) => [formatCurrency(val), "Portfolio Value"]}
                      labelFormatter={label => new Date(label).toLocaleDateString()}
                    />
                    <Area type="monotone" dataKey="portfolioValue" stroke="hsl(var(--primary))" strokeWidth={2} fillOpacity={1} fill="url(#colorEquity)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Trading Summary */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Target className="h-4 w-4" /> Trading Statistics
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isSummaryLoading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-8 w-full" />)}
              </div>
            ) : (
              <div className="space-y-3">
                {[
                  { label: "Total Trades", value: summary?.totalTrades?.toString() ?? "0" },
                  { label: "Win Rate", value: `${(summary?.winRate ?? 0).toFixed(1)}%`, colored: true, up: (summary?.winRate ?? 0) >= 50 },
                  { label: "Winning / Losing", value: `${summary?.winningTrades ?? 0} / ${summary?.losingTrades ?? 0}` },
                  { label: "Avg Win", value: formatCurrency(summary?.avgWin ?? 0), colored: true, up: true },
                  { label: "Avg Loss", value: formatCurrency(summary?.avgLoss ?? 0), colored: true, up: false },
                  { label: "Profit Factor", value: (summary?.profitFactor ?? 0).toFixed(2), colored: true, up: (summary?.profitFactor ?? 0) >= 1 },
                  { label: "Best Trade", value: formatCurrency(summary?.bestTrade ?? 0), colored: true, up: true },
                  { label: "Worst Trade", value: formatCurrency(summary?.worstTrade ?? 0), colored: true, up: false },
                  { label: "Total Volume", value: formatCurrency(summary?.totalVolume ?? 0) },
                  { label: "Stock / Option Trades", value: `${summary?.stockTrades ?? 0} / ${summary?.optionTrades ?? 0}` },
                ].map(item => (
                  <div key={item.label} className="flex items-center justify-between py-1 border-b border-border last:border-0">
                    <p className="text-sm text-muted-foreground">{item.label}</p>
                    <p className={cn("text-sm font-semibold", item.colored && item.up ? "text-success" : item.colored && !item.up ? "text-destructive" : "")}>
                      {item.value}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Agent Performance Chart */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4" /> Agent Performance
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isAgentPerfLoading ? (
              <Skeleton className="h-[280px] w-full" />
            ) : !agentPerf?.length ? (
              <div className="text-center py-12 text-muted-foreground text-sm">No agent data.</div>
            ) : (
              <div className="h-[280px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={agentPerf} margin={{ top: 5, right: 5, left: 0, bottom: 40 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis
                      dataKey="agentName"
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      angle={-30}
                      textAnchor="end"
                    />
                    <YAxis
                      tickFormatter={val => formatCurrency(val)}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      width={80}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
                      formatter={(val: number) => [formatCurrency(val), "P&L"]}
                    />
                    <Bar dataKey="totalPnl" radius={[4, 4, 0, 0]}>
                      {agentPerf.map((entry, index) => (
                        <Cell key={index} fill={entry.totalPnl >= 0 ? "hsl(var(--success))" : "hsl(var(--destructive))"} fillOpacity={0.8} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
