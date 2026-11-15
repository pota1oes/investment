import { useState } from "react";
import { isCrypto } from "../../supabase/functions/_shared/engine.ts";
import { useAction, useEnv } from "../hooks.tsx";
import { api, envLabel, isDemo } from "../lib/api.ts";
import { px, qty as fmtQty, usd } from "../lib/format.ts";
import type { OrderRequest } from "../lib/types.ts";

export function OrderTicket(
  { symbol, price, held, cash, onDone }: {
    symbol: string;
    price: number;
    held: number;
    cash: number | undefined;
    onDone: () => void;
  },
) {
  const { env } = useEnv();
  const crypto = isCrypto(symbol);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<OrderRequest["type"]>("market");
  const [unit, setUnit] = useState<"usd" | "shares">("usd");
  const [amount, setAmount] = useState("");
  const [limit, setLimit] = useState("");
  const [stop, setStop] = useState("");
  const [review, setReview] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const action = useAction();

  const n = Number(amount);
  const byDollars = type === "market" && unit === "usd";
  const refPrice = type === "limit" || type === "stop_limit" ? Number(limit) || price : price;
  const shares = byDollars ? n / price : n;
  const cost = byDollars ? n : n * refPrice;
  const needsLimit = type === "limit" || type === "stop_limit";
  const needsStop = type === "stop" || type === "stop_limit";

  let problem: string | null = null;
  if (!(n > 0)) problem = "Enter an amount.";
  else if (needsLimit && !(Number(limit) > 0)) problem = "Enter a limit price.";
  else if (needsStop && !(Number(stop) > 0)) problem = "Enter a stop price.";
  else if (side === "sell" && shares > held + 1e-9) problem = `You hold ${fmtQty(held)}.`;
  else if (side === "buy" && cash != null && cost > cash) problem = `Only ${usd(cash)} cash available.`;

  const request: OrderRequest = {
    symbol,
    side,
    type,
    tif: crypto ? "gtc" : type === "market" ? "day" : "gtc",
    ...(byDollars ? { notional: n } : { qty: n }),
    ...(needsLimit ? { limitPrice: Number(limit) } : {}),
    ...(needsStop ? { stopPrice: Number(stop) } : {}),
  };

  const submit = () =>
    action.run(async () => {
      const o = await api.placeOrder(env, request);
      setDone(
        o.status === "filled"
          ? `Filled: ${side === "buy" ? "bought" : "sold"} ${fmtQty(o.filledQty)} ${symbol} at ${px(o.filledAvgPrice)}.`
          : `Order sent (${o.status}). Track it under Portfolio.`,
      );
      setReview(false);
      setAmount("");
      onDone();
    });

  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setReview(false);
    setDone(null);
    action.clear();
  };

  return (
    <div className="card ticket">
      <div className="card-head">
        <h3>Trade {symbol}</h3>
        <span className={`badge ${isDemo ? "demo" : env}`}>{envLabel(env)}</span>
      </div>
      <div className="seg full">
        <button className={side === "buy" ? "on buy" : ""} onClick={() => edit(setSide)("buy")}>Buy</button>
        <button className={side === "sell" ? "on sell" : ""} onClick={() => edit(setSide)("sell")}>Sell</button>
      </div>

      <label>
        Order type
        <select value={type} onChange={(e) => edit(setType)(e.target.value as OrderRequest["type"])}>
          <option value="market">Market — fill now at the best price</option>
          <option value="limit">Limit — only at my price or better</option>
          {!crypto && <option value="stop">Stop — trigger when price hits a level</option>}
          <option value="stop_limit">Stop-limit</option>
        </select>
      </label>

      <label>
        <span className="row between">
          {byDollars ? "Amount (USD)" : crypto ? "Quantity" : "Shares"}
          {type === "market" && (
            <button className="link" type="button" onClick={() => edit(setUnit)(unit === "usd" ? "shares" : "usd")}>
              Switch to {unit === "usd" ? (crypto ? "quantity" : "shares") : "dollars"}
            </button>
          )}
        </span>
        <input inputMode="decimal" placeholder="0" value={amount} onChange={(e) => edit(setAmount)(e.target.value)} />
      </label>
      {needsStop && (
        <label>
          Stop price
          <input inputMode="decimal" placeholder={px(price)} value={stop} onChange={(e) => edit(setStop)(e.target.value)} />
        </label>
      )}
      {needsLimit && (
        <label>
          Limit price
          <input inputMode="decimal" placeholder={px(price)} value={limit} onChange={(e) => edit(setLimit)(e.target.value)} />
        </label>
      )}

      <dl className="kv">
        <dt>Last price</dt>
        <dd>{px(price)}</dd>
        <dt>Estimated {byDollars ? (crypto ? "quantity" : "shares") : side === "buy" ? "cost" : "proceeds"}</dt>
        <dd>{n > 0 ? (byDollars ? fmtQty(shares) : usd(cost)) : "—"}</dd>
        <dt>{side === "buy" ? "Cash available" : "You hold"}</dt>
        <dd>{side === "buy" ? usd(cash) : fmtQty(held)}</dd>
      </dl>

      {action.error && <p className="error">{action.error}</p>}
      {done && <p className="ok">{done}</p>}

      {!review
        ? (
          <button className="primary full" disabled={!!problem} title={problem ?? ""} onClick={() => setReview(true)}>
            {problem && n > 0 ? problem : "Review order"}
          </button>
        )
        : (
          <div className="confirm">
            <p>
              {side === "buy" ? "Buy" : "Sell"} <b>{byDollars ? usd(n) : fmtQty(n)}</b>
              {byDollars ? " of " : " "}
              <b>{symbol}</b> — {type.replace("_", "-")} order
              {needsStop && <>, stop {px(Number(stop))}</>}
              {needsLimit && <>, limit {px(Number(limit))}</>}
              {isDemo ? ", with fake money." : env === "live" ? ", using real money." : ", on the paper account."}
            </p>
            <div className="row">
              <button onClick={() => setReview(false)} disabled={action.busy}>Back</button>
              <button className={`primary grow ${side}`} onClick={submit} disabled={action.busy}>
                {action.busy ? "Sending…" : isDemo ? "Place fake-money order" : env === "live" ? "Place real order" : "Place paper order"}
              </button>
            </div>
          </div>
        )}
    </div>
  );
}
