export const usd = (n: number | null | undefined, digits = 2) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Prices: more decimals for cheap assets. */
export const px = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 5 : 2 });

export const pct = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

export const signed = (n: number) => `${n >= 0 ? "+" : "−"}${usd(Math.abs(n))}`;

export const qty = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 6 });

export const compact = (n: number) =>
  n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });

export const tone = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : "");

export function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const dateTime = (iso: string) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
