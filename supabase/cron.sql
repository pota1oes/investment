-- Run once in the Supabase SQL editor AFTER deploying the functions.
-- Replace YOUR_PROJECT_REF and YOUR_CRON_SECRET (the same value you set as the
-- CRON_SECRET function secret). This makes the database call the bot runner
-- every 5 minutes, so bots keep working when nobody has the site open.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('YOUR_CRON_SECRET', 'cron_secret');

select cron.schedule(
  'run-bots',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/bot-runner',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- To stop all automatic runs:  select cron.unschedule('run-bots');
