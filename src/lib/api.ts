import { demoApi } from "./demo.ts";
import { liveApi } from "./live.ts";
import { supabase } from "./supabase.ts";
import type { Api, Env } from "./types.ts";

// "Fake money" is the built-in simulator: pretend cash and simulated prices kept in
// this browser. It is always available — also when the real backend is configured,
// and without signing in.
const MODE_KEY = "investment.mode";
function wantsFake(): boolean {
  try {
    return localStorage.getItem(MODE_KEY) === "fake";
  } catch {
    return false;
  }
}

/** True when a real backend exists, so the user can leave fake-money mode. */
export const hasBackend = !!supabase;
export const isDemo = !supabase || wantsFake();
export const api: Api = isDemo ? demoApi : liveApi;

/** Switch between the simulator and the real backend. Reloads so no state leaks across. */
export function setFakeMoney(on: boolean) {
  try {
    if (on) localStorage.setItem(MODE_KEY, "fake");
    else localStorage.removeItem(MODE_KEY);
  } catch { /* ignore */ }
  location.reload();
}

export const envLabel = (env: Env) => (isDemo ? "Fake money" : env === "live" ? "Real money" : "Paper");
