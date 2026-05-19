import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import { LivePricesProvider } from "@/context/live-prices";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import Positions from "@/pages/positions";
import Orders from "@/pages/orders";
import Agents from "@/pages/agents";
import Market from "@/pages/market";
import Analytics from "@/pages/analytics";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30000,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/positions" component={Positions} />
        <Route path="/orders" component={Orders} />
        <Route path="/agents" component={Agents} />
        <Route path="/market" component={Market} />
        <Route path="/analytics" component={Analytics} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LivePricesProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </LivePricesProvider>
    </QueryClientProvider>
  );
}

export default App;
