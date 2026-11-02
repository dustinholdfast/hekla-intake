# Sale stock-update safety

This change fixes the reproduced overlapping-worker bug: a webhook and a scheduled poll could both discover the same sale, wait for the stock lock, and then each deduct it from Airtable. The regression started at 10 copies, sold 2, and ended at 6. It now ends at 8 with one stock write.

## Processing rules

1. Discovery results are candidates, not permission to change stock. Reload the sale after acquiring the tenant/record lock and again after reading Airtable.
2. A database transition must match the tenant, stock record, sale ID, holder and live lease. Completion, cancellation and review states are checked again by the update query.
3. Starting renews the lease to 60 seconds. A previously saved before/target pair can only be reused unchanged. An unfinished started update blocks a different sale on the same stock row.
4. A confirmed write followed by failed database finalization can be recovered by matching the saved target, without another stock write. An oversell still receives its review flag and alert on recovery.
5. A thrown stock-write request has an unknown outcome. Flag it for review and do not automatically retry it or start another sale on the same stock row. If flag persistence also fails, retain the lease.
6. Expired leases with no started update can be acquired again. Expired leases with unfinished started updates are flagged and cannot be stolen. A paused old worker must not overlap a replacement's writes.
7. Cancellation during or after an update is visible for review. Stock is never automatically added back. Stock PATCH requests have a ten-second timeout; a timeout is still an unknown outcome, not proof that Airtable did nothing.

## Operator recovery

Review messages appear on the Sales page. Unknown stock writes also generate the existing alert flow. Expired-work review markers persist even if a worker later finishes its external request.

An operator must inspect the sale, its recorded before/target, actual Airtable quantity, and any other stock activity before resolving a blocked update. Confirm that no old worker/request is still active. Resolve whether the stock write happened and record the decision in the operational audit trail; correct stock separately if necessary. Do not blindly replay the sale or bulk-clear review flags.

Clearing `needs_review` alone is not a recovery procedure for an expired unfinished plan: the plan and lease still prevent safe takeover. The current application has no dedicated recovery UI for this state; operator-assisted database resolution is required. A reviewed recovery interface can be added separately.

## Boundaries

No migration or production mode change is required. Existing `sales` and `stock_locks` columns are used. Log-only mode remains log-only; this patch does not enable decrement mode.

The lock coordinates this Hekla sales processor. It cannot serialize independent Airtable edits, purchase receiving, reconciliation or Starfoil writers that do not use it. Airtable and Postgres do not share a transaction, and Airtable has no fencing token for these PATCH calls. Accordingly, ambiguous work stops for review rather than claiming universal exactly-once behavior. The separate purchase, credit and movement-ingestion audit findings remain open.

For release, drain old decrement workers or temporarily suspend decrement processing before deploying; mixed old/new workers do not share all these safeguards. Resume only after old work has finished and review existing unfinished updates. This document does not authorize a deployment or changing production modes.

## Validation

`npm run check` now includes `npm run test:postgres`, which runs the actual store queries against an isolated PGlite Postgres engine. Tests use the sales/lock schema from migration 0005 and never connect to Neon or Airtable. They exercise stale discovery, two distinct sales, tenant/record/holder guards, cancellation, expiry, unknown writes, failed review persistence and failed finalization. This is not a load test or a multi-session Neon integration test.
