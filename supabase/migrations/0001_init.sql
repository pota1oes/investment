-- Investment app schema.
-- Security model: every table has row-level security ON.
--   * watchlist: a user can read/write only their own rows.
--   * bots, bot_events: a user can only READ their own rows; all writes go through
--     the server function, which validates input and enforces 2FA for live money.
--   * broker_connections, market_cache: NO policies at all, so the website can never
--     read them — only the server functions (service role) can.

create table public.broker_connections (
  user_id uuid not null references auth.users (id) on delete cascade,
  env text not null check (env in ('paper', 'live')),
  key_id_enc text not null,
  secret_enc text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, env)
);
alter table public.broker_connections enable row level security;

create table public.watchlist (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  symbol text not null check (char_length(symbol) between 1 and 20),
  name text not null default '' check (char_length(name) <= 120),
  created_at timestamptz not null default now(),
  primary key (user_id, symbol)
);
alter table public.watchlist enable row level security;
create policy "own watchlist: read" on public.watchlist
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own watchlist: add" on public.watchlist
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own watchlist: remove" on public.watchlist
  for delete to authenticated using ((select auth.uid()) = user_id);

create table public.bots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  env text not null default 'paper' check (env in ('paper', 'live')),
  status text not null default 'paused' check (status in ('paused', 'running', 'halted')),
  config jsonb not null,
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_run_at timestamptz
);
create index bots_user_idx on public.bots (user_id);
create index bots_running_idx on public.bots (status) where status = 'running';
alter table public.bots enable row level security;
create policy "own bots: read" on public.bots
  for select to authenticated using ((select auth.uid()) = user_id);

create table public.bot_events (
  id bigint generated always as identity primary key,
  bot_id uuid not null references public.bots (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  ts timestamptz not null default now(),
  type text not null,
  symbol text,
  message text not null
);
create index bot_events_bot_idx on public.bot_events (bot_id, id desc);
alter table public.bot_events enable row level security;
create policy "own bot events: read" on public.bot_events
  for select to authenticated using ((select auth.uid()) = user_id);

create table public.market_cache (
  key text primary key,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table public.market_cache enable row level security;

-- Belt and braces: the anonymous (not logged in) role gets nothing.
revoke all on all tables in schema public from anon;
