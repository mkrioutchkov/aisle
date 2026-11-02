-- The store layout the server keeps for a few minutes: stores, aisles with their biggest categories, facilities.
create or replace function store_info()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'count', (select count(*) from products),
    'stores', (select jsonb_agg(jsonb_build_object('slug', slug, 'name', name) order by slug) from stores),
    'facilities', (select jsonb_agg(jsonb_build_object('keys', keys, 'answer', answer) order by id) from facilities),
    'aisles', (select jsonb_agg(jsonb_build_object('n', a.n, 'dept', a.dept, 'label', a.label, 'cats', (
      select coalesce(jsonb_agg(t.cat), '[]'::jsonb) from (
        select p.cat from products p join categories c on c.name = p.cat where c.aisle = a.n group by p.cat order by count(*) desc limit 10
      ) t
    )) order by a.n) from aisles a)
  );
$$;
revoke execute on function store_info() from anon, authenticated, public;
grant execute on function store_info() to service_role;

-- Every catalogue word with its sound, loaded once into server memory so checking a word needs no database call.
create or replace function all_words()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_agg(jsonb_build_array(word, df, head, cat_word, sound, class)) from words;
$$;
revoke execute on function all_words() from anon, authenticated, public;
grant execute on function all_words() to service_role;
