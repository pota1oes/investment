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
export type StrategyId = "sma_cross" | "rsi_reversion" | "breakout";
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
  { name: string; description: string; params: ParamSpec[] }
> = {
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
