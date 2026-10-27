-- Phase 2 inventory settings. Additive and safe to re-run.
-- Do not apply this from CI or from a deploy. Apply it to Neon only when Dustin says go-live.
-- Airtable is not touched. stock_movements is not changed.
-- Threshold columns already exist from 0008. These columns add buy rates, the credit cost rule,
-- and per-method processor fees. Fees default to an empty object, which the app reads as unknown
-- (blank), never as a guessed amount. MP, HP and DMG stay blocked in the app; they have no rate columns.

alter table inventory_settings
  add column if not exists nm_cash_percent smallint not null default 50 check (nm_cash_percent between 0 and 100),
  add column if not exists nm_credit_percent smallint not null default 65 check (nm_credit_percent between 0 and 100),
  add column if not exists lp_cash_percent smallint not null default 40 check (lp_cash_percent between 0 and 100),
  add column if not exists lp_credit_percent smallint not null default 55 check (lp_credit_percent between 0 and 100),
  add column if not exists credit_cost_rule text not null default 'face_value' check (credit_cost_rule = 'face_value'),
  add column if not exists payment_fees jsonb not null default '{}'::jsonb check (jsonb_typeof(payment_fees) = 'object');
