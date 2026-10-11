-- Plans. Every tenant is 'free' unless a platform admin grants complimentary Pro (plan_source = 'comp').
-- 'paid' is reserved for billing; the admin screen never changes a paid plan.

alter table tenants
  add column plan             text not null default 'free' check (plan in ('free', 'pro')),
  add column plan_source      text check (plan_source in ('comp', 'paid')),
  add column plan_changed_by  text,          -- Clerk user id of the platform admin
  add column plan_changed_at  timestamptz,
  add column plan_note        text;
