-- On this shared host, everyone's minute-by-minute jobs start together: a worker started on the minute took up to 850 ms
-- to boot, against about 27 ms at any other second. So the warm ping runs on its own interval instead, which also lands a
-- ping just as the previous worker is replaced (about 75 seconds after it started).
select cron.unschedule(jobid) from cron.job where jobname = 'aisle-warm';
select cron.schedule('aisle-warm', '40 seconds', $job$
  select net.http_post(
    url := 'https://pctrghmhkchupwghncap.supabase.co/functions/v1/api',
    body := '{"action":"ping"}'::jsonb,
    headers := '{"content-type":"application/json"}'::jsonb,
    timeout_milliseconds := 5000
  );
$job$);
