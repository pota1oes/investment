-- When the AI analyst was last consulted for a bot. Used as an atomic "due" check so
-- the same bot is never sent to the AI twice at once (each consultation costs money).
alter table public.bots add column if not exists ai_checked_at timestamptz;
