import { useState, useEffect, useCallback } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/Dashboard";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 4000,
    },
  },
});

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function checkStatus(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/auth/status`, { credentials: "include" });
    if (!r.ok) return false;
    const { authenticated } = await r.json();
    return !!authenticated;
  } catch {
    return false;
  }
}

async function submitLogin(passcode: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode }),
    });
    if (r.ok) return { ok: true };
    const body = await r.json().catch(() => ({}));
    return { ok: false, error: body.error ?? "Login failed" };
  } catch {
    return { ok: false, error: "Network error — check connection" };
  }
}

function PasscodeScreen({ onSuccess }: { onSuccess: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!value.trim() || loading) return;
      setLoading(true);
      setError(null);
      const result = await submitLogin(value.trim());
      setLoading(false);
      if (result.ok) {
        onSuccess();
      } else {
        setError(result.error ?? "Invalid passcode");
        setValue("");
      }
    },
    [value, loading, onSuccess],
  );

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4">
      <div className="w-full max-w-xs space-y-6">
        <div className="text-center space-y-1">
          <p className="text-zinc-200 text-sm font-medium tracking-wide">Oracle Control Panel</p>
          <p className="text-zinc-500 text-xs">Enter your passcode to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="password"
            value={value}
            onChange={e => { setValue(e.target.value); setError(null); }}
            placeholder="Passcode"
            autoFocus
            autoComplete="current-password"
            className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder-zinc-600 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
          />
          {error && (
            <p className="text-red-400 text-xs px-1">{error}</p>
          )}
          <button
            type="submit"
            disabled={!value.trim() || loading}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium rounded-lg py-3 transition-colors"
          >
            {loading ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    </div>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "authed" | "unauthed">("loading");

  useEffect(() => {
    checkStatus().then(ok => setState(ok ? "authed" : "unauthed"));
  }, []);

  if (state === "loading") {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Loading…</div>
      </div>
    );
  }

  if (state === "unauthed") {
    return <PasscodeScreen onSuccess={() => setState("authed")} />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthGate>
          <WouterRouter base={BASE}>
            <AppRoutes />
          </WouterRouter>
        </AuthGate>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
