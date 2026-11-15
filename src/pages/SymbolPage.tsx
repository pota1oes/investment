import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { isCrypto, isEuSymbol } from "../../supabase/functions/_shared/engine.ts";
import { CandleChart } from "../components/Chart.tsx";
import { Loading, NewsList } from "../components/common.tsx";
import { OrderTicket } from "../components/OrderTicket.tsx";
import { Avatar, RangeBar, Term } from "../components/ui.tsx";
import { useAction, useAsync, useEnv } from "../hooks.tsx";
import { api, isDemo } from "../lib/api.ts";
import { barsCached } from "../lib/cache.ts";
import { compact, pct, px, qty, signed, tone, usd } from "../lib/format.ts";
import { analyze, plainEnglish } from "../lib/insights.ts";
import { mark } from "../lib/onboard.ts";
import type { Company, Timeframe } from "../lib/types.ts";

const VIEWS: { label: string; tf: Timeframe; limit: number }[] = [
  { label: "1 week", tf: "15Min", limit: 500 },
  { label: "1 month", tf: "1Hour", limit: 500 },
  { label: "6 months", tf: "1Day", limit: 130 },
  { label: "2 years", tf: "1Day", limit: 520 },
];

const big = (n: number | null) =>
  n == null ? "—" : n >= 1e12 ? `$${(n / 1e12).toFixed(2)} trillion` : n >= 1e9 ? `$${(n / 1e9).toFixed(1)} billion` : `$${(n / 1e6).toFixed(0)} million`;
const num = (n: number | null, d = 1, suffix = "") => (n == null ? "—" : `${n.toFixed(d)}${suffix}`);
const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function CompanyCard({ c }: { c: Company }) {
  const a = c.analysts;
  const total = a ? a.buy + a.hold + a.sell : 0;
  return (
    <section className="card">
      <div className="card-head">
        <h3>About {c.name}</h3>
        {c.website && <a href={c.website} target="_blank" rel="noopener noreferrer">Website</a>}
      </div>
      <p className="muted">
        {[c.industry, c.country, c.exchange, c.ipo && `listed since ${c.ipo.slice(0, 4)}`].filter(Boolean).join(" · ")}
      </p>
      <dl className="stats">
        <div><dt><Term k="marketCap">Market value</Term></dt><dd>{big(c.marketCap)}</dd></div>
        <div><dt><Term k="pe">P/E ratio</Term></dt><dd>{num(c.pe)}</dd></div>
        <div><dt><Term k="eps">Earnings per share</Term></dt><dd>{c.eps == null ? "—" : `$${c.eps.toFixed(2)}`}</dd></div>
        <div><dt><Term k="dividendYield">Dividend yield</Term></dt><dd>{c.dividendYield ? num(c.dividendYield, 2, "%") : "None"}</dd></div>
        <div><dt><Term k="profitMargin">Profit margin</Term></dt><dd>{num(c.profitMargin, 1, "%")}</dd></div>
        <div><dt><Term k="revenueGrowth">Sales growth</Term></dt><dd className={tone(c.revenueGrowth ?? 0)}>{c.revenueGrowth == null ? "—" : pct(c.revenueGrowth)}</dd></div>
        <div><dt><Term k="beta">Beta</Term></dt><dd>{num(c.beta, 2)}</dd></div>
        <div>
          <dt><Term k="earnings">Next earnings report</Term></dt>
          <dd>{c.nextEarnings ? day(c.nextEarnings) : "Not announced"}</dd>
        </div>
      </dl>
      {c.lastEarnings && (
        <p className="muted">
          Last report ({c.lastEarnings.period.slice(0, 7)}): earned ${c.lastEarnings.actual.toFixed(2)} per share
          {c.lastEarnings.estimate != null && <>, analysts expected ${c.lastEarnings.estimate.toFixed(2)}</>}
          {c.lastEarnings.surprisePct != null && (
            <> — <span className={tone(c.lastEarnings.surprisePct)}>{pct(c.lastEarnings.surprisePct)} vs expectations</span></>
          )}.
        </p>
      )}
      {a && total > 0 && (
        <div className="analysts">
          <div className="row between">
            <Term k="analysts">What {total} analysts say</Term>
            <small className="muted">{a.period.slice(0, 7)}</small>
          </div>
          <div className="stackbar" role="img" aria-label={`${a.buy} buy, ${a.hold} hold, ${a.sell} sell`}>
            <span className="buy" style={{ flex: a.buy }} />
            <span className="hold" style={{ flex: a.hold }} />
            <span className="sell" style={{ flex: a.sell }} />
          </div>
          <div className="row between">
            <small><b className="up">{a.buy}</b> buy</small>
            <small><b>{a.hold}</b> hold</small>
            <small><b className="down">{a.sell}</b> sell</small>
          </div>
        </div>
      )}
      <p className="note">Company data from Finnhub. Analyst opinions are theirs, are often wrong, and are not advice for you.</p>
    </section>
  );
}

export function SymbolPage() {
  const symbol = (useParams()["*"] ?? "").toUpperCase();
  const eu = isEuSymbol(symbol);
  const crypto = isCrypto(symbol);
  const { env } = useEnv();
  const [viewIdx, setViewIdx] = useState(2);
  const [averages, setAverages] = useState(true);
  const view = eu ? { label: "", tf: "1Day" as Timeframe, limit: 100 } : VIEWS[viewIdx];
  useEffect(() => mark("stock"), []);

  const asset = useAsync(
    () => api.search(symbol, eu ? "eu" : "us").then((r) => r.find((a) => a.symbol === symbol) ?? null),
    [symbol],
  );
  const quote = useAsync(() => api.quotes([symbol]).then((q) => q[symbol] ?? null), [symbol], 10_000);
  const bars = useAsync(() => barsCached(symbol, view.tf, view.limit), [symbol, view.tf, view.limit]);
  const daily = useAsync(() => barsCached(symbol, "1Day", eu ? 100 : 400), [symbol]);
  const spy = useAsync(() => (symbol === "SPY" ? Promise.resolve([]) : barsCached("SPY", "1Day", 400).catch(() => [])), [symbol]);
  const company = useAsync(() => api.company(symbol).catch(() => null), [symbol]);
  const name = company.data?.name ?? asset.data?.name;
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

  // Insights use the last year of daily prices.
  const perYear = crypto ? 366 : 253;
  const ins = daily.data ? analyze(daily.data.slice(-perYear), crypto) : null;
  const market = spy.data && spy.data.length ? analyze(spy.data.slice(-253), false) : null;
  const notes = ins ? plainEnglish(ins, market) : [];
  const yearLabel = ins && ins.days >= 250 ? "52-week" : `${ins?.days ?? 0}-day`;

  const refresh = () => {
    positions.reload();
    account.reload();
  };

  return (
    <>
      <div className="symbol-head">
        <div className="row">
          <Avatar symbol={symbol} logo={company.data?.logo} size={48} />
          <div>
            <h1>
              {name ?? symbol} <small className="muted">{symbol}</small>
            </h1>
            <div className="price-line">
              <b>{px(q?.price)}</b>
              {q && (
                <span className={`pill ${tone(change)}`}>
                  {change >= 0 ? "+" : "−"}
                  {px(Math.abs(change))} ({pct(changePct)}) {eu ? "last close" : "today"}
                </span>
              )}
              {ins?.risk && <span className="pill"><Term k="volatility">{ins.risk} swings</Term></span>}
            </div>
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
                <Term k="movingAverage">20 / 50 averages</Term>
              </label>
            </div>
            {bars.data && bars.data.length > 0
              ? <CandleChart bars={bars.data} intraday={view.tf !== "1Day"} averages={averages} />
              : bars.data
              ? <p className="empty">No price data for this period.</p>
              : <Loading error={bars.error} />}
          </section>

          {notes.length > 0 && (
            <section className="card">
              <div className="card-head">
                <h3>In plain English</h3>
                <small className="muted">What the last year of prices shows — not a prediction</small>
              </div>
              <ul className="notes">
                {notes.map((n) => (
                  <li key={n.title} className={n.tone}>
                    <b>{n.title}</b>
                    <span>{n.text}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {ins && (
            <section className="card">
              <h3>Performance</h3>
              <div className="scroll-x">
                <table className="perf">
                  <thead>
                    <tr>
                      <th />
                      {ins.returns.map((r) => <th key={r.label} className="num">{r.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{symbol}</td>
                      {ins.returns.map((r) => <td key={r.label} className={`num ${tone(r.value ?? 0)}`}>{pct(r.value)}</td>)}
                    </tr>
                    {market && (
                      <tr>
                        <td className="muted">S&P 500</td>
                        {market.returns.map((r, i) => (
                          <td key={r.label} className="num muted">{crypto || ins.returns[i].value == null ? "—" : pct(r.value)}</td>
                        ))}
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="range-wrap">
                <span className="muted"><Term k="week52">{yearLabel} range</Term></span>
                <RangeBar low={px(ins.low)} high={px(ins.high)} pos={ins.rangePos} lowLabel="Low" highLabel="High" />
              </div>
            </section>
          )}

          <section className="card">
            <h3>Key numbers</h3>
            <dl className="stats">
              <div><dt>Open</dt><dd>{px(q?.open)}</dd></div>
              <div><dt>Day high</dt><dd>{px(q?.high)}</dd></div>
              <div><dt>Day low</dt><dd>{px(q?.low)}</dd></div>
              <div><dt>Previous close</dt><dd>{px(q?.prevClose)}</dd></div>
              <div><dt><Term k="volume">Volume today</Term></dt><dd>{q ? compact(q.volume) : "—"}</dd></div>
              <div><dt>Average volume</dt><dd>{ins ? compact(ins.avgVolume) : "—"}</dd></div>
              <div><dt><Term k="movingAverage">50-day average</Term></dt><dd>{px(ins?.sma50)}</dd></div>
              <div><dt><Term k="movingAverage">200-day average</Term></dt><dd>{px(ins?.sma200)}</dd></div>
              <div>
                <dt><Term k="volatility">Typical daily move</Term></dt>
                <dd>{ins?.typicalDailyMovePct == null ? "—" : `±${ins.typicalDailyMovePct.toFixed(1)}%`}</dd>
              </div>
              <div>
                <dt><Term k="volatility">Yearly volatility</Term></dt>
                <dd>{ins?.volatilityPct == null ? "—" : `${ins.volatilityPct.toFixed(0)}%`}</dd>
              </div>
              <div>
                <dt><Term k="drawdown">Biggest drop</Term></dt>
                <dd className="down">{ins?.maxDrawdownPct == null ? "—" : `−${ins.maxDrawdownPct.toFixed(0)}%`}</dd>
              </div>
              <div>
                <dt><Term k="rsi">RSI (14 days)</Term></dt>
                <dd>
                  {ins?.rsi14 == null ? "—" : ins.rsi14.toFixed(0)}{" "}
                  <small className="muted">
                    {ins?.rsi14 == null ? "" : ins.rsi14 > 70 ? "overbought" : ins.rsi14 < 30 ? "oversold" : "neutral"}
                  </small>
                </dd>
              </div>
            </dl>
          </section>

          {company.data && <CompanyCard c={company.data} />}
          {!company.data && !company.loading && !eu && !crypto && (
            <section className="card">
              <h3>Company facts</h3>
              <p className="muted">
                {isDemo
                  ? "Market value, P/E ratio, earnings dates and analyst ratings appear here with real data. Fake-money mode has no real company data."
                  : "Not available for this symbol (funds have no company profile). If it is missing for every stock, the free Finnhub key has not been added yet — see the README."}
              </p>
            </section>
          )}

          <section className="card">
            <h3>News about {name ?? symbol}</h3>
            {news.data ? <NewsList items={news.data} showSymbols={false} /> : <Loading error={news.error} />}
          </section>
        </div>

        <div className="stack sticky">
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
                <dt>You own</dt><dd>{qty(position.qty)}</dd>
                <dt><Term k="avgCost">Average cost</Term></dt><dd>{px(position.avgPrice)}</dd>
                <dt>Worth now</dt><dd>{usd(position.marketValue)}</dd>
                <dt><Term k="unrealized">Gain / loss</Term></dt>
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
