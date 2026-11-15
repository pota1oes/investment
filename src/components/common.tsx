import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api.ts";
import { ago, errorText } from "../lib/format.ts";
import type { Asset, NewsItem } from "../lib/types.ts";

export const symbolPath = (symbol: string) => `/s/${symbol}`;

export function SymbolLink({ symbol }: { symbol: string }) {
  return <Link className="sym" to={symbolPath(symbol)}>{symbol}</Link>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Loading({ error }: { error?: string | null }) {
  return error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>;
}

/** Only http(s) links are ever rendered as links. */
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : null);

export function NewsList({ items, showSymbols = true }: { items: NewsItem[]; showSymbols?: boolean }) {
  if (!items.length) return <Empty>No recent news.</Empty>;
  return (
    <ul className="news">
      {items.map((n) => {
        const url = safeUrl(n.url);
        return (
          <li key={n.id}>
            <div className="news-meta">
              <span>{n.source || "News"}</span>
              <span>{ago(n.time)}</span>
              {showSymbols && n.symbols.slice(0, 4).map((s) => <SymbolLink key={s} symbol={s} />)}
            </div>
            {url
              ? <a className="news-title" href={url} target="_blank" rel="noopener noreferrer">{n.headline}</a>
              : <span className="news-title">{n.headline}</span>}
            {n.summary && <p>{n.summary.length > 220 ? n.summary.slice(0, 220) + "…" : n.summary}</p>}
          </li>
        );
      })}
    </ul>
  );
}

/** Search box with results dropdown. `onPick` overrides the default "open the stock page". */
export function Search(
  { onPick, placeholder = "Search stocks, ETFs, crypto…" }: {
    onPick?: (a: Asset) => void;
    placeholder?: string;
  },
) {
  const [q, setQ] = useState("");
  const [market, setMarket] = useState<"us" | "eu">("us");
  const [results, setResults] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const text = q.trim();
    if (!text) {
      setResults(null);
      return;
    }
    let alive = true;
    // Europe searches use a small daily quota, so wait longer before firing.
    const id = setTimeout(() => {
      api.search(text, market).then(
        (r) => alive && (setResults(r), setError(null)),
        (e) => alive && (setResults([]), setError(errorText(e))),
      );
    }, market === "eu" ? 700 : 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [q, market]);

  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const pick = (a: Asset) => {
    setOpen(false);
    setQ("");
    if (onPick) onPick(a);
    else navigate(symbolPath(a.symbol));
  };

  return (
    <div className="search" ref={box}>
      <input
        type="search"
        aria-label="Search"
        placeholder={placeholder}
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => (setQ(e.target.value), setOpen(true))}
        onKeyDown={(e) => e.key === "Enter" && results?.[0] && pick(results[0])}
      />
      {open && q.trim() && (
        <div className="search-pop">
          <div className="seg small">
            <button className={market === "us" ? "on" : ""} onClick={() => setMarket("us")}>US & crypto</button>
            <button className={market === "eu" ? "on" : ""} onClick={() => setMarket("eu")}>Europe</button>
          </div>
          {error && <p className="error">{error}</p>}
          {results === null && <p className="empty">Searching…</p>}
          {results?.length === 0 && !error && <p className="empty">No matches.</p>}
          {results?.map((a) => (
            <button key={a.symbol} className="search-row" onClick={() => pick(a)}>
              <b>{a.symbol}</b>
              <span>{a.name}</span>
              <small>{a.exchange}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
