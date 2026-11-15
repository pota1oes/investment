import { Link } from "react-router-dom";
import { Empty, Loading, Search, SymbolLink, symbolPath } from "../components/common.tsx";
import { MarketStrip, useSparks } from "../components/MarketStrip.tsx";
import { Avatar, Sparkline, Term } from "../components/ui.tsx";
import { useAction, useAsync } from "../hooks.tsx";
import { api } from "../lib/api.ts";
import { compact, pct, px, tone } from "../lib/format.ts";

// Starting points for browsing — a way to explore, not a list of recommendations.
const IDEAS: { title: string; text: string; symbols: [string, string][] }[] = [
  {
    title: "Whole-market funds",
    text: "One share holds hundreds of companies.",
    symbols: [["SPY", "S&P 500"], ["QQQ", "Nasdaq 100"], ["IWM", "Small companies"], ["EFA", "Outside the US"]],
  },
  {
    title: "Large companies",
    text: "Household names with lots of news coverage.",
    symbols: [["AAPL", "Apple"], ["MSFT", "Microsoft"], ["NVDA", "NVIDIA"], ["AMZN", "Amazon"], ["JPM", "JPMorgan"]],
  },
  {
    title: "Other kinds of assets",
    text: "They often move differently from stocks.",
    symbols: [["TLT", "US bonds"], ["GLD", "Gold"], ["VNQ", "Real estate"], ["BTC/USD", "Bitcoin"]],
  },
];

export function Markets() {
  const watch = useAsync(() => api.watchlist(), []);
  const symbols = (watch.data ?? []).map((w) => w.symbol);
  const quotes = useAsync(() => api.quotes(symbols), [symbols.join(",")], 15_000);
  const sparks = useSparks(symbols.slice(0, 20));
  const action = useAction();

  return (
    <>
      <h1>Markets</h1>
      <MarketStrip />

      <section className="card">
        <div className="card-head">
          <div>
            <h3>Your watchlist</h3>
            <small className="muted">Things you are following. Click one to see its page and trade it.</small>
          </div>
          <Search
            placeholder="Add a stock, fund or coin…"
            onPick={(a) => action.run(() => api.addWatch({ symbol: a.symbol, name: a.name }).then(watch.reload))}
          />
        </div>
        {action.error && <p className="error">{action.error}</p>}
        {quotes.error && <p className="error">{quotes.error}</p>}
        {!watch.data ? <Loading error={watch.error} /> : watch.data.length === 0
          ? <Empty>Nothing here yet. Use the search box, or pick something from the ideas below.</Empty>
          : (
            <div className="scroll-x">
              <table className="roomy">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="num">Price</th>
                    <th className="num"><Term k="dayChange">Today</Term></th>
                    <th className="num">Last 30 days</th>
                    <th className="num">Day range</th>
                    <th className="num"><Term k="volume">Volume</Term></th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {watch.data.map((w) => {
                    const q = quotes.data?.[w.symbol];
                    const ch = q ? (q.price / q.prevClose - 1) * 100 : 0;
                    return (
                      <tr key={w.symbol}>
                        <td>
                          <span className="row">
                            <Avatar symbol={w.symbol} size={30} />
                            <span>
                              <SymbolLink symbol={w.symbol} />
                              <small className="muted clip">{w.name}</small>
                            </span>
                          </span>
                        </td>
                        <td className="num"><b>{px(q?.price)}</b></td>
                        <td className="num"><span className={`pill ${tone(ch)}`}>{q ? pct(ch) : "—"}</span></td>
                        <td className="num"><Sparkline values={sparks[w.symbol] ?? []} /></td>
                        <td className="num">{q ? `${px(q.low)} – ${px(q.high)}` : "—"}</td>
                        <td className="num">{q ? compact(q.volume) : "—"}</td>
                        <td className="num">
                          <button
                            className="link"
                            aria-label={`Remove ${w.symbol}`}
                            onClick={() => action.run(() => api.removeWatch(w.symbol).then(watch.reload))}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </section>

      <h2>Places to start looking</h2>
      <div className="ideas">
        {IDEAS.map((idea) => (
          <section className="card" key={idea.title}>
            <h3>{idea.title}</h3>
            <p className="muted">{idea.text}</p>
            <div className="chips">
              {idea.symbols.map(([s, label]) => (
                <Link key={s} className="chip" to={symbolPath(s)}>
                  <b>{s.replace("/USD", "")}</b> {label}
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
      <p className="note">
        These are examples to explore, not recommendations. US prices come from the IEX exchange feed (free tier), so
        they can differ slightly from the consolidated price. European shares show end-of-day prices and cannot be
        traded through Alpaca yet.
      </p>
    </>
  );
}
