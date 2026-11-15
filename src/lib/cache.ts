import { api } from "./api.ts";
import type { Bar, Timeframe } from "./types.ts";

// Small in-memory cache so charts, sparklines and insights that need the same
// price history share one request.
const TTL = 10 * 60_000;
const store = new Map<string, { at: number; value: Promise<Bar[]> }>();

export function barsCached(symbol: string, timeframe: Timeframe, limit: number): Promise<Bar[]> {
  const key = `${symbol}|${timeframe}|${limit}`;
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = api.bars(symbol, timeframe, limit);
  store.set(key, { at: Date.now(), value });
  value.catch(() => store.delete(key));
  return value;
}
