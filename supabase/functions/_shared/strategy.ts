// Pure trading logic shared by the website (backtests) and the server (live bot).
// No imports, no I/O — everything here is deterministic and unit-tested.

export interface Bar {
  t: number; // bar start, ms since epoch
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Signal = "long" | "flat" | "hold";
export type StrategyId = "momentum" | "sma_cross" | "rsi_reversion" | "breakout";
export type Timeframe = "15Min" | "1Hour" | "1Day";

export interface StrategyConfig {
  id: StrategyId;
  params: Record<string, number>;
}

export interface ParamSpec {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
}

export const STRATEGIES: Record<
  StrategyId,
  { name: string; description: string; params: ParamSpec[]; portfolio?: boolean }
> = {
  momentum: {
    name: "Momentum rotation (hold the strongest few)",
    description:
      "Ranks everything on the list by how much it rose over the lookback period and holds only the strongest few, each only while it is above its own long-term average. When nothing qualifies, it waits in cash.",
    portfolio: true,
    params: [
      { key: "lookback", label: "Lookback (bars)", default: 126, min: 5, max: 300 },
      { key: "topN", label: "How many to hold", default: 3, min: 1, max: 10 },
      { key: "trend", label: "Long-term average (bars)", default: 100, min: 2, max: 300 },
    ],
  },
  sma_cross: {
    name: "Trend following (moving-average cross)",
    description:
      "Holds the asset while the fast moving average is above the slow one, and sells when it drops below.",
    params: [
      { key: "fast", label: "Fast average (bars)", default: 20, min: 2, max: 200 },
      { key: "slow", label: "Slow average (bars)", default: 50, min: 3, max: 400 },
    ],
  },
  rsi_reversion: {
    name: "Buy the dip (RSI mean reversion)",
    description:
      "Buys when RSI falls below the entry level (oversold) and sells once RSI recovers above the exit level.",
    params: [
      { key: "period", label: "RSI period (bars)", default: 14, min: 2, max: 100 },
      { key: "buyBelow", label: "Buy when RSI below", default: 30, min: 1, max: 60 },
      { key: "sellAbove", label: "Sell when RSI above", default: 55, min: 20, max: 99 },
    ],
  },
  breakout: {
    name: "Breakout (Donchian channel)",
    description:
      "Buys when price closes above the highest high of the entry window, sells when it closes below the lowest low of the exit window.",
    params: [
      { key: "entry", label: "Entry window (bars)", default: 20, min: 2, max: 300 },
      { key: "exit", label: "Exit window (bars)", default: 10, min: 2, max: 300 },
    ],
  },
};

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "15Min": 15 * 60_000,
  "1Hour": 60 * 60_000,
  "1Day": 24 * 60 * 60_000,
};

export function defaultParams(id: StrategyId): Record<string, number> {
  return Object.fromEntries(STRATEGIES[id].params.map((p) => [p.key, p.default]));
}

/** Fill in defaults and clamp every parameter into its allowed range. */
export function normalizeStrategy(cfg: StrategyConfig): StrategyConfig {
  const spec = STRATEGIES[cfg.id];
  if (!spec) throw new Error(`Unknown strategy: ${cfg.id}`);
  const params: Record<string, number> = {};
  for (const p of spec.params) {
    const raw = Number(cfg.params?.[p.key]);
    const v = Number.isFinite(raw) ? raw : p.default;
    params[p.key] = Math.min(p.max, Math.max(p.min, Math.round(v)));
  }
  if (cfg.id === "sma_cross" && params.fast >= params.slow) params.slow = params.fast + 1;
  if (cfg.id === "rsi_reversion" && params.sellAbove <= params.buyBelow) {
    params.sellAbove = Math.min(99, params.buyBelow + 1);
  }
  return { id: cfg.id, params };
}

/** Number of completed bars needed before the strategy can produce a signal. */
export function minBars(cfg: StrategyConfig): number {
  const p = normalizeStrategy(cfg).params;
  switch (cfg.id) {
    case "momentum":
      return Math.max(p.lookback + 1, p.trend);
    case "sma_cross":
      return p.slow;
    case "rsi_reversion":
      return p.period + 1;
    case "breakout":
      return Math.max(p.entry, p.exit) + 1;
  }
}

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const toRsi = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = toRsi();
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = toRsi();
  }
  return out;
}

/** Signal for every bar, each computed only from data up to and including that bar. */
export function computeSignals(config: StrategyConfig, bars: Bar[]): Signal[] {
  const cfg = normalizeStrategy(config);
  const p = cfg.params;
  const closes = bars.map((b) => b.c);
  const out: Signal[] = new Array(bars.length).fill("hold");
  switch (cfg.id) {
    case "momentum":
      // Needs every symbol at once; see portfolioSignals(). On its own a symbol only "holds".
      break;
    case "sma_cross": {
      const f = sma(closes, p.fast);
      const s = sma(closes, p.slow);
      for (let i = 0; i < bars.length; i++) {
        const a = f[i];
        const b = s[i];
        if (a != null && b != null) out[i] = a > b ? "long" : "flat";
      }
      break;
    }
    case "rsi_reversion": {
      const r = rsi(closes, p.period);
      for (let i = 0; i < bars.length; i++) {
        const v = r[i];
        if (v == null) continue;
        if (v < p.buyBelow) out[i] = "long";
        else if (v > p.sellAbove) out[i] = "flat";
      }
      break;
    }
    case "breakout": {
      for (let i = Math.max(p.entry, p.exit); i < bars.length; i++) {
        let hi = -Infinity;
        let lo = Infinity;
        for (let j = i - p.entry; j < i; j++) hi = Math.max(hi, bars[j].h);
        for (let j = i - p.exit; j < i; j++) lo = Math.min(lo, bars[j].l);
        if (bars[i].c > hi) out[i] = "long";
        else if (bars[i].c < lo) out[i] = "flat";
      }
      break;
    }
  }
  return out;
}

/** Drop the newest bar if its period has not finished yet, so signals never use partial data. */
export function completedBars(bars: Bar[], timeframe: Timeframe, now: number): Bar[] {
  if (bars.length === 0) return bars;
  const last = bars[bars.length - 1];
  return last.t + TIMEFRAME_MS[timeframe] > now ? bars.slice(0, -1) : bars;
}

export interface BacktestOptions {
  cash: number;
  feeBps: number; // cost per trade side in basis points (fees + slippage)
  stopLossPct: number; // 0 = off
}

export interface BacktestTrade {
  entryT: number;
  entryPrice: number;
  exitT: number;
  exitPrice: number;
  returnPct: number;
  reason: "signal" | "stop" | "end";
}

export interface BacktestResult {
  equity: { t: number; value: number }[];
  trades: BacktestTrade[];
  totalReturnPct: number;
  buyHoldReturnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  finalValue: number;
}

/**
 * Simulates the strategy on one symbol. Signals are read at a bar's close and
 * filled at the NEXT bar's open, so the test never trades on information it
 * could not have had.
 */
export function backtest(
  config: StrategyConfig,
  bars: Bar[],
  opts: BacktestOptions,
): BacktestResult {
  const signals = computeSignals(config, bars);
  const fee = opts.feeBps / 10_000;
  let cash = opts.cash;
  let qty = 0;
  let entryPrice = 0;
  let entryT = 0;
  let blocked = false; // after a stop-loss, wait for a "flat" signal before re-entering
  const equity: { t: number; value: number }[] = [];
  const trades: BacktestTrade[] = [];

  const exit = (price: number, t: number, reason: BacktestTrade["reason"]) => {
    const net = price * (1 - fee);
    cash += qty * net;
    trades.push({
      entryT,
      entryPrice,
      exitT: t,
      exitPrice: price,
      returnPct: (net / entryPrice - 1) * 100,
      reason,
    });
    qty = 0;
  };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const prev = i > 0 ? signals[i - 1] : "hold";
    if (prev === "flat") blocked = false;

    if (qty > 0 && prev === "flat") {
      exit(bar.o, bar.t, "signal");
    } else if (qty === 0 && prev === "long" && !blocked && cash > 0) {
      const cost = bar.o * (1 + fee);
      qty = cash / cost;
      entryPrice = cost;
      entryT = bar.t;
      cash = 0;
    }

    if (qty > 0 && opts.stopLossPct > 0) {
      const stop = entryPrice * (1 - opts.stopLossPct / 100);
      if (bar.l <= stop) {
        exit(Math.min(bar.o, stop), bar.t, "stop");
        blocked = true;
      }
    }
    equity.push({ t: bar.t, value: cash + qty * bar.c });
  }

  if (qty > 0 && bars.length > 0) {
    const last = bars[bars.length - 1];
    exit(last.c, last.t, "end");
    equity[equity.length - 1].value = cash;
  }

  let peak = opts.cash;
  let maxDd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e.value);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - e.value) / peak);
  }
  const finalValue = equity.length ? equity[equity.length - 1].value : opts.cash;
  const wins = trades.filter((t) => t.returnPct > 0).length;
  return {
    equity,
    trades,
    finalValue,
    totalReturnPct: (finalValue / opts.cash - 1) * 100,
    buyHoldReturnPct: bars.length > 1 ? (bars[bars.length - 1].c / bars[0].o - 1) * 100 : 0,
    maxDrawdownPct: maxDd * 100,
    winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
  };
}

// --- Portfolio level ---------------------------------------------------------

/** How many positions the budget is divided over. */
export function strategySlots(config: StrategyConfig, symbolCount: number): number {
  const cfg = normalizeStrategy(config);
  const n = cfg.id === "momentum" ? Math.min(cfg.params.topN, symbolCount) : symbolCount;
  return Math.max(1, n);
}

/**
 * Signals for a whole list of symbols, each aligned to that symbol's own bars.
 * Single-symbol strategies are computed independently. Momentum rotation compares
 * the symbols with each other at every point in time, using only data up to then:
 *   long = among the strongest `topN`, rising, and above its long-term average
 *   hold = just outside the top (keep if already owned, but do not buy)
 *   flat = everything else
 */
export function portfolioSignals(
  config: StrategyConfig,
  data: Record<string, Bar[]>,
): Record<string, Signal[]> {
  const cfg = normalizeStrategy(config);
  const symbols = Object.keys(data).sort();
  if (cfg.id !== "momentum") {
    return Object.fromEntries(symbols.map((s) => [s, computeSignals(cfg, data[s])]));
  }
  const { lookback, topN, trend } = cfg.params;
  const prep = symbols.map((symbol) => {
    const bars = data[symbol];
    const closes = bars.map((b) => b.c);
    return {
      symbol,
      bars,
      closes,
      avg: sma(closes, trend),
      i: -1,
      fresh: false,
      out: new Array<Signal>(bars.length).fill("hold"),
    };
  });
  const times = [...new Set(prep.flatMap((p) => p.bars.map((b) => b.t)))].sort((a, b) => a - b);
  for (const t of times) {
    const scored: { p: (typeof prep)[number]; mom: number; ok: boolean }[] = [];
    for (const p of prep) {
      const before = p.i;
      while (p.i + 1 < p.bars.length && p.bars[p.i + 1].t <= t) p.i++;
      p.fresh = p.i !== before;
      const avg = p.avg[p.i];
      if (p.i >= lookback && avg != null) {
        const mom = p.closes[p.i] / p.closes[p.i - lookback] - 1;
        scored.push({ p, mom, ok: mom > 0 && p.closes[p.i] > avg });
      }
    }
    scored.sort((a, b) => b.mom - a.mom || a.p.symbol.localeCompare(b.p.symbol));
    scored.forEach((x, rank) => {
      if (!x.p.fresh) return;
      x.p.out[x.p.i] = !x.ok ? "flat" : rank < topN ? "long" : rank < topN + 1 ? "hold" : "flat";
    });
  }
  return Object.fromEntries(prep.map((p) => [p.symbol, p.out]));
}

export interface PortfolioTrade extends BacktestTrade {
  symbol: string;
  profit: number;
}

export interface PortfolioBacktest {
  equity: { t: number; value: number }[];
  trades: PortfolioTrade[];
  perSymbol: Record<string, { trades: number; profit: number }>;
  totalReturnPct: number;
  /** Buying every symbol in equal parts at the start and never selling. */
  benchmarkReturnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  finalValue: number;
  /** Share of the time the strategy had money invested. */
  investedPct: number;
}

/**
 * Simulates a bot over several symbols sharing one budget, sized like the live
 * engine (budget split over `strategySlots`). Signals are read at a bar's close
 * and acted on at that symbol's next open. Measurement starts once the strategy
 * has enough history to produce signals, so the comparison with the benchmark is fair.
 */
export function backtestPortfolio(
  config: StrategyConfig,
  data: Record<string, Bar[]>,
  opts: BacktestOptions,
): PortfolioBacktest {
  const symbols = Object.keys(data).filter((s) => data[s].length > 0).sort();
  const signals = portfolioSignals(config, data);
  const slots = strategySlots(config, symbols.length);
  const need = minBars(config);
  const fee = opts.feeBps / 10_000;

  const starts = symbols.map((s) => data[s][Math.min(need, data[s].length) - 1].t);
  const startT = starts.length ? Math.min(...starts) : 0;
  const times = [...new Set(symbols.flatMap((s) => data[s].map((b) => b.t)))]
    .filter((t) => t >= startT)
    .sort((a, b) => a - b);

  let cash = opts.cash;
  const pos: Record<string, { qty: number; entry: number; entryT: number }> = {};
  const blocked: Record<string, boolean> = {};
  const idx: Record<string, number> = {};
  const last: Record<string, number> = {};
  const bench: Record<string, number> = {}; // units held by the buy-and-hold benchmark
  for (const s of symbols) idx[s] = -1;

  const equity: { t: number; value: number }[] = [];
  const trades: PortfolioTrade[] = [];
  const perSymbol: Record<string, { trades: number; profit: number }> = Object.fromEntries(
    symbols.map((s) => [s, { trades: 0, profit: 0 }]),
  );
  let investedSteps = 0;

  const close = (s: string, price: number, t: number, reason: BacktestTrade["reason"]) => {
    const p = pos[s];
    const net = price * (1 - fee);
    const profit = (net - p.entry) * p.qty;
    cash += p.qty * net;
    trades.push({
      symbol: s,
      entryT: p.entryT,
      entryPrice: p.entry,
      exitT: t,
      exitPrice: price,
      returnPct: (net / p.entry - 1) * 100,
      profit,
      reason,
    });
    perSymbol[s].trades++;
    perSymbol[s].profit += profit;
    delete pos[s];
  };

  for (const t of times) {
    const active: string[] = [];
    for (const s of symbols) {
      const bars = data[s];
      let moved = false;
      while (idx[s] + 1 < bars.length && bars[idx[s] + 1].t <= t) {
        idx[s]++;
        moved = true;
      }
      if (moved && bars[idx[s]].t === t) active.push(s);
    }
    const prev = (s: string): Signal => (idx[s] > 0 ? signals[s][idx[s] - 1] : "hold");
    const bar = (s: string) => data[s][idx[s]];

    for (const s of active) {
      if (bench[s] === undefined) bench[s] = opts.cash / symbols.length / bar(s).o;
      if (prev(s) === "flat") blocked[s] = false;
    }
    // Sells first, so the cash they free up can be used for buys on the same bar.
    for (const s of active) if (pos[s] && prev(s) === "flat") close(s, bar(s).o, t, "signal");
    for (const s of active) {
      if (pos[s] || prev(s) !== "long" || blocked[s]) continue;
      const value = cash +
        Object.entries(pos).reduce((a, [k, p]) => a + p.qty * (active.includes(k) ? bar(k).o : last[k]), 0);
      const spend = Math.min(cash, value / slots);
      if (spend < Math.max(1, opts.cash * 0.01)) continue;
      const cost = bar(s).o * (1 + fee);
      pos[s] = { qty: spend / cost, entry: cost, entryT: t };
      cash -= spend;
    }
    for (const s of active) {
      const p = pos[s];
      if (p && opts.stopLossPct > 0) {
        const stop = p.entry * (1 - opts.stopLossPct / 100);
        if (bar(s).l <= stop) {
          close(s, Math.min(bar(s).o, stop), t, "stop");
          blocked[s] = true;
        }
      }
      last[s] = bar(s).c;
    }
    if (Object.keys(pos).length) investedSteps++;
    equity.push({ t, value: cash + Object.entries(pos).reduce((a, [k, p]) => a + p.qty * last[k], 0) });
  }

  const endT = times.length ? times[times.length - 1] : 0;
  for (const s of Object.keys(pos)) close(s, last[s], endT, "end");
  if (equity.length) equity[equity.length - 1].value = cash;

  let peak = opts.cash;
  let maxDd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e.value);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - e.value) / peak);
  }
  const benchFinal = symbols.reduce(
    (a, s) => a + (bench[s] !== undefined ? bench[s] * last[s] : opts.cash / symbols.length),
    0,
  );
  const wins = trades.filter((x) => x.returnPct > 0).length;
  return {
    equity,
    trades,
    perSymbol,
    finalValue: cash,
    totalReturnPct: (cash / opts.cash - 1) * 100,
    benchmarkReturnPct: symbols.length ? (benchFinal / opts.cash - 1) * 100 : 0,
    maxDrawdownPct: maxDd * 100,
    winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
    investedPct: equity.length ? (investedSteps / equity.length) * 100 : 0,
  };
}
