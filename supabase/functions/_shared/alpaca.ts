// Thin Alpaca REST client (trading + market data + news) and the BrokerPort adapter
// the auto-trader uses. Runs only on the server.

import type { BrokerPort } from "./engine.ts";
import { isCrypto } from "./engine.ts";
import { type Bar, type Timeframe, TIMEFRAME_MS } from "./strategy.ts";

export type Env = "paper" | "live";
export interface Creds {
  keyId: string;
  secret: string;
}

const TRADE_URL: Record<Env, string> = {
  paper: "https://paper-api.alpaca.markets",
  live: "https://api.alpaca.markets",
};
const DATA_URL = "https://data.alpaca.markets";

export class AlpacaError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call(base: string, creds: Creds, path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: {
      "APCA-API-KEY-ID": creds.keyId,
      "APCA-API-SECRET-KEY": creds.secret,
      "content-type": "application/json",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  // deno-lint-ignore no-explicit-any
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new AlpacaError(res.status, body?.message ?? `Alpaca error ${res.status}`);
  }
  return body;
}

export const trade = (env: Env, creds: Creds, path: string, init?: RequestInit) =>
  call(TRADE_URL[env], creds, path, init);
export const data = (creds: Creds, path: string) => call(DATA_URL, creds, path);

const qs = (o: Record<string, string | number | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

// deno-lint-ignore no-explicit-any
const toBar = (b: any): Bar => ({
  t: Date.parse(b.t),
  o: Number(b.o),
  h: Number(b.h),
  l: Number(b.l),
  c: Number(b.c),
  v: Number(b.v),
});

/** Most recent `limit` bars, oldest first. */
export async function getBars(
  creds: Creds,
  symbol: string,
  timeframe: Timeframe,
  limit: number,
): Promise<Bar[]> {
  const n = Math.min(1000, Math.max(1, Math.floor(limit)));
  // Look far enough back to cover nights, weekends and holidays.
  const span = TIMEFRAME_MS[timeframe] * n * (timeframe === "1Day" ? 1.6 : 5) + 7 * 86_400_000;
  const start = new Date(Date.now() - span).toISOString();
  if (isCrypto(symbol)) {
    const r = await data(
      creds,
      `/v1beta3/crypto/us/bars?${qs({ symbols: symbol, timeframe, start, limit: n, sort: "desc" })}`,
    );
    return (r?.bars?.[symbol] ?? []).map(toBar).reverse();
  }
  const r = await data(
    creds,
    `/v2/stocks/${encodeURIComponent(symbol)}/bars?${
      qs({ timeframe, start, limit: n, sort: "desc", adjustment: "split", feed: "iex" })
    }`,
  );
  return (r?.bars ?? []).map(toBar).reverse();
}

export interface Quote {
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
}

// deno-lint-ignore no-explicit-any
function toQuote(s: any): Quote | null {
  if (!s) return null;
  const price = Number(s.latestTrade?.p ?? s.minuteBar?.c ?? s.dailyBar?.c ?? 0);
  if (!price) return null;
  return {
    price,
    prevClose: Number(s.prevDailyBar?.c ?? s.dailyBar?.o ?? price),
    open: Number(s.dailyBar?.o ?? price),
    high: Number(s.dailyBar?.h ?? price),
    low: Number(s.dailyBar?.l ?? price),
    volume: Number(s.dailyBar?.v ?? 0),
  };
}

export async function getQuotes(creds: Creds, symbols: string[]): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = {};
  const stocks = symbols.filter((s) => !isCrypto(s));
  const crypto = symbols.filter(isCrypto);
  const jobs: Promise<void>[] = [];
  if (stocks.length) {
    jobs.push(
      data(creds, `/v2/stocks/snapshots?${qs({ symbols: stocks.join(","), feed: "iex" })}`).then(
        (r) => {
          for (const s of stocks) {
            const q = toQuote(r?.[s]);
            if (q) out[s] = q;
          }
        },
      ),
    );
  }
  if (crypto.length) {
    jobs.push(
      data(creds, `/v1beta3/crypto/us/snapshots?${qs({ symbols: crypto.join(",") })}`).then((r) => {
        for (const s of crypto) {
          const q = toQuote(r?.snapshots?.[s]);
          if (q) out[s] = q;
        }
      }),
    );
  }
  await Promise.allSettled(jobs);
  return out;
}

export interface NewsItem {
  id: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  time: string;
  symbols: string[];
  image?: string;
}

export async function getNews(creds: Creds, symbols: string[], limit: number): Promise<NewsItem[]> {
  const r = await data(
    creds,
    `/v1beta1/news?${
      qs({
        symbols: symbols.map((s) => s.replace("/", "")).join(",") || undefined,
        limit: Math.min(50, Math.max(1, limit)),
        sort: "desc",
      })
    }`,
  );
  // deno-lint-ignore no-explicit-any
  return (r?.news ?? []).map((n: any) => ({
    id: String(n.id),
    headline: String(n.headline ?? ""),
    summary: String(n.summary ?? ""),
    source: String(n.source ?? ""),
    url: String(n.url ?? ""),
    time: String(n.created_at ?? ""),
    symbols: Array.isArray(n.symbols) ? n.symbols.map(String) : [],
    // deno-lint-ignore no-explicit-any
    image: n.images?.find((i: any) => i.size === "small")?.url ?? n.images?.[0]?.url,
  }));
}

export function brokerPort(env: Env, creds: Creds): BrokerPort {
  return {
    getBars: (symbol, timeframe, limit) => getBars(creds, symbol, timeframe, limit),
    async getOrder(id) {
      const o = await trade(env, creds, `/v2/orders/${encodeURIComponent(id)}`);
      return {
        status: String(o.status),
        filledQty: Number(o.filled_qty ?? 0),
        filledAvgPrice: Number(o.filled_avg_price ?? 0),
      };
    },
    async placeOrder(o) {
      const body: Record<string, string> = {
        symbol: o.symbol,
        side: o.side,
        type: "market",
        time_in_force: isCrypto(o.symbol) ? "gtc" : "day",
      };
      if (o.notional != null) body.notional = o.notional.toFixed(2);
      else body.qty = String(Math.floor((o.qty ?? 0) * 1e9) / 1e9);
      const r = await trade(env, creds, "/v2/orders", { method: "POST", body: JSON.stringify(body) });
      return { id: String(r.id) };
    },
    async isStockMarketOpen() {
      const c = await trade(env, creds, "/v2/clock");
      return Boolean(c.is_open);
    },
    async getPositionQty(symbol) {
      try {
        const p = await trade(
          env,
          creds,
          `/v2/positions/${encodeURIComponent(symbol.replace("/", ""))}`,
        );
        return Number(p.qty_available ?? p.qty ?? 0);
      } catch (e) {
        if (e instanceof AlpacaError && e.status === 404) return 0;
        throw e;
      }
    },
  };
}
