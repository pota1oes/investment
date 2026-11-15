import { useState } from "react";
import { Loading, NewsList } from "../components/common.tsx";
import { useAsync, useEnv } from "../hooks.tsx";
import { api } from "../lib/api.ts";

export function News() {
  const { env } = useEnv();
  const watch = useAsync(() => api.watchlist(), []);
  const positions = useAsync(() => api.positions(env).catch(() => []), [env]);
  const mine = [
    ...new Set([...(positions.data ?? []).map((p) => p.symbol), ...(watch.data ?? []).map((w) => w.symbol)]),
  ];
  const [filter, setFilter] = useState<string>("mine");
  const symbols = filter === "all" ? [] : filter === "mine" ? mine.slice(0, 20) : [filter];
  const ready = watch.data !== undefined && positions.data !== undefined;
  const news = useAsync(
    () => (ready ? api.news(symbols, 40) : Promise.resolve(null)),
    [ready, symbols.join(",")],
    300_000,
  );

  return (
    <>
      <h1>News</h1>
      <div className="chips">
        <button className={filter === "mine" ? "on" : ""} onClick={() => setFilter("mine")}>My stocks</button>
        <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>Whole market</button>
        {mine.map((s) => (
          <button key={s} className={filter === s ? "on" : ""} onClick={() => setFilter(s)}>{s}</button>
        ))}
      </div>
      <section className="card">
        {news.data ? <NewsList items={news.data} /> : <Loading error={news.error} />}
      </section>
    </>
  );
}
