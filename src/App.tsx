import type { Session } from "@supabase/supabase-js";
import { useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { Search } from "./components/common.tsx";
import { EnvContext, useAsync } from "./hooks.tsx";
import { api, hasBackend, isDemo, setFakeMoney } from "./lib/api.ts";
import { supabase } from "./lib/supabase.ts";
import type { Env } from "./lib/types.ts";
import { Bots } from "./pages/Bots.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Login, MfaChallenge } from "./pages/Login.tsx";
import { Markets } from "./pages/Markets.tsx";
import { News } from "./pages/News.tsx";
import { Portfolio } from "./pages/Portfolio.tsx";
import { Settings } from "./pages/Settings.tsx";
import { SymbolPage } from "./pages/SymbolPage.tsx";

type Gate = "loading" | "signed-out" | "needs-mfa" | "ready";

function useGate(): { gate: Gate; session: Session | null; recheck: () => void } {
  const [session, setSession] = useState<Session | null>(null);
  const [gate, setGate] = useState<Gate>(isDemo ? "ready" : "loading");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!supabase || isDemo) return;
    const sb = supabase;
    const { data } = sb.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setTick((t) => t + 1);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!supabase || isDemo) return;
    let alive = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!alive) return;
      setSession(data.session);
      if (!data.session) return setGate("signed-out");
      // If the account has two-factor turned on, a password alone is not enough.
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (!alive) return;
      setGate(aal && aal.nextLevel === "aal2" && aal.currentLevel !== "aal2" ? "needs-mfa" : "ready");
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  return { gate, session, recheck: () => setTick((t) => t + 1) };
}

export function App() {
  const { gate, session, recheck } = useGate();
  if (gate === "loading") return <div className="center">Loading…</div>;
  if (gate === "signed-out") return <Login />;
  if (gate === "needs-mfa") return <MfaChallenge onDone={recheck} />;
  return <Shell email={session?.user.email ?? null} />;
}

const NAV = [
  ["/", "Dashboard"],
  ["/markets", "Markets"],
  ["/portfolio", "Portfolio"],
  ["/bots", "Auto-trader"],
  ["/news", "News"],
  ["/settings", "Settings"],
] as const;

function Shell({ email }: { email: string | null }) {
  const broker = useAsync(() => api.brokerStatus(), []);
  const [wanted, setWanted] = useState<Env>(() => {
    try {
      return localStorage.getItem("env") === "live" ? "live" : "paper";
    } catch {
      return "paper";
    }
  });
  // Real money can only be selected while a live account is connected.
  const env: Env = wanted === "live" && broker.data?.live ? "live" : "paper";
  const ctx = useMemo(
    () => ({
      env,
      broker: broker.data,
      reloadBroker: broker.reload,
      setEnv: (e: Env) => {
        setWanted(e);
        try {
          localStorage.setItem("env", e);
        } catch { /* ignore */ }
      },
    }),
    [env, broker.data, broker.reload],
  );
  const connected = broker.data ? broker.data.paper || broker.data.live : true;

  return (
    <EnvContext.Provider value={ctx}>
      <div className={`app ${env === "live" ? "is-live" : ""}`}>
        <aside className="side">
          <div className="brand">Invest</div>
          <nav>
            {NAV.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === "/"}>
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="side-foot">
            {isDemo ? <span className="badge demo">Fake money</span> : <small title={email ?? ""}>{email}</small>}
          </div>
        </aside>
        <div className="main">
          <header className="top">
            <Search />
            <div className="seg" role="group" aria-label="Account">
              <button
                className={isDemo ? "on" : ""}
                title="Pretend cash and simulated prices, stored in this browser"
                onClick={() => !isDemo && setFakeMoney(true)}
              >
                Fake money
              </button>
              <button
                className={!isDemo && env === "paper" ? "on" : ""}
                disabled={!hasBackend}
                title={hasBackend ? "Alpaca practice account: pretend cash, real prices" : "Needs the backend (see README)"}
                onClick={() => (isDemo ? setFakeMoney(false) : ctx.setEnv("paper"))}
              >
                Paper
              </button>
              <button
                className={!isDemo && env === "live" ? "on live" : ""}
                disabled={isDemo ? !hasBackend : !broker.data?.live}
                title={isDemo || broker.data?.live ? "" : "Connect a live Alpaca account in Settings first"}
                onClick={() => (isDemo ? setFakeMoney(false) : ctx.setEnv("live"))}
              >
                Real money
              </button>
            </div>
          </header>
          {isDemo && (
            <div className="banner">
              Fake-money mode — prices, news and money are simulated and stay in this browser.{" "}
              {hasBackend
                ? <button className="link" onClick={() => setFakeMoney(false)}>Switch to your real account</button>
                : "Connect the backend (see README) for real data, logins and trading."}
            </div>
          )}
          {!isDemo && !connected && (
            <div className="banner">
              No brokerage connected yet. Add your Alpaca API keys in <NavLink to="/settings">Settings</NavLink>{" "}
              to load prices and trade.
            </div>
          )}
          <main>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/markets" element={<Markets />} />
              <Route path="/s/*" element={<SymbolPage />} />
              <Route path="/portfolio" element={<Portfolio />} />
              <Route path="/bots" element={<Bots />} />
              <Route path="/news" element={<News />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<p className="empty">Page not found.</p>} />
            </Routes>
          </main>
        </div>
      </div>
    </EnvContext.Provider>
  );
}
