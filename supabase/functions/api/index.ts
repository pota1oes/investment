// The one server endpoint the website talks to. Every request must carry the
// logged-in user's token; broker keys never leave this function.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  AlpacaError,
  type Creds,
  type Env,
  getBars,
  getNews,
  getQuotes,
  type NewsItem,
  type Quote,
  trade,
} from "../_shared/alpaca.ts";
import { answerProposal } from "../_shared/ai.ts";
import { aiConfigured } from "../_shared/analyst.ts";
import { initialState, isCrypto, isEuSymbol, validateBotConfig } from "../_shared/engine.ts";
import { admin, type BotRow, cycleBot, encrypt, loadCreds } from "../_shared/server.ts";
import { cached, companyFacts, googleNews, HttpError } from "../_shared/sources.ts";
import type { Bar, Timeframe } from "../_shared/strategy.ts";

const bad = (m: string) => new HttpError(400, m);

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" },
  });

// --- input validation --------------------------------------------------------

type Body = Record<string, unknown>;
const SYMBOL = /^[A-Z0-9.]{1,12}(\/[A-Z]{3,5})?$/;

function sym(v: unknown): string {
  const s = String(v ?? "").trim().toUpperCase();
  if (!SYMBOL.test(s)) throw bad("Invalid symbol.");
  return s;
}
function syms(v: unknown, max = 60): string[] {
  if (!Array.isArray(v)) throw bad("Expected a list of symbols.");
  return [...new Set(v.slice(0, max).map(sym))];
}
function envOf(v: unknown): Env {
  if (v !== "paper" && v !== "live") throw bad("Invalid account type.");
  return v;
}
function uuid(v: unknown): string {
  const s = String(v ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(s)) throw bad("Invalid id.");
  return s;
}
function positive(v: unknown, label: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw bad(`${label} must be a positive number.`);
  return n;
}
function timeframe(v: unknown): Timeframe {
  if (v !== "15Min" && v !== "1Hour" && v !== "1Day") throw bad("Invalid timeframe.");
  return v;
}

// --- request context ---------------------------------------------------------

interface Ctx {
  db: SupabaseClient;
  userId: string;
  aal: string;
}

function requireLive2fa(ctx: Ctx, env: Env) {
  if (env === "live" && ctx.aal !== "aal2") {
    throw new HttpError(
      403,
      "Real-money actions need two-factor authentication. Turn it on in Settings, then sign in again.",
    );
  }
}

async function creds(ctx: Ctx, env: Env): Promise<Creds> {
  const c = await loadCreds(ctx.db, ctx.userId, env);
  if (!c) throw bad(`No ${env} Alpaca account connected. Add your API keys in Settings.`);
  return c;
}

/** Keys used for prices and news: whichever account is connected. */
async function dataCreds(ctx: Ctx): Promise<Creds> {
  const c = (await loadCreds(ctx.db, ctx.userId, "paper")) ??
    (await loadCreds(ctx.db, ctx.userId, "live"));
  if (!c) throw bad("Connect an Alpaca account in Settings to load market data.");
  return c;
}

async function ownBot(ctx: Ctx, id: unknown): Promise<BotRow> {
  const { data, error } = await ctx.db
    .from("bots")
    .select("id, user_id, env, status, config, state")
    .eq("id", uuid(id))
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new HttpError(404, "Bot not found.");
  return data as BotRow;
}

// --- European data (Alpha Vantage daily prices + Google News headlines) ---------

async function alphaVantage(params: Record<string, string>) {
  const key = Deno.env.get("ALPHAVANTAGE_KEY");
  if (!key) throw bad("European data is not set up yet (missing ALPHAVANTAGE_KEY on the server).");
  const q = new URLSearchParams({ ...params, apikey: key });
  const res = await fetch(`https://www.alphavantage.co/query?${q}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json();
  if (body?.Information || body?.Note) {
    throw new HttpError(429, "European data provider's daily limit reached. Try again tomorrow.");
  }
  if (body?.["Error Message"]) throw bad("Symbol not found at the European data provider.");
  return body;
}

function euBars(db: SupabaseClient, symbol: string): Promise<Bar[]> {
  return cached(db, `av:daily:${symbol}`, 6 * 3_600_000, async () => {
    const body = await alphaVantage({ function: "TIME_SERIES_DAILY", symbol, outputsize: "compact" });
    const series = body?.["Time Series (Daily)"] ?? {};
    return Object.entries(series)
      // deno-lint-ignore no-explicit-any
      .map(([d, v]: [string, any]) => ({
        t: Date.parse(`${d}T00:00:00Z`),
        o: Number(v["1. open"]),
        h: Number(v["2. high"]),
        l: Number(v["3. low"]),
        c: Number(v["4. close"]),
        v: Number(v["5. volume"]),
      }))
      .sort((a, b) => a.t - b.t);
  });
}

function quoteFromBars(bars: Bar[]): Quote | null {
  const last = bars.at(-1);
  if (!last) return null;
  return {
    price: last.c,
    prevClose: bars.at(-2)?.c ?? last.o,
    open: last.o,
    high: last.h,
    low: last.l,
    volume: last.v,
  };
}

// --- asset search ------------------------------------------------------------

interface Asset {
  symbol: string;
  name: string;
  exchange: string;
  market: "us" | "crypto" | "eu";
  tradable: boolean;
}
let assetCache: { at: number; list: Asset[] } | null = null;

async function usAssets(c: Creds): Promise<Asset[]> {
  if (assetCache && Date.now() - assetCache.at < 6 * 3_600_000) return assetCache.list;
  const [stocks, crypto] = await Promise.all([
    trade("paper", c, "/v2/assets?status=active&asset_class=us_equity").catch(() => null),
    trade("paper", c, "/v2/assets?status=active&asset_class=crypto").catch(() => null),
  ]);
  if (!stocks && !crypto) {
    // Keys may be live-only.
    const [s2, c2] = await Promise.all([
      trade("live", c, "/v2/assets?status=active&asset_class=us_equity"),
      trade("live", c, "/v2/assets?status=active&asset_class=crypto"),
    ]);
    return storeAssets(s2, c2);
  }
  return storeAssets(stocks ?? [], crypto ?? []);
}
// deno-lint-ignore no-explicit-any
function storeAssets(stocks: any[], crypto: any[]): Asset[] {
  const list: Asset[] = [];
  for (const a of stocks) {
    if (!a.tradable) continue;
    list.push({ symbol: a.symbol, name: a.name ?? "", exchange: a.exchange ?? "", market: "us", tradable: true });
  }
  for (const a of crypto) {
    if (!a.tradable || !String(a.symbol).endsWith("/USD")) continue;
    list.push({ symbol: a.symbol, name: a.name ?? "", exchange: "Crypto", market: "crypto", tradable: true });
  }
  assetCache = { at: Date.now(), list };
  return list;
}

// --- shaping Alpaca objects for the website ----------------------------------

// deno-lint-ignore no-explicit-any
const shapeOrder = (o: any) => ({
  id: String(o.id),
  symbol: String(o.symbol),
  side: String(o.side),
  type: String(o.type),
  tif: String(o.time_in_force),
  qty: o.qty != null ? Number(o.qty) : null,
  notional: o.notional != null ? Number(o.notional) : null,
  filledQty: Number(o.filled_qty ?? 0),
  filledAvgPrice: o.filled_avg_price != null ? Number(o.filled_avg_price) : null,
  limitPrice: o.limit_price != null ? Number(o.limit_price) : null,
  stopPrice: o.stop_price != null ? Number(o.stop_price) : null,
  status: String(o.status),
  submittedAt: String(o.submitted_at ?? o.created_at ?? ""),
});

// deno-lint-ignore no-explicit-any
const shapePosition = (p: any) => {
  let symbol = String(p.symbol);
  if (p.asset_class === "crypto" && !symbol.includes("/")) {
    symbol = symbol.replace(/(USDT|USDC|USD)$/, "/$1");
  }
  return {
    symbol,
    qty: Number(p.qty),
    avgPrice: Number(p.avg_entry_price),
    price: Number(p.current_price),
    marketValue: Number(p.market_value),
    unrealizedPl: Number(p.unrealized_pl),
    unrealizedPlPct: Number(p.unrealized_plpc) * 100,
    dayPl: Number(p.unrealized_intraday_pl ?? 0),
  };
};

// --- actions -----------------------------------------------------------------

const actions: Record<string, (ctx: Ctx, b: Body) => Promise<unknown>> = {
  async "broker.status"(ctx) {
    const { data, error } = await ctx.db.from("broker_connections").select("env").eq(
      "user_id",
      ctx.userId,
    );
    if (error) throw new Error(error.message);
    const envs = (data ?? []).map((r) => r.env);
    return { paper: envs.includes("paper"), live: envs.includes("live") };
  },

  async "broker.connect"(ctx, b) {
    const env = envOf(b.env);
    requireLive2fa(ctx, env);
    const keyId = String(b.keyId ?? "").trim();
    const secret = String(b.secret ?? "").trim();
    if (!/^[A-Za-z0-9]{10,80}$/.test(keyId) || !/^[A-Za-z0-9+/=_-]{20,200}$/.test(secret)) {
      throw bad("Those do not look like Alpaca API keys.");
    }
    try {
      await trade(env, { keyId, secret }, "/v2/account");
    } catch {
      throw bad(
        `Alpaca rejected these keys for a ${env} account. Check that you copied the ${env} keys.`,
      );
    }
    const { error } = await ctx.db.from("broker_connections").upsert({
      user_id: ctx.userId,
      env,
      key_id_enc: await encrypt(keyId),
      secret_enc: await encrypt(secret),
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  async "broker.disconnect"(ctx, b) {
    const env = envOf(b.env);
    const { data: running } = await ctx.db.from("bots").select("id").eq("user_id", ctx.userId)
      .eq("env", env).eq("status", "running").limit(1);
    if (running?.length) throw bad("Pause the bots using this account first.");
    const { error } = await ctx.db.from("broker_connections").delete().eq("user_id", ctx.userId)
      .eq("env", env);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  async account(ctx, b) {
    const env = envOf(b.env);
    const a = await trade(env, await creds(ctx, env), "/v2/account");
    return {
      equity: Number(a.equity),
      lastEquity: Number(a.last_equity),
      cash: Number(a.cash),
      buyingPower: Number(a.buying_power),
      currency: String(a.currency ?? "USD"),
      status: String(a.status),
    };
  },

  async positions(ctx, b) {
    const env = envOf(b.env);
    const list = await trade(env, await creds(ctx, env), "/v2/positions");
    return (list ?? []).map(shapePosition);
  },

  async "positions.close"(ctx, b) {
    const env = envOf(b.env);
    requireLive2fa(ctx, env);
    const s = sym(b.symbol).replace("/", "");
    const o = await trade(env, await creds(ctx, env), `/v2/positions/${encodeURIComponent(s)}`, {
      method: "DELETE",
    });
    return shapeOrder(o);
  },

  async "orders.list"(ctx, b) {
    const env = envOf(b.env);
    const list = await trade(
      env,
      await creds(ctx, env),
      "/v2/orders?status=all&limit=100&direction=desc",
    );
    return (list ?? []).map(shapeOrder);
  },

  async "orders.place"(ctx, b) {
    const env = envOf(b.env);
    requireLive2fa(ctx, env);
    const symbol = sym(b.symbol);
    if (isEuSymbol(symbol)) throw bad("European shares cannot be traded through Alpaca yet.");
    const side = b.side === "buy" || b.side === "sell" ? b.side : null;
    if (!side) throw bad("Choose buy or sell.");
    const type = String(b.type ?? "market");
    if (!["market", "limit", "stop", "stop_limit"].includes(type)) throw bad("Invalid order type.");
    const crypto = isCrypto(symbol);
    const tif = String(b.tif ?? (crypto ? "gtc" : "day"));
    if (!["day", "gtc", "ioc"].includes(tif)) throw bad("Invalid time in force.");
    if (crypto && tif === "day") throw bad("Crypto orders must be 'good till cancelled' or 'immediate'.");
    if (crypto && type === "stop") throw bad("Use a stop-limit order for crypto.");

    const order: Record<string, string> = { symbol, side, type, time_in_force: tif };
    if (b.notional != null && b.notional !== "") {
      if (type !== "market") throw bad("Dollar-amount orders must be market orders.");
      order.notional = positive(b.notional, "Amount").toFixed(2);
    } else {
      order.qty = String(positive(b.qty, "Quantity"));
    }
    if (type === "limit" || type === "stop_limit") {
      order.limit_price = String(positive(b.limitPrice, "Limit price"));
    }
    if (type === "stop" || type === "stop_limit") {
      order.stop_price = String(positive(b.stopPrice, "Stop price"));
    }
    const o = await trade(env, await creds(ctx, env), "/v2/orders", {
      method: "POST",
      body: JSON.stringify(order),
    });
    return shapeOrder(o);
  },

  async "orders.cancel"(ctx, b) {
    const env = envOf(b.env);
    await trade(env, await creds(ctx, env), `/v2/orders/${uuid(b.id)}`, { method: "DELETE" });
    return { ok: true };
  },

  async "portfolio.history"(ctx, b) {
    const env = envOf(b.env);
    const period = ["1W", "1M", "3M", "1A"].includes(String(b.period)) ? String(b.period) : "1M";
    const tf = period === "1W" ? "1H" : "1D";
    const h = await trade(
      env,
      await creds(ctx, env),
      `/v2/account/portfolio/history?period=${period}&timeframe=${tf}`,
    );
    const out: { t: number; value: number }[] = [];
    (h?.timestamp ?? []).forEach((ts: number, i: number) => {
      const v = h.equity?.[i];
      if (v != null && Number(v) > 0) out.push({ t: ts * 1000, value: Number(v) });
    });
    return out;
  },

  async clock(ctx) {
    const c = await dataCreds(ctx);
    const r = await trade("paper", c, "/v2/clock").catch(() => trade("live", c, "/v2/clock"));
    return { isOpen: Boolean(r.is_open), nextOpen: String(r.next_open), nextClose: String(r.next_close) };
  },

  async bars(ctx, b) {
    const symbol = sym(b.symbol);
    const limit = Math.min(1000, Math.max(10, Number(b.limit) || 300));
    if (isEuSymbol(symbol)) return (await euBars(ctx.db, symbol)).slice(-limit);
    return getBars(await dataCreds(ctx), symbol, timeframe(b.timeframe), limit);
  },

  async quotes(ctx, b) {
    const all = syms(b.symbols);
    const eu = all.filter(isEuSymbol);
    const rest = all.filter((s) => !isEuSymbol(s));
    const out: Record<string, Quote> = rest.length ? await getQuotes(await dataCreds(ctx), rest) : {};
    await Promise.allSettled(eu.map(async (s) => {
      const q = quoteFromBars(await euBars(ctx.db, s));
      if (q) out[s] = q;
    }));
    return out;
  },

  async news(ctx, b) {
    const all = b.symbols == null ? [] : syms(b.symbols, 30);
    const limit = Math.min(50, Math.max(1, Number(b.limit) || 20));
    const eu = all.filter(isEuSymbol);
    const rest = all.filter((s) => !isEuSymbol(s));
    const name = String(b.name ?? "").replace(/[^\p{L}\p{N} .&'-]/gu, "").slice(0, 60);
    const jobs: Promise<NewsItem[]>[] = eu.slice(0, 3).map((s) =>
      googleNews(ctx.db, s, eu.length === 1 ? name : "")
    );
    if (rest.length || !eu.length) {
      jobs.push(dataCreds(ctx).then((c) => getNews(c, rest, limit)));
    }
    const settled = await Promise.allSettled(jobs);
    const items = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    if (!items.length) {
      const failed = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      if (failed) throw failed.reason;
    }
    return items.sort((a, c) => Date.parse(c.time) - Date.parse(a.time)).slice(0, limit);
  },

  async search(ctx, b) {
    const q = String(b.q ?? "").trim().toUpperCase().slice(0, 30);
    if (!q) return [];
    if (b.market === "eu") {
      if (q.length < 2) return [];
      return cached(ctx.db, `av:search:${q}`, 7 * 86_400_000, async () => {
        const body = await alphaVantage({ function: "SYMBOL_SEARCH", keywords: q });
        // deno-lint-ignore no-explicit-any
        return (body?.bestMatches ?? []).map((m: any): Asset => ({
          symbol: String(m["1. symbol"]),
          name: String(m["2. name"]),
          exchange: String(m["4. region"]),
          market: "eu",
          tradable: false,
        })).filter((a: Asset) => isEuSymbol(a.symbol));
      });
    }
    const list = await usAssets(await dataCreds(ctx));
    const score = (a: Asset) =>
      a.symbol === q || a.symbol === `${q}/USD`
        ? 0
        : a.symbol.startsWith(q)
        ? 1
        : a.name.toUpperCase().startsWith(q)
        ? 2
        : a.name.toUpperCase().includes(q)
        ? 3
        : 9;
    return list
      .map((a) => ({ a, s: score(a) }))
      .filter((x) => x.s < 9)
      .sort((x, y) => x.s - y.s || x.a.symbol.length - y.a.symbol.length)
      .slice(0, 12)
      .map((x) => x.a);
  },

  async company(ctx, b) {
    return companyFacts(ctx.db, sym(b.symbol));
  },

  async "bots.save"(ctx, b) {
    const env = envOf(b.env);
    requireLive2fa(ctx, env);
    const config = validateBotConfig(b.config as never);
    if (config.strategy.id === "ai" && env === "live" && Deno.env.get("AI_LIVE_ENABLED") !== "true") {
      throw bad("AI analysts are limited to the paper account for now.");
    }
    if (b.id) {
      const bot = await ownBot(ctx, b.id);
      if (bot.status === "running") throw bad("Pause the bot before editing it.");
      if (bot.env !== env) throw bad("A bot cannot be moved between paper and real money. Create a new one.");
      const state = { ...bot.state, cash: bot.state.cash + (config.budget - bot.config.budget) };
      if (state.cash < 0) throw bad("The new budget is smaller than what the bot has already invested.");
      const { error } = await ctx.db.from("bots").update({
        config,
        state,
        updated_at: new Date().toISOString(),
      }).eq("id", bot.id);
      if (error) throw new Error(error.message);
      return { id: bot.id };
    }
    const { count } = await ctx.db.from("bots").select("id", { count: "exact", head: true }).eq(
      "user_id",
      ctx.userId,
    );
    if ((count ?? 0) >= 20) throw bad("You can have at most 20 bots.");
    const { data, error } = await ctx.db.from("bots").insert({
      user_id: ctx.userId,
      env,
      config,
      state: initialState(config.budget),
    }).select("id").single();
    if (error) throw new Error(error.message);
    return { id: data.id };
  },

  async "bots.setStatus"(ctx, b) {
    const bot = await ownBot(ctx, b.id);
    const status = b.status === "running" ? "running" : "paused";
    if (status === "running") {
      requireLive2fa(ctx, bot.env);
      if (bot.config.strategy.id === "ai" && !aiConfigured()) {
        throw bad("The AI is not set up yet: add your Anthropic API key to the server first (see README).");
      }
      const a = await trade(bot.env, await creds(ctx, bot.env), "/v2/account");
      if (bot.state.cash > Number(a.cash)) {
        throw bad(
          `The bot needs $${bot.state.cash.toFixed(2)} in cash but the ${bot.env} account only has $${
            Number(a.cash).toFixed(2)
          }.`,
        );
      }
    }
    const { error } = await ctx.db.from("bots").update({
      status,
      updated_at: new Date().toISOString(),
    }).eq("id", bot.id);
    if (error) throw new Error(error.message);
    await ctx.db.from("bot_events").insert({
      bot_id: bot.id,
      user_id: ctx.userId,
      type: "info",
      message: status === "running" ? "Bot started." : "Bot paused.",
    });
    return { ok: true };
  },

  async "bots.run"(ctx, b) {
    const bot = await ownBot(ctx, b.id);
    requireLive2fa(ctx, bot.env);
    if (bot.status !== "running") throw bad("Start the bot first.");
    return cycleBot(ctx.db, bot, "run", { ai: b.force === true ? "force" : "auto" });
  },

  // The user's answer to an AI proposal ("ask me first" mode).
  async "bots.decide"(ctx, b) {
    const bot = await ownBot(ctx, b.id);
    requireLive2fa(ctx, bot.env);
    if (bot.status !== "running") throw bad("Start the bot first.");
    const proposalId = String(b.proposalId ?? "").slice(0, 40);
    const approve = b.approve === true;
    try {
      return await cycleBot(ctx.db, bot, "run", {
        ai: "skip",
        mutate: (state) => [answerProposal(state, proposalId, approve, Date.now())],
      });
    } catch (e) {
      throw bad(e instanceof Error ? e.message : "Could not record your answer.");
    }
  },

  // The kill switch is deliberately NOT behind 2FA: stopping must always be possible.
  async "bots.liquidate"(ctx, b) {
    const bot = await ownBot(ctx, b.id);
    return cycleBot(ctx.db, bot, "liquidate");
  },

  async "bots.delete"(ctx, b) {
    const bot = await ownBot(ctx, b.id);
    if (bot.status === "running") throw bad("Pause the bot first.");
    if (Object.keys(bot.state.positions ?? {}).length || (bot.state.pending ?? []).length) {
      throw bad("This bot still holds positions or open orders. Use 'Stop & sell everything' first.");
    }
    const { error } = await ctx.db.from("bots").delete().eq("id", bot.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) throw new HttpError(401, "Not signed in.");
    const db = admin();
    const { data: auth, error: authError } = await db.auth.getUser(token);
    if (authError || !auth?.user) throw new HttpError(401, "Session expired. Sign in again.");

    // The token's signature was just verified by getUser, so its claims can be trusted.
    let aal = "aal1";
    try {
      const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      aal = String(JSON.parse(atob(payload)).aal ?? "aal1");
    } catch { /* keep aal1 */ }

    const body = (await req.json().catch(() => null)) as Body | null;
    const action = actions[String(body?.action ?? "")];
    if (!body || !action) throw bad("Unknown action.");
    return json({ data: await action({ db, userId: auth.user.id, aal }, body) });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof AlpacaError) {
      const status = e.status === 401 || e.status === 403 ? 400 : e.status === 429 ? 429 : 400;
      const hint = e.status === 401 ? " (Alpaca no longer accepts the saved keys — reconnect in Settings.)" : "";
      return json({ error: `Alpaca: ${e.message}${hint}` }, status);
    }
    console.error(e);
    return json({ error: "Something went wrong on the server." }, 500);
  }
});
