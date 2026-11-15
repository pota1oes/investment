import { useState } from "react";
import { Link } from "react-router-dom";
import { LineChart } from "../components/Chart.tsx";
import { Empty, Loading, NewsList, SymbolLink } from "../components/common.tsx";
import { MarketStrip, useSparks } from "../components/MarketStrip.tsx";
import { Avatar, Donut, Icon, sliceColor, Sparkline, Term } from "../components/ui.tsx";
import { useAsync, useEnv } from "../hooks.tsx";
import { api, envLabel, isDemo } from "../lib/api.ts";
import { pct, px, signed, tone, usd } from "../lib/format.ts";
import { has, mark } from "../lib/onboard.ts";

const PERIODS = ["1W", "1M", "3M", "1A"] as const;

function GettingStarted({ hasOrders, hasBots, paperConnected }: { hasOrders: boolean; hasBots: boolean; paperConnected: boolean }) {
  const [hidden, setHidden] = useState(() => has("hide"));
  const steps = [
    { done: has("learn"), to: "/learn", title: "Read the 5-minute basics", text: "What stocks and funds are, and how orders work." },
    { done: has("stock"), to: "/s/SPY", title: "Look at your first stock page", text: "See the chart, the plain-English summary and the news." },
    { done: hasOrders, to: "/s/SPY", title: "Place a practice order", text: `Buy $100 of something with ${isDemo ? "fake money" : "practice money"} — nothing real happens.` },
    { done: hasBots, to: "/bots", title: "Set up an auto-trader", text: "Pick a ready-made setup, test it on past prices, and let it run on practice money." },
    ...(isDemo ? [] : [{ done: paperConnected, to: "/settings", title: "Connect your Alpaca paper account", text: "Practice money on real market prices." }]),
  ];
  const left = steps.filter((s) => !s.done).length;
  if (hidden || left === 0) return null;
  return (
    <section className="card start">
      <div className="card-head">
        <div>
          <h3>Getting started</h3>
          <small className="muted">{steps.length - left} of {steps.length} done</small>
        </div>
        <button className="link" onClick={() => (mark("hide"), setHidden(true))}>Hide</button>
      </div>
      <div className="progress"><span style={{ width: `${((steps.length - left) / steps.length) * 100}%` }} /></div>
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.title} className={s.done ? "done" : ""}>
            <span className="step-mark">{s.done && <Icon name="check" size={14} />}</span>
            <Link to={s.to}>
              <b>{s.title}</b>
              <small>{s.text}</small>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Dashboard() {
  const { env, broker } = useEnv();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("1M");
  const account = useAsync(() => api.account(env), [env], 30_000);
  const positions = useAsync(() => api.positions(env), [env], 30_000);
  const orders = useAsync(() => api.orders(env).catch(() => []), [env]);
  const bots = useAsync(() => api.bots().catch(() => []), []);
  const history = useAsync(() => api.portfolioHistory(env, period), [env, period]);
  const watch = useAsync(() => api.watchlist(), []);
  const watchSymbols = (watch.data ?? []).map((w) => w.symbol).slice(0, 8);
  const quotes = useAsync(() => api.quotes(watchSymbols), [watchSymbols.join(",")], 20_000);
  const sparks = useSparks(watchSymbols);
  const newsSymbols = [...new Set([...(positions.data ?? []).map((p) => p.symbol), ...watchSymbols])].slice(0, 20);
  const news = useAsync(() => api.news(newsSymbols, 8), [newsSymbols.join(",")], 300_000);

  const a = account.data;
  const dayPl = a ? a.equity - a.lastEquity : 0;
  const dayPct = a && a.lastEquity ? (dayPl / a.lastEquity) * 100 : 0;
  const sorted = [...(positions.data ?? [])].sort((x, y) => y.marketValue - x.marketValue);
  const invested = sorted.reduce((s, p) => s + p.marketValue, 0);
  const totalPl = sorted.reduce((s, p) => s + p.unrealizedPl, 0);
  const slices = [
    ...sorted.slice(0, 5).map((p) => ({ label: p.symbol, value: p.marketValue })),
    ...(sorted.length > 5 ? [{ label: "Other", value: sorted.slice(5).reduce((s, p) => s + p.marketValue, 0) }] : []),
    ...(a && a.cash > 0 ? [{ label: "Cash", value: a.cash }] : []),
  ];
  const sliceTotal = slices.reduce((s, x) => s + x.value, 0);
  const runningBots = (bots.data ?? []).filter((b) => b.status === "running").length;

  return (
    <>
      <GettingStarted
        hasOrders={(orders.data ?? []).length > 0}
        hasBots={(bots.data ?? []).length > 0}
        paperConnected={!!broker?.paper}
      />
      {account.error && <p className="error">{account.error}</p>}

      <div className="hero">
        <section className="card hero-main">
          <div className="card-head">
            <div>
              <span className="eyebrow">
                <Term k="portfolio">Portfolio value</Term> · {envLabel(env)}
              </span>
              <div className="big">{usd(a?.equity)}</div>
              <div className={`delta ${tone(dayPl)}`}>
                {a ? `${signed(dayPl)} (${pct(dayPct)})` : "—"} <span className="muted">today</span>
              </div>
            </div>
            <div className="seg small">
              {PERIODS.map((p) => (
                <button key={p} className={p === period ? "on" : ""} onClick={() => setPeriod(p)}>
                  {p === "1A" ? "1Y" : p}
                </button>
              ))}
            </div>
          </div>
          {history.data && history.data.length > 1
            ? <LineChart points={history.data} intraday={period === "1W"} height={220} />
            : history.data
            ? <Empty>Your value over time appears here once the account has some history.</Empty>
            : <Loading error={history.error} />}
        </section>

        <section className="card hero-side">
          <h3>Where your money is</h3>
          <div className="alloc">
            <Donut
              slices={slices}
              center={
                <>
                  <small>Invested</small>
                  <b>{a && a.equity > 0 ? `${Math.round((invested / a.equity) * 100)}%` : "—"}</b>
                </>
              }
            />
            <ul className="legend">
              {slices.length === 0 && <li className="muted">Nothing yet</li>}
              {slices.map((s, i) => (
                <li key={s.label}>
                  <i style={{ background: sliceColor(i) }} />
                  <span>{s.label}</span>
                  <b>{sliceTotal ? `${((s.value / sliceTotal) * 100).toFixed(0)}%` : ""}</b>
                </li>
              ))}
            </ul>
          </div>
          <dl className="kv">
            <dt><Term k="cash">Cash</Term></dt>
            <dd>{usd(a?.cash)}</dd>
            <dt>Invested</dt>
            <dd>{usd(invested)}</dd>
            <dt><Term k="unrealized">Total gain / loss</Term></dt>
            <dd className={tone(totalPl)}>{positions.data ? signed(totalPl) : "—"}</dd>
            <dt>Auto-traders running</dt>
            <dd><Link to="/bots">{runningBots}</Link></dd>
          </dl>
        </section>
      </div>

      <h2>Markets today</h2>
      <MarketStrip />

      <div className="grid2">
        <section className="card">
          <div className="card-head">
            <h3>Your investments</h3>
            <Link to="/portfolio">See all</Link>
          </div>
          {!positions.data ? <Loading error={positions.error} /> : sorted.length === 0
            ? (
              <div className="empty-cta">
                <p>You do not own anything yet.</p>
                <Link className="button primary" to="/markets">Find something to invest in</Link>
              </div>
            )
            : (
              <ul className="rows">
                {sorted.slice(0, 6).map((p) => (
                  <li key={p.symbol}>
                    <Avatar symbol={p.symbol} />
                    <div className="grow">
                      <SymbolLink symbol={p.symbol} />
                      <small className="muted">{usd(p.marketValue)}</small>
                    </div>
                    <div className={`num ${tone(p.unrealizedPl)}`}>
                      <b>{signed(p.unrealizedPl)}</b>
                      <small>{pct(p.unrealizedPlPct)}</small>
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Watchlist</h3>
            <Link to="/markets">Edit</Link>
          </div>
          {!watch.data ? <Loading error={watch.error} /> : watch.data.length === 0
            ? <Empty>Add stocks you want to follow under Markets.</Empty>
            : (
              <ul className="rows">
                {watch.data.slice(0, 8).map((w) => {
                  const q = quotes.data?.[w.symbol];
                  const ch = q ? (q.price / q.prevClose - 1) * 100 : 0;
                  return (
                    <li key={w.symbol}>
                      <Avatar symbol={w.symbol} />
                      <div className="grow">
                        <SymbolLink symbol={w.symbol} />
                        <small className="muted clip">{w.name}</small>
                      </div>
                      <Sparkline values={sparks[w.symbol] ?? []} width={72} height={26} />
                      <div className="num">
                        <b>{px(q?.price)}</b>
                        <small className={tone(ch)}>{q ? pct(ch) : "—"}</small>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          {quotes.error && <p className="error">{quotes.error}</p>}
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h3>News about your stocks</h3>
          <Link to="/news">More news</Link>
        </div>
        {news.data ? <NewsList items={news.data} /> : <Loading error={news.error} />}
      </section>
    </>
  );
}
