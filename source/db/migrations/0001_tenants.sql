-- Hekla Intake: tenants and audit log (Neon Postgres).
-- Users, memberships and roles live in Clerk; a tenant is a Clerk Organization.
-- Cards stay in Airtable; each tenant row says which base/table holds them.

create table tenants (
  id                 uuid primary key default gen_random_uuid(),
  clerk_org_id       text not null unique,
  name               text not null,
  airtable_base_id   text not null,
  airtable_table_id  text not null,
  bot_webhook_url    text check (bot_webhook_url is null or bot_webhook_url like 'https://%'),
  created_at         timestamptz not null default now()
);

create table audit_log (
  id             bigint generated always as identity primary key,
  tenant_id      uuid not null references tenants (id) on delete cascade,
  clerk_user_id  text not null,
  action         text not null check (action in ('create', 'merge', 'edit', 'delete')),
  record_id      text not null,   -- Airtable record id
  snapshot       jsonb,           -- the row after the change; null for delete
  created_at     timestamptz not null default now()
);

create index audit_log_tenant_created_idx on audit_log (tenant_id, created_at desc);
create index audit_log_record_idx on audit_log (tenant_id, record_id);

-- Tenant one: the Hekla organization in Clerk.
insert into tenants (clerk_org_id, name, airtable_base_id, airtable_table_id)
values ('org_3KYI7xB6yJInWU8sf5KbJ6x3mZx', 'Hekla', 'app4Tjz72sZtVMQyp', 'tblvHPu7dgDHA91bc');
