import { useState } from "react";
import {
  useGetPerformance, useGetAnalyticsSummary, useGetAgentPerformance,
  useGetAgentHistory, getGetPerformanceQueryKey, getGetAgentHistoryQueryKey,
} from "@workspace/api-client-react";
import { formatCurrency, cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend,
} from "recharts";
import { Activity, Target, Bot, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const PERIODS = ["1d", "1w", "1m", "3m", "1y"] as const;
const HISTORY_PERIODS = ["1w", "1m", "3m", "1y"] as const;
type Period = typeof PERIODS[number];
type HistoryPeriod = typeof HISTORY_PERIODS[number];

// Custom tooltip for the multi-line agent chart
function AgentHistoryTooltip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover p-3 shadow-md text-xs space-y-1.5 min-w-[160px]">
      <p className="text-muted-foreground font-medium mb-1">{label ? new Date(label).toLocaleDateString([], { month: "short", day: "numeric" }) : ""}</p>
      {payload.map(p => (
        <div key={p.name} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color }} />
            <span className="text-foreground truncate max-w-[100px]">{p.name}</span>
          </span>
          <span className={cn("font-semibold tabular-nums", p.value >= 0 ? "text-success" : "text-destructive")}>
            {p.value >= 0 ? "+" : ""}{formatCurrency(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function Analytics() {
  const [period, setPeriod] = useState<Period>("1m");
  const [histPeriod, setHistPeriod] = useState<HistoryPeriod>("1m");

  const { data: performance, isLoading: isPerformanceLoading } = useGetPerformance(
    { period },
    { query: { queryKey: getGetPerformanceQueryKey({ period }) } }
  );
  const { data: summary, isLoading: isSummaryLoading } = useGetAnalyticsSummary();
  const { data: agentPerf, isLoading: isAgentPerfLoading } = useGetAgentPerformance();
  const { data: agentHistory, isLoading: isAgentHistoryLoading } = useGetAgentHistory(
    { period: histPeriod },
    { query: { queryKey: getGetAgentHistoryQueryKey({ period: histPeriod }) } }
  );

  const isReturn = (performance?.totalReturnPercent ?? 0) >= 0;
  const dataPoints = (agentHistory?.dataPoints ?? []) as Record<string, number | string>[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground">Portfolio performance and trading statistics.</p>
      </div>

      {/* Equity Curve */}
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
              <div className="flex flex-wrap items-center gap-6 mb-4">
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
                  <p className="text-2xl font-bold">{(performance?.sharpeRatio ?? 0).toFixed(2)}</p>
                </div>
              </div>
              <div className="h-[260px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={performance?.dataPoints ?? []} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorEquity" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={val => { const d = new Date(val); return period === "1d" ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" }); }} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                    <YAxis tickFormatter={val => `$${(val / 1000).toFixed(1)}k`} domain={["auto", "auto"]} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} width={60} />
                    <Tooltip contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }} itemStyle={{ color: "hsl(var(--foreground))" }} formatter={(val: number) => [formatCurrency(val), "Portfolio Value"]} labelFormatter={label => new Date(label).toLocaleDateString()} />
                    <Area type="monotone" dataKey="portfolioValue" stroke="hsl(var(--primary))" strokeWidth={2} fillOpacity={1} fill="url(#colorEquity)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Agent Cumulative P&L History — full width */}
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Bot className="h-4 w-4" /> Agent Cumulative P&amp;L History
            </CardTitle>
            <Tabs value={histPeriod} onValueChange={(v) => setHistPeriod(v as HistoryPeriod)}>
              <TabsList className="h-8">
                {HISTORY_PERIODS.map(p => <TabsTrigger key={p} value={p} className="text-xs px-3 h-7 uppercase">{p}</TabsTrigger>)}
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent>
          {isAgentHistoryLoading ? (
            <Skeleton className="h-[340px] w-full" />
          ) : !agentHistory?.agents?.length ? (
            <div className="text-center py-16 text-muted-foreground text-sm">No agent data. Create some agents and run them to see history.</div>
          ) : (
            <>
              {/* Agent legend */}
              <div className="flex flex-wrap gap-3 mb-4">
                {agentHistory.agents.map(agent => (
                  <div key={agent.id} className="flex items-center gap-1.5 text-xs">
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: agent.color }} />
                    <span className="text-foreground font-medium">{agent.name}</span>
                    <Badge variant="outline" className="text-[9px] h-4 px-1 capitalize border-muted-foreground/30 text-muted-foreground">
                      {agent.strategy.replace(/_/g, " ")}
                    </Badge>
                  </div>
                ))}
              </div>
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={dataPoints} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={val => new Date(val as string).toLocaleDateString([], { month: "short", day: "numeric" })}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11} tickLine={false} axisLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tickFormatter={val => `$${val >= 0 ? "" : "-"}${Math.abs(val / 1000).toFixed(1)}k`}
                      domain={["auto", "auto"]}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11} tickLine={false} axisLine={false}
                      width={64}
                    />
                    {/* Zero reference line */}
                    <CartesianGrid stroke="hsl(var(--border))" horizontal={false} />
                    <Tooltip content={<AgentHistoryTooltip />} />
                    {agentHistory.agents.map(agent => (
                      <Line
                        key={agent.id}
                        type="monotone"
                        dataKey={agent.name}
                        stroke={agent.color}
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 0 }}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Trading Statistics */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Target className="h-4 w-4" /> Trading Statistics
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isSummaryLoading ? (
              <div className="space-y-3">{[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
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

        {/* Agent P&L Bar Chart */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4" /> Agent Total P&amp;L
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
                    <XAxis dataKey="agentName" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} angle={-30} textAnchor="end" />
                    <YAxis tickFormatter={val => formatCurrency(val)} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} width={80} />
                    <Tooltip contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }} formatter={(val: number) => [formatCurrency(val), "Total P&L"]} />
                    <Bar dataKey="totalPnl" radius={[4, 4, 0, 0]}>
                      {agentPerf.map((entry, index) => (
                        <Cell key={index} fill={entry.totalPnl >= 0 ? "hsl(var(--success))" : "hsl(var(--destructive))"} fillOpacity={0.85} />
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
