import { useListPositions } from "@workspace/api-client-react";
import { formatCurrency, formatPercentage, cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function Positions() {
  const { data: positions, isLoading } = useListPositions();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Open Positions</h1>
        <p className="text-muted-foreground">Manage your current stock and option holdings.</p>
      </div>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg">All Positions</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : !positions?.length ? (
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
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead className="text-right">Avg Cost</TableHead>
                    <TableHead className="text-right">Current Price</TableHead>
                    <TableHead className="text-right">Market Value</TableHead>
                    <TableHead className="text-right">Unrealized P&L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {positions.map((pos) => {
                    const isUp = pos.unrealizedPnl >= 0;
                    return (
                      <TableRow key={pos.id}>
                        <TableCell className="font-medium">
                          {pos.symbol}
                          {pos.assetType === 'option' && (
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              {pos.strikePrice} {pos.optionType?.toUpperCase()} {pos.expirationDate ? new Date(pos.expirationDate).toLocaleDateString() : ''}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="uppercase text-[10px]">{pos.assetType}</Badge>
                        </TableCell>
                        <TableCell className="text-right">{pos.quantity}</TableCell>
                        <TableCell className="text-right">{formatCurrency(pos.avgCost)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(pos.currentPrice)}</TableCell>
                        <TableCell className="text-right font-medium">{formatCurrency(pos.marketValue)}</TableCell>
                        <TableCell className="text-right">
                          <div className={cn("font-medium", isUp ? "text-success" : "text-destructive")}>
                            {isUp ? '+' : ''}{formatCurrency(pos.unrealizedPnl)}
                          </div>
                          <div className={cn("text-xs", isUp ? "text-success/80" : "text-destructive/80")}>
                            {isUp ? '+' : ''}{formatPercentage(pos.unrealizedPnlPercent)}
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
