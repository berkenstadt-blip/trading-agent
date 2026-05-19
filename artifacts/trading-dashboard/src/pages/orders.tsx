import { useState } from "react";
import { useListOrders, usePlaceOrder, useCancelOrder, getListOrdersQueryKey } from "@workspace/api-client-react";
import { formatCurrency, formatDateTime, cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

type OrderStatusFilter = "pending" | "filled" | "cancelled" | "all";

export default function Orders() {
  const [filter, setFilter] = useState<OrderStatusFilter>("all");
  const { data: orders, isLoading } = useListOrders(filter !== "all" ? { status: filter } : undefined, { query: { queryKey: ["orders", filter] } });
  
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
      }
    }
  });

  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [quantity, setQuantity] = useState("1");
  const [limitPrice, setLimitPrice] = useState("");

  const placeOrderMutation = usePlaceOrder({
    mutation: {
      onSuccess: () => {
        toast({ title: "Order placed successfully" });
        queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey() });
        setSymbol("");
        setQuantity("1");
        setLimitPrice("");
      },
      onError: (err: any) => {
        toast({ title: "Order failed", description: err.message, variant: "destructive" });
      }
    }
  });

  const handlePlaceOrder = (e: React.FormEvent) => {
    e.preventDefault();
    if (!symbol) return;
    
    placeOrderMutation.mutate({
      data: {
        symbol: symbol.toUpperCase(),
        assetType: "stock",
        side,
        orderType,
        quantity: parseInt(quantity, 10),
        limitPrice: orderType === "limit" && limitPrice ? parseFloat(limitPrice) : undefined,
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Order Management</h1>
          <p className="text-muted-foreground">Place manual trades and view order history.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-1 bg-card border-border">
          <CardHeader>
            <CardTitle>Place Order</CardTitle>
            <CardDescription>Execute a manual trade</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handlePlaceOrder} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="symbol">Symbol</Label>
                <Input 
                  id="symbol" 
                  placeholder="AAPL" 
                  value={symbol} 
                  onChange={(e) => setSymbol(e.target.value)} 
                  required 
                  className="uppercase"
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Action</Label>
                  <Select value={side} onValueChange={(val: any) => setSide(val)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="buy">Buy</SelectItem>
                      <SelectItem value="sell">Sell</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Order Type</Label>
                  <Select value={orderType} onValueChange={(val: any) => setOrderType(val)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="market">Market</SelectItem>
                      <SelectItem value="limit">Limit</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="qty">Quantity</Label>
                  <Input 
                    id="qty" 
                    type="number" 
                    min="1" 
                    value={quantity} 
                    onChange={(e) => setQuantity(e.target.value)} 
                    required 
                  />
                </div>
                {orderType === "limit" && (
                  <div className="space-y-2">
                    <Label htmlFor="price">Limit Price</Label>
                    <Input 
                      id="price" 
                      type="number" 
                      step="0.01" 
                      min="0.01"
                      value={limitPrice} 
                      onChange={(e) => setLimitPrice(e.target.value)} 
                      required 
                    />
                  </div>
                )}
              </div>

              <Button 
                type="submit" 
                className="w-full mt-4" 
                variant={side === 'buy' ? 'default' : 'destructive'}
                disabled={placeOrderMutation.isPending || !symbol}
              >
                {placeOrderMutation.isPending ? "Placing..." : `${side === 'buy' ? 'Buy' : 'Sell'} ${symbol || 'Stock'}`}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2 bg-card border-border flex flex-col">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <CardTitle>Order History</CardTitle>
              <Tabs value={filter} onValueChange={(v: any) => setFilter(v)} className="w-auto">
                <TabsList className="grid w-full grid-cols-4 h-9">
                  <TabsTrigger value="all" className="text-xs">All</TabsTrigger>
                  <TabsTrigger value="pending" className="text-xs">Pending</TabsTrigger>
                  <TabsTrigger value="filled" className="text-xs">Filled</TabsTrigger>
                  <TabsTrigger value="cancelled" className="text-xs">Cancelled</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </CardHeader>
          <CardContent className="flex-1 overflow-hidden">
            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : !orders?.length ? (
              <div className="text-center py-12 text-muted-foreground flex items-center justify-center h-full">
                No orders found for this filter.
              </div>
            ) : (
              <div className="rounded-md border border-border overflow-auto max-h-[500px]">
                <Table>
                  <TableHeader className="bg-muted/50 sticky top-0 z-10">
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Symbol</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.map((order) => (
                      <TableRow key={order.id}>
                        <TableCell className="text-xs whitespace-nowrap">{formatDateTime(order.createdAt)}</TableCell>
                        <TableCell>
                          <div className="font-medium">{order.symbol}</div>
                          <div className="text-[10px] text-muted-foreground uppercase">{order.assetType}</div>
                        </TableCell>
                        <TableCell>
                          <div className={cn("font-medium uppercase", order.side === 'buy' ? 'text-success' : 'text-destructive')}>
                            {order.side} {order.quantity}
                          </div>
                          <div className="text-xs text-muted-foreground uppercase">{order.orderType}</div>
                        </TableCell>
                        <TableCell className="text-right">
                          {order.status === 'filled' && order.filledPrice 
                            ? formatCurrency(order.filledPrice) 
                            : order.limitPrice 
                              ? formatCurrency(order.limitPrice) 
                              : 'MKT'}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn(
                            "uppercase text-[10px]",
                            order.status === 'filled' ? 'border-success text-success' : 
                            order.status === 'cancelled' || order.status === 'rejected' ? 'border-destructive text-destructive' : 'border-primary text-primary'
                          )}>
                            {order.status}
                          </Badge>
                          {order.agentName && (
                            <div className="text-[10px] text-muted-foreground mt-1 truncate max-w-[100px]" title={`By ${order.agentName}`}>
                              By: {order.agentName}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {order.status === 'pending' && (
                            <Button 
                              variant="destructive" 
                              size="sm" 
                              className="h-7 text-xs"
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
      </div>
    </div>
  );
}
