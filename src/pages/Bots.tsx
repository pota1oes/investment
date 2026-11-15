import { useState } from "react";
import { isEuSymbol } from "../../supabase/functions/_shared/engine.ts";
import {
  backtestPortfolio,
  defaultParams,
  minBars,
  type PortfolioBacktest,
  STRATEGIES,
  type StrategyId,
  strategySlots,
} from "../../supabase/functions/_shared/strategy.ts";
import { LineChart } from "../components/Chart.tsx";
import { Empty, Loading, Search } from "../components/common.tsx";
import { Term } from "../components/ui.tsx";
import { useAction, useAsync, useEnv } from "../hooks.tsx";
import { api, envLabel, isDemo } from "../lib/api.ts";
import { barsCached } from "../lib/cache.ts";
import { ago, dateTime, pct, px, qty, signed, tone, usd } from "../lib/format.ts";
import type { Bar, Bot, BotConfig, Env, Timeframe } from "../lib/types.ts";

const TIMEFRAMES: { value: Timeframe; label: string; bars: number }[] = [
  { value: "1Day", label: "Once a day (calm, fewer trades)", bars: 760 },
  { value: "1Hour", label: "Every hour", bars: 1000 },
  { value: "15Min", label: "Every 15 minutes (busy, many trades)", bars: 1000 },
];

const RISK = {
  cautious: { label: "Cautious", stopLossPct: 6, maxDrawdownPct: 10 },
  balanced: { label: "Balanced", stopLossPct: 10, maxDrawdownPct: 20 },
  bold: { label: "Bold", stopLossPct: 15, maxDrawdownPct: 35 },
} as const;
type RiskKey = keyof typeof RISK;
const riskOf = (c: BotConfig): RiskKey | null =>
  (Object.keys(RISK) as RiskKey[]).find((k) => RISK[k].stopLossPct === c.stopLossPct && RISK[k].maxDrawdownPct === c.maxDrawdownPct) ?? null;

const base = (patch: Partial<BotConfig>): BotConfig => ({
  name: "",
  strategy: { id: "momentum", params: defaultParams("momentum") },
  symbols: [],
  timeframe: "1Day",
  budget: 1000,
  stopLossPct: RISK.balanced.stopLossPct,
  maxDrawdownPct: RISK.balanced.maxDrawdownPct,
  ...patch,
});

// Ready-made examples of well-known rule sets. They are starting points to study
// and test, not recommendations, and any of them can lose money.
const PRESETS: { key: string; title: string; tag: string; text: string; config: BotConfig }[] = [
  {
    key: "funds",
    title: "Follow the strongest markets",
    tag: "Momentum rotation · 8 funds",
    text: "Watches funds covering US and international stocks, bonds, gold and real estate. Holds the 3 that rose most over about 6 months and waits in cash when nothing is rising.",
    config: base({
      name: "Strongest markets",
      strategy: { id: "momentum", params: { lookback: 126, topN: 3, trend: 100 } },
      symbols: ["SPY", "QQQ", "IWM", "EFA", "EEM", "TLT", "GLD", "VNQ"],
    }),
  },
  {
    key: "stocks",
    title: "Strongest large companies",
    tag: "Momentum rotation · 12 stocks",
    text: "Ranks twelve large US companies by their rise over about 6 months and holds the top 4. Single stocks swing more than funds.",
    config: base({
      name: "Strongest companies",
      strategy: { id: "momentum", params: { lookback: 126, topN: 4, trend: 100 } },
      symbols: ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "JPM", "JNJ", "XOM", "WMT", "KO"],
    }),
  },
  {
    key: "trend",
    title: "Ride the S&P 500 trend",
    tag: "Trend following · 1 fund",
    text: "Holds an S&P 500 fund while its 50-day average is above its 200-day average, otherwise stays in cash. Trades only a few times a year.",
    config: base({
      name: "S&P 500 trend",
      strategy: { id: "sma_cross", params: { fast: 50, slow: 200 } },
      symbols: ["SPY"],
    }),
  },
  {
    key: "dip",
    title: "Buy the dip",
    tag: "Mean reversion · 2 funds",
    text: "Buys S&P 500 and Nasdaq funds after sharp falls and sells once they recover. Spends a lot of time in cash.",
    config: base({
      name: "Buy the dip",
      strategy: { id: "rsi_reversion", params: defaultParams("rsi_reversion") },
      symbols: ["SPY", "QQQ"],
    }),
  },
];

interface TestOutput {
  r: PortfolioBacktest;
  days: number;
}

function Editor(
  { initial, onClose }: { initial: { id?: string; env: Env; config: BotConfig | null }; onClose: (saved: boolean) => void },
) {
  const { broker } = useEnv();
  const [cfg, setCfg] = useState<BotConfig | null>(initial.config);
  const [env, setEnv] = useState<Env>(initial.env);
  const [test, setTest] = useState<TestOutput | null>(null);
  const save = useAction();
  const testing = useAction();

  if (!cfg) {
    return (
      <section className="card">
        <div className="card-head">
          <div>
            <h3>Choose a starting point</h3>
            <small className="muted">Well-known rule sets you can test and adjust. Examples to learn from, not recommendations.</small>
          </div>
          <button className="link" onClick={() => onClose(false)}>Cancel</button>
        </div>
        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p.key} className="preset" onClick={() => setCfg(p.config)}>
              <small>{p.tag}</small>
              <b>{p.title}</b>
              <span>{p.text}</span>
            </button>
          ))}
          <button className="preset" onClick={() => setCfg(base({ name: "My bot" }))}>
            <small>Custom</small>
            <b>Build my own</b>
            <span>Pick the rules and what to trade yourself.</span>
          </button>
        </div>
      </section>
    );
  }

  const spec = STRATEGIES[cfg.strategy.id];
  const set = (patch: Partial<BotConfig>) => {
    setCfg({ ...cfg, ...patch });
    setTest(null);
  };
  const n = (v: string) => (v === "" ? 0 : Number(v));
  const risk = riskOf(cfg);
  const slots = strategySlots(cfg.strategy, Math.max(1, cfg.symbols.length));

  const runTest = () =>
    testing.run(async () => {
      if (!cfg.symbols.length) throw new Error("Add at least one thing to trade first.");
      const tf = TIMEFRAMES.find((t) => t.value === cfg.timeframe)!;
      const need = minBars(cfg.strategy);
      const data: Record<string, Bar[]> = {};
      await Promise.all(cfg.symbols.map(async (symbol) => {
        const bars = await barsCached(symbol, cfg.timeframe, tf.bars);
        if (bars.length < need + 20) throw new Error(`Not enough price history for ${symbol} to test these rules.`);
        data[symbol] = bars;
      }));
      const r = backtestPortfolio(cfg.strategy, data, { cash: cfg.budget, feeBps: 5, stopLossPct: cfg.stopLossPct });
      setTest({ r, days: r.equity.length > 1 ? Math.round((r.equity.at(-1)!.t - r.equity[0].t) / 86_400_000) : 0 });
    });

  return (
    <section className="card">
      <div className="card-head">
        <h3>{initial.id ? "Edit bot" : "Set up your bot"}</h3>
        <button className="link" onClick={() => onClose(false)}>Cancel</button>
      </div>
      <p className="muted">{spec.description}</p>

      <div className="form-grid">
        <label>
          Name
          <input value={cfg.name} placeholder="My bot" maxLength={60} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label>
          Which money?
          <select value={env} disabled={!!initial.id} onChange={(e) => setEnv(e.target.value as Env)}>
            <option value="paper">{isDemo ? "Fake money (simulator)" : "Paper (practice money)"}</option>
            <option value="live" disabled={!broker?.live}>
              Real money{broker?.live ? "" : " — connect a live account first"}
            </option>
          </select>
        </label>
        <label>
          <Term k="budget">Budget (USD)</Term>
          <span className="money-input">
            <input type="number" min={10} step="any" value={cfg.budget || ""} onChange={(e) => set({ budget: n(e.target.value) })} />
          </span>
          <small>The bot can never have more than this invested.</small>
        </label>
        <div className="field">
          <span>How careful should it be?</span>
          <div className="seg">
            {(Object.keys(RISK) as RiskKey[]).map((k) => (
              <button
                key={k}
                type="button"
                className={risk === k ? "on" : ""}
                onClick={() => set({ stopLossPct: RISK[k].stopLossPct, maxDrawdownPct: RISK[k].maxDrawdownPct })}
              >
                {RISK[k].label}
              </button>
            ))}
          </div>
          <small>
            Sells a holding that falls {cfg.stopLossPct}% and switches itself off after losing {cfg.maxDrawdownPct}% of
            the budget ({usd(cfg.budget * cfg.maxDrawdownPct / 100, 0)}).
          </small>
        </div>
        <div className="span2 field">
          <span>
            What it may trade — holds up to {slots} at a time, about {usd(cfg.budget / slots, 0)} each
          </span>
          <div className="chips">
            {cfg.symbols.map((s) => (
              <button key={s} className="on" title="Remove" onClick={() => set({ symbols: cfg.symbols.filter((x) => x !== s) })}>
                {s} ×
              </button>
            ))}
            <Search
              placeholder="Add stock, fund or coin…"
              onPick={(a) => {
                if (isEuSymbol(a.symbol) || !a.tradable) {
                  return save.run(async () => {
                    throw new Error(`${a.symbol} cannot be traded through Alpaca.`);
                  });
                }
                if (!cfg.symbols.includes(a.symbol)) set({ symbols: [...cfg.symbols, a.symbol] });
              }}
            />
          </div>
        </div>
      </div>

      <details className="advanced">
        <summary>Advanced settings</summary>
        <div className="form-grid">
          <label className="span2">
            Rules
            <select
              value={cfg.strategy.id}
              onChange={(e) => {
                const id = e.target.value as StrategyId;
                set({ strategy: { id, params: defaultParams(id) } });
              }}
            >
              {Object.entries(STRATEGIES).map(([id, s]) => <option key={id} value={id}>{s.name}</option>)}
            </select>
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
                  set({ strategy: { ...cfg.strategy, params: { ...cfg.strategy.params, [p.key]: n(e.target.value) } } })}
              />
            </label>
          ))}
          <label>
            <Term k="bars">How often it checks prices</Term>
            <select value={cfg.timeframe} onChange={(e) => set({ timeframe: e.target.value as Timeframe })}>
              {TIMEFRAMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          <label>
            <Term k="stopLoss">Stop-loss per holding (%)</Term>
            <input type="number" min={0} max={90} step="any" value={cfg.stopLossPct} onChange={(e) => set({ stopLossPct: n(e.target.value) })} />
            <small>0 = off</small>
          </label>
          <label>
            <Term k="lossLimit">Total loss limit (%)</Term>
            <input type="number" min={0} max={100} step="any" value={cfg.maxDrawdownPct} onChange={(e) => set({ maxDrawdownPct: n(e.target.value) })} />
            <small>0 = off</small>
          </label>
        </div>
      </details>

      <div className="row wrap">
        <button onClick={runTest} disabled={testing.busy}>
          {testing.busy ? "Testing…" : "Test on past prices"}
        </button>
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
          <h3>What would have happened over the last {test.days} days</h3>
          <div className="tiles small">
            <div className="tile">
              <span>These rules</span>
              <b className={tone(test.r.totalReturnPct)}>{pct(test.r.totalReturnPct)}</b>
              <small>{usd(cfg.budget)} → {usd(test.r.finalValue)}</small>
            </div>
            <div className="tile">
              <span><Term k="benchmark">Just holding everything</Term></span>
              <b className={tone(test.r.benchmarkReturnPct)}>{pct(test.r.benchmarkReturnPct)}</b>
              <small>no trading at all</small>
            </div>
            <div className="tile">
              <span><Term k="drawdown">Worst drop on the way</Term></span>
              <b className="down">−{test.r.maxDrawdownPct.toFixed(1)}%</b>
              <small>−{usd(cfg.budget * test.r.maxDrawdownPct / 100, 0)} at its worst</small>
            </div>
            <div className="tile">
              <span>Trades</span>
              <b>{test.r.trades.length}</b>
              <small>
                {test.r.trades.length ? `${test.r.winRatePct.toFixed(0)}% made money · ` : ""}
                invested {test.r.investedPct.toFixed(0)}% of the time
              </small>
            </div>
          </div>
          {test.r.equity.length > 1 && (
            <LineChart points={test.r.equity} intraday={cfg.timeframe !== "1Day"} baseline={cfg.budget} height={220} />
          )}
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="num">Times traded</th>
                  <th className="num">Profit / loss</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(test.r.perSymbol).sort((a, b) => b[1].profit - a[1].profit).map(([symbol, s]) => (
                  <tr key={symbol}>
                    <td>{symbol}</td>
                    <td className="num">{s.trades}</td>
                    <td className={`num ${tone(s.profit)}`}>{s.trades ? signed(s.profit) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">
            {isDemo && <b>Fake-money prices are randomly generated, so this result says nothing about real markets.{" "}</b>}
            A simulation on past prices with 0.05% cost per trade, not a forecast. Real trading adds slippage, gaps and
            outages, and rules that worked before can lose money later.
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
    <section className={`card bot ${bot.status}`}>
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
        {STRATEGIES[bot.config.strategy.id].name} · {bot.config.symbols.join(", ")} · checks{" "}
        {bot.config.timeframe === "1Day" ? "daily" : bot.config.timeframe === "1Hour" ? "hourly" : "every 15 min"}
      </p>
      <div className="tiles small">
        <div className="tile"><span>Worth now</span><b>{usd(bot.state.equity)}</b></div>
        <div className="tile">
          <span>Profit / loss</span>
          <b className={tone(pnl)}>{signed(pnl)}</b>
          <small className={tone(pnl)}>{pct((pnl / bot.config.budget) * 100)}</small>
        </div>
        <div className="tile"><span><Term k="budget">Budget</Term></span><b>{usd(bot.config.budget)}</b></div>
        <div className="tile"><span>Waiting in cash</span><b>{usd(bot.state.cash)}</b></div>
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
  const [editing, setEditing] = useState<{ id?: string; env: Env; config: BotConfig | null } | null>(null);

  return (
    <>
      <div className="row between">
        <h1>Auto-trader</h1>
        {!editing && <button className="primary" onClick={() => setEditing({ env, config: null })}>New bot</button>}
      </div>
      <p className="muted lead">
        A <Term k="bot">bot</Term> trades for you by following fixed rules with a fixed budget.{" "}
        {api.mode === "demo"
          ? "In fake-money mode it only acts when you press “Check now”."
          : "The server checks every running bot every few minutes, even when this page is closed."}{" "}
        It never spends more than its budget and never touches holdings it did not buy itself.
      </p>

      {!editing && bots.data?.length === 0 && (
        <section className="card how">
          <h3>How it works</h3>
          <ol>
            <li><b>Pick a setup.</b> Start from a ready-made rule set or build your own.</li>
            <li><b>Test it.</b> See what the rules would have done on past prices, including the worst drop.</li>
            <li><b>Run it on practice money.</b> Watch what it does for a few weeks before you trust it.</li>
            <li><b>Decide.</b> Only then consider real money — and only an amount you can afford to lose.</li>
          </ol>
          <button className="primary" onClick={() => setEditing({ env, config: null })}>Set up my first bot</button>
        </section>
      )}

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
      {!bots.data ? <Loading error={bots.error} /> : bots.data.map((b) => (
        <BotCard key={b.id} bot={b} reload={bots.reload} onEdit={() => setEditing({ id: b.id, env: b.env, config: b.config })} />
      ))}
      <p className="note">
        Automated trading can lose money quickly. No rule set here is a recommendation, and past results do not
        predict future ones. Only fund a real-money bot with an amount you can afford to lose.
      </p>
    </>
  );
}
