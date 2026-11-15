import { useState } from "react";
import { useParams } from "react-router-dom";
import { isEuSymbol } from "../../supabase/functions/_shared/engine.ts";
import { rsi, sma } from "../../supabase/functions/_shared/strategy.ts";
import { CandleChart } from "../components/Chart.tsx";
import { Loading, NewsList } from "../components/common.tsx";
import { OrderTicket } from "../components/OrderTicket.tsx";
import { useAction, useAsync, useEnv } from "../hooks.tsx";
import { api } from "../lib/api.ts";
import { compact, pct, px, qty, signed, tone, usd } from "../lib/format.ts";
import type { Timeframe } from "../lib/types.ts";

const VIEWS: { label: string; tf: Timeframe; limit: number }[] = [
  { label: "1 week", tf: "15Min", limit: 500 },
  { label: "1 month", tf: "1Hour", limit: 500 },
  { label: "6 months", tf: "1Day", limit: 130 },
  { label: "2 years", tf: "1Day", limit: 520 },
];

export function SymbolPage() {
  const symbol = (useParams()["*"] ?? "").toUpperCase();
  const eu = isEuSymbol(symbol);
  const { env } = useEnv();
  const [viewIdx, setViewIdx] = useState(2);
  const [averages, setAverages] = useState(true);
  const view = eu ? { label: "", tf: "1Day" as Timeframe, limit: 100 } : VIEWS[viewIdx];

  const asset = useAsync(
    () => api.search(symbol, eu ? "eu" : "us").then((r) => r.find((a) => a.symbol === symbol) ?? null),
    [symbol],
  );
  const quote = useAsync(() => api.quotes([symbol]).then((q) => q[symbol] ?? null), [symbol], 10_000);
  const bars = useAsync(() => api.bars(symbol, view.tf, view.limit), [symbol, view.tf, view.limit]);
  const daily = useAsync(() => api.bars(symbol, "1Day", 260), [symbol]);
  const name = asset.data?.name;
  const news = useAsync(() => api.news([symbol], 15, name), [symbol, name], 300_000);
  const watch = useAsync(() => api.watchlist(), []);
  const positions = useAsync(() => api.positions(env), [env], 20_000);
  const account = useAsync(() => api.account(env), [env], 20_000);
  const star = useAction();

  const q = quote.data;
  const change = q ? q.price - q.prevClose : 0;
  const changePct = q && q.prevClose ? (change / q.prevClose) * 100 : 0;
  const watched = watch.data?.some((w) => w.symbol === symbol) ?? false;
  const position = positions.data?.find((p) => p.symbol === symbol);

  const d = daily.data ?? [];
  const closes = d.map((b) => b.c);
  const hi52 = d.length ? Math.max(...d.map((b) => b.h)) : null;
  const lo52 = d.length ? Math.min(...d.map((b) => b.l)) : null;
  const rsi14 = rsi(closes, 14).at(-1) ?? null;
  const sma50 = sma(closes, 50).at(-1) ?? null;
  const sma200 = sma(closes, 200).at(-1) ?? null;
  const ret = (n: number) => (closes.length > n ? (closes.at(-1)! / closes.at(-1 - n)! - 1) * 100 : null);

  const refresh = () => {
    positions.reload();
    account.reload();
  };

  return (
    <>
      <div className="symbol-head">
        <div>
          <h1>
            {symbol} <small className="muted">{name ?? ""}</small>
          </h1>
          <div className="price-line">
            <b>{px(q?.price)}</b>
            {q && (
              <span className={tone(change)}>
                {change >= 0 ? "+" : "−"}
                {px(Math.abs(change))} ({pct(changePct)}) {eu ? "last close" : "today"}
              </span>
            )}
          </div>
        </div>
        <button
          disabled={star.busy || !watch.data}
          onClick={() =>
            star.run(() =>
              (watched ? api.removeWatch(symbol) : api.addWatch({ symbol, name: name ?? "" })).then(watch.reload)
            )}
        >
          {watched ? "★ Watching" : "☆ Add to watchlist"}
        </button>
      </div>
      {quote.error && <p className="error">{quote.error}</p>}
      {star.error && <p className="error">{star.error}</p>}

      <div className="symbol-grid">
        <div className="stack">
          <section className="card">
            <div className="card-head">
              {eu ? <h3>Daily prices</h3> : (
                <div className="seg small">
                  {VIEWS.map((v, i) => (
                    <button key={v.label} className={i === viewIdx ? "on" : ""} onClick={() => setViewIdx(i)}>
                      {v.label}
                    </button>
                  ))}
                </div>
              )}
              <label className="check">
                <input type="checkbox" checked={averages} onChange={(e) => setAverages(e.target.checked)} />
                20 / 50 averages
              </label>
            </div>
            {bars.data && bars.data.length > 0
              ? <CandleChart bars={bars.data} intraday={view.tf !== "1Day"} averages={averages} />
              : bars.data
              ? <p className="empty">No price data for this period.</p>
              : <Loading error={bars.error} />}
          </section>

          <section className="card">
            <h3>Key numbers</h3>
            <dl className="stats">
              <div><dt>Open</dt><dd>{px(q?.open)}</dd></div>
              <div><dt>Day high</dt><dd>{px(q?.high)}</dd></div>
              <div><dt>Day low</dt><dd>{px(q?.low)}</dd></div>
              <div><dt>Previous close</dt><dd>{px(q?.prevClose)}</dd></div>
              <div><dt>Volume</dt><dd>{q ? compact(q.volume) : "—"}</dd></div>
              <div><dt>{d.length >= 250 ? "52-week" : `${d.length}-day`} high</dt><dd>{px(hi52)}</dd></div>
              <div><dt>{d.length >= 250 ? "52-week" : `${d.length}-day`} low</dt><dd>{px(lo52)}</dd></div>
              <div><dt>1-month return</dt><dd className={tone(ret(21) ?? 0)}>{pct(ret(21))}</dd></div>
              <div><dt>6-month return</dt><dd className={tone(ret(126) ?? 0)}>{pct(ret(126))}</dd></div>
              <div><dt>50-day average</dt><dd>{px(sma50)}</dd></div>
              <div><dt>200-day average</dt><dd>{px(sma200)}</dd></div>
              <div>
                <dt>RSI (14 days)</dt>
                <dd>
                  {rsi14 == null ? "—" : rsi14.toFixed(0)}{" "}
                  <small className="muted">
                    {rsi14 == null ? "" : rsi14 > 70 ? "overbought zone" : rsi14 < 30 ? "oversold zone" : "neutral"}
                  </small>
                </dd>
              </div>
            </dl>
          </section>

          <section className="card">
            <h3>News about {name ?? symbol}</h3>
            {news.data ? <NewsList items={news.data} showSymbols={false} /> : <Loading error={news.error} />}
          </section>
        </div>

        <div className="stack">
          {eu
            ? (
              <div className="card">
                <h3>Trading</h3>
                <p className="muted">
                  European-listed shares can be followed here but not traded: Alpaca's trading API does not offer
                  them yet. Many large European companies also trade in the US — search the company name under “US &
                  crypto”.
                </p>
              </div>
            )
            : q
            ? (
              <OrderTicket
                key={`${symbol}-${env}`}
                symbol={symbol}
                price={q.price}
                held={position?.qty ?? 0}
                cash={account.data?.cash}
                onDone={refresh}
              />
            )
            : <div className="card"><Loading error={quote.error} /></div>}

          {position && (
            <div className="card">
              <h3>Your position</h3>
              <dl className="kv">
                <dt>Quantity</dt><dd>{qty(position.qty)}</dd>
                <dt>Average cost</dt><dd>{px(position.avgPrice)}</dd>
                <dt>Market value</dt><dd>{usd(position.marketValue)}</dd>
                <dt>Gain / loss</dt>
                <dd className={tone(position.unrealizedPl)}>
                  {signed(position.unrealizedPl)} ({pct(position.unrealizedPlPct)})
                </dd>
              </dl>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
