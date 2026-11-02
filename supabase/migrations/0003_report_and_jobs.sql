-- The shopper question report, with what the store actually wants to know: what people ask, and what they couldn't find.
create or replace function question_report(p_store text default null, p_days int default 30)
returns jsonb
language sql stable security definer set search_path = public as $$
  with q as (
    select * from questions where at > now() - make_interval(days => p_days) and (p_store is null or store = p_store)
  ),
  lowered as (select *, lower(trim(both ' ?.!' from question)) as text from q)
  select jsonb_build_object(
    'days', p_days,
    'total', (select count(*) from q),
    'sessions', (select count(distinct session) from q),
    'unanswered', (select count(*) from q where not answered),
    'ai', (select count(*) from q where route = 'ai'),
    -- Speed is only ever reported from real questions, never from the sample rows.
    'real_answers', (select count(*) from q where not sample),
    'instant_ms', (select round(percentile_cont(0.5) within group (order by total_ms)) from q where not sample and answered and route is distinct from 'ai' and total_ms is not null),
    'ai_first_ms', (select round(percentile_cont(0.5) within group (order by first_ms)) from q where not sample and route = 'ai' and first_ms > 0),
    'top', coalesce((select jsonb_agg(t) from (select text as question, count(*) as n from lowered group by 1 order by n desc, 1 limit 10) t), '[]'::jsonb),
    'gaps', coalesce((select jsonb_agg(t) from (select text as question, count(*) as n from lowered where not answered group by 1 order by n desc, 1 limit 10) t), '[]'::jsonb),
    'by_day', coalesce((select jsonb_agg(t order by t.day) from (select (at at time zone 'Australia/Brisbane')::date as day, count(*) as n from q group by 1) t), '[]'::jsonb),
    'by_hour', coalesce((select jsonb_agg(t order by t.hour) from (select extract(hour from at at time zone 'Australia/Brisbane')::int as hour, count(*) as n from q group by 1) t), '[]'::jsonb),
    'live', coalesce((select jsonb_agg(t) from (select at, store, question, route, answered, first_ms from q where not sample order by at desc limit 15) t), '[]'::jsonb),
    'sample', (select count(*) from q where sample),
    'stock_updated', (select max(updated_at) from placements)
  );
$$;
revoke execute on function question_report(text, int) from anon, authenticated, public;
grant execute on function question_report(text, int) to service_role;

-- What the store calls its products, for telling a real phrase from a lookalike.
create or replace function store_info()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'count', (select count(*) from products),
    'stores', (select jsonb_agg(jsonb_build_object('slug', slug, 'name', name) order by slug) from stores),
    'facilities', (select jsonb_agg(jsonb_build_object('keys', keys, 'answer', answer) order by id) from facilities),
    'terms', (select jsonb_agg(t) from (select name as t from categories union select unnest(aka) from categories) s),
    'aisles', (select jsonb_agg(jsonb_build_object('n', a.n, 'dept', a.dept, 'label', a.label, 'cats', (
      select coalesce(jsonb_agg(t.cat), '[]'::jsonb) from (
        select p.cat from products p join categories c on c.name = p.cat where c.aisle = a.n group by p.cat order by count(*) desc limit 10
      ) t
    )) order by a.n) from aisles a)
  );
$$;
revoke execute on function store_info() from anon, authenticated, public;
grant execute on function store_info() to service_role;

-- Stock changes every five minutes, and a ping every minute keeps the server warm so nobody waits for it to start.
select cron.unschedule(jobid) from cron.job where jobname in ('aisle-stock', 'aisle-warm');
select cron.schedule('aisle-stock', '*/5 * * * *', 'select public.mock_stock_tick()');
select cron.schedule('aisle-warm', '* * * * *', $job$
  select net.http_post(
    url := 'https://pctrghmhkchupwghncap.supabase.co/functions/v1/api',
    body := '{"action":"ping"}'::jsonb,
    headers := '{"content-type":"application/json"}'::jsonb,
    timeout_milliseconds := 5000
  );
$job$);
