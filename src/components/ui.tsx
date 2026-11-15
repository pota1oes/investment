import type { ReactNode } from "react";
import { GLOSSARY } from "../lib/glossary.ts";

/** A term with a plain-language explanation on hover, tap or keyboard focus. */
export function Term({ k, children }: { k: keyof typeof GLOSSARY | string; children?: ReactNode }) {
  const entry = GLOSSARY[k];
  if (!entry) return <>{children}</>;
  return (
    <span className="term" tabIndex={0}>
      {children ?? entry.term}
      <span className="term-pop" role="tooltip">
        <b>{entry.term}</b>
        {entry.text}
      </span>
    </span>
  );
}

export function Sparkline({ values, width = 96, height = 30 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return <svg className="spark" width={width} height={height} aria-hidden />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`);
  const up = values[values.length - 1] >= values[0];
  return (
    <svg className={`spark ${up ? "up" : "down"}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <polygon points={`0,${height} ${pts.join(" ")} ${width},${height}`} className="spark-fill" />
      <polyline points={pts.join(" ")} fill="none" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const PALETTE = ["#4c9aff", "#2ebd85", "#f0b429", "#b98bff", "#ff7eb6", "#3dd6d0", "#ff9f5a", "#8fa3bf"];
export const sliceColor = (i: number) => PALETTE[i % PALETTE.length];

export function Donut({ slices, size = 150, center }: { slices: { label: string; value: number }[]; size?: number; center?: ReactNode }) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  const r = size / 2 - 11;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Allocation">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" className="donut-track" strokeWidth="14" />
        {total > 0 && slices.map((s, i) => {
          const len = (s.value / total) * c;
          const el = (
            <circle
              key={s.label}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={sliceColor(i)}
              strokeWidth="14"
              strokeDasharray={`${Math.max(0, len - 1.5)} ${c}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          );
          offset += len;
          return el;
        })}
      </svg>
      {center && <div className="donut-center">{center}</div>}
    </div>
  );
}

/** Where a value sits between a low and a high. */
export function RangeBar({ low, high, pos, lowLabel, highLabel }: { low: string; high: string; pos: number; lowLabel: string; highLabel: string }) {
  return (
    <div className="range">
      <div className="range-track">
        <span className="range-dot" style={{ left: `${Math.round(pos * 100)}%` }} />
      </div>
      <div className="range-ends">
        <span><small>{lowLabel}</small> {low}</span>
        <span><small>{highLabel}</small> {high}</span>
      </div>
    </div>
  );
}

function hue(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function Avatar({ symbol, logo, size = 32 }: { symbol: string; logo?: string; size?: number }) {
  const style = { width: size, height: size, fontSize: size * 0.36 };
  if (logo) return <img className="avatar" src={logo} alt="" style={style} referrerPolicy="no-referrer" />;
  const h = hue(symbol);
  return (
    <span className="avatar" style={{ ...style, background: `linear-gradient(135deg, hsl(${h} 70% 46%), hsl(${(h + 40) % 360} 70% 36%))` }} aria-hidden>
      {symbol.replace(/[^A-Z]/g, "").slice(0, 2)}
    </span>
  );
}

const ICONS: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  markets: "M4 19V5m0 14h16M8 15l3-4 3 2 5-7",
  portfolio: "M4 7h16v12H4zM9 7V5h6v2M4 12h16",
  bot: "M12 3v3M6 6h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm3 6v2m6-2v2M9 17h6",
  news: "M5 4h11v16H5zM16 8h3v10a2 2 0 0 1-2 2M8 8h5M8 12h5M8 16h3",
  learn: "M3 8l9-4 9 4-9 4zM7 10v5c1.5 1.5 3.2 2 5 2s3.5-.5 5-2v-5",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm8 3-.9-.5.2-1.9-1.8-1-.9 1.2-1.1-.4L15 6h-2l-.5 1.9-1.1.4-.9-1.2-1.8 1 .2 1.9L8 12l.9.5-.2 1.9 1.8 1 .9-1.2 1.1.4.5 1.9h2l.5-1.9 1.1-.4.9 1.2 1.8-1-.2-1.9z",
  check: "M5 12.5l4.5 4.5L19 7.5",
};

export function Icon({ name, size = 18 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[name] ?? ""} />
    </svg>
  );
}
