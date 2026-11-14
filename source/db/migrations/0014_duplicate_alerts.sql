-- Duplicate stock identities noticed by intake.
-- One open alert per tenant and identity key. Checking it on /admin sets acked_at.
-- Additive and safe to re-run. Do not apply this from CI or from a deploy.
-- Apply it to Neon only when Dustin says go-live. This file does not write Airtable.

create table if not exists duplicate_identity_alerts (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references tenants (id) on delete cascade,
  identity_key  text not null check (length(identity_key) > 0),
  record_ids    jsonb not null,
  source        text not null check (source in ('override', 'observed')),
  note          text,
  created_at    timestamptz not null default now(),
  acked_at      timestamptz,
  acked_by      text,
  email_sent_at timestamptz
);

create unique index if not exists duplicate_identity_alerts_open_idx
  on duplicate_identity_alerts (tenant_id, identity_key)
  where acked_at is null;
