import { useState } from "react";
import { useListAgents, useCreateAgent, useUpdateAgent, useDeleteAgent, useToggleAgent, useRunAgent, getListAgentsQueryKey, getGetAgentPerformanceQueryKey } from "@workspace/api-client-react";
import { formatCurrency, formatPercentage, cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Bot, Play, Plus, Trash2, Power, TrendingUp, TrendingDown } from "lucide-react";

const STRATEGIES = [
  { value: "momentum", label: "Momentum" },
  { value: "mean_reversion", label: "Mean Reversion" },
  { value: "breakout", label: "Breakout" },
  { value: "trend_following", label: "Trend Following" },
  { value: "options_selling", label: "Options Selling" },
];

const RISK_LEVELS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export default function Agents() {
  const { data: agents, isLoading } = useListAgents();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [runResult, setRunResult] = useState<{ agentName: string; analysis: string; action: string } | null>(null);
  const [runResultOpen, setRunResultOpen] = useState(false);

  const [name, setName] = useState("");
  const [strategy, setStrategy] = useState("momentum");
  const [symbolsInput, setSymbolsInput] = useState("AAPL,MSFT");
  const [riskLevel, setRiskLevel] = useState("medium");
  const [maxPositionSize, setMaxPositionSize] = useState("5000");

  const createAgent = useCreateAgent({
    mutation: {
      onSuccess: () => {
        toast({ title: "Agent created" });
        queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
        setCreateOpen(false);
        setName(""); setSymbolsInput("AAPL,MSFT");
      },
      onError: () => toast({ title: "Failed to create agent", variant: "destructive" }),
    }
  });

  const toggleAgent = useToggleAgent({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() }),
      onError: () => toast({ title: "Failed to toggle agent", variant: "destructive" }),
    }
  });

  const deleteAgent = useDeleteAgent({
    mutation: {
      onSuccess: () => {
        toast({ title: "Agent deleted" });
        queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
      },
    }
  });

  const runAgent = useRunAgent({
    mutation: {
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
        setRunResult({ agentName: result.agentName, analysis: result.analysis, action: result.action });
        setRunResultOpen(true);
      },
      onError: () => toast({ title: "Failed to run agent", variant: "destructive" }),
    }
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const symbols = symbolsInput.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    createAgent.mutate({ data: { name, strategy: strategy as "momentum" | "mean_reversion" | "breakout" | "trend_following" | "options_selling", symbols, riskLevel: riskLevel as "low" | "medium" | "high", maxPositionSize: parseFloat(maxPositionSize) } });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">AI Agents</h1>
          <p className="text-muted-foreground">Manage your automated trading agents.</p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-create-agent"><Plus className="h-4 w-4 mr-2" /> New Agent</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create AI Agent</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label htmlFor="agent-name">Agent Name</Label>
                <Input id="agent-name" placeholder="Alpha Bot" value={name} onChange={e => setName(e.target.value)} required data-testid="input-agent-name" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Strategy</Label>
                  <Select value={strategy} onValueChange={setStrategy}>
                    <SelectTrigger data-testid="select-strategy"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {STRATEGIES.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Risk Level</Label>
                  <Select value={riskLevel} onValueChange={setRiskLevel}>
                    <SelectTrigger data-testid="select-risk"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {RISK_LEVELS.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="symbols">Symbols (comma-separated)</Label>
                <Input id="symbols" placeholder="AAPL,MSFT,NVDA" value={symbolsInput} onChange={e => setSymbolsInput(e.target.value)} data-testid="input-symbols" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="max-pos">Max Position Size ($)</Label>
                <Input id="max-pos" type="number" min="100" value={maxPositionSize} onChange={e => setMaxPositionSize(e.target.value)} data-testid="input-max-position" />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={createAgent.isPending || !name} data-testid="button-submit-agent">
                  {createAgent.isPending ? "Creating..." : "Create Agent"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Run result dialog */}
      <Dialog open={runResultOpen} onOpenChange={setRunResultOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{runResult?.agentName} — Run Result</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <p className="text-sm font-medium text-muted-foreground mb-1">Action Taken</p>
              <Badge className={cn(
                "capitalize",
                runResult?.action === "bought" ? "bg-success/20 text-success border-success" :
                runResult?.action === "sold" ? "bg-destructive/20 text-destructive border-destructive" :
                "bg-muted"
              )} variant="outline">{runResult?.action ?? "-"}</Badge>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground mb-1">Analysis</p>
              <p className="text-sm leading-relaxed">{runResult?.analysis}</p>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-52 w-full" />)}
        </div>
      ) : agents?.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground flex flex-col items-center gap-4">
          <Bot className="h-12 w-12 opacity-30" />
          <div>
            <p className="font-medium">No agents yet</p>
            <p className="text-sm mt-1">Create your first AI trading agent to get started.</p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {agents?.map(agent => {
            const isProfit = agent.totalPnl >= 0;
            return (
              <Card key={agent.id} className={cn("border-border bg-card transition-shadow hover:shadow-md", agent.isActive && "border-primary/30")} data-testid={`card-agent-${agent.id}`}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-base font-semibold truncate">{agent.name}</CardTitle>
                      <CardDescription className="text-xs mt-0.5 capitalize">{agent.strategy.replace("_", " ")}</CardDescription>
                    </div>
                    <Badge variant="outline" className={cn("text-[10px] shrink-0", agent.isActive ? "border-success text-success" : "border-muted-foreground text-muted-foreground")}>
                      {agent.isActive ? "Active" : "Paused"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-[10px] uppercase text-muted-foreground">Trades</p>
                      <p className="text-base font-bold">{agent.totalTrades}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase text-muted-foreground">Win Rate</p>
                      <p className="text-base font-bold">{agent.winRate.toFixed(1)}%</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase text-muted-foreground">P&L</p>
                      <p className={cn("text-base font-bold", isProfit ? "text-success" : "text-destructive")}>
                        {isProfit ? "+" : ""}{formatCurrency(agent.totalPnl)}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {agent.symbols.slice(0, 4).map(s => (
                      <Badge key={s} variant="secondary" className="text-[10px] h-5 px-1.5">{s}</Badge>
                    ))}
                    {agent.symbols.length > 4 && (
                      <Badge variant="secondary" className="text-[10px] h-5 px-1.5">+{agent.symbols.length - 4}</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      size="sm" variant="outline" className="flex-1 h-8 text-xs"
                      onClick={() => toggleAgent.mutate({ id: agent.id })}
                      disabled={toggleAgent.isPending}
                      data-testid={`button-toggle-agent-${agent.id}`}
                    >
                      <Power className="h-3 w-3 mr-1.5" /> {agent.isActive ? "Pause" : "Activate"}
                    </Button>
                    <Button
                      size="sm" variant="default" className="flex-1 h-8 text-xs"
                      onClick={() => runAgent.mutate({ id: agent.id })}
                      disabled={runAgent.isPending}
                      data-testid={`button-run-agent-${agent.id}`}
                    >
                      <Play className="h-3 w-3 mr-1.5" /> Run
                    </Button>
                    <Button
                      size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => deleteAgent.mutate({ id: agent.id })}
                      data-testid={`button-delete-agent-${agent.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {agent.lastRunAt && (
                    <p className="text-[10px] text-muted-foreground">
                      Last run: {new Date(agent.lastRunAt).toLocaleString()}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
