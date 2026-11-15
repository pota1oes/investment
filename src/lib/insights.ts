// Turns a price history into the numbers and plain-language notes shown on a
// stock page. Everything here describes what already happened — it is not a forecast.
import { rsi, sma } from "../../supabase/functions/_shared/strategy.ts";
import type { Bar } from "./types.ts";

export interface PeriodReturn {
  label: string;
  value: number | null;
}
export interface Insights {
  price: number;
  returns: PeriodReturn[];
  typicalDailyMovePct: number | null;
  volatilityPct: number | null; // annualised
  risk: "Low" | "Medium" | "High" | "Very high" | null;
  maxDrawdownPct: number | null;
  high: number;
  low: number;
  fromHighPct: number;
  rangePos: number; // 0 = at the low, 1 = at the high
  sma50: number | null;
  sma200: number | null;
  rsi14: number | null;
  trend: "up" | "down" | "mixed" | null;
  avgVolume: number;
  days: number;
}

export function analyze(daily: Bar[], crypto: boolean): Insights | null {
  if (daily.length < 2) return null;
  const closes = daily.map((b) => b.c);
  const price = closes[closes.length - 1];
  const perYear = crypto ? 365 : 252;
  const periods: [string, number][] = crypto
    ? [["1 week", 7], ["1 month", 30], ["3 months", 91], ["6 months", 182], ["1 year", 365]]
    : [["1 week", 5], ["1 month", 21], ["3 months", 63], ["6 months", 126], ["1 year", 252]];
  const back = (n: number) => (closes.length > n ? (price / closes[closes.length - 1 - n] - 1) * 100 : null);

  const window = closes.slice(-Math.min(closes.length, 64));
  const rets: number[] = [];
  for (let i = 1; i < window.length; i++) rets.push(Math.log(window[i] / window[i - 1]));
  let vol: number | null = null;
  let typical: number | null = null;
  if (rets.length >= 10) {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
    vol = sd * Math.sqrt(perYear) * 100;
    typical = (rets.reduce((a, b) => a + Math.abs(b), 0) / rets.length) * 100;
  }

  let peak = closes[0];
  let dd = 0;
  for (const c of closes) {
    peak = Math.max(peak, c);
    dd = Math.max(dd, (peak - c) / peak);
  }
  const high = Math.max(...daily.map((b) => b.h));
  const low = Math.min(...daily.map((b) => b.l));
  const s50 = sma(closes, 50).at(-1) ?? null;
  const s200 = sma(closes, 200).at(-1) ?? null;
  const trend = s50 == null
    ? null
    : s200 == null
    ? (price > s50 ? "up" : "down")
    : price > s50 && s50 > s200
    ? "up"
    : price < s50 && s50 < s200
    ? "down"
    : "mixed";
  const recent = daily.slice(-20);

  return {
    price,
    returns: periods.map(([label, n]) => ({ label, value: back(n) })),
    typicalDailyMovePct: typical,
    volatilityPct: vol,
    risk: vol == null ? null : vol < 15 ? "Low" : vol < 30 ? "Medium" : vol < 55 ? "High" : "Very high",
    maxDrawdownPct: dd * 100,
    high,
    low,
    fromHighPct: (price / high - 1) * 100,
    rangePos: high > low ? Math.min(1, Math.max(0, (price - low) / (high - low))) : 0.5,
    sma50: s50,
    sma200: s200,
    rsi14: rsi(closes, 14).at(-1) ?? null,
    trend,
    avgVolume: recent.reduce((a, b) => a + b.v, 0) / recent.length,
    days: daily.length,
  };
}

export interface Note {
  tone: "up" | "down" | "neutral";
  title: string;
  text: string;
}

const f = (n: number, d = 0) => `${Math.abs(n).toFixed(d)}%`;

/** Short, factual sentences a newcomer can read. No advice, no predictions. */
export function plainEnglish(i: Insights, market: Insights | null): Note[] {
  const notes: Note[] = [];
  if (i.trend === "up") {
    notes.push({ tone: "up", title: "Trending up", text: "The price is above its 50-day average" + (i.sma200 != null ? ", which is above the 200-day average." : ".") });
  } else if (i.trend === "down") {
    notes.push({ tone: "down", title: "Trending down", text: "The price is below its 50-day average" + (i.sma200 != null ? ", which is below the 200-day average." : ".") });
  } else if (i.trend === "mixed") {
    notes.push({ tone: "neutral", title: "No clear trend", text: "The short-term and long-term averages point in different directions." });
  }

  const m = i.returns.find((r) => r.label === "1 month")?.value;
  const mm = market?.returns.find((r) => r.label === "1 month")?.value;
  if (m != null) {
    const vs = mm != null ? ` The S&P 500 is ${mm >= 0 ? "up" : "down"} ${f(mm, 1)} over the same time.` : "";
    notes.push({ tone: m >= 0 ? "up" : "down", title: `${m >= 0 ? "Up" : "Down"} ${f(m, 1)} in a month`, text: `That is the change over the last month.${vs}` });
  }

  if (i.typicalDailyMovePct != null && i.risk) {
    const per1000 = Math.round(i.typicalDailyMovePct * 10);
    notes.push({
      tone: i.risk === "Low" || i.risk === "Medium" ? "neutral" : "down",
      title: `${i.risk} price swings`,
      text: `It moves about ${f(i.typicalDailyMovePct, 1)} on a typical day, so $1,000 invested would go up or down by roughly $${per1000} a day.`,
    });
  }
  if (i.maxDrawdownPct != null && i.maxDrawdownPct > 1) {
    notes.push({
      tone: "neutral",
      title: `Biggest drop: ${f(i.maxDrawdownPct)}`,
      text: `The largest fall from a peak in the last ${i.days >= 250 ? "year" : `${i.days} days`}. It is now ${f(i.fromHighPct)} below its high for that period.`,
    });
  }
  if (i.rsi14 != null && (i.rsi14 > 70 || i.rsi14 < 30)) {
    notes.push({
      tone: "neutral",
      title: i.rsi14 > 70 ? "Has risen quickly" : "Has fallen quickly",
      text: `RSI is ${i.rsi14.toFixed(0)}. Traders call that ${i.rsi14 > 70 ? "“overbought”" : "“oversold”"}: the recent move has been unusually one-sided. It does not say what happens next.`,
    });
  }
  return notes;
}
