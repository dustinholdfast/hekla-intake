-- Hekla Intake: tenants and audit log (Neon Postgres).
-- Users, memberships and roles live in Clerk; a tenant is a Clerk Organization.
-- Cards stay in Airtable; each tenant row says which base/table holds them.

create table tenants (
  id                 uuid primary key default gen_random_uuid(),
  clerk_org_id       text not null unique,
  name               text not null,
  listed_cap         integer not null default 100 check (listed_cap > 0),
  enabled_games      text[] not null default array['Lorcana'],
  airtable_base_id   text not null,
  airtable_table_id  text not null,
  bot_webhook_url    text check (bot_webhook_url is null or bot_webhook_url like 'https://%'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table audit_log (
  id             bigint generated always as identity primary key,
  tenant_id      uuid not null references tenants (id) on delete cascade,
  clerk_user_id  text,            -- null for cron
  action         text not null check (action in ('create', 'merge', 'edit', 'delete', 'enrich')),
  record_id      text not null,   -- Airtable record id
  before         jsonb,
  after          jsonb,
  created_at     timestamptz not null default now()
);

create index audit_log_tenant_created_idx on audit_log (tenant_id, created_at desc);
create index audit_log_record_idx on audit_log (tenant_id, record_id);
