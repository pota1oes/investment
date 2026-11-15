import { functionsUrl, supabase } from "./supabase.ts";
import type { Api, Bot, BotLogEntry, WatchItem } from "./types.ts";

async function call<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data } = await supabase!.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not signed in.");
  const res = await fetch(functionsUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action, ...body }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? json?.message ?? `Server error (${res.status})`);
  return json.data as T;
}

function ok<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export const liveApi: Api = {
  mode: "live",
  brokerStatus: () => call("broker.status"),
  connectBroker: (env, keyId, secret) => call("broker.connect", { env, keyId, secret }),
  disconnectBroker: (env) => call("broker.disconnect", { env }),
  account: (env) => call("account", { env }),
  positions: (env) => call("positions", { env }),
  closePosition: (env, symbol) => call("positions.close", { env, symbol }),
  orders: (env) => call("orders.list", { env }),
  placeOrder: (env, req) => call("orders.place", { env, ...req }),
  cancelOrder: (env, id) => call("orders.cancel", { env, id }),
  portfolioHistory: (env, period) => call("portfolio.history", { env, period }),
  clock: () => call("clock"),
  bars: (symbol, timeframe, limit) => call("bars", { symbol, timeframe, limit }),
  quotes: (symbols) => (symbols.length ? call("quotes", { symbols }) : Promise.resolve({})),
  news: (symbols, limit, name) => call("news", { symbols, limit, name }),
  search: (q, market) => call("search", { q, market }),

  // Watchlist and bot reads go straight to the database; row-level security
  // guarantees a user only ever sees their own rows.
  async watchlist() {
    return ok<WatchItem[]>(
      await supabase!.from("watchlist").select("symbol, name").order("created_at"),
    );
  },
  async addWatch(item) {
    ok(await supabase!.from("watchlist").upsert({ symbol: item.symbol, name: item.name.slice(0, 120) }));
  },
  async removeWatch(symbol) {
    ok(await supabase!.from("watchlist").delete().eq("symbol", symbol));
  },
  async bots() {
    const rows = ok<Record<string, unknown>[]>(
      await supabase!.from("bots").select("id, env, status, config, state, last_run_at").order("created_at"),
    );
    return rows.map((r) => ({ ...r, lastRunAt: r.last_run_at }) as unknown as Bot);
  },
  saveBot: (env, config, id) => call("bots.save", { env, config, id }),
  deleteBot: (id) => call("bots.delete", { id }),
  setBotStatus: (id, status) => call("bots.setStatus", { id, status }),
  runBot: (id) => call("bots.run", { id }),
  liquidateBot: (id) => call("bots.liquidate", { id }),
  async botEvents(id) {
    const rows = ok<Record<string, unknown>[]>(
      await supabase!.from("bot_events").select("id, ts, type, symbol, message").eq("bot_id", id)
        .order("id", { ascending: false }).limit(100),
    );
    return rows.map((r) => ({ ...r, id: String(r.id), symbol: r.symbol ?? undefined }) as BotLogEntry);
  },
};
