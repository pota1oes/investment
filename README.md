# Invest

A private investing app: market data and news per stock, manual trading, and
rule-based auto-trading bots. The website is static (GitHub Pages); logins,
per-user data and everything involving broker keys run on Supabase; orders go
through your own Alpaca brokerage account.

```
Browser (GitHub Pages)  ──login token──▶  Supabase  ──your encrypted keys──▶  Alpaca
  React site                              • Auth (invite-only, 2FA)           • prices, news
                                          • Postgres + row-level security     • paper & live orders
                                          • Edge functions: api, bot-runner
                                          • Scheduler: runs bots every 5 min
```

## Fake-money mode

```bash
npm install
npm run dev
```

The built-in simulator gives you $100,000 of pretend money on simulated prices,
stored in your browser. Nothing real happens. With no backend configured it is the
only mode; once the backend exists it stays available from the "Fake money" switch
in the top bar and from the sign-in page (no account needed).

There are three levels: **Fake money** (simulator), **Paper** (Alpaca practice
account: pretend cash, real market prices) and **Real money**.

## Going live

You do these steps yourself — they involve creating accounts and handling secrets.

### 1. Supabase (logins, database, server)

1. Create a project at supabase.com. Note the **project ref**, **project URL** and **anon/publishable key**.
2. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up".
   Accounts then exist only if you create them: **Authentication → Users → Add user**.
3. From this folder:

   ```bash
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase db push
   npx supabase secrets set BROKER_ENC_KEY="$(openssl rand -base64 32)" CRON_SECRET="$(openssl rand -hex 32)" ALLOWED_ORIGIN="https://YOUR_GITHUB_USER.github.io"
   npx supabase functions deploy api
   npx supabase functions deploy bot-runner
   ```

   Keep a copy of the `CRON_SECRET` value for step 4. Never change `BROKER_ENC_KEY`
   afterwards — saved broker keys could no longer be decrypted (you would reconnect them).
   Optional, for European end-of-day prices: get a free key at alphavantage.co and run
   `npx supabase secrets set ALPHAVANTAGE_KEY=...` (free tier: about 25 lookups a day).
4. Open `supabase/cron.sql`, fill in the two placeholders, and run it in the SQL editor.

### 2. GitHub Pages (the website)

1. Create a GitHub repository and push this folder to its `main` branch.
   (Free GitHub accounts need a **public** repository for Pages. That is fine: no secret is in the code.)
2. Repository **Settings → Pages → Source: GitHub Actions**.
3. Repository **Settings → Secrets and variables → Actions → Variables**: add
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Push (or re-run the workflow). The site appears at `https://YOUR_GITHUB_USER.github.io/REPO/`.

### 3. Alpaca (brokerage)

1. Open an account at alpaca.markets. A paper (practice) account is created immediately.
2. In the app: **Settings → Alpaca paper account**, paste the paper API keys.
3. For real money: complete Alpaca's live-account verification, turn on two-factor
   authentication in the app's Settings, then add the live keys.

## Security model

- **Invite-only logins**, optional 2FA; anything touching real money *requires* 2FA.
- **Row-level security** on every table: a user can only read their own rows. Bots and
  broker keys can only be written by the server, never directly from the browser.
- **Broker keys** are AES-256-GCM encrypted at rest and never sent back to the browser.
- The site ships a strict Content-Security-Policy and loads no third-party scripts.
- The Supabase URL and anon key are public on purpose; they grant nothing without a login.

## Auto-trader rules

- A bot only uses its own budget and only sells what it bought itself.
- Signals use completed price bars only; stock orders are placed only while the market is open.
- Per-position stop-loss, a total loss limit that sells everything and halts the bot, and a
  "Stop & sell everything" button that works without 2FA.
- Always run a bot on the paper account before funding it. Backtests are simulations;
  none of the built-in strategies is a recommendation and all of them can lose money.

## What is not included yet

- European shares are view-only (end-of-day prices, headlines): Alpaca's trading API does not offer them.
- US prices use the free IEX feed; real-time consolidated quotes need a paid Alpaca data plan.
- No options, no short selling, no margin controls, no tax reports.
- Each person connects their own brokerage account. The app must not pool or manage other people's money.

## Development

```bash
npm test                 # strategy + bot engine tests
npm run build            # type-check and build the site
npm run check:functions  # type-check the server functions
```

Trading logic lives in `supabase/functions/_shared/strategy.ts` and `engine.ts` and is
shared by the website (backtests, demo) and the server (live bots).
