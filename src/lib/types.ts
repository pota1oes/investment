import type { BotConfig, BotEvent, BotState } from "../../supabase/functions/_shared/engine.ts";
import type { Bar, Timeframe } from "../../supabase/functions/_shared/strategy.ts";

export type { Bar, BotConfig, BotEvent, BotState, Timeframe };
export type Env = "paper" | "live";

export interface Account {
  equity: number;
  lastEquity: number;
  cash: number;
  buyingPower: number;
  currency: string;
  status: string;
}
export interface Position {
  symbol: string;
  qty: number;
  avgPrice: number;
  price: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
  dayPl: number;
}
export interface Order {
  id: string;
  symbol: string;
  side: string;
  type: string;
  tif: string;
  qty: number | null;
  notional: number | null;
  filledQty: number;
  filledAvgPrice: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  status: string;
  submittedAt: string;
}
export interface OrderRequest {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit";
  tif?: "day" | "gtc" | "ioc";
  qty?: number;
  notional?: number;
  limitPrice?: number;
  stopPrice?: number;
}
export interface Quote {
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
}
export interface NewsItem {
  id: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  time: string;
  symbols: string[];
  image?: string;
}
export interface Asset {
  symbol: string;
  name: string;
  exchange: string;
  market: "us" | "crypto" | "eu";
  tradable: boolean;
}
export interface WatchItem {
  symbol: string;
  name: string;
}
export interface Bot {
  id: string;
  env: Env;
  status: "paused" | "running" | "halted";
  config: BotConfig;
  state: BotState;
  lastRunAt: string | null;
}
export interface BotLogEntry extends BotEvent {
  id: string;
  ts: string;
}
export interface Point {
  t: number;
  value: number;
}

export interface Company {
  name: string;
  industry: string;
  country: string;
  exchange: string;
  ipo: string;
  website: string;
  logo: string;
  marketCap: number | null;
  pe: number | null;
  eps: number | null;
  dividendYield: number | null;
  beta: number | null;
  profitMargin: number | null;
  revenueGrowth: number | null;
  analysts: { buy: number; hold: number; sell: number; period: string } | null;
  nextEarnings: string | null;
  lastEarnings: { period: string; actual: number; estimate: number | null; surprisePct: number | null } | null;
}

export interface Api {
  mode: "demo" | "live";
  brokerStatus(): Promise<{ paper: boolean; live: boolean }>;
  connectBroker(env: Env, keyId: string, secret: string): Promise<void>;
  disconnectBroker(env: Env): Promise<void>;
  account(env: Env): Promise<Account>;
  positions(env: Env): Promise<Position[]>;
  closePosition(env: Env, symbol: string): Promise<void>;
  orders(env: Env): Promise<Order[]>;
  placeOrder(env: Env, req: OrderRequest): Promise<Order>;
  cancelOrder(env: Env, id: string): Promise<void>;
  portfolioHistory(env: Env, period: string): Promise<Point[]>;
  clock(): Promise<{ isOpen: boolean; nextOpen: string; nextClose: string }>;
  bars(symbol: string, timeframe: Timeframe, limit: number): Promise<Bar[]>;
  quotes(symbols: string[]): Promise<Record<string, Quote>>;
  news(symbols: string[], limit: number, name?: string): Promise<NewsItem[]>;
  search(q: string, market: "us" | "eu"): Promise<Asset[]>;
  /** Company facts; null when unavailable (ETF, crypto, or the data source is not set up). */
  company(symbol: string): Promise<Company | null>;
  watchlist(): Promise<WatchItem[]>;
  addWatch(item: WatchItem): Promise<void>;
  removeWatch(symbol: string): Promise<void>;
  bots(): Promise<Bot[]>;
  saveBot(env: Env, config: BotConfig, id?: string): Promise<void>;
  deleteBot(id: string): Promise<void>;
  setBotStatus(id: string, status: "running" | "paused"): Promise<void>;
  runBot(id: string): Promise<void>;
  liquidateBot(id: string): Promise<void>;
  botEvents(id: string): Promise<BotLogEntry[]>;
}
