-- Per-tenant connections to outside services (CardTrader first).
-- The secret is stored encrypted with AES-256-GCM. The key exists only as the CONNECTIONS_KEY Worker secret,
-- so a copy of this table alone cannot be used to read any tenant's token.

create table tenant_connections (
  tenant_id          uuid not null references tenants (id) on delete cascade,
  provider           text not null check (provider in ('cardtrader')),
  secret_ciphertext  text not null,
  secret_iv          text not null,
  account_label      text not null,   -- what the service calls the account; shown in Settings
  account_id         text,
  connected_by       text not null,   -- Clerk user id
  connected_at       timestamptz not null default now(),
  primary key (tenant_id, provider)
);

-- Connecting and disconnecting are audited alongside card changes.
alter table audit_log drop constraint audit_log_action_check;
alter table audit_log add constraint audit_log_action_check
  check (action in ('create', 'merge', 'edit', 'delete', 'connect', 'disconnect'));
