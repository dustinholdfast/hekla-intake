# Reconcile: Airtable vs CardTrader vs TCGplayer

`/reconcile` lists every Waitlist card with three numbers side by side: the Airtable **Qty**, what CardTrader lists, and
what TCGplayer lists. Org members can view it. Only org admins (`org:admin`) can run a check, upload, confirm or change anything.

**Expected quantity.** A `Listed` row should show its Qty on each platform. Any other status (Sold, Skip, ...) should show 0.
`Sold` rows and rows with a CardTrader listing id are read too, so a sold card that is still listed shows up. A non-Listed
row that has nothing listed anywhere is left out.

## Sources

| Source | How it gets here | Freshness |
|---|---|---|
| Airtable | Read live on every page load (Listed, Sold, or has a CardTrader Listing ID; plus the optional `TCGplayer SKU` column) | live |
| CardTrader | **Run check now** makes one read-only `/products/export` call and caches it in `sync_state` `reconcile:ct_listings` | when last checked |
| TCGplayer | An admin uploads the Seller Portal pricing export. It is stored in Neon (`tcgplayer_snapshots` / `tcgplayer_rows`, latest only) | when uploaded |

Run check now works whatever `RECONCILE_MODE` says, and it never writes `reconcile:last` (the 15-minute cron's report,
which push mode uses for its two-checks-in-a-row rule). When `RECONCILE_MODE` is `report` or `push`, the page also shows that cron's last result.

**CardTrader matching** follows the cron's `diffStock` rule: a listing belongs to a row if its id is the row's `CardTrader
Listing ID` or its `tag` is the row's record id. A test keeps the two in agreement. Listings that belong to no row are listed separately.

## Reconciled rows leave the list

The list opens on **All mismatches** (or just CardTrader or TCGplayer). A row is *reconciled* when CardTrader and TCGplayer both
match the expected quantity and no suggested TCGplayer match is waiting for confirmation. After a successful
**Set CardTrader**, **Set Airtable** or **Confirm match** that reconciles a row, the row is removed at once, without reloading the page, and the counts update.

Rows put into a downloaded **TCGplayer import CSV** are marked *pending upload* (`sync_state` `reconcile:tcg_pending`) and hidden.
They stay pending until a TCGplayer export uploaded *after* the CSV shows whether they now match, or until 24 hours pass. After that, a row that
still differs comes back. **Show reconciled** lists every row, with pending rows shown as `1 → 3 pending upload`.

After **Set CardTrader**, the cached listings are patched with the change instead of being re-exported, because CardTrader's export can
lag a write by a few seconds. Without the patch, the row would look unchanged and a second click would be refused as stale.

## Reconcile All

This is an admin-only button. Airtable is the source of truth, and **Airtable Qty is never changed**. It acts on the open mismatches in the current view, so the game filter applies.
The platform filter applies too: "CardTrader mismatches" means CardTrader only, "TCGplayer mismatches" means TCGplayer only, and "All" means both.

1. **Check.** If the last CardTrader check is older than 2 minutes, the page first runs a fresh read-only check.
2. **Plan.** `POST /api/reconcile/all/plan` reports what would happen and changes nothing. The confirm dialog shows:
   - How many CardTrader cards would change, split into up and down.
   - Listings that would be **DELETED**. These are listings that reach 0, usually because Airtable is 0, and they are called out separately.
   - Cards that can't be raised because they have no listing.
   - TCGplayer rows that would go in the import CSV. Only SKU or confirmed matches are included; unconfirmed suggestions are counted and left out.
3. **CardTrader changes.** The page sends `POST /api/reconcile/all/cardtrader` repeatedly, `RECONCILE_BATCH` = 25 rows per request, so no single request runs long.
   - Each request makes a fresh Airtable read and a fresh CardTrader export.
   - Rows are processed one at a time through the rate-limited client.
   - A row whose Airtable or CardTrader number moved since the plan is **skipped**, not changed.
   - A failure affects only that row; the rest of the batch continues.
   - Every row's result (succeeded, skipped or failed, with what was applied) is logged as `cardtrader_set` with the `batchId`.
   - Progress and per-row results show on the page. Succeeded rows leave the list.
4. **TCGplayer.** The page downloads one import CSV for all included rows and marks them pending upload. The `tcgplayer_import_csv` log entry carries the `batchId`.

## TCGplayer export (column assumptions)

Export from Seller Portal → Pricing → **Export From Live** (or Export My Inventory). Hekla expects TCGplayer's pricing CSV:

`TCGplayer Id, Product Line, Set Name, Product Name, Title, Number, Rarity, Condition, TCG Market Price, TCG Direct Low,
TCG Low Price With Shipping, TCG Low Price, Total Quantity, Add to Quantity, TCG Marketplace Price, Photo URL`

- Columns are found by name, case-insensitively, in any order. Extra columns (e.g. `My Store Reserve Quantity`, `My Store Price`) are ignored.
- Required columns: `TCGplayer Id` (the SKU), `Product Name` and `Total Quantity`. Without them the upload is refused.
- Only rows with Total Quantity > 0 are kept. Export From Live includes the whole catalog at 0.
- Rows with a non-numeric id are counted as unreadable. A repeated SKU keeps its first row.
- `TCG Marketplace Price` is your price and `TCG Market Price` is the market price. `$` and `,` are stripped.
- `Condition` reads like `Near Mint`, `Lightly Played Foil`, or `Near Mint Holofoil - Japanese`.
- `Product Line` is matched loosely: lorcana, riftbound, magic, pokemon, yugioh / yu-gi-oh.
- `Number` like `14/204` is compared on the part before `/`, without leading zeros.
- Limit: 15 MB.

## TCGplayer matching

1. **Airtable `TCGplayer SKU`** on the row, if the column exists. A SKU that is not in the export counts as 0 on TCGplayer.
2. **Confirmed** matches (`tcgplayer_matches`, saved by an admin on this page).
3. **Suggested** fuzzy matches, one-to-one, highest score first:
   - The game and the collector number must agree.
   - Weights: name 0.40, number 0.25, set 0.15, condition 0.12, foil/Enchanted 0.08.
   - Suggestions start at 0.60. They are banded as high (≥ 0.90), medium (≥ 0.75) or low.

Suggestions must be confirmed before anything acts on them. **Confirm + save SKU to Airtable** writes the `TCGplayer SKU`
column only on that click. If the column does not exist, Hekla says so and keeps the match in Hekla only. **Hekla never
creates Airtable fields**: to store SKUs in Airtable, add a text (or number) column named exactly `TCGplayer SKU`.
Unmatched TCGplayer rows can be tied to a row by record id (**Match to a row...**).

## Actions (admins only, every one logged in `reconcile_actions`)

- **Set CardTrader to N**:
  - Re-reads the Airtable row and CardTrader first, and refuses (409) if either has changed since the page loaded.
  - Lowering takes from the largest listing first. Raising adds to the row's stored listing.
  - At 0, CardTrader deletes the listing (the confirm says so).
  - A card with no listing cannot be raised here.
  - Uses the shared rate-limited CardTrader client.
- **TCGplayer import CSV for selected**: builds (never uploads) a Seller Portal import with Add to Quantity = expected − TCGplayer.
  - Only SKU or confirmed matches are included.
  - TCG Marketplace Price is required by the import and *sets* the price, so it is your current TCGplayer price from the snapshot.
  - Hekla's market price is used only for a SKU you do not stock there yet.
  - The response says which rows were left out and why.
- **Set Airtable to N**: the only way this page changes Airtable Qty.
  - The button appears for Listed rows and offers the CardTrader or matched TCGplayer number.
  - It needs a confirm and refuses (409) if Airtable changed since the page loaded.
  - At 0 the Status becomes Sold, the same rule as everywhere else.
- Also logged: checks, uploads, confirm/unconfirm and SKU write-backs. The page shows the last 25 actions.

## Routes

`GET /api/reconcile/view` (?mismatch=any|cardtrader|tcgplayer&game=...&reconciled=1), `GET /api/reconcile/view.csv`, and admin-only
`POST /api/reconcile/check`, `POST /api/reconcile/tcgplayer/upload` (raw CSV body), `POST|DELETE /api/reconcile/tcgplayer/confirm`,
`POST /api/reconcile/tcgplayer/import`, `POST /api/reconcile/cardtrader/set`, `POST /api/reconcile/airtable/set`.

## Migration

`db/migrations/0006_reconcile.sql` is additive. It adds four tables (`create ... if not exists`) and changes no existing table.
Apply it before deploying. Without it, `/reconcile` errors, but nothing else in Hekla is affected.
