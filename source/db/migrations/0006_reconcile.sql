-- Three-way reconcile (Airtable vs CardTrader vs TCGplayer) and its action log.
-- Additive only: new tables, IF NOT EXISTS, nothing existing is altered. Safe to re-run.

-- The latest TCGplayer Seller Portal export a tenant uploaded (older ones are deleted on upload).
create table if not exists tcgplayer_snapshots (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references tenants (id) on delete cascade,
  uploaded_by   text not null,             -- Clerk user id
  uploaded_at   timestamptz not null default now(),
  filename      text,
  total_rows    integer not null,          -- rows in the file
  stocked_rows  integer not null,          -- rows kept (Total Quantity > 0)
  columns       jsonb not null             -- header row as uploaded
);
create index if not exists tcgplayer_snapshots_tenant_idx on tcgplayer_snapshots (tenant_id, uploaded_at desc);

-- Rows of a snapshot with a quantity on TCGplayer. A SKU not listed here has 0 on TCGplayer.
create table if not exists tcgplayer_rows (
  snapshot_id      bigint not null references tcgplayer_snapshots (id) on delete cascade,
  tcgplayer_id     text not null,          -- the TCGplayer SKU ("TCGplayer Id" column)
  product_line     text,
  set_name         text,
  product_name     text,
  number           text,
  rarity           text,
  condition        text,
  total_qty        integer not null,
  price_cents      integer,                -- "TCG Marketplace Price" (your price)
  market_cents     integer,                -- "TCG Market Price"
  primary key (snapshot_id, tcgplayer_id)
);

-- Matches an admin confirmed between a Waitlist row and a TCGplayer SKU (used when the
-- Airtable "TCGplayer SKU" column is missing or empty for that row).
create table if not exists tcgplayer_matches (
  tenant_id     uuid not null references tenants (id) on delete cascade,
  record_id     text not null,
  tcgplayer_id  text not null,
  confirmed_by  text not null,
  confirmed_at  timestamptz not null default now(),
  primary key (tenant_id, record_id),
  unique (tenant_id, tcgplayer_id)
);

-- Every action taken from the Reconcile page: checks, uploads, matches, quantity changes, CSVs.
create table if not exists reconcile_actions (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references tenants (id) on delete cascade,
  user_id     text not null,
  action      text not null,
  record_id   text,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists reconcile_actions_tenant_idx on reconcile_actions (tenant_id, created_at desc);
