import { useState } from "react";
import { Link } from "react-router-dom";
import { LineChart } from "../components/Chart.tsx";
import { Empty, Loading, NewsList, SymbolLink } from "../components/common.tsx";
import { useAsync, useEnv } from "../hooks.tsx";
import { api } from "../lib/api.ts";
import { pct, px, signed, tone, usd } from "../lib/format.ts";

const PERIODS = ["1W", "1M", "3M", "1A"] as const;

export function Dashboard() {
  const { env } = useEnv();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("1M");
  const account = useAsync(() => api.account(env), [env], 30_000);
  const positions = useAsync(() => api.positions(env), [env], 30_000);
  const history = useAsync(() => api.portfolioHistory(env, period), [env, period]);
  const watch = useAsync(() => api.watchlist(), []);
  const watchSymbols = (watch.data ?? []).map((w) => w.symbol);
  const quotes = useAsync(() => api.quotes(watchSymbols), [watchSymbols.join(",")], 20_000);
  const newsSymbols = [...new Set([...(positions.data ?? []).map((p) => p.symbol), ...watchSymbols])].slice(0, 20);
  const news = useAsync(() => api.news(newsSymbols, 8), [newsSymbols.join(",")], 300_000);

  const a = account.data;
  const dayPl = a ? a.equity - a.lastEquity : 0;
  const dayPct = a && a.lastEquity ? (dayPl / a.lastEquity) * 100 : 0;
  const top = [...(positions.data ?? [])].sort((x, y) => y.marketValue - x.marketValue).slice(0, 6);

  return (
    <>
      <h1>Dashboard</h1>
      {account.error && <p className="error">{account.error}</p>}
      <div className="tiles">
        <div className="tile">
          <span>Portfolio value</span>
          <b>{usd(a?.equity)}</b>
        </div>
        <div className="tile">
          <span>Today</span>
          <b className={tone(dayPl)}>{a ? signed(dayPl) : "—"}</b>
          <small className={tone(dayPl)}>{a ? pct(dayPct) : ""}</small>
        </div>
        <div className="tile">
          <span>Cash</span>
          <b>{usd(a?.cash)}</b>
        </div>
        <div className="tile">
          <span>Buying power</span>
          <b>{usd(a?.buyingPower)}</b>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h3>Portfolio value over time</h3>
          <div className="seg small">
            {PERIODS.map((p) => (
              <button key={p} className={p === period ? "on" : ""} onClick={() => setPeriod(p)}>
                {p === "1A" ? "1Y" : p}
              </button>
            ))}
          </div>
        </div>
        {history.data && history.data.length > 1
          ? <LineChart points={history.data} intraday={period === "1W"} />
          : history.data
          ? <Empty>Not enough history yet.</Empty>
          : <Loading error={history.error} />}
      </section>

      <div className="grid2">
        <section className="card">
          <div className="card-head">
            <h3>Largest positions</h3>
            <Link to="/portfolio">All positions</Link>
          </div>
          {!positions.data ? <Loading error={positions.error} /> : top.length === 0
            ? <Empty>No positions yet. Find something under Markets.</Empty>
            : (
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th className="num">Value</th>
                    <th className="num">Gain / loss</th>
                  </tr>
                </thead>
                <tbody>
                  {top.map((p) => (
                    <tr key={p.symbol}>
                      <td><SymbolLink symbol={p.symbol} /></td>
                      <td className="num">{usd(p.marketValue)}</td>
                      <td className={`num ${tone(p.unrealizedPl)}`}>
                        {signed(p.unrealizedPl)} <small>{pct(p.unrealizedPlPct)}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Watchlist</h3>
            <Link to="/markets">Edit</Link>
          </div>
          {!watch.data ? <Loading error={watch.error} /> : watch.data.length === 0
            ? <Empty>Your watchlist is empty.</Empty>
            : (
              <table>
                <tbody>
                  {watch.data.slice(0, 8).map((w) => {
                    const q = quotes.data?.[w.symbol];
                    const ch = q ? (q.price / q.prevClose - 1) * 100 : 0;
                    return (
                      <tr key={w.symbol}>
                        <td>
                          <SymbolLink symbol={w.symbol} />
                          <small className="muted clip">{w.name}</small>
                        </td>
                        <td className="num">{px(q?.price)}</td>
                        <td className={`num ${tone(ch)}`}>{q ? pct(ch) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          {quotes.error && <p className="error">{quotes.error}</p>}
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h3>News for your holdings and watchlist</h3>
          <Link to="/news">More news</Link>
        </div>
        {news.data ? <NewsList items={news.data} /> : <Loading error={news.error} />}
      </section>
    </>
  );
}
