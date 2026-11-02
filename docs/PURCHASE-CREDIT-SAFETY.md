# Purchase and store-credit safeguards

Prepared locally against main `7370321e1aa87c11c6fedecf803010a3aa05ebb9`.
Migration 0011 was applied to production `neondb` on November 2, 2026 at approximately 13:49 UTC after explicit approval. A manual Neon snapshot was created first (`production at 2026-11-02 13:49:06 UTC (manual)`). Verification confirmed the account table, acceptance guard, and enabled credit trigger; the ledger was empty and there were no balance mismatches. Application changes are prepared for the approved release.

## Implemented

- `source/src/purchase-access.ts` and API middleware in `source/src/index.ts` restrict all purchase endpoints to the seeded original Clerk organization with its exact Waitlist base and table. Purchase helpers still use fixed Sell Request, Buy List, and Purchases tables. This is a deliberate access restriction, not multi-tenant purchasing support.
- `source/src/purchasesdb.ts` saves acceptance headers and every line in a single Neon transaction. A tenant advisory transaction lock serializes draft replacements; non-accepted headers cannot be replaced. A failed line restores the previous header and lines.
- `source/db/migrations/0011_purchase_safety.sql` backfills tenant/customer credit balances and installs an AFTER INSERT trigger. An atomic conditional account update permits spending only when the balance remains nonnegative. Failed spending rolls back the ledger insert. Duplicate ledger keys do not fire the trigger or change balances.
- Redemption validates the request before attempting the insert. The database authorizes spending; a previously read balance is not an authorization. Exact duplicate requests return the saved entry, including its historical balance and timestamp. Reusing a source ID for a changed customer, amount, or date returns a conflict.
- Acceptance, receiving, and redemption check for the migration before writing. Receiving checks before any Airtable writes. Missing/disabled safeguards return a setup error.

## Verification

`npm run check`: typecheck, 178 source tests, and 22 isolated embedded PostgreSQL tests passed (200 total). The PostgreSQL suite covers production persistence SQL, competing redemption requests, replay after spending, changed-key conflicts, tenant separation, failed acceptance rollback, disabled triggers, positive backfill, and refusal of negative historical balances. The existing stock-decrement regression suite also passes.

PGlite serializes work through one embedded database connection. Competing request tests exercise the application paths and the SQL condition, but do not constitute a multi-connection Neon load or lock-contention test. The safety decision itself is a single PostgreSQL account-row UPDATE, rather than an application read followed by an unchecked insert. An isolated multi-connection staging check is recommended before go-live.

`wrangler deploy --dry-run` built the Worker successfully without uploading or deploying. No real customer records, credit, or inventory were modified. There are no UI changes in this patch.

## Rollout after explicit approval

1. Review the migration and patch. Back up Neon; inspect existing credit ledger totals grouped by tenant/customer and invalid legacy sign conventions. Migration 0010 must already exist. The new migration intentionally fails on a negative aggregate balance.
2. Run migration 0011 on an isolated staging database containing a production-like copy. Check two separate database connections attempting to spend more than the same available balance, plus exact retries.
3. Apply migration 0011 to production in a quiet window. It briefly locks credit ledger writes while backfilling and installing the trigger; duration depends on ledger size. Existing Worker code remains compatible with the added tables and trigger.
4. Deploy the approved Worker. Check original-shop purchase access, blocked foreign-shop purchase access, and administrator redemption with dedicated test data. Verify database-recorded balances and retries. Keep CardTrader sales in log mode and reconciliation off.
5. If the Worker must be rolled back, retain the database trigger and accounts. Removing them would restore the overspending race. Never delete credit entries to undo a test or correction; design a separately reviewed adjustment procedure.

## Still incomplete

Receiving remains a sequence of Airtable writes followed by database persistence (`source/src/index.ts`, `/api/purchases/receive`; `source/src/purchases.ts`, `applyReceiveWrites`; `source/src/purchasesdb.ts`, `saveReceipt`). This patch does not make that cross-system sequence atomic or safely replayable. A crash or uncertain Airtable response can still leave partial receiving. Acceptance replacement can also race with receiving before receiving has persisted its status.

The next implementation should claim a durable receipt operation before external writes, reserve shared stock locks, reload stock identity/grade/cost and Buy List demand, persist an immutable plan and per-step journal, accumulate duplicate lines targeting the same row, and finalize purchase status, lots, movements, and issued credit in one database transaction. Completed retries must return the saved result; uncertain writes must require review instead of blind replay. Acceptance editing must consult the receipt claim. Add an operator recovery screen and crash-boundary tests before enabling this path broadly.

Shared locks must eventually cover every Hekla stock writer, and external Airtable edits/Starfoil cannot be fenced by a Hekla-only lock. Sales-to-movement ingestion, broader stock-history coverage, automatic/manual reconciliation of uncertain operations, and more Shadow POS-style checkout/customer workflows remain separate backlog items. No receipt claim table or half-implemented recovery handler is included in this patch.
