// Server-only helpers: database client, encryption of broker keys, and the
// function that runs one bot cycle and saves the result.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { activeSignals, applyVerdict } from "./ai.ts";
import { brokerPort, type Creds, type Env } from "./alpaca.ts";
import { consultAi } from "./analyst.ts";
import {
  type BotConfig,
  type BotEvent,
  type BotState,
  liquidateBot,
  runBot,
  type RunResult,
} from "./engine.ts";

export function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// --- AES-256-GCM encryption for broker keys at rest -------------------------

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let cachedKey: Promise<CryptoKey> | null = null;
function encKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    const raw = Deno.env.get("BROKER_ENC_KEY") ?? "";
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = unb64(raw);
    } catch {
      bytes = new Uint8Array(new ArrayBuffer(0));
    }
    if (bytes.length !== 32) {
      throw new Error("Server is missing a valid BROKER_ENC_KEY secret (32 random bytes, base64).");
    }
    cachedKey = crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  return cachedKey;
}

export async function encrypt(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encKey(),
    new TextEncoder().encode(plain),
  );
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function decrypt(blob: string): Promise<string> {
  const [iv, ct] = blob.split(".");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv) },
    await encKey(),
    unb64(ct),
  );
  return new TextDecoder().decode(pt);
}

export async function loadCreds(db: SupabaseClient, userId: string, env: Env): Promise<Creds | null> {
  const { data, error } = await db
    .from("broker_connections")
    .select("key_id_enc, secret_enc")
    .eq("user_id", userId)
    .eq("env", env)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return { keyId: await decrypt(data.key_id_enc), secret: await decrypt(data.secret_enc) };
}

// --- Bot cycle ---------------------------------------------------------------

export interface BotRow {
  id: string;
  user_id: string;
  env: Env;
  status: "paused" | "running" | "halted";
  config: BotConfig;
  state: BotState;
}

/**
 * Runs one cycle (or the kill switch) for a bot and persists state + log.
 * The new state is saved even if only part of the cycle succeeded, so an order
 * that was placed is never forgotten.
 */
export interface CycleOptions {
  /** "auto": consult the AI if it is due; "force": consult it now; "skip": do not consult it. */
  ai?: "auto" | "force" | "skip";
  /** A change to apply to the freshly loaded state before the cycle (e.g. the user's answer to a proposal). */
  mutate?: (state: BotState) => BotEvent[];
}

export async function cycleBot(
  db: SupabaseClient,
  bot: BotRow,
  mode: "run" | "liquidate",
  opts: CycleOptions = {},
): Promise<{ events: BotEvent[]; status: BotRow["status"]; consultedAi: boolean }> {
  const isAi = bot.config.strategy.id === "ai";
  const pre: BotEvent[] = [];

  // The slow, paid part (collecting news and asking the AI) happens BEFORE the bot is
  // locked, so the kill switch is never held up by it. Its result is applied to the
  // freshly loaded state below.
  let consulted: Awaited<ReturnType<typeof consultAi>> = null;
  if (isAi && mode === "run" && bot.status === "running" && (opts.ai ?? "auto") !== "skip") {
    const aiCreds = await loadCreds(db, bot.user_id, bot.env).catch(() => null);
    if (aiCreds) consulted = await consultAi(db, bot, aiCreds, opts.ai === "force");
  }
  const consultedAi = !!consulted;

  // Claim the bot so the scheduler and a manual "run now" can never act on it at
  // the same moment (which could double an order). Also re-reads the latest state.
  // The kill switch only waits 3 seconds: stopping must not be held up.
  const cutoff = new Date(Date.now() - (mode === "liquidate" ? 3_000 : 20_000)).toISOString();
  const { data: claimed, error: claimError } = await db
    .from("bots")
    .update({ last_run_at: new Date().toISOString() })
    .eq("id", bot.id)
    .or(`last_run_at.is.null,last_run_at.lt."${cutoff}"`)
    .select("id, user_id, env, status, config, state")
    .maybeSingle();
  if (claimError) throw new Error(claimError.message);
  if (!claimed) {
    if (opts.mutate) throw new Error("The bot is busy right now; try again in a few seconds.");
    return {
      events: [{ type: "info", message: "A cycle is running for this bot right now; try again in a few seconds." }],
      status: bot.status,
      consultedAi,
    };
  }
  bot = claimed as BotRow;
  if (mode === "run" && bot.status !== "running") {
    return { events: [], status: bot.status, consultedAi };
  }
  if (opts.mutate) pre.push(...opts.mutate(bot.state));
  if (consulted) {
    pre.push(...consulted.events);
    if (consulted.verdict) {
      pre.push(...applyVerdict(bot.config, bot.state, consulted.verdict, Date.now(), consulted.verdict.cost));
    }
  }

  let result: RunResult;
  try {
    const creds = await loadCreds(db, bot.user_id, bot.env);
    if (!creds) throw new Error(`No ${bot.env} Alpaca connection. Connect it in Settings.`);
    const port = brokerPort(bot.env, creds);
    result = mode === "liquidate"
      ? await liquidateBot(bot.state, port)
      : await runBot(bot.config, bot.state, port, Date.now(), isAi ? activeSignals(bot.state, Date.now()) : undefined);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    result = { state: bot.state, events: [{ type: "error", message }], halted: false };
  }
  result.events.unshift(...pre);
  const status = result.halted ? (mode === "liquidate" ? "paused" : "halted") : bot.status;
  const now = new Date().toISOString();
  const { error } = await db
    .from("bots")
    .update({ state: result.state, status, last_run_at: now, updated_at: now })
    .eq("id", bot.id);
  if (error) throw new Error(error.message);
  if (result.events.length) {
    await db.from("bot_events").insert(
      result.events.map((ev) => ({
        bot_id: bot.id,
        user_id: bot.user_id,
        type: ev.type,
        symbol: ev.symbol ?? null,
        message: ev.message.slice(0, 500),
      })),
    );
  }
  return { events: result.events, status, consultedAi };
}
