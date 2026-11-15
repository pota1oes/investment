import { describe, expect, it } from "vitest";
import {
  backtest,
  type Bar,
  completedBars,
  computeSignals,
  normalizeStrategy,
  rsi,
  sma,
} from "../supabase/functions/_shared/strategy.ts";

const DAY = 86_400_000;
const bars = (closes: number[]): Bar[] =>
  closes.map((c, i) => ({ t: i * DAY, o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 }));

describe("indicators", () => {
  it("sma", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("rsi is 100 on a straight rise and 0 on a straight fall", () => {
    const up = rsi([1, 2, 3, 4, 5, 6], 3);
    expect(up[5]).toBe(100);
    const down = rsi([6, 5, 4, 3, 2, 1], 3);
    expect(down[5]).toBe(0);
    expect(up.slice(0, 3)).toEqual([null, null, null]);
  });
});

describe("signals", () => {
  it("sma_cross goes long in an uptrend and flat in a downtrend", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const down = Array.from({ length: 30 }, (_, i) => 130 - i);
    const cfg = { id: "sma_cross" as const, params: { fast: 3, slow: 10 } };
    const s = computeSignals(cfg, bars([...up, ...down]));
    expect(s[5]).toBe("hold"); // not enough data yet
    expect(s[29]).toBe("long");
    expect(s[59]).toBe("flat");
  });
  it("signals never look ahead", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.1);
    for (const id of ["sma_cross", "rsi_reversion", "breakout"] as const) {
      const cfg = normalizeStrategy({ id, params: { fast: 5, slow: 12, period: 5, entry: 8, exit: 4 } });
      const full = computeSignals(cfg, bars(closes));
      const partial = computeSignals(cfg, bars(closes.slice(0, 50)));
      expect(partial).toEqual(full.slice(0, 50));
    }
  });
  it("normalizeStrategy clamps bad input", () => {
    const n = normalizeStrategy({ id: "sma_cross", params: { fast: 500, slow: 1 } });
    expect(n.params.fast).toBe(200);
    expect(n.params.slow).toBe(201);
  });
  it("completedBars drops an unfinished bar", () => {
    const b = bars([1, 2, 3]);
    expect(completedBars(b, "1Day", 2 * DAY + 5).length).toBe(2);
    expect(completedBars(b, "1Day", 3 * DAY).length).toBe(3);
  });
});

describe("backtest", () => {
  const cfg = { id: "sma_cross" as const, params: { fast: 3, slow: 10 } };
  it("makes money following a clean trend and exits on the way down", () => {
    const up = Array.from({ length: 60 }, (_, i) => 100 + i * 2);
    const down = Array.from({ length: 30 }, (_, i) => 218 - i * 4);
    const r = backtest(cfg, bars([...up, ...down]), { cash: 1000, feeBps: 0, stopLossPct: 0 });
    expect(r.trades.length).toBe(1);
    expect(r.trades[0].reason).toBe("signal");
    expect(r.totalReturnPct).toBeGreaterThan(50);
    expect(r.finalValue).toBeCloseTo(1000 * (1 + r.totalReturnPct / 100));
  });
  it("fees reduce the result", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 6) * 15);
    const free = backtest(cfg, bars(closes), { cash: 1000, feeBps: 0, stopLossPct: 0 });
    const paid = backtest(cfg, bars(closes), { cash: 1000, feeBps: 50, stopLossPct: 0 });
    expect(free.trades.length).toBeGreaterThan(2);
    expect(paid.finalValue).toBeLessThan(free.finalValue);
  });
  it("stop-loss caps a crash and blocks re-entry until the signal resets", () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    const closes = [...up, 60, 60, 60];
    const r = backtest(cfg, bars(closes), { cash: 1000, feeBps: 0, stopLossPct: 5 });
    expect(r.trades.length).toBe(1);
    expect(r.trades[0].reason).toBe("stop");
    // gapped below the stop, so the fill is the open of the crash bar, not the stop price
    expect(r.trades[0].exitPrice).toBe(60);
    expect(r.maxDrawdownPct).toBeGreaterThan(30);
  });
});
