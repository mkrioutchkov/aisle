-- Products whose name reads like what was said, closest first. The words in a question can't find a name that was misheard
-- or run together differently ("sound extreme" for SoundExtreme, "triton" for Tritan), but most of its letters still line
-- up. % narrows through the trigram index on name, at pg_trgm's default of 0.3. A function can't set that to 0.4 itself
-- ("permission denied to set parameter"), so the closer cut is made afterwards.
create or replace function find_named(p_store text, p_text text, p_limit int default 6)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(r) order by r.sim desc, r.reviews desc, r.id), '[]'::jsonb)
  from (
    select p.id, p.name, p.brand, p.cat, p.price, p.rating, p.reviews, p.url, p.img, p.bayes, p.acc, p.kids, pl.aisle, pl.bay, pl.stock,
           similarity(p.name, p_text) as sim
    from products p join placements pl on pl.product_id = p.id and pl.store = p_store
    where p.name % p_text and similarity(p.name, p_text) >= 0.4
    order by sim desc, p.reviews desc, p.id
    limit p_limit
  ) r;
$$;
revoke execute on function find_named(text, text, int) from anon, authenticated, public;
grant execute on function find_named(text, text, int) to service_role;
