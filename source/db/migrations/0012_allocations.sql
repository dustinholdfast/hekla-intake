-- Pick-list allocation idempotency, and a sales-log platform for deck sales.
-- Additive and safe to re-run. Does not read or write Airtable or CardTrader.
-- Apply to Neon by hand. Do not run this from deploy or CI against production.
-- Requires 0005_sales.sql (the sales table). CT_SALES_MODE is unchanged: allocation lines use
-- decrement_owner 'none', so Hekla never lowers Qty for them.

create table if not exists allocation_results (
  tenant_id          uuid not null references tenants (id) on delete cascade,
  idempotency_key    text not null,
  allocation_id      text not null,
  deck_id            text not null,
  op                 text not null check (op in ('reserve', 'release', 'finalize_built', 'finalize_sold')),
  waitlist_record_id text not null,
  qty                integer not null check (qty > 0),
  http_status        integer not null,
  result             jsonb not null,
  created_at         timestamptz not null default now(),
  primary key (tenant_id, idempotency_key)
);

-- Deck sales share the sales log. line_key is the allocation idempotency key, so a repeat cannot insert a second line.
do $$
declare r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'sales' and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%platform%'
  loop
    execute format('alter table sales drop constraint %I', r.conname);
  end loop;
end $$;

alter table sales drop constraint if exists sales_platform_check;
alter table sales add constraint sales_platform_check
  check (platform in ('cardtrader', 'starfoil', 'allocation'));
