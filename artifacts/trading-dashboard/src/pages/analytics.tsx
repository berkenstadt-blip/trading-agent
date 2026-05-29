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
import { Activity, Target, Bot, TrendingUp, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";

const PERIODS = ["1d", "1w", "1m", "3m", "1y"] as const;
const HISTORY_PERIODS = ["1w", "1m", "3m", "1y"] as const;
type Period = typeof PERIODS[number];
type HistoryPeriod = typeof HISTORY_PERIODS[number];

function AgentHistoryTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover p-3 shadow-md text-xs space-y-1.5 min-w-[160px]">
      <p className="text-muted-foreground font-medium mb-1">{label ? new Date(label).toLocaleDateString([], { month: "short", day: "numeric" }) : ""}</p>
      {payload.map((p: any) => (
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
  const [optTab, setOptTab] = useState<"all" | "open" | "closed">("all");

  const { data: performance, isLoading: isPerformanceLoading } = useGetPerformance(
    { period }, { query: { queryKey: getGetPerformanceQueryKey({ period }) } }
  );
  const { data: summary, isLoading: isSummaryLoading } = useGetAnalyticsSummary();
  const { data: agentPerf, isLoading: isAgentPerfLoading } = useGetAgentPerformance();
  const { data: agentHistory, isLoading: isAgentHistoryLoading } = useGetAgentHistory(
    { period: histPeriod }, { query: { queryKey: getGetAgentHistoryQueryKey({ period: histPeriod }) } }
  );
  const { data: optPerf, isLoading: isOptPerfLoading } = useQuery({
    queryKey: ["options-performance"],
    queryFn: () => fetch("/api/analytics/options-performance").then(r => r.json()),
    refetchInterval: 30000,
  });

  const isReturn = (performance?.totalReturnPercent ?? 0) >= 0;
  const dataPoints = (agentHistory?.dataPoints ?? []) as Record<string, number | string>[];
  const optSummary = optPerf?.summary ?? { totalTrades: 0, totalPnl: 0, winRate: 0, winners: 0, losers: 0 };
  const optTrades = (optPerf?.trades ?? []) as any[];
  const filteredOptTrades = optTab === "all" ? optTrades :
    optTab === "open" ? optTrades.filter((t: any) => t.status !== "closed") :
    optTrades.filter((t: any) => t.status === "closed");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground">Portfolio performance and trading statistics.</p>
      </div>

      {/* ── OPTIONS P&L HERO ── */}
      <Card className="border-violet-500/30 bg-violet-950/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2 text-violet-300">
            <Zap className="h-4 w-4" /> Options Performance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
            {[
              { label: "Total P&L", value: formatCurrency(optSummary.totalPnl), accent: optSummary.totalPnl >= 0 ? "text-success" : "text-destructive" },
              { label: "Total Trades", value: String(optSummary.totalTrades), accent: "text-foreground" },
              { label: "Win Rate", value: `${optSummary.winRate?.toFixed(1)}%`, accent: (optSummary.winRate ?? 0) >= 50 ? "text-success" : "text-destructive" },
              { label: "Winners", value: String(optSummary.winners), accent: "text-success" },
              { label: "Losers", value: String(optSummary.losers), accent: "text-destructive" },
            ].map(s => (
              <div key={s.label}>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{s.label}</p>
                <p className={cn("text-2xl font-bold", s.accent)}>{s.value}</p>
              </div>
            ))}
          </div>

          {/* Options trade list */}
          <div className="flex items-center gap-2 mb-3">
            {(["all", "open", "closed"] as const).map(t => (
              <button key={t} onClick={() => setOptTab(t)}
                className={cn("text-xs px-3 py-1 rounded-full capitalize",
                  optTab === t ? "bg-violet-500/30 text-violet-200" : "text-muted-foreground hover:text-foreground"
                )}>{t}</button>
            ))}
          </div>

          {isOptPerfLoading ? <Skeleton className="h-32 w-full" /> : filteredOptTrades.length === 0 ? (
            <p className="text-center text-muted-foreground py-6 text-sm">No options trades yet.</p>
          ) : (
            <div className="rounded-md border border-violet-500/20 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-violet-950/40">
                  <tr>
                    {["Symbol", "Type", "Strike", "Contracts", "Entry", "Current", "P&L", "P&L %", "Expiry", "Status"].map(h => (
                      <th key={h} className="px-3 py-2 text-left font-medium text-muted-foreground uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredOptTrades.slice(0, 20).map((t: any) => {
                    const pnlUp = t.pnl >= 0;
                    return (
                      <tr key={t.id} className="hover:bg-muted/20">
                        <td className="px-3 py-2 font-semibold">{t.symbol}</td>
                        <td className="px-3 py-2">
                          <Badge className={cn("text-[9px] h-4 px-1 border-0",
                            t.optionType === "call" ? "bg-success/20 text-success" : "bg-destructive/20 text-destructive"
                          )}>{t.optionType?.toUpperCase()}</Badge>
                        </td>
                        <td className="px-3 py-2 tabular-nums">${t.strike}</td>
                        <td className="px-3 py-2 tabular-nums">{t.contracts}</td>
                        <td className="px-3 py-2 tabular-nums">${t.entryPremium?.toFixed(2)}</td>
                        <td className="px-3 py-2 tabular-nums">${t.currentValue?.toFixed(2)}</td>
                        <td className={cn("px-3 py-2 font-semibold tabular-nums", pnlUp ? "text-success" : "text-destructive")}>
                          {pnlUp ? "+" : ""}{formatCurrency(t.pnl)}
                        </td>
                        <td className={cn("px-3 py-2 tabular-nums", pnlUp ? "text-success" : "text-destructive")}>
                          {pnlUp ? "+" : ""}{t.pnlPct?.toFixed(1)}%
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {t.expirationDate ? new Date(t.expirationDate).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-3 py-2">
                          <Badge className={cn("text-[9px] h-4 px-1 border-0",
                            t.status === "filled" ? "bg-success/20 text-success" :
                            t.status === "simulated" ? "bg-violet-500/20 text-violet-300" : "bg-muted"
                          )}>{t.status}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── EQUITY CURVE ── */}
      <Card className="bg-card border-border">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-base font-medium flex items-center gap-2">
            <Activity className="h-4 w-4" /> Equity Curve
          </CardTitle>
          <Tabs value={period} onValueChange={v => setPeriod(v as Period)}>
            <TabsList className="h-7">
              {PERIODS.map(p => <TabsTrigger key={p} value={p} className="text-xs px-2 h-6">{p.toUpperCase()}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent>
          {isPerformanceLoading ? <Skeleton className="h-[240px] w-full" /> : (
            <div className="h-[240px] w-full mt-2">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={performance?.dataPoints || []} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorVal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis domain={["auto", "auto"]} tickFormatter={(v) => `$${(v/1000).toFixed(1)}k`}
                    stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} width={55} />
                  <Tooltip contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
                    formatter={(v: number) => [formatCurrency(v), "Portfolio"]} />
                  <Area type="monotone" dataKey="portfolioValue" stroke="hsl(var(--primary))" strokeWidth={2} fillOpacity={1} fill="url(#colorVal)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-border">
            {[
              { label: "Total Return", value: `${isReturn ? "+" : ""}${performance?.totalReturnPercent?.toFixed(2) ?? 0}%`, up: isReturn },
              { label: "Max Drawdown", value: `${((performance?.maxDrawdown ?? 0) * 100).toFixed(2)}%`, up: false },
              { label: "Sharpe Ratio", value: performance?.sharpeRatio?.toFixed(2) ?? "0", up: (performance?.sharpeRatio ?? 0) > 0 },
            ].map(s => (
              <div key={s.label} className="text-center">
                <p className="text-xs text-muted-foreground uppercase">{s.label}</p>
                <p className={cn("text-lg font-bold mt-1", s.up ? "text-success" : "text-destructive")}>{s.value}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── TRADE SUMMARY ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { label: "Total Trades", value: summary?.totalTrades ?? 0, fmt: String },
          { label: "Win Rate", value: summary?.winRate ?? 0, fmt: (v: number) => `${v.toFixed(1)}%` },
          { label: "Profit Factor", value: summary?.profitFactor ?? 0, fmt: (v: number) => v.toFixed(2) },
        ].map(s => (
          <Card key={s.label} className="bg-card border-border">
            <CardContent className="p-5">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{s.label}</p>
              <p className="text-2xl font-bold">{s.fmt(s.value as number)}</p>
              <div className="flex gap-3 mt-2 text-xs text-muted-foreground">
                <span>📈 Stocks: {summary?.stockTrades ?? 0}</span>
                <span>⚡ Options: {summary?.optionTrades ?? 0}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── AGENT PERFORMANCE ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium flex items-center gap-2"><Bot className="h-4 w-4" /> Agent P&L</CardTitle>
          </CardHeader>
          <CardContent>
            {isAgentPerfLoading ? <Skeleton className="h-[200px] w-full" /> : !agentPerf?.length ? (
              <p className="text-muted-foreground text-sm text-center py-8">No agent data.</p>
            ) : (
              <div className="h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={agentPerf} margin={{ top: 5, right: 10, left: 0, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="agentName" fontSize={10} tick={{ fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} angle={-25} textAnchor="end" />
                    <YAxis tickFormatter={(v) => `$${(v/1000).toFixed(1)}k`} fontSize={10} tick={{ fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={50} />
                    <Tooltip contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
                      formatter={(v: number) => [formatCurrency(v), "P&L"]} />
                    <Bar dataKey="totalPnl" radius={[4, 4, 0, 0]}>
                      {agentPerf.map((e: any, i: number) => <Cell key={i} fill={e.totalPnl >= 0 ? "hsl(var(--success))" : "hsl(var(--destructive))"} fillOpacity={0.85} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base font-medium flex items-center gap-2"><TrendingUp className="h-4 w-4" /> Agent History</CardTitle>
            <Tabs value={histPeriod} onValueChange={v => setHistPeriod(v as HistoryPeriod)}>
              <TabsList className="h-7">
                {HISTORY_PERIODS.map(p => <TabsTrigger key={p} value={p} className="text-xs px-2 h-6">{p.toUpperCase()}</TabsTrigger>)}
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent>
            {isAgentHistoryLoading ? <Skeleton className="h-[200px] w-full" /> : (
              <div className="h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={dataPoints} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="date" fontSize={10} tick={{ fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false}
                      tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })} />
                    <YAxis tickFormatter={(v) => `$${(v/1000).toFixed(1)}k`} fontSize={10} tick={{ fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={50} />
                    <Tooltip content={<AgentHistoryTooltip />} />
                    {(agentHistory?.agents ?? []).map((a: any) => (
                      <Line key={a.id} type="monotone" dataKey={a.name} stroke={a.color} strokeWidth={1.5} dot={false} />
                    ))}
                    <Legend formatter={(v) => <span style={{ fontSize: 10, color: "hsl(var(--muted-foreground))" }}>{v}</span>} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
