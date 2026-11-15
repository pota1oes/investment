import { useState } from "react";
import { Empty, Loading, SymbolLink } from "../components/common.tsx";
import { useAction, useAsync, useEnv } from "../hooks.tsx";
import { api, envLabel, isDemo } from "../lib/api.ts";
import { dateTime, pct, px, qty, signed, tone, usd } from "../lib/format.ts";

const OPEN = new Set(["new", "accepted", "pending_new", "partially_filled", "held", "accepted_for_bidding"]);

export function Portfolio() {
  const { env } = useEnv();
  const positions = useAsync(() => api.positions(env), [env], 20_000);
  const orders = useAsync(() => api.orders(env), [env], 20_000);
  const action = useAction();
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const reload = () => {
    positions.reload();
    orders.reload();
  };
  const total = (positions.data ?? []).reduce((a, p) => a + p.marketValue, 0);
  const totalPl = (positions.data ?? []).reduce((a, p) => a + p.unrealizedPl, 0);

  return (
    <>
      <h1>
        Portfolio <span className={`badge ${isDemo ? "demo" : env}`}>{envLabel(env)}</span>
      </h1>
      {action.error && <p className="error">{action.error}</p>}

      <section className="card">
        <div className="card-head">
          <h3>Positions</h3>
          {positions.data && positions.data.length > 0 && (
            <span>
              {usd(total)} <span className={tone(totalPl)}>({signed(totalPl)})</span>
            </span>
          )}
        </div>
        {!positions.data ? <Loading error={positions.error} /> : positions.data.length === 0
          ? <Empty>You hold nothing in this account.</Empty>
          : (
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th className="num">Quantity</th>
                    <th className="num">Avg cost</th>
                    <th className="num">Price</th>
                    <th className="num">Value</th>
                    <th className="num">Today</th>
                    <th className="num">Total gain / loss</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {positions.data.map((p) => (
                    <tr key={p.symbol}>
                      <td><SymbolLink symbol={p.symbol} /></td>
                      <td className="num">{qty(p.qty)}</td>
                      <td className="num">{px(p.avgPrice)}</td>
                      <td className="num">{px(p.price)}</td>
                      <td className="num">{usd(p.marketValue)}</td>
                      <td className={`num ${tone(p.dayPl)}`}>{signed(p.dayPl)}</td>
                      <td className={`num ${tone(p.unrealizedPl)}`}>
                        {signed(p.unrealizedPl)} <small>{pct(p.unrealizedPlPct)}</small>
                      </td>
                      <td className="num">
                        {confirmClose === p.symbol
                          ? (
                            <span className="row end">
                              <button
                                className="danger"
                                disabled={action.busy}
                                onClick={() =>
                                  action.run(() => api.closePosition(env, p.symbol)).then(() => {
                                    setConfirmClose(null);
                                    reload();
                                  })}
                              >
                                Sell all
                              </button>
                              <button onClick={() => setConfirmClose(null)}>Keep</button>
                            </span>
                          )
                          : <button className="link" onClick={() => setConfirmClose(p.symbol)}>Close</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      <section className="card">
        <h3>Orders</h3>
        {!orders.data ? <Loading error={orders.error} /> : orders.data.length === 0
          ? <Empty>No orders yet.</Empty>
          : (
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Symbol</th>
                    <th>Order</th>
                    <th className="num">Size</th>
                    <th className="num">Filled at</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {orders.data.map((o) => (
                    <tr key={o.id}>
                      <td>{dateTime(o.submittedAt)}</td>
                      <td><SymbolLink symbol={o.symbol} /></td>
                      <td>
                        <span className={o.side === "buy" ? "up" : "down"}>{o.side === "buy" ? "Buy" : "Sell"}</span>{" "}
                        {o.type.replace("_", "-")}
                        {o.limitPrice != null && ` @ ${px(o.limitPrice)}`}
                        {o.stopPrice != null && ` stop ${px(o.stopPrice)}`}
                      </td>
                      <td className="num">{o.qty != null ? qty(o.qty) : usd(o.notional)}</td>
                      <td className="num">{px(o.filledAvgPrice)}</td>
                      <td>{o.status.replace(/_/g, " ")}</td>
                      <td className="num">
                        {OPEN.has(o.status) && (
                          <button
                            className="link"
                            disabled={action.busy}
                            onClick={() => action.run(() => api.cancelOrder(env, o.id)).then(reload)}
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </>
  );
}
