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

  let ok = 0;
  let failed = 0;
  for (const bot of (bots ?? []) as BotRow[]) {
    try {
      await cycleBot(db, bot, "run");
      ok++;
    } catch (e) {
      failed++;
      console.error(`bot ${bot.id}`, e);
    }
  }
  return Response.json({ ran: ok, failed });
});
