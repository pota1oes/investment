// Called by the database scheduler every few minutes. Runs one cycle for every
// bot that is switched on. Protected by a shared secret instead of a user login.

import { admin, type BotRow, cycleBot } from "../_shared/server.ts";

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  const expected = Deno.env.get("CRON_SECRET") ?? "";
  const given = req.headers.get("x-cron-secret") ?? "";
  if (expected.length < 20 || !sameSecret(expected, given)) {
    return new Response("Forbidden", { status: 403 });
  }
  const db = admin();
  const { data: bots, error } = await db
    .from("bots")
    .select("id, user_id, env, status, config, state")
    .eq("status", "running")
    .limit(200);
  if (error) return new Response(error.message, { status: 500 });

  // The work continues after the reply is sent, so the scheduler is not kept waiting.
  const work = runAll(db, (bots ?? []) as BotRow[]);
  const wait = new URL(req.url).searchParams.get("wait") === "1";
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  if (!wait && runtime?.waitUntil) {
    runtime.waitUntil(work);
    return Response.json({ started: (bots ?? []).length }, { status: 202 });
  }
  return Response.json(await work);
});

async function runAll(db: ReturnType<typeof admin>, bots: BotRow[]) {
  let ok = 0;
  let failed = 0;
  // An AI consultation can take a minute or two, so at most one per run; the others
  // get their turn on the following runs.
  let aiUsed = false;
  for (const bot of bots) {
    try {
      const r = await cycleBot(db, bot, "run", { ai: aiUsed ? "skip" : "auto" });
      aiUsed ||= r.consultedAi;
      ok++;
    } catch (e) {
      failed++;
      console.error(`bot ${bot.id}`, e);
    }
  }
  return { ran: ok, failed };
}
