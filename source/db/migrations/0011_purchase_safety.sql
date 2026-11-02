-- Explicitly approved migration only. Do not run from deployment or CI against production.
-- Backfill and trigger installation are one transaction; block concurrent credit writes while installing.
begin;
lock table store_credit_entries in share row exclusive mode;

create table if not exists credit_accounts (
  tenant_id uuid not null references tenants(id),
  customer_ref text not null,
  balance_cents bigint not null check (balance_cents >= 0),
  primary key (tenant_id, customer_ref)
);
-- Fail rather than conceal a pre-existing negative ledger balance.
insert into credit_accounts (tenant_id, customer_ref, balance_cents)
  select tenant_id, customer_ref, sum(amount_cents) from store_credit_entries group by tenant_id, customer_ref
  on conflict (tenant_id, customer_ref) do update set balance_cents = excluded.balance_cents;

create or replace function hekla_credit_after_insert() returns trigger language plpgsql as $$
declare new_balance bigint;
begin
  if (new.entry_kind = 'redemption' and new.amount_cents >= 0)
    or (new.entry_kind = 'issue' and new.amount_cents <= 0) then
    raise exception 'invalid_credit_sign';
  end if;
  insert into credit_accounts values (new.tenant_id, new.customer_ref, 0) on conflict do nothing;
  update credit_accounts set balance_cents = balance_cents + new.amount_cents
    where tenant_id = new.tenant_id and customer_ref = new.customer_ref and balance_cents + new.amount_cents >= 0
    returning balance_cents into new_balance;
  if not found then raise exception 'insufficient_store_credit'; end if;
  update store_credit_entries set balance_after_cents = new_balance where id = new.id;
  return new;
end $$;
drop trigger if exists hekla_credit_balance on store_credit_entries;
create trigger hekla_credit_balance after insert on store_credit_entries for each row execute function hekla_credit_after_insert();

create or replace function hekla_guard_acceptance(t uuid, sr text) returns void language plpgsql as $$
declare current_status text;
begin
  perform pg_advisory_xact_lock(hashtextextended('purchase:' || t::text, 0));
  select status into current_status from purchases where tenant_id=t and sell_request_id=sr for update;
  if found and current_status <> 'accepted' then raise exception 'purchase_no_longer_accepted'; end if;
end $$;
commit;
