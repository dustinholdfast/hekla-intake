-- Phase 1 inventory ledger. Additive and safe to re-run.
-- Do not apply this from CI or from a deploy. Apply it to Neon only when Dustin says go-live.
-- Airtable is not touched. On-hand in the app is the sum of these rows, not a live Qty read.

-- One row per stock change. The unique key is the idempotency key: the same source event
-- (tenant + source kind + source ref + reason) can be recorded once, never twice.
-- source_kind is an open label, not a closed list, so a later order source (including a
-- Starfoil TCGplayer account, which does not exist yet) can log here without a schema change.
-- This table is append-only. Corrections are new rows (adjustment, cancel_restock), not edits.
create table if not exists stock_movements (
  id               bigint generated always as identity primary key,
  tenant_id        uuid not null references tenants (id) on delete cascade,
  record_id        text not null,             -- Airtable Waitlist record
  delta            integer not null,          -- signed change; opening_balance is +qty
  qty_before       integer not null check (qty_before >= 0),
  qty_after        integer not null check (qty_after >= 0),
  reason           text not null check (reason in (
                     'opening_balance', 'intake', 'buylist_purchase',
                     'sale_cardtrader', 'sale_starfoil', 'sale_tcgplayer',
                     'sale_in_person', 'cancel_restock', 'adjustment',
                     'reserve', 'release'
                   )),
  source_kind      text not null check (source_kind ~ '^[a-z][a-z0-9_]{0,40}$'),
  source_ref       text not null check (length(source_ref) > 0),
  applied_by       text not null check (length(applied_by) > 0),  -- hekla | starfoil-lgs | Clerk user id
  unit_cost_cents  integer check (unit_cost_cents is null or unit_cost_cents >= 0),  -- null = unknown
  note             text,
  needs_review     text,
  snapshot         jsonb not null default '{}'::jsonb,  -- identity for display; Date Acquired stays null on opening rows
  created_at       timestamptz not null default now(),
  constraint stock_movements_qty_balance check (qty_after = qty_before + delta),
  unique (tenant_id, source_kind, source_ref, reason)
);

create index if not exists stock_movements_record_idx on stock_movements (tenant_id, record_id, created_at, id);
create index if not exists stock_movements_created_idx on stock_movements (tenant_id, created_at desc);

-- Thresholds are settings (approved defaults). No row is inserted here.
-- tcgplayer_level is only the overstock rule's default. It is not a connected seller account.
create table if not exists inventory_settings (
  tenant_id            uuid primary key references tenants (id) on delete cascade,
  low_stock_on_hand    integer not null default 0 check (low_stock_on_hand >= 0),
  overstock_sku_limit  integer not null default 3 check (overstock_sku_limit >= 0),
  tcgplayer_level      integer not null default 1 check (tcgplayer_level between 1 and 4),
  slow_mover_days      integer not null default 45 check (slow_mover_days >= 1),
  updated_at           timestamptz not null default now()
);

create or replace function stock_movements_reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'stock_movements is append-only';
end;
$$;

drop trigger if exists stock_movements_append_only on stock_movements;
create trigger stock_movements_append_only
  before update or delete on stock_movements
  for each row execute function stock_movements_reject_mutation();
