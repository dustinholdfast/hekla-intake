-- Sales log, CardTrader/starfoil.store sale handling, and reconcile state.
-- Additive. Safe to re-run: tables and columns use IF NOT EXISTS.
-- The one non-additive statement is the tenant_connections provider check, which is dropped and
-- re-created with a wider list (same pattern as 0003). No rows are changed or removed.

-- One row per sold line. The unique key makes every webhook, poll and retry idempotent.
create table if not exists sales (
  id                 bigint generated always as identity primary key,
  tenant_id          uuid not null references tenants (id) on delete cascade,
  platform           text not null check (platform in ('cardtrader', 'starfoil')),
  external_order_id  text not null,           -- CardTrader order id / starfoil.store order id
  order_code         text,                    -- human-readable code where the platform has one
  line_key           text not null,           -- CardTrader order item id / starfoil product+variant+record
  record_id          text,                    -- Airtable Waitlist record (null when the listing had none)
  game               text,
  card_name          text,
  qty                integer not null check (qty > 0),
  currency           text not null,
  gross_cents        integer not null,        -- item price x qty, before fees, without shipping or tax
  fee_cents          integer,                 -- marketplace or payment fee allocated to this line; null = unknown
  net_cents          integer,                 -- gross - fee; null when the fee is unknown
  sold_at            timestamptz not null,
  order_state        text,
  cancelled_at       timestamptz,
  -- Who lowers the Airtable Qty for this sale: 'starfoil' (starfoil-lgs does it), 'hekla' (this app), 'none'.
  decrement_owner    text not null default 'starfoil' check (decrement_owner in ('starfoil', 'hekla', 'none')),
  decrement_started_at timestamptz,
  qty_before         integer,
  qty_target         integer,
  decremented_at     timestamptz,
  oversold           boolean not null default false,
  needs_review       text,                    -- why a person should look at this line; null = fine
  raw                jsonb not null,
  created_at         timestamptz not null default now(),
  unique (tenant_id, platform, external_order_id, line_key)
);
create index if not exists sales_tenant_sold_idx on sales (tenant_id, sold_at desc);
create index if not exists sales_record_idx on sales (tenant_id, record_id);
create index if not exists sales_pending_idx on sales (tenant_id) where decrement_owner = 'hekla' and decremented_at is null and cancelled_at is null;

-- A short lease per Waitlist row, so two deliveries never read-modify-write the same Qty at once.
create table if not exists stock_locks (
  tenant_id   uuid not null references tenants (id) on delete cascade,
  record_id   text not null,
  holder      text not null,
  expires_at  timestamptz not null,
  primary key (tenant_id, record_id)
);

-- Small per-tenant state: poll cursors, the last reconcile report, alert de-duplication.
create table if not exists sync_state (
  tenant_id   uuid not null references tenants (id) on delete cascade,
  key         text not null,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, key)
);

-- Non-secret settings for a connection (e.g. alert email addresses). Secrets stay in secret_ciphertext.
alter table tenant_connections add column if not exists settings jsonb;

alter table tenant_connections drop constraint if exists tenant_connections_provider_check;
alter table tenant_connections add constraint tenant_connections_provider_check
  check (provider in ('cardtrader', 'cardtrader_webhook', 'starfoil', 'resend'));
