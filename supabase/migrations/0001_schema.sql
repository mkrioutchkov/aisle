-- Aisle: the store's catalogue, stock, search words and question log.
-- Only the server function (service role) can read or write any of this; the phone never talks to the database.
create extension if not exists pg_trgm;
create extension if not exists fuzzystrmatch;
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists stores (
  slug text primary key,
  name text not null,
  state text
);

-- The floor layout. In the mock every store shares one; in a real pilot this gains a store column.
create table if not exists aisles (
  n int primary key,
  dept text not null,
  label text not null
);

create table if not exists categories (
  name text primary key,
  aisle int references aisles (n),
  accessory boolean not null default false,
  aka text[] not null default '{}'
);

-- Tokens and sizes are worked out once at load, by the same text rules the server applies to questions.
create table if not exists products (
  id text primary key,
  name text not null,
  brand text,
  cat text not null references categories (name),
  dept text,
  price numeric(10, 2) not null,
  rating numeric(3, 1),
  reviews int not null default 0,
  url text,
  img text,
  name_tokens text[] not null default '{}',
  cat_tokens text[] not null default '{}',
  brand_tokens text[] not null default '{}',
  dept_tokens text[] not null default '{}',
  aka_tokens text[] not null default '{}',
  all_tokens text[] not null default '{}',
  heads text[] not null default '{}',
  name_str text not null default '',
  cat_str text not null default '',
  kids boolean not null default false,
  acc boolean not null default false,
  persons int,
  litres numeric,
  cans int,
  lumens int,
  degrees int,
  feet numeric,
  bayes numeric not null default 4.2,
  value numeric not null default 0
);
create index if not exists products_all_tokens on products using gin (all_tokens);
create index if not exists products_name_trgm on products using gin (name gin_trgm_ops);
create index if not exists products_cat on products (cat);

-- Where a product is in a store and how many are there. This is what a real stock feed would fill.
create table if not exists placements (
  store text not null references stores (slug),
  product_id text not null references products (id),
  aisle int not null references aisles (n),
  bay int not null,
  stock int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (store, product_id)
);
create index if not exists placements_product on placements (product_id);

-- Every word in the catalogue, with how it sounds, for correcting misheard words.
create table if not exists words (
  word text primary key,
  df int not null default 0,
  sound text not null default '',
  class text not null default '',
  cat_word boolean not null default false,
  head boolean not null default false
);
create index if not exists words_sound on words (sound);
create index if not exists words_class on words (class);

create table if not exists facilities (
  id serial primary key,
  keys text[] not null,
  answer text not null,
  zone text
);

-- Every question from every phone: the shopper question report reads this.
create table if not exists questions (
  id bigserial primary key,
  at timestamptz not null default now(),
  store text,
  session text,
  question text not null,
  heard text,
  route text,
  answered boolean,
  first_ms int,
  total_ms int,
  sample boolean not null default false
);
create index if not exists questions_at on questions (at desc);

-- Daily count of AI calls, so a public address can't run up a bill.
create table if not exists usage_counters (
  day date not null default current_date,
  kind text not null,
  n int not null default 0,
  primary key (day, kind)
);

alter table stores enable row level security;
alter table aisles enable row level security;
alter table categories enable row level security;
alter table products enable row level security;
alter table placements enable row level security;
alter table words enable row level security;
alter table facilities enable row level security;
alter table questions enable row level security;
alter table usage_counters enable row level security;

-- Finds the products a question means, then ranks them, all in one query. Each narrowing step only applies if
-- it leaves something: "cheapest tent" drops pegs and kids' tents, "cheapest tent pegs" still finds pegs.
create or replace function find_products(
  p_store text,
  p_terms jsonb default '[]',
  p_own jsonb default null,
  p_idf jsonb default null,
  p_head text[] default null,
  p_addon text default null,
  p_kids_ok boolean default false,
  p_persons int default null,
  p_min numeric default null,
  p_max numeric default null,
  p_min_bayes numeric default null,
  p_size_gt numeric default null,
  p_size_lt numeric default null,
  p_exclude text[] default null,
  p_cat text default null,
  p_sort text default 'relevance',
  p_limit int default 12,
  p_phrase text default null,
  p_whole text default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  where_sql text := '';
  rel_sql text := '0';
  term jsonb;
  i int := 0;
  alts text[];
  own text;
  weight numeric;
  result jsonb;
begin
  for term in select * from jsonb_array_elements(coalesce(p_terms, '[]'::jsonb)) loop
    alts := array(select jsonb_array_elements_text(term));
    where_sql := where_sql || format(' and p.all_tokens && %L::text[]', alts);
    own := coalesce(p_own ->> i, alts[1]);
    weight := coalesce((p_idf ->> i)::numeric, 1);
    rel_sql := rel_sql || format(
      ' + %s * (case when p.name_tokens @> %L::text[] then 3 when p.name_tokens && %L::text[] then 2.7'
      ' when p.cat_tokens @> %L::text[] then 2.2 when p.cat_tokens && %L::text[] then 1.98'
      ' when p.brand_tokens && %L::text[] then 1.8 when p.aka_tokens && %L::text[] then 1.6 else 1 end)',
      weight, array[own], alts, array[own], alts, alts, alts);
    i := i + 1;
  end loop;
  if p_cat is not null then
    where_sql := where_sql || format(' and p.cat = %L', p_cat);
  end if;

  execute format($q$
    with base as (
      select p.id, p.name, p.brand, p.cat, p.price, p.rating, p.reviews, p.url, p.img, p.heads, p.name_tokens, p.name_str,
             p.kids, p.acc, p.persons, p.litres, p.cans, p.lumens, p.degrees, p.feet, p.bayes, p.value,
             pl.aisle, pl.bay, pl.stock,
             ((%s) * (case when $14 is not null and p.name_str like '%%' || $14 || '%%' then 1.25 else 1 end)
                   * (case when p.cat_str = $15 then 1.6 else 1 end)
                   * (case when p.acc then 0.6 else 1 end)
              + log(1 + p.reviews) * 0.15) as rel
      from products p join placements pl on pl.product_id = p.id and pl.store = $1
      where true %s
    ),
    a1f as (select * from base where $2 is null or heads && $2),
    a1 as (select * from a1f union all select * from base where not exists (select 1 from a1f)),
    named as (select * from a1 where $2 is null or name_tokens && $2),
    a2 as (
      select * from named where (select count(*) from named) * 2 > (select count(*) from a1)
      union all
      select * from a1 where (select count(*) from named) * 2 <= (select count(*) from a1)
    ),
    a3f as (select * from a2 where $3 is null or name_str !~ $3),
    a3 as (select * from a3f union all select * from a2 where not exists (select 1 from a3f)),
    a4f as (select * from a3 where not acc),
    a4 as (select * from a4f union all select * from a3 where not exists (select 1 from a4f)),
    a5f as (select * from a4 where $4 or not kids),
    a5 as (select * from a5f union all select * from a4 where not exists (select 1 from a5f)),
    a6f as (select * from a5 where $5 is null or coalesce(persons, 0) >= $5),
    a6 as (select * from a6f union all select * from a5 where not exists (select 1 from a6f)),
    a7f as (select * from a6 where stock > 0),
    a7 as (select * from a7f union all select * from a6 where not exists (select 1 from a7f)),
    sized as (select count(persons) c1, count(litres) c2, count(cans) c3 from a7),
    measured as (
      select a7.*, case when s.c1 >= s.c2 and s.c1 >= s.c3 then a7.persons::numeric when s.c2 >= s.c3 then a7.litres else a7.cans::numeric end as size
      from a7, sized s
    ),
    picked as (
      select * from measured
      where ($6 is null or price >= $6) and ($7 is null or price <= $7)
        and ($8 is null or bayes > $8)
        and ($9 is null or size > $9) and ($10 is null or size < $10)
        and ($11 is null or not (id = any ($11)))
        and case $12
              when 'size-desc' then size is not null when 'size-asc' then size is not null
              when 'bright' then lumens is not null when 'warm' then degrees is not null
              when 'long' then feet is not null when 'short' then feet is not null
              else true end
    ),
    ranked as (
      select * from picked
      order by
        case when $12 = 'price-asc' then price end asc nulls last,
        case when $12 = 'price-desc' then price end desc nulls last,
        case when $12 = 'rating' then bayes end desc nulls last,
        case when $12 = 'popular' then reviews end desc nulls last,
        case when $12 = 'value' then value end desc nulls last,
        case when $12 = 'size-desc' then size end desc nulls last,
        case when $12 = 'size-asc' then size end asc nulls last,
        case when $12 = 'bright' then lumens end desc nulls last,
        case when $12 = 'warm' then degrees end asc nulls last,
        case when $12 = 'long' then feet end desc nulls last,
        case when $12 = 'short' then feet end asc nulls last,
        case when $12 = 'fit' then coalesce(persons, 99) end asc nulls last,
        case when $12 = 'relevance' then rel end desc nulls last,
        bayes desc, reviews desc, id
      limit $13
    )
    select jsonb_build_object(
      'count', (select count(*) from picked),
      'kind_count', (select count(*) from a7),
      'min_price', (select min(price) from picked),
      'max_price', (select max(price) from picked),
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'brand', brand, 'cat', cat, 'price', price, 'rating', rating, 'reviews', reviews,
        'url', url, 'img', img, 'aisle', aisle, 'bay', bay, 'stock', stock, 'size', size, 'bayes', bayes, 'rel', rel
      )) from ranked), '[]'::jsonb)
    )
  $q$, rel_sql, where_sql)
  into result
  using p_store, p_head, p_addon, p_kids_ok, p_persons, p_min, p_max, p_min_bayes, p_size_gt, p_size_lt, p_exclude, p_sort, p_limit, p_phrase, p_whole;
  return result;
end;
$$;

-- How many products match each of several readings of a question, in one round trip.
create or replace function count_matches(p_sets jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s jsonb;
  term jsonb;
  where_sql text;
  n int;
  out_counts jsonb := '[]'::jsonb;
begin
  for s in select * from jsonb_array_elements(p_sets) loop
    where_sql := 'true';
    for term in select * from jsonb_array_elements(s) loop
      where_sql := where_sql || format(' and all_tokens && %L::text[]', array(select jsonb_array_elements_text(term)));
    end loop;
    execute 'select count(*) from products where ' || where_sql into n;
    out_counts := out_counts || to_jsonb(n);
  end loop;
  return out_counts;
end;
$$;

create or replace function words_lookup(p_words text[])
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(word, jsonb_build_object('df', df, 'head', head, 'cat', cat_word)), '{}'::jsonb)
  from words where word = any (p_words);
$$;

-- Catalogue words that sound like this one or are one letter out; the server ranks them.
create or replace function word_alikes(p_word text, p_sound text, p_class text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('v', word, 's', sound, 'c', class, 'df', df, 'cat', cat_word)), '[]'::jsonb)
  from (
    select * from words
    where length(word) >= 3 and word <> p_word and (
      sound = p_sound or class = p_class
      or (length(p_sound) >= 3 and left(sound, 1) = left(p_sound, 1) and levenshtein_less_equal(class, p_class, 1) <= 1)
      or levenshtein_less_equal(word, p_word, 2) <= 2
    )
    limit 200
  ) w;
$$;

create or replace function bump_usage(p_kind text)
returns int
language sql security definer set search_path = public as $$
  insert into usage_counters (day, kind, n) values (current_date, p_kind, 1)
  on conflict (day, kind) do update set n = usage_counters.n + 1
  returning n;
$$;

create or replace function log_question(
  p_store text, p_session text, p_question text, p_heard text, p_route text, p_answered boolean, p_first_ms int, p_total_ms int
) returns void
language sql security definer set search_path = public as $$
  insert into questions (store, session, question, heard, route, answered, first_ms, total_ms)
  values (p_store, p_session, left(p_question, 300), left(p_heard, 300), p_route, p_answered, p_first_ms, p_total_ms);
$$;

-- Everything the shopper question report shows.
create or replace function question_report(p_store text default null, p_days int default 30)
returns jsonb
language sql stable security definer set search_path = public as $$
  with q as (
    select * from questions where at > now() - make_interval(days => p_days) and (p_store is null or store = p_store)
  )
  select jsonb_build_object(
    'days', p_days,
    'total', (select count(*) from q),
    'sessions', (select count(distinct session) from q),
    'unanswered', (select count(*) from q where not answered),
    'ai_share', (select round(100.0 * count(*) filter (where route = 'ai') / greatest(count(*), 1), 1) from q),
    'first_ms_p50', (select percentile_cont(0.5) within group (order by first_ms) from q where first_ms is not null),
    'first_ms_p95', (select percentile_cont(0.95) within group (order by first_ms) from q where first_ms is not null),
    'top', coalesce((select jsonb_agg(t) from (select lower(question) as question, count(*) as n from q group by 1 order by n desc, 1 limit 12) t), '[]'::jsonb),
    'gaps', coalesce((select jsonb_agg(t) from (select lower(question) as question, count(*) as n from q where not answered group by 1 order by n desc, 1 limit 12) t), '[]'::jsonb),
    'by_day', coalesce((select jsonb_agg(t order by t.day) from (select (at at time zone 'Australia/Brisbane')::date as day, count(*) as n from q group by 1) t), '[]'::jsonb),
    'by_hour', coalesce((select jsonb_agg(t order by t.hour) from (select extract(hour from at at time zone 'Australia/Brisbane')::int as hour, count(*) as n from q group by 1) t), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(t) from (select at, question, route, answered, sample from q order by at desc limit 25) t), '[]'::jsonb),
    'sample_share', (select round(100.0 * count(*) filter (where sample) / greatest(count(*), 1), 1) from q)
  );
$$;

-- Mock stock moves through the day, like sales and deliveries would: this is what proves stock is live.
create or replace function mock_stock_tick()
returns void
language sql security definer set search_path = public as $$
  update placements
  set stock = greatest(0, stock + (case when random() < 0.8 then -1 else 6 end)), updated_at = now()
  where (store, product_id) in (select store, product_id from placements tablesample bernoulli (0.5));
$$;

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
revoke execute on all functions in schema public from anon, authenticated, public;
grant execute on all functions in schema public to service_role;
