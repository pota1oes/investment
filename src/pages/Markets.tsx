import { Empty, Loading, Search, SymbolLink } from "../components/common.tsx";
import { useAction, useAsync } from "../hooks.tsx";
import { api } from "../lib/api.ts";
import { compact, pct, px, tone } from "../lib/format.ts";

export function Markets() {
  const watch = useAsync(() => api.watchlist(), []);
  const symbols = (watch.data ?? []).map((w) => w.symbol);
  const quotes = useAsync(() => api.quotes(symbols), [symbols.join(",")], 15_000);
  const action = useAction();

  return (
    <>
      <h1>Markets</h1>
      <section className="card">
        <div className="card-head">
          <h3>Watchlist</h3>
          <Search
            placeholder="Add a symbol…"
            onPick={(a) => action.run(() => api.addWatch({ symbol: a.symbol, name: a.name }).then(watch.reload))}
          />
        </div>
        {action.error && <p className="error">{action.error}</p>}
        {quotes.error && <p className="error">{quotes.error}</p>}
        {!watch.data ? <Loading error={watch.error} /> : watch.data.length === 0
          ? <Empty>Nothing here yet. Use the search box to add stocks, ETFs or crypto.</Empty>
          : (
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th className="num">Price</th>
                    <th className="num">Today</th>
                    <th className="num">Day range</th>
                    <th className="num">Volume</th>
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
                          <SymbolLink symbol={w.symbol} />
                          <small className="muted clip">{w.name}</small>
                        </td>
                        <td className="num">{px(q?.price)}</td>
                        <td className={`num ${tone(ch)}`}>{q ? pct(ch) : "—"}</td>
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
        <p className="note">
          US prices come from the IEX exchange feed (free tier), so they can differ slightly from the consolidated
          price. European shares show end-of-day prices and cannot be traded through Alpaca yet.
        </p>
      </section>
    </>
  );
}
