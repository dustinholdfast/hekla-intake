-- CardTrader cleanup: a full copy of every Airtable Waitlist record before Hekla deletes, archives or rewrites it.
-- Additive only: one new table, IF NOT EXISTS, nothing existing is altered or removed. Safe to re-run.
-- These rows are cleanup records, never sales: nothing here is written to (or referenced from) the sales log.
-- tenant_id is ON DELETE RESTRICT on purpose: removing a tenant must never silently drop these copies.

create table if not exists airtable_record_snapshots (
  id                 bigint generated always as identity primary key,
  tenant_id          uuid not null references tenants (id) on delete restrict,
  record_id          text not null,            -- Airtable record id at the time of the snapshot
  base_id            text not null,
  table_id           text not null,
  fields             jsonb not null,           -- every field Airtable returned for the record (incl. Cost Basis USD)
  record_created_at  timestamptz,              -- Airtable createdTime
  action             text not null check (action in ('delete', 'archive', 'update')),
  reason             text not null,            -- e.g. 'cardtrader-cleanup'
  batch_id           text,
  detail             jsonb not null default '{}'::jsonb,  -- survivor, listing id, CardTrader qty, cost before/after, mismatch
  taken_by           text not null,            -- Clerk user id
  taken_at           timestamptz not null default now(),
  applied_at         timestamptz,              -- set once the Airtable delete/archive/update succeeded
  restored_at        timestamptz,
  restored_by        text,
  restored_record_id text                      -- the new record Restore created
);
create index if not exists airtable_record_snapshots_tenant_idx on airtable_record_snapshots (tenant_id, taken_at desc);
create index if not exists airtable_record_snapshots_record_idx on airtable_record_snapshots (tenant_id, record_id);
