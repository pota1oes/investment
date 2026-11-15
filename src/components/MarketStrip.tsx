import { Link } from "react-router-dom";
import { useAsync } from "../hooks.tsx";
import { api } from "../lib/api.ts";
import { barsCached } from "../lib/cache.ts";
import { pct, px, tone } from "../lib/format.ts";
import { symbolPath } from "./common.tsx";
import { Sparkline } from "./ui.tsx";

const INDEXES: [string, string][] = [
  ["SPY", "S&P 500"],
  ["QQQ", "Nasdaq 100"],
  ["DIA", "Dow Jones"],
  ["IWM", "Small companies"],
  ["BTC/USD", "Bitcoin"],
];

/** 30-day closing prices per symbol, for sparklines. Failures simply leave a symbol out. */
export function useSparks(symbols: string[]): Record<string, number[]> {
  const res = useAsync(
    () =>
      Promise.all(
        symbols.map((s) =>
          barsCached(s, "1Day", 30).then((b) => [s, b.map((x) => x.c)] as const, () => [s, [] as number[]] as const)
        ),
      ).then((rows) => Object.fromEntries(rows)),
    [symbols.join(",")],
  );
  return res.data ?? {};
}

/** The big market gauges, each tracked through a fund that follows it. */
export function MarketStrip() {
  const symbols = INDEXES.map((i) => i[0]);
  const quotes = useAsync(() => api.quotes(symbols), [], 30_000);
  const sparks = useSparks(symbols);
  if (quotes.error && !quotes.data) return null;
  return (
    <div className="strip" aria-label="Markets today">
      {INDEXES.map(([symbol, label]) => {
        const q = quotes.data?.[symbol];
        const ch = q && q.prevClose ? (q.price / q.prevClose - 1) * 100 : 0;
        return (
          <Link key={symbol} to={symbolPath(symbol)} className="strip-item">
            <span className="strip-top">
              <span>{label}</span>
              <b className={tone(ch)}>{q ? pct(ch) : "—"}</b>
            </span>
            <span className="strip-bottom">
              <span className="strip-price">{px(q?.price)}</span>
              <Sparkline values={sparks[symbol] ?? []} width={84} height={26} />
            </span>
          </Link>
        );
      })}
    </div>
  );
}
