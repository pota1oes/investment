import { useState } from "react";
import { isEuSymbol } from "../../supabase/functions/_shared/engine.ts";
import {
  backtest,
  type BacktestResult,
  defaultParams,
  STRATEGIES,
  type StrategyId,
} from "../../supabase/functions/_shared/strategy.ts";
import { LineChart } from "../components/Chart.tsx";
import { Empty, Loading, Search } from "../components/common.tsx";
import { useAction, useAsync, useEnv } from "../hooks.tsx";
import { api, envLabel, isDemo } from "../lib/api.ts";
import { ago, dateTime, pct, px, qty, signed, tone, usd } from "../lib/format.ts";
import type { Bot, BotConfig, Env, Point, Timeframe } from "../lib/types.ts";

const TIMEFRAMES: { value: Timeframe; label: string; bars: number }[] = [
  { value: "1Day", label: "Daily bars (slow, fewer trades)", bars: 520 },
  { value: "1Hour", label: "Hourly bars", bars: 1000 },
  { value: "15Min", label: "15-minute bars (fast, many trades)", bars: 1000 },
];

const blank = (): BotConfig => ({
  name: "",
  strategy: { id: "sma_cross", params: defaultParams("sma_cross") },
  symbols: [],
  timeframe: "1Day",
  budget: 1000,
  stopLossPct: 8,
  maxDrawdownPct: 20,
});

interface TestOutput {
  rows: { symbol: string; r: BacktestResult }[];
  curve: Point[];
  total: number;
  days: number;
}

/** Adds the per-symbol equity curves into one, carrying each last value forward. */
function combine(rows: TestOutput["rows"], perSymbol: number): Point[] {
  const times = [...new Set(rows.flatMap((x) => x.r.equity.map((e) => e.t)))].sort((a, b) => a - b);
  const idx = rows.map(() => 0);
  const last = rows.map(() => perSymbol);
  return times.map((t) => {
    rows.forEach((row, i) => {
      const eq = row.r.equity;
      while (idx[i] < eq.length && eq[idx[i]].t <= t) last[i] = eq[idx[i]++].value;
    });
    return { t, value: last.reduce((a, b) => a + b, 0) };
  });
}

function Editor(
  { initial, onClose }: { initial: { id?: string; env: Env; config: BotConfig }; onClose: (saved: boolean) => void },
) {
  const { broker } = useEnv();
  const [cfg, setCfg] = useState<BotConfig>(initial.config);
  const [env, setEnv] = useState<Env>(initial.env);
  const [test, setTest] = useState<TestOutput | null>(null);
  const save = useAction();
  const testing = useAction();
  const spec = STRATEGIES[cfg.strategy.id];
  const set = (patch: Partial<BotConfig>) => {
    setCfg({ ...cfg, ...patch });
    setTest(null);
  };
  const num = (v: string) => (v === "" ? 0 : Number(v));

  const runTest = () =>
    testing.run(async () => {
      if (!cfg.symbols.length) throw new Error("Add at least one symbol first.");
      const tf = TIMEFRAMES.find((t) => t.value === cfg.timeframe)!;
      const perSymbol = cfg.budget / cfg.symbols.length;
      const rows = await Promise.all(cfg.symbols.map(async (symbol) => {
        const bars = await api.bars(symbol, cfg.timeframe, tf.bars);
        if (bars.length < 30) throw new Error(`Not enough price history for ${symbol}.`);
        return { symbol, r: backtest(cfg.strategy, bars, { cash: perSymbol, feeBps: 5, stopLossPct: cfg.stopLossPct }) };
      }));
      const curve = combine(rows, perSymbol);
      const final = rows.reduce((a, x) => a + x.r.finalValue, 0);
      setTest({
        rows,
        curve,
        total: (final / cfg.budget - 1) * 100,
        days: curve.length > 1 ? Math.round((curve.at(-1)!.t - curve[0].t) / 86_400_000) : 0,
      });
    });

  return (
    <section className="card">
      <div className="card-head">
        <h3>{initial.id ? "Edit bot" : "New bot"}</h3>
        <button className="link" onClick={() => onClose(false)}>Cancel</button>
      </div>
      <div className="form-grid">
        <label>
          Name
          <input value={cfg.name} placeholder="My bot" maxLength={60} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label>
          Account
          <select value={env} disabled={!!initial.id} onChange={(e) => setEnv(e.target.value as Env)}>
            <option value="paper">{isDemo ? "Fake money (simulator)" : "Paper (practice money)"}</option>
            <option value="live" disabled={!broker?.live}>
              Real money{broker?.live ? "" : " — connect a live account first"}
            </option>
          </select>
        </label>
        <label className="span2">
          Strategy
          <select
            value={cfg.strategy.id}
            onChange={(e) => {
              const id = e.target.value as StrategyId;
              set({ strategy: { id, params: defaultParams(id) } });
            }}
          >
            {Object.entries(STRATEGIES).map(([id, s]) => <option key={id} value={id}>{s.name}</option>)}
          </select>
          <small className="muted">{spec.description}</small>
        </label>
        {spec.params.map((p) => (
          <label key={p.key}>
            {p.label}
            <input
              type="number"
              min={p.min}
              max={p.max}
              value={cfg.strategy.params[p.key] ?? p.default}
              onChange={(e) =>
                set({ strategy: { ...cfg.strategy, params: { ...cfg.strategy.params, [p.key]: num(e.target.value) } } })}
            />
          </label>
        ))}
        <label>
          Price bars
          <select value={cfg.timeframe} onChange={(e) => set({ timeframe: e.target.value as Timeframe })}>
            {TIMEFRAMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <div className="span2 field">
          <span>What it may trade (budget is split equally)</span>
          <div className="chips">
            {cfg.symbols.map((s) => (
              <button key={s} className="on" title="Remove" onClick={() => set({ symbols: cfg.symbols.filter((x) => x !== s) })}>
                {s} ×
              </button>
            ))}
            <Search
              placeholder="Add stock, ETF or crypto…"
              onPick={(a) => {
                if (isEuSymbol(a.symbol) || !a.tradable) return save.run(async () => {
                  throw new Error(`${a.symbol} cannot be traded through Alpaca.`);
                });
                if (!cfg.symbols.includes(a.symbol)) set({ symbols: [...cfg.symbols, a.symbol] });
              }}
            />
          </div>
        </div>
        <label>
          Budget (USD)
          <input type="number" min={10} step="any" value={cfg.budget || ""} onChange={(e) => set({ budget: num(e.target.value) })} />
          <small className="muted">The most this bot can ever have invested.</small>
        </label>
        <label>
          Stop-loss per position (%)
          <input type="number" min={0} max={90} step="any" value={cfg.stopLossPct} onChange={(e) => set({ stopLossPct: num(e.target.value) })} />
          <small className="muted">Sells a holding that falls this far below its purchase price. 0 = off.</small>
        </label>
        <label>
          Total loss limit (%)
          <input type="number" min={0} max={100} step="any" value={cfg.maxDrawdownPct} onChange={(e) => set({ maxDrawdownPct: num(e.target.value) })} />
          <small className="muted">If the bot loses this share of its budget it sells everything and stops. 0 = off.</small>
        </label>
      </div>

      <div className="row">
        <button onClick={runTest} disabled={testing.busy}>{testing.busy ? "Testing…" : "Test on past prices"}</button>
        <button
          className="primary"
          disabled={save.busy}
          onClick={() => save.run(() => api.saveBot(env, cfg, initial.id)).then((ok) => ok && onClose(true))}
        >
          {initial.id ? "Save changes" : "Create bot (starts paused)"}
        </button>
      </div>
      {(save.error || testing.error) && <p className="error">{save.error ?? testing.error}</p>}

      {test && (
        <div className="backtest">
          <h3>
            Past {test.days} days: <span className={tone(test.total)}>{pct(test.total)}</span>{" "}
            <small className="muted">on {usd(cfg.budget)}, after 0.05% cost per trade</small>
          </h3>
          <LineChart points={test.curve} intraday={cfg.timeframe !== "1Day"} baseline={cfg.budget} height={220} />
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="num">Strategy</th>
                  <th className="num">Just holding</th>
                  <th className="num">Worst drop</th>
                  <th className="num">Trades</th>
                  <th className="num">Winning trades</th>
                </tr>
              </thead>
              <tbody>
                {test.rows.map(({ symbol, r }) => (
                  <tr key={symbol}>
                    <td>{symbol}</td>
                    <td className={`num ${tone(r.totalReturnPct)}`}>{pct(r.totalReturnPct)}</td>
                    <td className={`num ${tone(r.buyHoldReturnPct)}`}>{pct(r.buyHoldReturnPct)}</td>
                    <td className="num">−{r.maxDrawdownPct.toFixed(1)}%</td>
                    <td className="num">{r.trades.length}</td>
                    <td className="num">{r.trades.length ? `${r.winRatePct.toFixed(0)}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">
            {api.mode === "demo" && <b>Demo prices are randomly generated, so this result says nothing about real markets.{" "}</b>}
            A simulation on past prices, not a forecast. Real trading adds slippage, gaps and outages, and a strategy
            that worked before can lose money later.
          </p>
        </div>
      )}
    </section>
  );
}

function BotCard({ bot, onEdit, reload }: { bot: Bot; onEdit: () => void; reload: () => void }) {
  const [showLog, setShowLog] = useState(false);
  const [confirm, setConfirm] = useState<"stop" | "delete" | "start" | null>(null);
  const action = useAction();
  const log = useAsync(() => (showLog ? api.botEvents(bot.id) : Promise.resolve(null)), [showLog, bot.id, bot.lastRunAt], showLog ? 30_000 : undefined);
  const pnl = bot.state.equity - bot.config.budget;
  const positions = Object.entries(bot.state.positions);
  const live = bot.env === "live";
  const act = (fn: () => Promise<unknown>) =>
    action.run(fn).then(() => {
      setConfirm(null);
      reload();
      log.reload();
    });

  return (
    <section className="card bot">
      <div className="card-head">
        <h3>
          {bot.config.name}{" "}
          <span className={`badge ${bot.status}`}>
            {bot.status === "running" ? "Running" : bot.status === "halted" ? "Stopped by loss limit" : "Paused"}
          </span>{" "}
          <span className={`badge ${isDemo ? "demo" : bot.env}`}>{envLabel(bot.env)}</span>
        </h3>
        <small className="muted">{bot.lastRunAt ? `Last check ${ago(bot.lastRunAt)}` : "Has not run yet"}</small>
      </div>
      <p className="muted">
        {STRATEGIES[bot.config.strategy.id].name} · {bot.config.symbols.join(", ")} ·{" "}
        {bot.config.timeframe === "1Day" ? "daily" : bot.config.timeframe === "1Hour" ? "hourly" : "15-min"} bars
      </p>
      <div className="tiles small">
        <div className="tile"><span>Value</span><b>{usd(bot.state.equity)}</b></div>
        <div className="tile">
          <span>Profit / loss</span>
          <b className={tone(pnl)}>{signed(pnl)}</b>
          <small className={tone(pnl)}>{pct((pnl / bot.config.budget) * 100)}</small>
        </div>
        <div className="tile"><span>Budget</span><b>{usd(bot.config.budget)}</b></div>
        <div className="tile"><span>Uninvested</span><b>{usd(bot.state.cash)}</b></div>
      </div>
      {positions.length > 0 && (
        <p>
          Holding:{" "}
          {positions.map(([s, p]) => `${qty(p.qty)} ${s} @ ${px(p.avgPrice)}`).join(" · ")}
          {bot.state.pending.length > 0 && ` · ${bot.state.pending.length} order(s) in progress`}
        </p>
      )}

      {confirm === "start" && (
        <div className="confirm">
          <p>
            This bot will buy and sell with <b>real money</b>, up to {usd(bot.config.budget)}, without asking you each
            time. You can lose money.
          </p>
          <div className="row">
            <button onClick={() => setConfirm(null)}>Cancel</button>
            <button className="danger" disabled={action.busy} onClick={() => act(() => api.setBotStatus(bot.id, "running"))}>
              Start with real money
            </button>
          </div>
        </div>
      )}
      {confirm === "stop" && (
        <div className="confirm">
          <p>Sell everything this bot holds at market price and pause it?</p>
          <div className="row">
            <button onClick={() => setConfirm(null)}>Cancel</button>
            <button className="danger" disabled={action.busy} onClick={() => act(() => api.liquidateBot(bot.id))}>
              Stop & sell everything
            </button>
          </div>
        </div>
      )}
      {confirm === "delete" && (
        <div className="confirm">
          <p>Delete this bot and its history?</p>
          <div className="row">
            <button onClick={() => setConfirm(null)}>Cancel</button>
            <button className="danger" disabled={action.busy} onClick={() => act(() => api.deleteBot(bot.id))}>Delete</button>
          </div>
        </div>
      )}

      {!confirm && (
        <div className="row wrap">
          {bot.status === "running"
            ? (
              <>
                <button disabled={action.busy} onClick={() => act(() => api.setBotStatus(bot.id, "paused"))}>Pause</button>
                <button disabled={action.busy} onClick={() => act(() => api.runBot(bot.id))}>
                  {action.busy ? "Working…" : "Check now"}
                </button>
              </>
            )
            : (
              <>
                <button
                  className="primary"
                  disabled={action.busy}
                  onClick={() => (live ? setConfirm("start") : act(() => api.setBotStatus(bot.id, "running")))}
                >
                  Start
                </button>
                <button onClick={onEdit}>Edit</button>
                <button onClick={() => setConfirm("delete")}>Delete</button>
              </>
            )}
          {(positions.length > 0 || bot.state.pending.length > 0) && (
            <button className="danger" onClick={() => setConfirm("stop")}>Stop & sell everything</button>
          )}
          <button className="link" onClick={() => setShowLog(!showLog)}>{showLog ? "Hide activity" : "Show activity"}</button>
        </div>
      )}
      {action.error && <p className="error">{action.error}</p>}

      {showLog && (log.data
        ? log.data.length === 0 ? <Empty>No activity yet.</Empty> : (
          <ul className="log">
            {log.data.map((e) => (
              <li key={e.id} className={e.type}>
                <time>{dateTime(e.ts)}</time>
                <span>{e.symbol ? <b>{e.symbol} </b> : null}{e.message}</span>
              </li>
            ))}
          </ul>
        )
        : <Loading error={log.error} />)}
    </section>
  );
}

export function Bots() {
  const { env } = useEnv();
  const bots = useAsync(() => api.bots(), [], 30_000);
  const [editing, setEditing] = useState<{ id?: string; env: Env; config: BotConfig } | null>(null);

  return (
    <>
      <div className="row between">
        <h1>Auto-trader</h1>
        {!editing && <button className="primary" onClick={() => setEditing({ env, config: blank() })}>New bot</button>}
      </div>
      <p className="muted lead">
        A bot follows one rule-based strategy with a fixed budget. {api.mode === "demo"
          ? "In fake-money mode it only acts when you press “Check now”."
          : "The server checks every running bot every few minutes, even when this page is closed."}{" "}
        It never uses more than its budget and never touches holdings it did not buy itself.
      </p>
      {editing && (
        <Editor
          key={editing.id ?? "new"}
          initial={editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) bots.reload();
          }}
        />
      )}
      {!bots.data ? <Loading error={bots.error} /> : bots.data.length === 0 && !editing
        ? (
          <section className="card">
            <Empty>No bots yet. Create one, test it on past prices, and run it on the paper account first.</Empty>
          </section>
        )
        : bots.data.map((b) => (
          <BotCard key={b.id} bot={b} reload={bots.reload} onEdit={() => setEditing({ id: b.id, env: b.env, config: b.config })} />
        ))}
      <p className="note">
        Automated trading can lose money quickly. No strategy here is a recommendation, and past results do not
        predict future ones. Only fund a real-money bot with an amount you can afford to lose.
      </p>
    </>
  );
}
