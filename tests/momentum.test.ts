import { describe, expect, it } from "vitest";
import { type BotConfig, type BrokerPort, initialState, runBot } from "../supabase/functions/_shared/engine.ts";
import {
  backtestPortfolio,
  type Bar,
  portfolioSignals,
  strategySlots,
} from "../supabase/functions/_shared/strategy.ts";

const DAY = 86_400_000;
const mk = (closes: number[], offset = 0): Bar[] =>
  closes.map((c, i) => ({ t: i * DAY + offset, o: c, h: c * 1.005, l: c * 0.995, c, v: 1 }));
const line = (n: number, start: number, step: number) => Array.from({ length: n }, (_, i) => start + i * step);

const cfg = { id: "momentum" as const, params: { lookback: 10, topN: 1, trend: 10 } };

describe("momentum rotation signals", () => {
  const data = {
    FAST: mk(line(40, 100, 3)), // strongest
    SLOW: mk(line(40, 100, 1)), // second
    DOWN: mk(line(40, 200, -2)), // falling
  };
  it("goes long the strongest, holds the runner-up, avoids fallers", () => {
    const s = portfolioSignals(cfg, data);
    expect(s.FAST.at(-1)).toBe("long");
    expect(s.SLOW.at(-1)).toBe("hold");
    expect(s.DOWN.at(-1)).toBe("flat");
    expect(s.FAST[5]).toBe("hold"); // not enough history yet
  });
  it("stays out when everything is falling", () => {
    const s = portfolioSignals(cfg, { A: mk(line(40, 200, -1)), B: mk(line(40, 300, -2)) });
    expect(s.A.at(-1)).toBe("flat");
    expect(s.B.at(-1)).toBe("flat");
  });
  it("never looks ahead", () => {
    const wavy = (p: number) => Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 7 + p) * 20 + i * 0.3);
    const full = { A: mk(wavy(0)), B: mk(wavy(2)), C: mk(wavy(4), 3_600_000) }; // C on a different clock
    const cut = Object.fromEntries(Object.entries(full).map(([k, v]) => [k, v.slice(0, 55)]));
    const a = portfolioSignals(cfg, full);
    const b = portfolioSignals(cfg, cut);
    for (const k of Object.keys(full)) expect(b[k]).toEqual(a[k].slice(0, 55));
  });
  it("slots follow topN, capped by the list size", () => {
    expect(strategySlots({ id: "momentum", params: { topN: 3 } }, 8)).toBe(3);
    expect(strategySlots({ id: "momentum", params: { topN: 3 } }, 2)).toBe(2);
    expect(strategySlots({ id: "sma_cross", params: {} }, 5)).toBe(5);
  });
});

describe("backtestPortfolio", () => {
  it("rotates from the old leader into the new one", () => {
    const a = [...line(30, 100, 3), ...line(30, 187, -3)]; // rises then falls
    const b = [...line(30, 100, 0.2), ...line(30, 106, 4)]; // flat then rises
    const r = backtestPortfolio(cfg, { A: mk(a), B: mk(b) }, { cash: 1000, feeBps: 0, stopLossPct: 0 });
    const order = r.trades.map((t) => t.symbol);
    expect(order[0]).toBe("A");
    expect(order.at(-1)).toBe("B");
    expect(r.finalValue).toBeGreaterThan(1000);
    expect(r.finalValue).toBeCloseTo(1000 + r.trades.reduce((x, t) => x + t.profit, 0));
    expect(r.perSymbol.A.trades + r.perSymbol.B.trades).toBe(r.trades.length);
  });
  it("is never more than fully invested and money is conserved with fees", () => {
    const wavy = (p: number) => Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 9 + p) * 25 + i * 0.2);
    const data = { A: mk(wavy(0)), B: mk(wavy(2)), C: mk(wavy(4)), D: mk(wavy(5)) };
    const two = { id: "momentum" as const, params: { lookback: 10, topN: 2, trend: 10 } };
    const free = backtestPortfolio(two, data, { cash: 1000, feeBps: 0, stopLossPct: 0 });
    const paid = backtestPortfolio(two, data, { cash: 1000, feeBps: 30, stopLossPct: 0 });
    expect(free.trades.length).toBeGreaterThan(3);
    expect(paid.finalValue).toBeLessThan(free.finalValue);
    expect(free.finalValue).toBeCloseTo(1000 + free.trades.reduce((x, t) => x + t.profit, 0));
    expect(Math.min(...free.equity.map((e) => e.value))).toBeGreaterThan(0);
    expect(free.investedPct).toBeGreaterThan(0);
    expect(free.investedPct).toBeLessThanOrEqual(100);
  });
  it("matches a single-symbol strategy when given one symbol", () => {
    const up = [...line(60, 100, 2), ...line(30, 218, -4)];
    const r = backtestPortfolio({ id: "sma_cross", params: { fast: 3, slow: 10 } }, { X: mk(up) }, {
      cash: 1000,
      feeBps: 0,
      stopLossPct: 0,
    });
    expect(r.trades.length).toBe(1);
    expect(r.totalReturnPct).toBeGreaterThan(30);
  });
});

describe("runBot with momentum rotation", () => {
  function broker(prices: Record<string, number[]>) {
    const held: Record<string, number> = {};
    const orders: Record<string, { status: string; filledQty: number; filledAvgPrice: number }> = {};
    const placed: { symbol: string; side: string; notional?: number; qty?: number }[] = [];
    let n = 0;
    const port: BrokerPort = {
      getBars: async (s) => mk(prices[s]),
      getOrder: async (id) => orders[id],
      placeOrder: async (o) => {
        placed.push(o);
        const px = prices[o.symbol].at(-1)!;
        const qty = o.side === "buy" ? o.notional! / px : o.qty!;
        held[o.symbol] = (held[o.symbol] ?? 0) + (o.side === "buy" ? qty : -qty);
        orders[`o${++n}`] = { status: "filled", filledQty: qty, filledAvgPrice: px };
        return { id: `o${n}` };
      },
      isStockMarketOpen: async () => true,
      getPositionQty: async (s) => held[s] ?? 0,
    };
    return { port, placed, prices };
  }
  const bot: BotConfig = {
    name: "rot",
    strategy: cfg,
    symbols: ["AAA", "BBB", "CCC"],
    timeframe: "1Day",
    budget: 900,
    stopLossPct: 0,
    maxDrawdownPct: 0,
  };
  const NOW = 10_000 * DAY;

  it("puts the whole budget in the single strongest symbol, then rotates sell-first", async () => {
    const f = broker({ AAA: line(30, 100, 3), BBB: line(30, 100, 1), CCC: line(30, 200, -2) });
    let s = (await runBot(bot, initialState(900), f.port, NOW)).state;
    expect(f.placed).toEqual([{ symbol: "AAA", side: "buy", notional: 900 }]);
    s = (await runBot(bot, s, f.port, NOW)).state;
    expect(Object.keys(s.positions)).toEqual(["AAA"]);

    // AAA collapses, BBB becomes the leader.
    f.prices.AAA = [...line(30, 100, 3), ...line(15, 180, -8)];
    f.prices.BBB = [...line(30, 100, 1), ...line(15, 135, 6)];
    f.prices.CCC = [...line(30, 200, -2), ...line(15, 140, -2)];
    const sellCycle = await runBot(bot, s, f.port, NOW);
    // Same cycle: the sale is placed but the buy waits for the cash.
    expect(f.placed.slice(1)).toMatchObject([{ symbol: "AAA", side: "sell" }]);
    const buyCycle = await runBot(bot, sellCycle.state, f.port, NOW);
    expect(f.placed.at(-1)).toMatchObject({ symbol: "BBB", side: "buy" });
    expect(f.placed.at(-1)!.notional).toBeCloseTo(buyCycle.state.equity, 0);
    const done = await runBot(bot, buyCycle.state, f.port, NOW);
    expect(Object.keys(done.state.positions)).toEqual(["BBB"]);
    expect(f.placed.length).toBe(3);
  });

  it("reports missing price history once, not every cycle", async () => {
    const f = broker({ AAA: line(30, 100, 3), BBB: line(4, 100, 1), CCC: line(30, 200, -2) });
    const r1 = await runBot(bot, initialState(900), f.port, NOW);
    const r2 = await runBot(bot, r1.state, f.port, NOW);
    const note = (r: typeof r1) => r.events.filter((e) => e.symbol === "BBB" && e.type === "info").length;
    expect(note(r1)).toBe(1);
    expect(note(r2)).toBe(0);
  });
});
