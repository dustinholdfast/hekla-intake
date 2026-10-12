-- Listing a card on a marketplace is audited as 'list'.
alter table audit_log drop constraint audit_log_action_check;
alter table audit_log add constraint audit_log_action_check
  check (action in ('create', 'merge', 'edit', 'delete', 'connect', 'disconnect', 'list'));
