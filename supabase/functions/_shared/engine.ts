// The auto-trader. One call to runBot() = one decision cycle for one bot.
// It talks to the broker only through BrokerPort, so the same code runs on the
// server against Alpaca, in demo mode against a simulator, and in unit tests.

import {
  type Bar,
  completedBars,
  minBars,
  normalizeStrategy,
  portfolioSignals,
  type Signal,
  type StrategyConfig,
  strategySlots,
  type Timeframe,
} from "./strategy.ts";

export interface BotConfig {
  name: string;
  strategy: StrategyConfig;
  symbols: string[];
  timeframe: Timeframe;
  budget: number; // money the bot is allowed to use
  stopLossPct: number; // per position, 0 = off
  maxDrawdownPct: number; // bot sells everything and halts when it has lost this much of its budget
}

export interface PendingOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  notional?: number; // cash reserved for a buy
  qty?: number;
  reason: string;
}

export interface BotState {
  cash: number; // un-invested, un-reserved cash
  positions: Record<string, { qty: number; avgPrice: number }>;
  pending: PendingOrder[];
  blocked: Record<string, boolean>; // symbols stopped out, waiting for a fresh setup
  realizedPnl: number;
  equity: number; // last computed value of the bot
  waiting?: Record<string, boolean>; // symbols already reported as lacking price history
}

export interface BrokerPort {
  getBars(symbol: string, timeframe: Timeframe, limit: number): Promise<Bar[]>;
  getOrder(id: string): Promise<{ status: string; filledQty: number; filledAvgPrice: number }>;
  placeOrder(o: {
    symbol: string;
    side: "buy" | "sell";
    notional?: number;
    qty?: number;
  }): Promise<{ id: string }>;
  isStockMarketOpen(): Promise<boolean>;
  /** Quantity actually held in the brokerage account (may be less than the bot thinks, e.g. after fees). */
  getPositionQty(symbol: string): Promise<number>;
}

export interface BotEvent {
  type: "order" | "fill" | "info" | "risk" | "error";
  symbol?: string;
  message: string;
}

export const MIN_ORDER_USD = 10;
const TERMINAL = new Set(["filled", "canceled", "cancelled", "expired", "rejected"]);

export const isCrypto = (symbol: string) => symbol.includes("/");
export const isEuSymbol = (symbol: string) => /\.[A-Z]{3}$/.test(symbol);

export function initialState(budget: number): BotState {
  return { cash: budget, positions: {}, pending: [], blocked: {}, realizedPnl: 0, equity: budget };
}

export function validateBotConfig(input: BotConfig): BotConfig {
  const symbols = [...new Set((input.symbols ?? []).map((s) => String(s).trim().toUpperCase()))]
    .filter(Boolean);
  if (symbols.length === 0) throw new Error("Add at least one symbol.");
  if (symbols.length > 20) throw new Error("A bot can trade at most 20 symbols.");
  for (const s of symbols) {
    if (isEuSymbol(s)) throw new Error(`${s} cannot be traded through Alpaca yet.`);
    if (!/^[A-Z0-9.]{1,10}(\/[A-Z]{3,5})?$/.test(s)) throw new Error(`Invalid symbol: ${s}`);
  }
  const budget = Number(input.budget);
  if (!Number.isFinite(budget) || budget < MIN_ORDER_USD) {
    throw new Error(`Budget must be at least $${MIN_ORDER_USD}.`);
  }
  if (!["15Min", "1Hour", "1Day"].includes(input.timeframe)) throw new Error("Invalid timeframe.");
  const pct = (v: unknown, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0;
  };
  return {
    name: String(input.name ?? "").trim().slice(0, 60) || "My bot",
    strategy: normalizeStrategy(input.strategy),
    symbols,
    timeframe: input.timeframe,
    budget: Math.round(budget * 100) / 100,
    stopLossPct: pct(input.stopLossPct, 90),
    maxDrawdownPct: pct(input.maxDrawdownPct, 100),
  };
}

const money = (n: number) => `$${n.toFixed(2)}`;
const clone = (s: BotState): BotState => JSON.parse(JSON.stringify(s));

/** Apply fills / cancellations of orders placed in earlier cycles. */
async function reconcile(state: BotState, broker: BrokerPort, events: BotEvent[]) {
  const still: PendingOrder[] = [];
  for (const p of state.pending) {
    let o;
    try {
      o = await broker.getOrder(p.id);
    } catch (e) {
      events.push({ type: "error", symbol: p.symbol, message: `Could not check order: ${msg(e)}` });
      still.push(p);
      continue;
    }
    if (!TERMINAL.has(o.status)) {
      still.push(p);
      continue;
    }
    const qty = o.filledQty || 0;
    const price = o.filledAvgPrice || 0;
    if (p.side === "buy") {
      const cost = qty * price;
      state.cash += (p.notional ?? 0) - cost; // release whatever part of the reservation was not spent
      if (qty > 0) {
        const pos = state.positions[p.symbol] ?? { qty: 0, avgPrice: 0 };
        const total = pos.qty + qty;
        state.positions[p.symbol] = {
          qty: total,
          avgPrice: (pos.qty * pos.avgPrice + cost) / total,
        };
        events.push({
          type: "fill",
          symbol: p.symbol,
          message: `Bought ${fmtQty(qty)} at ${money(price)} (${p.reason})`,
        });
      }
    } else {
      const pos = state.positions[p.symbol];
      if (pos && qty > 0) {
        state.cash += qty * price;
        const pnl = (price - pos.avgPrice) * qty;
        state.realizedPnl += pnl;
        events.push({
          type: "fill",
          symbol: p.symbol,
          message: `Sold ${fmtQty(qty)} at ${money(price)}, ${pnl >= 0 ? "profit" : "loss"} ${
            money(Math.abs(pnl))
          } (${p.reason})`,
        });
        // A sell order always targets the whole position; anything left over is
        // dust (e.g. crypto fees), so only keep it if the order did not complete.
        if (o.status === "filled" || pos.qty - qty < 1e-9) delete state.positions[p.symbol];
        else pos.qty -= qty;
      }
    }
    if (o.status !== "filled") {
      events.push({
        type: "info",
        symbol: p.symbol,
        message: `Order ${o.status}${qty > 0 ? " after a partial fill" : ""}.`,
      });
    }
  }
  state.pending = still;
}

async function sell(
  symbol: string,
  reason: string,
  state: BotState,
  broker: BrokerPort,
  events: BotEvent[],
) {
  const pos = state.positions[symbol];
  if (!pos) return;
  const held = await broker.getPositionQty(symbol);
  const qty = Math.min(pos.qty, held);
  if (qty <= 0) {
    delete state.positions[symbol];
    events.push({
      type: "info",
      symbol,
      message: "Position no longer exists in the brokerage account; removed from the bot.",
    });
    return;
  }
  const { id } = await broker.placeOrder({ symbol, side: "sell", qty });
  state.pending.push({ id, symbol, side: "sell", qty, reason });
  events.push({
    type: reason === "signal" ? "order" : "risk",
    symbol,
    message: `Sell order for ${fmtQty(qty)} (${reason})`,
  });
}

export interface RunResult {
  state: BotState;
  events: BotEvent[];
  halted: boolean;
}

export async function runBot(
  config: BotConfig,
  prev: BotState,
  broker: BrokerPort,
  now: number,
): Promise<RunResult> {
  const cfg = validateBotConfig(config);
  const state = clone(prev);
  const events: BotEvent[] = [];

  await reconcile(state, broker, events);

  const hasStocks = cfg.symbols.concat(Object.keys(state.positions)).some((s) => !isCrypto(s));
  let marketOpen = false;
  if (hasStocks) {
    try {
      marketOpen = await broker.isStockMarketOpen();
    } catch (e) {
      events.push({ type: "error", message: `Could not read market hours: ${msg(e)}` });
    }
  }
  const tradable = (s: string) => isCrypto(s) || marketOpen;

  // Load prices for everything the bot trades or still holds.
  const universe = [...new Set([...cfg.symbols, ...Object.keys(state.positions)])];
  const need = minBars(cfg.strategy);
  const data: Record<string, Bar[]> = {};
  for (const symbol of universe) {
    try {
      const raw = await broker.getBars(symbol, cfg.timeframe, need + 10);
      data[symbol] = completedBars(raw, cfg.timeframe, now);
    } catch (e) {
      events.push({ type: "error", symbol, message: `Could not load prices: ${msg(e)}` });
    }
  }
  const lastPrice = (s: string) => {
    const b = data[s];
    return b && b.length ? b[b.length - 1].c : state.positions[s]?.avgPrice ?? 0;
  };

  const reserved = state.pending.reduce((a, p) => a + (p.side === "buy" ? p.notional ?? 0 : 0), 0);
  state.equity = state.cash + reserved +
    Object.entries(state.positions).reduce((a, [s, p]) => a + p.qty * lastPrice(s), 0);

  // Hard risk limit: stop the whole bot once it has lost too much of its budget.
  if (cfg.maxDrawdownPct > 0 && state.equity <= cfg.budget * (1 - cfg.maxDrawdownPct / 100)) {
    events.push({
      type: "risk",
      message: `Bot value ${money(state.equity)} hit the ${cfg.maxDrawdownPct}% loss limit on a ${
        money(cfg.budget)
      } budget. Selling everything and stopping.`,
    });
    await liquidateInto(state, broker, events, "loss limit", tradable);
    return { state, events, halted: true };
  }

  // Signals for the configured symbols, computed together so that strategies which
  // compare symbols with each other (momentum rotation) see the whole list.
  const usable: Record<string, Bar[]> = {};
  state.waiting ??= {};
  for (const symbol of cfg.symbols) {
    const bars = data[symbol];
    if (!bars) continue;
    if (bars.length < need) {
      if (!state.waiting[symbol]) {
        state.waiting[symbol] = true;
        events.push({
          type: "info",
          symbol,
          message: `Only ${bars.length} of ${need} price bars available; skipping until there are more.`,
        });
      }
      continue;
    }
    delete state.waiting[symbol];
    usable[symbol] = bars;
  }
  const allSignals = portfolioSignals(cfg.strategy, usable);
  const signalOf = (s: string): Signal | undefined => allSignals[s]?.at(-1);
  const slots = strategySlots(cfg.strategy, cfg.symbols.length);
  const busy = (s: string) => state.pending.some((p) => p.symbol === s);

  // Pass 1: exits (removed symbols, stop-losses, sell signals).
  for (const symbol of universe) {
    const pos = state.positions[symbol];
    const signal = signalOf(symbol);
    if (signal === "flat") state.blocked[symbol] = false;
    if (!pos || busy(symbol) || !tradable(symbol)) continue;
    try {
      const price = data[symbol]?.at(-1)?.c;
      if (!cfg.symbols.includes(symbol)) {
        await sell(symbol, "removed from bot", state, broker, events);
      } else if (
        price != null && cfg.stopLossPct > 0 && price <= pos.avgPrice * (1 - cfg.stopLossPct / 100)
      ) {
        state.blocked[symbol] = true;
        await sell(symbol, "stop-loss", state, broker, events);
      } else if (signal === "flat") {
        await sell(symbol, "signal", state, broker, events);
      }
    } catch (e) {
      events.push({ type: "error", symbol, message: msg(e) });
    }
  }

  // Pass 2: entries. Wait while any sale is still settling, so the freed cash is
  // available and a rotation never buys a half-sized position.
  if (!state.pending.some((p) => p.side === "sell")) {
    const wanted = cfg.symbols.filter((s) =>
      signalOf(s) === "long" && !state.positions[s] && !state.blocked[s] && !busy(s) && tradable(s)
    );
    for (const symbol of wanted) {
      try {
        const target = state.equity / slots;
        const notional = Math.floor(Math.min(state.cash, target) * 100) / 100;
        // Skip scraps: a position far below its intended size is not worth opening.
        if (notional < MIN_ORDER_USD || notional < target * 0.5) continue;
        const { id } = await broker.placeOrder({ symbol, side: "buy", notional });
        state.cash -= notional;
        state.pending.push({ id, symbol, side: "buy", notional, reason: "signal" });
        events.push({ type: "order", symbol, message: `Buy order for ${money(notional)} (signal)` });
      } catch (e) {
        events.push({ type: "error", symbol, message: msg(e) });
      }
    }
  }
  return { state, events, halted: false };
}

async function liquidateInto(
  state: BotState,
  broker: BrokerPort,
  events: BotEvent[],
  reason: string,
  tradable: (s: string) => boolean,
) {
  for (const symbol of Object.keys(state.positions)) {
    if (state.pending.some((p) => p.symbol === symbol && p.side === "sell")) continue;
    if (!tradable(symbol)) {
      events.push({
        type: "info",
        symbol,
        message: "Market is closed; this position must be sold when it reopens.",
      });
      continue;
    }
    try {
      await sell(symbol, reason, state, broker, events);
    } catch (e) {
      events.push({ type: "error", symbol, message: msg(e) });
    }
  }
}

/** Kill switch: settle open orders, then sell every position the bot holds. */
export async function liquidateBot(prev: BotState, broker: BrokerPort): Promise<RunResult> {
  const state = clone(prev);
  const events: BotEvent[] = [];
  await reconcile(state, broker, events);
  let open = false;
  if (Object.keys(state.positions).some((s) => !isCrypto(s))) {
    try {
      open = await broker.isStockMarketOpen();
    } catch (e) {
      events.push({ type: "error", message: `Could not read market hours: ${msg(e)}` });
    }
  }
  await liquidateInto(state, broker, events, "manual stop", (s) => isCrypto(s) || open);
  return { state, events, halted: true };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtQty(q: number): string {
  return String(Math.round(q * 1e6) / 1e6);
}
