// Outside data sources shared by the website endpoint and the AI analyst:
// a small database-backed cache, Google News headlines and Finnhub company facts.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { NewsItem } from "./alpaca.ts";
import { isCrypto, isEuSymbol } from "./engine.ts";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function cached<T>(
  db: SupabaseClient,
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const { data: row } = await db.from("market_cache").select("data, fetched_at").eq("key", key)
    .maybeSingle();
  if (row && Date.now() - Date.parse(row.fetched_at) < ttlMs) return row.data as T;
  try {
    const fresh = await load();
    await db.from("market_cache").upsert({ key, data: fresh, fetched_at: new Date().toISOString() });
    return fresh;
  } catch (e) {
    if (row) return row.data as T; // provider down or rate-limited: serve the older copy
    throw e;
  }
}

const unescapeXml = (s: string) =>
  s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export function googleNews(db: SupabaseClient, symbol: string, name: string): Promise<NewsItem[]> {
  const query = `${name || symbol.split(".")[0]} stock`;
  return cached(db, `gnews:${query.toLowerCase()}`, 30 * 60_000, async () => {
    const res = await fetch(
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en&gl=US&ceid=US:en`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) throw new Error("News provider unavailable.");
    const xml = await res.text();
    const items: NewsItem[] = [];
    for (const m of xml.matchAll(/<item>(.*?)<\/item>/gs)) {
      const tag = (t: string) =>
        unescapeXml(m[1].match(new RegExp(`<${t}[^>]*>(.*?)</${t}>`, "s"))?.[1] ?? "").trim();
      const url = tag("link");
      if (!/^https:\/\//.test(url)) continue;
      const source = tag("source");
      items.push({
        id: url,
        headline: tag("title").replace(new RegExp(`\\s+-\\s+${escapeRe(source)}$`), ""),
        summary: "",
        source,
        url,
        time: new Date(tag("pubDate") || Date.now()).toISOString(),
        symbols: [symbol],
      });
      if (items.length >= 20) break;
    }
    return items;
  });
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// deno-lint-ignore no-explicit-any
export type CompanyFacts = Record<string, any> | null;

/** Company facts from Finnhub (optional: needs a free FINNHUB_KEY secret). Cached for a day. */
export function companyFacts(db: SupabaseClient, symbol: string): Promise<CompanyFacts> {
  const key = Deno.env.get("FINNHUB_KEY");
  if (!key || isCrypto(symbol) || isEuSymbol(symbol)) return Promise.resolve(null);
  return cached(db, `finnhub:company:${symbol}`, 24 * 3_600_000, async () => {
      // deno-lint-ignore no-explicit-any
      const get = async (path: string): Promise<any> => {
        const res = await fetch(`https://finnhub.io/api/v1${path}`, {
          headers: { "X-Finnhub-Token": key },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 429) throw new HttpError(429, "Company data limit reached; try again in a minute.");
        return res.ok ? await res.json() : null; // endpoints outside the free plan are simply skipped
      };
      const day = (d: Date) => d.toISOString().slice(0, 10);
      const now = new Date();
      const soon = new Date(now.getTime() + 120 * 86_400_000);
      const q = `symbol=${encodeURIComponent(symbol)}`;
      const [profile, metrics, recs, calendar, past] = await Promise.all([
        get(`/stock/profile2?${q}`),
        get(`/stock/metric?${q}&metric=all`),
        get(`/stock/recommendation?${q}`),
        get(`/calendar/earnings?${q}&from=${day(now)}&to=${day(soon)}`),
        get(`/stock/earnings?${q}`),
      ]);
      if (!profile?.name) return null; // ETFs and unknown tickers have no company profile
      const m = metrics?.metric ?? {};
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const rec = Array.isArray(recs) ? recs[0] : null;
      // deno-lint-ignore no-explicit-any
      const next = (calendar?.earningsCalendar ?? []).map((e: any) => String(e.date)).sort()[0] ?? null;
      const lastQ = Array.isArray(past) ? past[0] : null;
      const web = String(profile.weburl ?? "");
      const logo = String(profile.logo ?? "");
      return {
        name: String(profile.name),
        industry: String(profile.finnhubIndustry ?? ""),
        country: String(profile.country ?? ""),
        exchange: String(profile.exchange ?? ""),
        ipo: String(profile.ipo ?? ""),
        website: /^https:\/\//.test(web) ? web : "",
        logo: /^https:\/\//.test(logo) ? logo : "",
        marketCap: num(profile.marketCapitalization) != null ? profile.marketCapitalization * 1e6 : null,
        pe: num(m.peTTM) ?? num(m.peBasicExclExtraTTM),
        eps: num(m.epsTTM) ?? num(m.epsBasicExclExtraItemsTTM),
        dividendYield: num(m.dividendYieldIndicatedAnnual),
        beta: num(m.beta),
        profitMargin: num(m.netProfitMarginTTM),
        revenueGrowth: num(m.revenueGrowthTTMYoy),
        analysts: rec
          ? {
            buy: (num(rec.buy) ?? 0) + (num(rec.strongBuy) ?? 0),
            hold: num(rec.hold) ?? 0,
            sell: (num(rec.sell) ?? 0) + (num(rec.strongSell) ?? 0),
            period: String(rec.period ?? ""),
          }
          : null,
        nextEarnings: next,
        lastEarnings: lastQ && num(lastQ.actual) != null
          ? {
            period: String(lastQ.period ?? ""),
            actual: lastQ.actual,
            estimate: num(lastQ.estimate),
            surprisePct: num(lastQ.surprisePercent),
          }
          : null,
      };
    });
}
