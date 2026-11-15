// Demo mode: a simulated market and brokerage that live entirely in this browser.
// Used when no backend is configured, so the whole app can be tried safely.
import {
  type BrokerPort,
  initialState,
  isCrypto,
  isEuSymbol,
  liquidateBot,
  runBot,
  validateBotConfig,
} from "../../supabase/functions/_shared/engine.ts";
import { TIMEFRAME_MS } from "../../supabase/functions/_shared/strategy.ts";
import type { Api, Asset, Bar, Bot, BotLogEntry, Order, Position, Timeframe, WatchItem } from "./types.ts";

const UNIVERSE: (Asset & { base: number; vol: number })[] = [
  { symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", market: "us", tradable: true, base: 230, vol: 0.016 },
  { symbol: "MSFT", name: "Microsoft Corporation", exchange: "NASDAQ", market: "us", tradable: true, base: 480, vol: 0.014 },
  { symbol: "NVDA", name: "NVIDIA Corporation", exchange: "NASDAQ", market: "us", tradable: true, base: 160, vol: 0.028 },
  { symbol: "AMZN", name: "Amazon.com Inc.", exchange: "NASDAQ", market: "us", tradable: true, base: 220, vol: 0.019 },
  { symbol: "GOOGL", name: "Alphabet Inc. Class A", exchange: "NASDAQ", market: "us", tradable: true, base: 190, vol: 0.018 },
  { symbol: "TSLA", name: "Tesla Inc.", exchange: "NASDAQ", market: "us", tradable: true, base: 340, vol: 0.035 },
  { symbol: "SPY", name: "SPDR S&P 500 ETF", exchange: "ARCA", market: "us", tradable: true, base: 640, vol: 0.009 },
  { symbol: "QQQ", name: "Invesco QQQ ETF", exchange: "NASDAQ", market: "us", tradable: true, base: 560, vol: 0.012 },
  { symbol: "ASML.AMS", name: "ASML Holding NV", exchange: "Amsterdam", market: "eu", tradable: false, base: 690, vol: 0.02 },
  { symbol: "SAP.DEX", name: "SAP SE", exchange: "XETRA", market: "eu", tradable: false, base: 250, vol: 0.015 },
  { symbol: "MC.PAR", name: "LVMH Moët Hennessy", exchange: "Paris", market: "eu", tradable: false, base: 560, vol: 0.018 },
  { symbol: "BTC/USD", name: "Bitcoin", exchange: "Crypto", market: "crypto", tradable: true, base: 98000, vol: 0.03 },
  { symbol: "ETH/USD", name: "Ethereum", exchange: "Crypto", market: "crypto", tradable: true, base: 3400, vol: 0.04 },
];
const DAY = 86_400_000;

function rng(seed: string) {
  let h = 1779033703;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), h = (h << 13) | (h >>> 19);
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

const info = (symbol: string) => {
  const a = UNIVERSE.find((u) => u.symbol === symbol);
  if (!a) throw new Error(`${symbol} is not available in fake-money mode.`);
  return a;
};

const cache = new Map<string, Bar[]>();
/** Walks backwards from the asset's base price so the latest price is stable. */
function series(symbol: string, tf: Timeframe, n: number): Bar[] {
  const key = `${symbol}|${tf}`;
  const hit = cache.get(key);
  if (hit && hit.length >= n) return hit.slice(-n);
  const a = info(symbol);
  const r = rng(key);
  const step = TIMEFRAME_MS[tf];
  const sigma = a.vol * Math.sqrt(step / DAY);
  const drift = 0.0003 * (step / DAY);
  const times: number[] = [];
  let t = Math.floor(Date.now() / step) * step;
  while (times.length < n) {
    const dow = new Date(t).getUTCDay();
    if (isCrypto(symbol) || tf !== "1Day" || (dow !== 0 && dow !== 6)) times.push(t);
    t -= step;
  }
  times.reverse();
  // Mostly noise with a faint slow cycle, so results are not flattering by construction.
  const phase = r() * 6.28;
  const closes = new Array<number>(n);
  let c = a.base;
  for (let i = n - 1; i >= 0; i--) {
    closes[i] = c;
    const cyc = Math.cos(i / 22 + phase) * sigma * 0.1;
    c = c / Math.exp(drift + cyc + gauss(r) * sigma);
  }
  const bars = closes.map((close, i) => {
    const open = i === 0 ? close * (1 - sigma / 2) : closes[i - 1] * (1 + gauss(r) * sigma * 0.15);
    const hi = Math.max(open, close) * (1 + Math.abs(gauss(r)) * sigma * 0.5);
    const lo = Math.min(open, close) * (1 - Math.abs(gauss(r)) * sigma * 0.5);
    return { t: times[i], o: open, h: hi, l: lo, c: close, v: Math.round(1e6 * (0.5 + r())) };
  });
  cache.set(key, bars);
  return bars;
}
const price = (symbol: string) => info(symbol).base;

interface DemoState {
  cash: number;
  positions: Record<string, { qty: number; avgPrice: number }>;
  orders: Order[];
  watchlist: WatchItem[];
  bots: Bot[];
  events: Record<string, BotLogEntry[]>;
}
const KEY = "investment.demo.v1";
function load(): DemoState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* storage unavailable: fall through to a fresh state */ }
  return {
    cash: 100_000,
    positions: {},
    orders: [],
    watchlist: ["AAPL", "NVDA", "SPY", "ASML.AMS", "BTC/USD"].map((s) => ({ symbol: s, name: info(s).name })),
    bots: [],
    events: {},
  };
}
let state = load();
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}
const uid = () => crypto.randomUUID();

function fill(symbol: string, side: "buy" | "sell", qty: number, px: number) {
  const pos = state.positions[symbol] ?? { qty: 0, avgPrice: 0 };
  if (side === "buy") {
    if (qty * px > state.cash + 1e-6) throw new Error("Not enough cash.");
    state.cash -= qty * px;
    state.positions[symbol] = { qty: pos.qty + qty, avgPrice: (pos.qty * pos.avgPrice + qty * px) / (pos.qty + qty) };
  } else {
    if (qty > pos.qty + 1e-9) throw new Error("You cannot sell more than you hold.");
    state.cash += qty * px;
    if (pos.qty - qty < 1e-9) delete state.positions[symbol];
    else state.positions[symbol] = { ...pos, qty: pos.qty - qty };
  }
}

function place(req: { symbol: string; side: "buy" | "sell"; type?: string; qty?: number; notional?: number; limitPrice?: number; stopPrice?: number; tif?: string }): Order {
  const a = info(req.symbol);
  if (!a.tradable) throw new Error("European shares cannot be traded through Alpaca yet.");
  const px = price(req.symbol);
  const type = req.type ?? "market";
  const qty = req.notional ? req.notional / px : Number(req.qty);
  if (!(qty > 0)) throw new Error("Enter a quantity or amount.");
  const marketable = type === "market" || (type === "limit" && (req.side === "buy" ? req.limitPrice! >= px : req.limitPrice! <= px));
  if (marketable) fill(req.symbol, req.side, qty, px);
  const order: Order = {
    id: uid(), symbol: req.symbol, side: req.side, type, tif: req.tif ?? "day",
    qty: req.notional ? null : qty, notional: req.notional ?? null,
    filledQty: marketable ? qty : 0, filledAvgPrice: marketable ? px : null,
    limitPrice: req.limitPrice ?? null, stopPrice: req.stopPrice ?? null,
    status: marketable ? "filled" : "new", submittedAt: new Date().toISOString(),
  };
  state.orders.unshift(order);
  state.orders = state.orders.slice(0, 100);
  save();
  return order;
}

const port: BrokerPort = {
  getBars: async (s, tf, n) => series(s, tf, n),
  getOrder: async (id) => {
    const o = state.orders.find((x) => x.id === id);
    return { status: o?.status ?? "canceled", filledQty: o?.filledQty ?? 0, filledAvgPrice: o?.filledAvgPrice ?? 0 };
  },
  placeOrder: async (o) => ({ id: place(o).id }),
  isStockMarketOpen: async () => true,
  getPositionQty: async (s) => state.positions[s]?.qty ?? 0,
};

function positionsList(): Position[] {
  return Object.entries(state.positions).map(([symbol, p]) => {
    const px = price(symbol);
    const prev = series(symbol, "1Day", 2)[0].c;
    return {
      symbol, qty: p.qty, avgPrice: p.avgPrice, price: px, marketValue: p.qty * px,
      unrealizedPl: (px - p.avgPrice) * p.qty, unrealizedPlPct: (px / p.avgPrice - 1) * 100, dayPl: (px - prev) * p.qty,
    };
  });
}
const equity = () => state.cash + positionsList().reduce((a, p) => a + p.marketValue, 0);
const bot = (id: string) => {
  const b = state.bots.find((x) => x.id === id);
  if (!b) throw new Error("Bot not found.");
  return b;
};
function log(id: string, events: { type: string; symbol?: string; message: string }[]) {
  const list = state.events[id] ?? [];
  for (const e of events) list.unshift({ ...(e as BotLogEntry), id: uid(), ts: new Date().toISOString() });
  state.events[id] = list.slice(0, 100);
}
const wait = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 60));

export const demoApi: Api = {
  mode: "demo",
  brokerStatus: () => wait({ paper: true, live: false }),
  connectBroker: async () => { throw new Error("Brokerage connections are not available in fake-money mode."); },
  disconnectBroker: async () => { throw new Error("Nothing to disconnect in fake-money mode."); },
  account: () => {
    const eq = equity();
    const dayPl = positionsList().reduce((a, p) => a + p.dayPl, 0);
    return wait({ equity: eq, lastEquity: eq - dayPl, cash: state.cash, buyingPower: state.cash, currency: "USD", status: "ACTIVE" });
  },
  positions: () => wait(positionsList()),
  async closePosition(_env, symbol) {
    const p = state.positions[symbol];
    if (p) place({ symbol, side: "sell", qty: p.qty });
  },
  orders: () => wait(state.orders),
  placeOrder: async (_env, req) => place(req),
  async cancelOrder(_env, id) {
    const o = state.orders.find((x) => x.id === id);
    if (o && o.status === "new") o.status = "canceled";
    save();
  },
  portfolioHistory: (_env, period) => {
    const n = period === "1W" ? 7 : period === "3M" ? 90 : period === "1A" ? 250 : 30;
    const spy = series("SPY", "1Day", n);
    const eq = equity();
    const invested = 1 - state.cash / eq;
    const last = spy[spy.length - 1].c;
    return wait(spy.map((b) => ({ t: b.t, value: eq * (1 + (b.c / last - 1) * invested) })));
  },
  clock: () => wait({ isOpen: true, nextOpen: "", nextClose: "" }),
  bars: (symbol, tf, limit) => wait(series(symbol, isEuSymbol(symbol) ? "1Day" : tf, limit)),
  quotes: (symbols) => {
    const out: Record<string, { price: number; prevClose: number; open: number; high: number; low: number; volume: number }> = {};
    for (const s of symbols) {
      if (!UNIVERSE.some((u) => u.symbol === s)) continue;
      const [prev, last] = series(s, "1Day", 2);
      out[s] = { price: last.c, prevClose: prev.c, open: last.o, high: last.h, low: last.l, volume: last.v };
    }
    return wait(out);
  },
  news: (symbols, limit) => {
    const list = symbols.length ? symbols : ["SPY", "NVDA", "BTC/USD"];
    const templates = [
      "{n} shares move as investors weigh the latest results",
      "Analysts revisit their {n} price targets",
      "What to watch for {n} this week",
      "{n}: three charts that explain the recent move",
    ];
    const items = list.flatMap((s, si) =>
      templates.map((tpl, i) => ({
        id: `${s}-${i}`, headline: tpl.replace("{n}", UNIVERSE.find((u) => u.symbol === s)?.name ?? s),
        summary: "Sample headline. Real news appears here once the backend is connected.",
        source: "Sample", url: "", time: new Date(Date.now() - (i * list.length + si) * 3_600_000 * 3).toISOString(), symbols: [s],
      }))
    );
    return wait(items.sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, limit));
  },
  search: (q, market) => {
    const Q = q.trim().toUpperCase();
    return wait(UNIVERSE.filter((u) => (market === "eu") === (u.market === "eu") && (u.symbol.startsWith(Q) || u.name.toUpperCase().includes(Q))));
  },
  watchlist: () => wait(state.watchlist),
  async addWatch(item) {
    if (!state.watchlist.some((w) => w.symbol === item.symbol)) state.watchlist.push(item);
    save();
  },
  async removeWatch(symbol) {
    state.watchlist = state.watchlist.filter((w) => w.symbol !== symbol);
    save();
  },
  bots: () => wait(state.bots),
  async saveBot(_env, input, id) {
    const config = validateBotConfig(input);
    for (const s of config.symbols) info(s);
    if (id) {
      const b = bot(id);
      if (b.status === "running") throw new Error("Pause the bot before editing it.");
      const cash = b.state.cash + (config.budget - b.config.budget);
      if (cash < 0) throw new Error("The new budget is smaller than what the bot has already invested.");
      b.config = config;
      b.state.cash = cash;
    } else {
      state.bots.push({ id: uid(), env: "paper", status: "paused", config, state: initialState(config.budget), lastRunAt: null });
    }
    save();
  },
  async deleteBot(id) {
    const b = bot(id);
    if (Object.keys(b.state.positions).length) throw new Error("This bot still holds positions. Use 'Stop & sell everything' first.");
    state.bots = state.bots.filter((x) => x.id !== id);
    delete state.events[id];
    save();
  },
  async setBotStatus(id, status) {
    const b = bot(id);
    if (status === "running" && b.state.cash > state.cash) throw new Error("The account does not have enough cash for this bot's budget.");
    b.status = status;
    log(id, [{ type: "info", message: status === "running" ? "Bot started." : "Bot paused." }]);
    save();
  },
  async runBot(id) {
    const b = bot(id);
    if (b.status !== "running") throw new Error("Start the bot first.");
    // Two passes: the first places orders, the second records their (instant) fills.
    for (let i = 0; i < 2; i++) {
      const r = await runBot(b.config, b.state, port, Date.now() + DAY);
      b.state = r.state;
      if (r.halted) b.status = "halted";
      log(id, r.events);
      if (r.halted) break;
    }
    b.lastRunAt = new Date().toISOString();
    save();
  },
  async liquidateBot(id) {
    const b = bot(id);
    for (let i = 0; i < 2; i++) {
      const r = await liquidateBot(b.state, port);
      b.state = r.state;
      log(id, r.events);
    }
    b.status = "paused";
    save();
  },
  botEvents: (id) => wait(state.events[id] ?? []),
};

export function resetDemo() {
  try {
    localStorage.removeItem(KEY);
  } catch { /* ignore */ }
  state = load();
}
