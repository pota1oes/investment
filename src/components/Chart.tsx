import {
  AreaSeries,
  CandlestickSeries,
  createChart,
  HistogramSeries,
  type IChartApi,
  LineSeries,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { sma } from "../../supabase/functions/_shared/strategy.ts";
import type { Bar, Point } from "../lib/types.ts";

const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const ts = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

function useChart(height: number, intraday: boolean, draw: (chart: IChartApi) => void, deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      height,
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: cssVar("--muted"),
        fontFamily: "inherit",
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: cssVar("--line") } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: intraday, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    draw(chart);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={ref} className="chart" style={{ height }} />;
}

export function CandleChart(
  { bars, intraday, averages, height = 380 }: {
    bars: Bar[];
    intraday: boolean;
    averages: boolean;
    height?: number;
  },
) {
  return useChart(height, intraday, (chart) => {
    const up = cssVar("--up");
    const down = cssVar("--down");
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderVisible: false,
      wickUpColor: up,
      wickDownColor: down,
    });
    candles.setData(bars.map((b) => ({ time: ts(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));

    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    volume.setData(
      bars.map((b) => ({ time: ts(b.t), value: b.v, color: (b.c >= b.o ? up : down) + "55" })),
    );

    if (averages) {
      const closes = bars.map((b) => b.c);
      for (const [period, color] of [[20, cssVar("--accent")], [50, cssVar("--warn")]] as const) {
        const line = chart.addSeries(LineSeries, {
          color,
          lineWidth: 1,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
        });
        const values = sma(closes, period);
        line.setData(
          bars.flatMap((b, i) => (values[i] == null ? [] : [{ time: ts(b.t), value: values[i]! }])),
        );
      }
    }
  }, [bars, intraday, averages, height]);
}

export function LineChart(
  { points, intraday = false, height = 240, baseline }: {
    points: Point[];
    intraday?: boolean;
    height?: number;
    baseline?: number;
  },
) {
  return useChart(height, intraday, (chart) => {
    const first = baseline ?? points[0]?.value ?? 0;
    const last = points[points.length - 1]?.value ?? 0;
    const color = last >= first ? cssVar("--up") : cssVar("--down");
    const series = chart.addSeries(AreaSeries, {
      lineColor: color,
      topColor: color + "40",
      bottomColor: color + "00",
      lineWidth: 2,
      priceLineVisible: false,
    });
    // The chart needs strictly increasing times.
    const seen = new Set<number>();
    series.setData(
      points.flatMap((p) => {
        const time = ts(p.t);
        if (seen.has(time)) return [];
        seen.add(time);
        return [{ time, value: p.value }];
      }),
    );
  }, [points, intraday, height, baseline]);
}
