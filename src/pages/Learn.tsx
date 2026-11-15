import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { GLOSSARY } from "../lib/glossary.ts";
import { mark } from "../lib/onboard.ts";

const LESSONS: { title: string; body: string[] }[] = [
  {
    title: "1. What you are actually buying",
    body: [
      "A stock is a small piece of a company. An ETF is a ready-made basket of many stocks (or bonds) that you buy as one share, so a single purchase spreads your money over hundreds of companies.",
      "Prices move every second the market is open because buyers and sellers keep agreeing on new prices. Nobody knows where a price goes next — not analysts, not algorithms, not this app.",
    ],
  },
  {
    title: "2. Three levels: fake money, paper, real",
    body: [
      "Fake money is a sandbox with made-up prices. Use it to learn the buttons. Paper trading uses the broker's practice account: pretend cash, real market prices. Real money is exactly that.",
      "A sensible order is fake money → paper → a small real amount. The switch in the top bar always shows which one you are in.",
    ],
  },
  {
    title: "3. Placing an order",
    body: [
      "The simple ticket asks one thing: how many dollars you want to invest. That sends a market order, which fills right away at the best available price. You can buy a fraction of a share, so $50 of a $500 stock is fine.",
      "A limit order lets you name your price; it only fills if the market reaches it. A stop order waits for a price level and then sells, which people use to cap a loss.",
    ],
  },
  {
    title: "4. Risk, in plain terms",
    body: [
      "Anything that can go up 30% in a year can go down 30% too. Each stock page shows how much it typically moves in a day and its biggest drop over the last year — look at those before the chart.",
      "Spreading money over many different things (diversification) lowers the damage any single one can do. Only invest money you will not need soon, because the price may be down exactly when you need it.",
    ],
  },
  {
    title: "5. Reading a stock page",
    body: [
      "Green and red candles show each day's price range. The two lines are the 20- and 50-day averages: they smooth out noise so you can see the direction.",
      "“In plain English” sums up the trend, recent performance against the S&P 500 and the size of the swings. Hover or tap any dotted-underlined word for an explanation.",
    ],
  },
  {
    title: "6. How the auto-trader works",
    body: [
      "A bot follows fixed rules with a fixed budget. The default one, momentum rotation, looks at a list of stocks or funds, keeps only the few that have risen the most recently, and moves to cash when nothing is rising.",
      "Rules like this have worked in some periods and lost money in others. Test a bot on past prices, run it on paper for a few weeks, and only then decide whether it deserves real money. Every bot has a stop-loss, a total loss limit and a stop button.",
    ],
  },
  {
    title: "7. Costs and taxes",
    body: [
      "Even with commission-free brokers there are costs: the small gap between buying and selling prices, currency conversion if your money is not in dollars, and tax on profits or holdings depending on where you live.",
      "This app does not calculate taxes. Keep your broker's yearly statements, and ask a tax adviser if you are unsure what applies to you.",
    ],
  },
];

export function Learn() {
  const [q, setQ] = useState("");
  useEffect(() => mark("learn"), []);
  const entries = Object.values(GLOSSARY)
    .filter((e) => (e.term + e.text).toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => a.term.localeCompare(b.term));

  return (
    <>
      <h1>Learn the basics</h1>
      <p className="muted lead">
        Seven short notes that cover what you need to start. This is general education, not advice about what you
        should buy. Ready to try? <Link to="/markets">Open Markets</Link> and practise with fake money.
      </p>
      <div className="lessons">
        {LESSONS.map((l) => (
          <section className="card" key={l.title}>
            <h3>{l.title}</h3>
            {l.body.map((p) => <p key={p.slice(0, 24)}>{p}</p>)}
          </section>
        ))}
      </div>

      <section className="card">
        <div className="card-head">
          <h3>Words you will see</h3>
          <div className="search">
            <input type="search" placeholder="Search a term…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search glossary" />
          </div>
        </div>
        {entries.length === 0 ? <p className="empty">No term matches “{q}”.</p> : (
          <dl className="glossary">
            {entries.map((e) => (
              <div key={e.term}>
                <dt>{e.term}</dt>
                <dd>{e.text}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </>
  );
}
