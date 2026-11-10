-- Claim an allocation key before CardTrader is called, and keep the CardTrader plan with it.
-- Additive and safe to re-run. Requires 0012_allocations.sql. Apply to Neon by hand.
--
-- state 'pending': a request owns the key until claimed_until. plan is what it means to do on CardTrader, saved
-- before the first write, so a retry after a timeout reconciles against the export instead of writing twice.
-- state 'done': http_status and result are the stored answer.
-- Each plan step carries attemptedAt (saved before its CardTrader write) and done (saved from CardTrader's answer).
-- A step with attemptedAt and no done is "unresolved": its retry needs proof it landed, and no other key may plan
-- against that row until it is resolved (see allocations.ts). This index makes that row check cheap.

alter table allocation_results add column if not exists state text not null default 'done';
alter table allocation_results add column if not exists claim_token text;
alter table allocation_results add column if not exists claimed_until timestamptz;
alter table allocation_results add column if not exists plan jsonb;
alter table allocation_results add column if not exists order_id text;
alter table allocation_results add column if not exists line_key text;
alter table allocation_results alter column http_status drop not null;
alter table allocation_results alter column result drop not null;

alter table allocation_results drop constraint if exists allocation_results_state_check;
alter table allocation_results add constraint allocation_results_state_check
  check (state in ('pending', 'done') and (state = 'pending' or (http_status is not null and result is not null)));

-- One lease per Waitlist row around the CardTrader read-modify-write. Separate from stock_locks (Airtable Qty).
create table if not exists allocation_row_locks (
  tenant_id   uuid not null references tenants (id) on delete cascade,
  record_id   text not null,
  holder      text not null,
  expires_at  timestamptz not null,
  primary key (tenant_id, record_id)
);

create index if not exists allocation_results_pending_row_idx
  on allocation_results (tenant_id, waitlist_record_id) where state = 'pending';
