import { describe, expect, it } from "vitest";
import {
  type BotConfig,
  type BrokerPort,
  initialState,
  liquidateBot,
  runBot,
  validateBotConfig,
} from "../supabase/functions/_shared/engine.ts";
import type { Bar } from "../supabase/functions/_shared/strategy.ts";

const DAY = 86_400_000;
const mk = (closes: number[]): Bar[] =>
  closes.map((c, i) => ({ t: i * DAY, o: c, h: c, l: c, c, v: 1 }));

/** Fake broker: orders fill instantly at the latest close. */
function fakeBroker(prices: Record<string, number[]>, opts: { open?: boolean; feePct?: number } = {}) {
  const held: Record<string, number> = {};
  const orders: Record<string, { status: string; filledQty: number; filledAvgPrice: number }> = {};
  const placed: { symbol: string; side: string; notional?: number; qty?: number }[] = [];
  let n = 0;
  const broker: BrokerPort = {
    getBars: async (s) => {
      if (!prices[s]) throw new Error("no data");
      return mk(prices[s]);
    },
    getOrder: async (id) => orders[id],
    placeOrder: async (o) => {
      placed.push(o);
      const px = prices[o.symbol].at(-1)!;
      const qty = o.side === "buy" ? o.notional! / px : o.qty!;
      held[o.symbol] = (held[o.symbol] ?? 0) +
        (o.side === "buy" ? qty * (1 - (opts.feePct ?? 0) / 100) : -qty);
      const id = `o${++n}`;
      orders[id] = { status: "filled", filledQty: qty, filledAvgPrice: px };
      return { id };
    },
    isStockMarketOpen: async () => opts.open ?? true,
    getPositionQty: async (s) => held[s] ?? 0,
  };
  return { broker, placed, prices };
}

const up = Array.from({ length: 30 }, (_, i) => 100 + i); // ends at 129
const cfg: BotConfig = {
  name: "t",
  strategy: { id: "sma_cross", params: { fast: 3, slow: 10 } },
  symbols: ["AAA", "BBB"],
  timeframe: "1Day",
  budget: 1000,
  stopLossPct: 10,
  maxDrawdownPct: 30,
};
const NOW = 1000 * DAY;

describe("runBot", () => {
  it("splits the budget across symbols and never spends more than it has", async () => {
    const f = fakeBroker({ AAA: up, BBB: up });
    const r1 = await runBot(cfg, initialState(1000), f.broker, NOW);
    expect(f.placed).toEqual([
      { symbol: "AAA", side: "buy", notional: 500 },
      { symbol: "BBB", side: "buy", notional: 500 },
    ]);
    expect(r1.state.cash).toBe(0);
    expect(r1.state.pending.length).toBe(2);

    const r2 = await runBot(cfg, r1.state, f.broker, NOW);
    expect(r2.state.pending.length).toBe(0);
    expect(r2.state.positions.AAA.qty).toBeCloseTo(500 / 129);
    expect(r2.state.equity).toBeCloseTo(1000);
    expect(f.placed.length).toBe(2); // already invested: no new orders
  });

  it("sells on a flat signal and books the loss", async () => {
    const noStop = { ...cfg, stopLossPct: 0 };
    const f = fakeBroker({ AAA: up, BBB: up });
    let s = (await runBot(noStop, initialState(1000), f.broker, NOW)).state;
    s = (await runBot(noStop, s, f.broker, NOW)).state;
    f.prices.AAA = [...up, 140, 150, 160, 120, 110, 105]; // fast average drops under the slow one
    const r = await runBot(noStop, s, f.broker, NOW);
    expect(f.placed.at(-1)).toMatchObject({ symbol: "AAA", side: "sell" });
    expect(r.events.at(-1)!.type).toBe("order");
    s = (await runBot(noStop, r.state, f.broker, NOW)).state;
    expect(s.positions.AAA).toBeUndefined();
    expect(s.positions.BBB).toBeDefined();
    expect(s.realizedPnl).toBeCloseTo((500 / 129) * (105 - 129));
    expect(s.cash).toBeCloseTo((500 / 129) * 105);
  });

  it("stop-loss sells and blocks re-entry while the signal is still long", async () => {
    const one = { ...cfg, symbols: ["AAA"], maxDrawdownPct: 0 };
    const f = fakeBroker({ AAA: up });
    let s = (await runBot(one, initialState(1000), f.broker, NOW)).state;
    s = (await runBot(one, s, f.broker, NOW)).state;
    f.prices.AAA = [...up.slice(0, -1), 300, 300, 300, 115]; // averages still say long; price -11% from entry
    const r = await runBot(one, s, f.broker, NOW);
    expect(r.events.some((e) => e.type === "risk" && e.message.includes("stop-loss"))).toBe(true);
    s = (await runBot(one, r.state, f.broker, NOW)).state;
    expect(s.positions.AAA).toBeUndefined();
    expect(s.blocked.AAA).toBe(true);
    expect(f.placed.filter((p) => p.side === "buy").length).toBe(1);
  });

  it("halts and liquidates at the loss limit", async () => {
    const one = { ...cfg, symbols: ["AAA"], stopLossPct: 0 };
    const f = fakeBroker({ AAA: up });
    let s = (await runBot(one, initialState(1000), f.broker, NOW)).state;
    s = (await runBot(one, s, f.broker, NOW)).state;
    f.prices.AAA = [...up, 80];
    const r = await runBot(one, s, f.broker, NOW);
    expect(r.halted).toBe(true);
    expect(f.placed.at(-1)).toMatchObject({ symbol: "AAA", side: "sell" });
  });

  it("does not trade stocks while the market is closed, but still trades crypto", async () => {
    const mixed = { ...cfg, symbols: ["AAA", "BTC/USD"] };
    const f = fakeBroker({ AAA: up, "BTC/USD": up }, { open: false });
    await runBot(mixed, initialState(1000), f.broker, NOW);
    expect(f.placed.map((p) => p.symbol)).toEqual(["BTC/USD"]);
  });

  it("ignores an unfinished bar", async () => {
    const one = { ...cfg, symbols: ["AAA"] };
    const flatThenSpike = [...Array.from({ length: 29 }, (_, i) => 130 - i), 500];
    const f = fakeBroker({ AAA: flatThenSpike });
    await runBot(one, initialState(1000), f.broker, 29 * DAY + 1000); // last bar still forming
    expect(f.placed.length).toBe(0);
  });

  it("never sells more than the account really holds (crypto fees)", async () => {
    const one = { ...cfg, symbols: ["BTC/USD"] };
    const f = fakeBroker({ "BTC/USD": up }, { feePct: 0.25 });
    let s = (await runBot(one, initialState(1000), f.broker, NOW)).state;
    s = (await runBot(one, s, f.broker, NOW)).state;
    const r = await liquidateBot(s, f.broker);
    expect(f.placed.at(-1)!.qty).toBeCloseTo((1000 / 129) * 0.9975);
    const done = await liquidateBot(r.state, f.broker);
    expect(done.state.positions).toEqual({});
  });

  it("one failing symbol does not stop the others", async () => {
    const f = fakeBroker({ AAA: up });
    const r = await runBot(cfg, initialState(1000), f.broker, NOW);
    expect(r.events.some((e) => e.type === "error" && e.symbol === "BBB")).toBe(true);
    expect(f.placed.map((p) => p.symbol)).toEqual(["AAA"]);
  });
});

describe("validateBotConfig", () => {
  it("rejects bad input", () => {
    expect(() => validateBotConfig({ ...cfg, symbols: [] })).toThrow();
    expect(() => validateBotConfig({ ...cfg, budget: 1 })).toThrow();
    expect(() => validateBotConfig({ ...cfg, symbols: ["ASML.AMS"] })).toThrow();
    expect(() => validateBotConfig({ ...cfg, symbols: ["DROP TABLE"] })).toThrow();
    expect(validateBotConfig({ ...cfg, symbols: ["aaa", "AAA", "btc/usd"] }).symbols).toEqual([
      "AAA",
      "BTC/USD",
    ]);
  });
});
