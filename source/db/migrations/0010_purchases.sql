-- Phase 3 buy-list purchases, FIFO lots, and the store-credit liability.
-- Additive and safe to re-run. Do not apply this from CI or from a deploy.
-- Apply it to Neon only when Dustin says go-live. This file does not write Airtable.
-- Customer contact is not a column. A customer is a Sell Request record id.

create table if not exists purchases (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  sell_request_id   text not null check (sell_request_id ~ '^rec[A-Za-z0-9]{14}$'),
  sell_request_ref  text not null check (length(sell_request_ref) > 0),
  payout            text not null check (length(payout) > 0),
  payment_type      text not null check (payment_type in ('cash', 'store_credit')),
  offer_cents       integer not null check (offer_cents >= 0),
  status            text not null check (status in ('accepted', 'received', 'partial', 'cancelled')),
  accepted_at       timestamptz not null default now(),
  received_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, sell_request_id)
);

create table if not exists purchase_lines (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants (id) on delete cascade,
  purchase_id           uuid not null references purchases (id) on delete cascade,
  sell_request_id       text not null check (sell_request_id ~ '^rec[A-Za-z0-9]{14}$'),
  line_no               integer not null check (line_no >= 1),
  raw_line              text not null,
  game                  text,
  item                  text,
  set_name              text,
  set_identity          text,
  collector_number      text,
  finish                text,
  finish_stored         text,
  language              text,
  condition             text not null check (condition in ('NM', 'LP', 'MP', 'HP', 'DMG')),
  qty                   integer not null check (qty >= 1),
  market_ref_cents      integer check (market_ref_cents is null or market_ref_cents >= 0),
  market_ref_source     text,
  rate_percent          integer check (rate_percent is null or rate_percent between 0 and 100),
  offer_cents           integer check (offer_cents is null or offer_cents >= 0),
  cash_cents            integer check (cash_cents is null or cash_cents >= 0),
  credit_cents          integer check (credit_cents is null or credit_cents >= 0),
  cost_total_cents      integer check (cost_total_cents is null or cost_total_cents >= 0),
  unit_cost_cents       integer check (unit_cost_cents is null or unit_cost_cents >= 0),
  cost_rule             text,
  buy_list_id           text,
  buy_list_kind         text,
  buy_list_status       text,
  stock_record_id       text,
  on_hand               integer,
  unknown_cost_qty      integer,
  cost_basis_cents      integer,
  stock_status          text,
  review                text,
  status                text not null check (status in ('accepted', 'received', 'rejected', 'cancelled')),
  received_condition    text check (received_condition is null or received_condition in ('NM', 'LP', 'MP', 'HP', 'DMG')),
  received_at           timestamptz,
  want_before           integer,
  want_after            integer check (want_after is null or want_after >= 0),
  overstock_qty         integer check (overstock_qty is null or overstock_qty >= 0),
  want_decremented_at   timestamptz,
  airtable_purchase_id  text,
  movement_source_ref   text,
  unique (tenant_id, sell_request_id, line_no)
);

create index if not exists purchase_lines_purchase_idx on purchase_lines (purchase_id, line_no);

-- FIFO cost layers. unit_cost_cents is the per-unit figure (null = unknown).
-- cost_total_cents is the exact line cost, so a qty that does not divide still sums.
create table if not exists stock_lots (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  record_id         text not null,
  qty_in            integer not null check (qty_in >= 0),
  qty_left          integer not null check (qty_left >= 0 and qty_left <= qty_in),
  unit_cost_cents   integer check (unit_cost_cents is null or unit_cost_cents >= 0),
  cost_total_cents  integer check (cost_total_cents is null or cost_total_cents >= 0),
  acquired_at       timestamptz not null,
  purchase_line_id  uuid references purchase_lines (id),
  created_at        timestamptz not null default now()
);

create index if not exists stock_lots_record_idx on stock_lots (tenant_id, record_id, acquired_at);
create unique index if not exists stock_lots_line_idx on stock_lots (purchase_line_id);

-- The Phase 1 ledger has no lot pointer. This column is nullable and the table stays append-only.
alter table stock_movements add column if not exists lot_id uuid;

-- One row per issue or redemption. customer_ref is a Sell Request record id, never a name, email, or phone.
-- amount_cents is positive for an issue and negative for a redemption.
-- The unique key makes a repeated receive or a repeated redemption insert nothing.
create table if not exists store_credit_entries (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants (id) on delete cascade,
  customer_ref         text not null check (customer_ref ~ '^rec[A-Za-z0-9]{14}$'),
  amount_cents         integer not null check (amount_cents <> 0),
  entry_kind           text not null check (entry_kind in ('issue', 'redemption')),
  source_kind          text not null check (source_kind ~ '^[a-z][a-z0-9_]{0,40}$'),
  source_ref           text not null check (length(source_ref) > 0),
  occurred_on          date not null,
  balance_after_cents  integer not null check (balance_after_cents >= 0),
  created_at           timestamptz not null default now(),
  unique (tenant_id, source_kind, source_ref, entry_kind)
);

create index if not exists store_credit_customer_idx on store_credit_entries (tenant_id, customer_ref, created_at, id);
