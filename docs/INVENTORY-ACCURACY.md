# Current inventory accuracy

The inventory page now reads the active tenant's Airtable stock table for current quantity and identity. Airtable remains the shared operational record used by Hekla and Starfoil. Recorded movements are retained as history and compared with current stock; they are not presented as a complete current-stock authority.

## Behavior

- Intake, edits, purchases, sales and cleanup become visible on the next successful stock refresh, including changes made outside Hekla.
- Rows with no movements appear immediately. Rows absent from the complete Airtable scan remain visible as **Missing**, with their history retained and zero contribution to current units.
- Differences in quantity, printing, condition or language are flagged. Equality does not prove that all historical events were recorded.
- Sold/Skip rows with positive Qty preserve that Qty and receive a conflict warning. The page does not guess whether status or quantity is wrong.
- Current names, conditions, languages, prices and listing references come from the current stock record.
- A current cost basis is used only with an explicit, valid Unknown-Cost Qty. Partly known rows split known/unknown unit counts. This is not FIFO valuation or realized margin accounting.
- Slow-mover flags are unavailable because current movement ingestion cannot establish complete sales history. Acquisition dates are not inferred.
- Failed, invalid or incomplete stock reads fail the request. The browser clears old totals rather than presenting a stale fallback as current.
- List and detail requests ignore late responses from older requests/selections.

## Completeness and scoping

The stock reader uses only the resolved tenant base/table, with GET requests, ten-second per-request timeouts, and a projection that discards unrelated fields. It follows pagination beyond the old 20-page cap. A repeated page/record, malformed response, or the explicit 500-page safety limit causes an error with no partial totals.

Movement reads use tenant-scoped ID pagination, with a starting high-water ID, instead of silently returning the oldest 20,000 events. IDs remain strings to preserve bigint precision. Detail reads constrain both the current-stock and history queries to the selected record.

Airtable pagination is not a transactional snapshot. Responses include the stock-read start and completion times; changes during a scan can create temporary differences. Refresh after a stock operation. The reader detects repeated records/cursors, but cannot prove the absence of every possible concurrent omission.

## Scope and release

No new database migration, stock correction, historical backfill, marketplace write or schema change is introduced. Existing stock/credit mutation paths are unchanged. This change makes current inventory follow the existing operational stock record and exposes incomplete history; it does not fix upstream double decrements, purchase tenant isolation, receipt retry safety, or credit concurrency. Those remain separate high-priority audit findings. Do not describe this release as completing event-ledger ingestion or financial accounting.

Before deployment, use staging credentials for two organizations to verify current quantities, missing records, schema variants and failed stock reads. Compare a read-only export with inventory totals and measure pagination latency for the largest tenant. Apply the patch, run `npm ci` and `npm run check`, and review the Worker bundle. Deployment and enabling any production mutation mode require separate approval.

The local fixture preview uses a changed opening quantity, a missing record and a new stock record with no history. Run `node --experimental-strip-types src/preview-server.ts` from `source/` and open the printed local address. Fixtures make no requests to Airtable or Neon.
