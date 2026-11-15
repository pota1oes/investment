// The AI analyst's network side: collect the evidence, ask the AI, return a verdict.
// The rules for what a verdict may do live in ai.ts and are enforced by code.
//
// Two AI services are supported; whichever key is set on the server is used:
//   DEEPSEEK_API_KEY  -> DeepSeek (checked first)
//   ANTHROPIC_API_KEY -> Claude

import Anthropic from "npm:@anthropic-ai/sdk@^1.8.0";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  type AiDecision,
  type AiState,
  type Article,
  buildUserMessage,
  decisionSchema,
  estimateUsd,
  type Evidence,
  jsonInstructions,
  parseDecisions,
  priceFacts,
  type SymbolEvidence,
  SYSTEM_PROMPT,
} from "./ai.ts";
import { type Creds, getBars, getNews } from "./alpaca.ts";
import type { BotConfig, BotEvent, BotState } from "./engine.ts";
import { isCrypto } from "./engine.ts";
import { companyFacts, googleNews } from "./sources.ts";
import { normalizeStrategy, strategySlots } from "./strategy.ts";

const MODEL = "claude-opus-5-5";
const LIST_PRICE = { input: 4, output: 20 }; // USD per million tokens
const NEWS_WINDOW_MS = 4 * 86_400_000;

// DeepSeek: peak-hour list prices per million tokens, so the logged cost is an upper
// estimate (off-peak hours cost half). Unknown models are logged at the "pro" price.
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_PRICE: Record<string, { input: number; output: number }> = {
  "deepseek-v4-pro": { input: 1.32, output: 3.96 },
  "deepseek-flash": { input: 0.3, output: 1.2 },
};
const deepseekModel = () => Deno.env.get("DEEPSEEK_MODEL") || "deepseek-v4-pro";

export const aiProvider = (): "deepseek" | "claude" | null =>
  Deno.env.get("DEEPSEEK_API_KEY") ? "deepseek" : Deno.env.get("ANTHROPIC_API_KEY") ? "claude" : null;
export const aiConfigured = () => aiProvider() !== null;

async function symbolEvidence(
  db: SupabaseClient,
  creds: Creds,
  symbol: string,
  state: BotState,
): Promise<SymbolEvidence> {
  const recent = (iso: string) => Date.now() - Date.parse(iso) < NEWS_WINDOW_MS;
  const [bars, wire, facts] = await Promise.all([
    getBars(creds, symbol, "1Day", 90).catch(() => []),
    getNews(creds, [symbol], 10).catch(() => []),
    companyFacts(db, symbol).catch(() => null),
  ]);
  const name = String(facts?.name ?? symbol);
  // Other outlets are looked up by company name, so only when we know it.
  const others = facts?.name && !isCrypto(symbol)
    ? await googleNews(db, symbol, name).catch(() => [])
    : [];
  const toArticle = (n: { source: string; headline: string; summary: string; time: string }): Article => ({
    source: n.source,
    headline: n.headline,
    summary: n.summary || undefined,
    time: n.time,
  });
  const prices = priceFacts(bars);
  const pos = state.positions[symbol];
  return {
    symbol,
    name,
    prices,
    newswire: wire.filter((n) => recent(n.time)).slice(0, 8).map(toArticle),
    otherOutlets: others.filter((n) => recent(n.time)).slice(0, 8).map(toArticle),
    company: facts
      ? {
        industry: facts.industry,
        marketCapUsd: facts.marketCap,
        pe: facts.pe,
        nextEarnings: facts.nextEarnings,
        analystsBuyHoldSell: facts.analysts ? `${facts.analysts.buy}/${facts.analysts.hold}/${facts.analysts.sell}` : null,
      }
      : undefined,
    held: pos
      ? {
        qty: Math.round(pos.qty * 1e4) / 1e4,
        avgPrice: Math.round(pos.avgPrice * 100) / 100,
        gainPct: prices ? Math.round((prices.price / pos.avgPrice - 1) * 1000) / 10 : 0,
      }
      : null,
  };
}

export async function gatherEvidence(
  db: SupabaseClient,
  creds: Creds,
  config: BotConfig,
  state: BotState,
): Promise<Evidence> {
  const symbols = await Promise.all(config.symbols.map((s) => symbolEvidence(db, creds, s, state)));
  return {
    now: new Date().toISOString(),
    cashAvailable: state.cash,
    budget: config.budget,
    maxPositions: strategySlots(config.strategy, config.symbols.length),
    notes: config.ai?.notes ?? "",
    symbols,
  };
}

export interface Verdict {
  view: string;
  decisions: AiDecision[];
  cost: NonNullable<AiState["cost"]>;
}

export function askAi(evidence: Evidence, symbols: string[]): Promise<Verdict> {
  const provider = aiProvider();
  if (provider === "deepseek") return askDeepSeek(evidence, symbols);
  if (provider === "claude") return askClaude(evidence, symbols);
  throw new Error("The AI is not set up yet: the server has no DEEPSEEK_API_KEY (see README).");
}

function finish(json: unknown, symbols: string[], inTok: number, outTok: number, price: { input: number; output: number }): Verdict {
  const parsed = parseDecisions(json, symbols);
  if (!parsed.decisions.length) throw new Error("The AI returned no usable decisions. No trades were made.");
  return {
    ...parsed,
    cost: { inputTokens: inTok, outputTokens: outTok, usd: estimateUsd(inTok, outTok, price.input, price.output) },
  };
}

async function askDeepSeek(evidence: Evidence, symbols: string[]): Promise<Verdict> {
  const apiKey = Deno.env.get("DEEPSEEK_API_KEY")!;
  const model = deepseekModel();
  const body = JSON.stringify({
    model,
    stream: false,
    max_tokens: 16000,
    reasoning_effort: "high",
    // DeepSeek guarantees valid JSON, not a particular shape; the shape is described in
    // the prompt and every field is validated afterwards.
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n${jsonInstructions(symbols)}` },
      { role: "user", content: buildUserMessage(evidence) },
    ],
  });
  const deadline = Date.now() + 110_000;
  let inTok = 0;
  let outTok = 0;
  // DeepSeek documents that JSON mode can occasionally return blank content; ask once more then.
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = deadline - Date.now();
    if (left < 15_000) break;
    let res: Response;
    try {
      res = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(left),
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") throw new Error("The AI took too long to answer; it will be tried again later.");
      throw new Error("Could not reach the AI service; it will be tried again later.");
    }
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 401) throw new Error("DeepSeek rejected the API key. Check DEEPSEEK_API_KEY.");
      if (res.status === 402) throw new Error("Your DeepSeek account has no balance left. Top it up to continue.");
      if (res.status === 429) throw new Error("DeepSeek is rate-limiting this account; it will be tried again later.");
      if (res.status === 400 || res.status === 422) throw new Error(`DeepSeek did not accept the request (error ${res.status}).`);
      throw new Error(`DeepSeek is having problems (error ${res.status}); it will be tried again later.`);
    }
    // deno-lint-ignore no-explicit-any
    const data: any = await res.json();
    inTok += Number(data?.usage?.prompt_tokens ?? 0);
    outTok += Number(data?.usage?.completion_tokens ?? 0);
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === "length") throw new Error("The AI's answer was cut off. No trades were made.");
    if (choice?.finish_reason === "content_filter") throw new Error("The AI declined to assess this request. No trades were made.");
    const text = String(choice?.message?.content ?? "").trim();
    if (!text) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("The AI's answer could not be read. No trades were made.");
    }
    return finish(json, symbols, inTok, outTok, DEEPSEEK_PRICE[model] ?? DEEPSEEK_PRICE["deepseek-v4-pro"]);
  }
  throw new Error("The AI returned an empty answer. No trades were made; it will be tried again later.");
}

async function askClaude(evidence: Evidence, symbols: string[]): Promise<Verdict> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")!;
  // One attempt, bounded in time: the scheduler will simply try again later.
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 110_000 });

  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // If a safety filter declines the request, the API retries it on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: decisionSchema(symbols) },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessage(evidence) }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error("The AI service rejected the API key. Check ANTHROPIC_API_KEY.");
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error("The AI service refused this API key for the model. Check your Anthropic account.");
    if (e instanceof Anthropic.RateLimitError) throw new Error("The AI service is rate-limiting this account; it will be tried again later.");
    if (e instanceof Anthropic.APIConnectionTimeoutError) throw new Error("The AI took too long to answer; it will be tried again later.");
    if (e instanceof Anthropic.APIConnectionError) throw new Error("Could not reach the AI service; it will be tried again later.");
    if (e instanceof Anthropic.APIError) throw new Error(`AI service error ${e.status ?? ""}: ${e.message}`.slice(0, 300));
    throw e;
  }

  if (response.stop_reason === "refusal") throw new Error("The AI declined to assess this request. No trades were made.");
  if (response.stop_reason === "max_tokens") throw new Error("The AI's answer was cut off. No trades were made.");
  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("The AI's answer could not be read. No trades were made.");
  }
  const inTok = response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) +
    (response.usage.cache_creation_input_tokens ?? 0);
  return finish(json, symbols, inTok, response.usage.output_tokens, LIST_PRICE);
}

/**
 * Consults the AI for a bot if it is due. Returns null when it is not due or another
 * consultation is already under way. Never throws: failures come back as log events.
 */
export async function consultAi(
  db: SupabaseClient,
  bot: { id: string; config: BotConfig; state: BotState },
  creds: Creds,
  force: boolean,
): Promise<{ verdict?: Verdict; events: BotEvent[] } | null> {
  const hours = normalizeStrategy(bot.config.strategy).params.intervalHours;
  const now = Date.now();
  const dueBefore = new Date(now - (force ? 90_000 : hours * 3_600_000)).toISOString();
  const { data: claimed, error } = await db
    .from("bots")
    .update({ ai_checked_at: new Date(now).toISOString() })
    .eq("id", bot.id)
    .or(`ai_checked_at.is.null,ai_checked_at.lt."${dueBefore}"`)
    .select("id")
    .maybeSingle();
  if (error) return { events: [{ type: "error", message: `Could not schedule the AI check: ${error.message}` }] };
  if (!claimed) {
    return force
      ? { events: [{ type: "info", message: "The AI was asked less than two minutes ago; wait a moment before asking again." }] }
      : null;
  }
  try {
    const evidence = await gatherEvidence(db, creds, bot.config, bot.state);
    const verdict = await askAi(evidence, bot.config.symbols);
    return {
      verdict,
      events: [{
        type: "info",
        message: `AI read ${evidence.symbols.reduce((a, s) => a + s.newswire.length + s.otherOutlets.length, 0)} articles for ${evidence.symbols.length} symbols (at most about $${
          verdict.cost.usd.toFixed(3)
        } of AI usage). ${verdict.view}`,
      }],
    };
  } catch (e) {
    // Try again in 30 minutes rather than at the next 5-minute tick.
    const retryAt = new Date(now - hours * 3_600_000 + 30 * 60_000).toISOString();
    await db.from("bots").update({ ai_checked_at: retryAt }).eq("id", bot.id);
    return { events: [{ type: "error", message: e instanceof Error ? e.message : String(e) }] };
  }
}
