# Sales log, cross-delist and TCGplayer pull list

Hekla Intake now:

1. **Keeps a sales log** in Neon (`sales`): one row per sold line, for CardTrader and starfoil.store. Each row has the platform, order id, line, Waitlist record, game, qty, gross, fees, net payout after fees, sold time and the raw payload. The `/sales` page (behind Clerk) has filters, totals per platform and a CSV download.
2. **Can take over CardTrader sale handling** from starfoil-lgs: it lowers the shared Airtable Waitlist **Qty** once per sale, using a row lease and an idempotent log. This sits behind a flag that is **off** by default.
3. **Checks stock every 15 minutes** (reconcile): it compares Airtable Qty with CardTrader listings, and can optionally lower an over-listed CardTrader listing.
4. **Builds a daily "pull from TCGplayer" list**, with a CSV in TCGplayer's Seller Portal import format. An optional daily email is **off** by default.

Nothing changes in production until the migration is applied and the flags below are set.

## Who lowers the shared Qty (only one system ever does)

| Sale on | Lowers CardTrader | Lowers Airtable Qty | Logged in Hekla by |
|---|---|---|---|
| starfoil.store (Stripe) | starfoil-lgs (unchanged) | starfoil-lgs (unchanged) | signed POST from starfoil-lgs → `/hooks/starfoil/:tenantId` |
| CardTrader, paid **before** the hand-over instant | CardTrader itself | starfoil-lgs (unchanged) | Hekla poll / webhook (log only) |
| CardTrader, paid **at or after** the hand-over instant | CardTrader itself | **Hekla** (`CT_SALES_MODE=decrement`) | Hekla poll / webhook |

- **Hand-over instant.** Hekla's `CT_DECREMENT_FROM` and starfoil-lgs's `CT_DECREMENT_UNTIL` hold the same ISO instant.
  - Both decide ownership with the same rule: `paid_at`, else `created_at`. Every order therefore has exactly one owner, with no gap and no overlap.
  - Until both are set, starfoil-lgs keeps doing what it does today.
- **Why starfoil keeps the store-side decrement.** It already reserves stock at checkout (holds), decrements its D1 inventory, lowers the CardTrader listing and the Airtable row, and flags OVERSOLD/FAILED in the same request.
  - Moving that into Hekla would add a network hop inside Stripe's webhook, for no gain.
  - Hekla only logs those sales.
- **"Push the absolute qty to the other platform."**
  - After a CardTrader sale, CardTrader has already lowered its own listing. starfoil.store re-reads CardTrader every 3 minutes, so nothing needs pushing.
  - After a store sale, starfoil-lgs has already pushed to CardTrader.
  - The reconcile is the safety net. It compares absolute numbers (listable quantity vs the sum of CardTrader listing quantities, matched by `user_data_field`). Listable quantity is Airtable Qty minus `Reserved Qty` minus `Deck Reserved Qty`, or the `Free Qty` formula when that column has a number. Blanks count as 0. In `push` mode it sets CardTrader down to that listable quantity. `CT_SALES_MODE` still lowers Qty itself and does not read either hold field.

### The decrement, step by step (`src/sales.ts` → `applyPendingDecrements`)

1. Every sale line is inserted with `unique (tenant, platform, order, line)`, so webhook + poll + retries insert it once.
2. For each pending Hekla-owned line, take a 30 s lease on the Waitlist row (`stock_locks`). If another run holds it, skip; the next run picks it up.
3. Read Qty. Plan `target = max(0, before − qty)`, and record `qty_before` / `qty_target` on the line *before* writing.
4. PATCH Airtable (Qty, plus Status = Sold at 0, the same rule starfoil-lgs uses). Then mark the line done.
5. If the Worker stops between 3 and 5, the next run compares Airtable with before/target:
   - Airtable shows the target: the write happened, so mark done.
   - Airtable still shows the old Qty: redo.
   - Anything else: flag the line for a person. Hekla never guesses.
6. **Oversell.** If the qty sold is more than Qty, Hekla sets Qty to 0, marks the line oversold and emails an alert once. **No order is ever cancelled automatically.**
7. **Cancellation after Hekla lowered Qty.** The line is flagged and alerted. Stock is never added back automatically, matching what starfoil-lgs does today.

Known limit: Airtable has no compare-and-set. During the hand-over both systems can write the same row, starfoil (store sales) and Hekla (CardTrader sales), and either could overwrite the other's write if they land within the same second. The window is one read and one PATCH. The 15-minute reconcile reports any resulting mismatch.

## Flags (wrangler `[vars]`, all off by default)

| Var | Values | Effect |
|---|---|---|
| `CT_SALES_MODE` | `off` / `log` / `decrement` | `log`: record CardTrader sales (poll every 5 min, plus the webhook if enabled). `decrement`: also lower Qty for sales at or after `CT_DECREMENT_FROM`. With `decrement` and an empty `CT_DECREMENT_FROM`, it behaves like `log`. |
| `CT_DECREMENT_FROM` | ISO instant, e.g. `2026-10-25T14:00:00Z` | The hand-over. Must equal starfoil-lgs `CT_DECREMENT_UNTIL`. |
| `RECONCILE_MODE` | `off` / `report` / `push` | `push` only ever *lowers* a CardTrader listing, and only when the same excess shows on two runs in a row. It never raises anything. |
| `TCGPLAYER_DAILY_EMAIL` | `off` / `on` | 9 AM America/New_York email of the pull list (needs alert email on Settings). |

Cron: a single `*/5` trigger. Each tick runs the CardTrader poll and decrements, the reconcile on :00/:15/:30/:45 and the daily email (each no-op while its flag is off), and every 10th minute it also runs enrichment (same cadence as the old `*/10`). There is no separate `*/10`, simply to keep one schedule. (While both were configured on deploy day, two `*/10` ticks were missed; that was most likely because each deploy landed a minute or two before the tick, not a Cloudflare limit: starfoil-lgs runs `*/3` and `*/15` in the same minute without trouble.)

CardTrader rate limit: 200 requests / 10 s per account. Hekla's client keeps itself under 150 / 10 s per isolate. The poll is 1 request every 5 min and the reconcile is 1 export request, which leaves plenty of room for starfoil-lgs.

## Settings (all secrets sealed with `CONNECTIONS_KEY`, like the CardTrader token)

- **CardTrader webhook.**
  - Reads the account's current `webhook_url` and the app's `shared_secret` from `GET /info`, seals the secret, then sets `webhook_url` to `https://<host>/hooks/cardtrader/<tenantId>`.
  - CardTrader allows **one** webhook URL per account. If one is already set elsewhere, Hekla shows it and asks before replacing it.
  - Turning it off clears the URL only if it still points at Hekla.
  - Optional: the 5-minute poll works without it.
- **starfoil.store sales.** Generates a random secret (shown once) for starfoil-lgs to sign sale events with (HMAC-SHA256 hex of `timestamp.body`, ±5 min).
- **Alert email.** A Resend API key plus to/from addresses. starfoil-lgs already uses Resend, so a key for the same verified domain works. Without it, alerts are logged and shown on the Sales page.

## TCGplayer

There is no TCGplayer API access, so Hekla cannot delist there. The Sales page lists everything sold on CardTrader or starfoil.store in the last 24 h (or 48 h / 7 days), with the shared Qty and a sold-out flag.

- **Import CSV:** the 16-column format from TCGplayer's help article *Importing and Exporting CSVs to Mass Update Prices and Quantities*:
  `TCGplayer Id, Product Line, Set Name, Product Name, Title, Number, Rarity, Condition, TCG Market Price, TCG Direct Low, TCG Low Price With Shipping, TCG Low Price, Total Quantity, Add to Quantity, TCG Marketplace Price, Photo URL`.
  - **Add to Quantity** = −qty sold. TCGplayer floors at 0.
  - **TCGplayer Id** is the TCGplayer **SKU** (not the product id). It comes from an optional Airtable column **`TCGplayer SKU`**. Rows without one are only in the checklist CSV.
  - **TCG Marketplace Price** is required by TCGplayer, and the import **sets your price** to it. Hekla fills in its Market Price USD, so check the Staged screen before you publish.
  - Upload: Seller Portal → Pricing → Import (goes to Staged). TCGplayer documents this as needing seller Level 4.
  - Product Line names and the Condition text are best guesses and informational only. TCGplayer matches on the SKU.
- **Checklist CSV:** everything, SKU or not, for pulling by hand.

## starfoil-lgs companion change (`docs/starfoil-companion.patch`)

Applies cleanly to `dustinholdfast/starfoil-worker` main `12603e5` and typechecks. It is not pushed anywhere; apply it in its own PR.

- `src/marketplace.ts`:
  - `heklaOwns()`: orders with `paid_at ?? created_at` ≥ `CT_DECREMENT_UNTIL` are recorded in `ct_orders` with a Hekla marker and **not** decremented. Their cancels are left to Hekla.
  - Because they are still marked processed, clearing `CT_DECREMENT_UNTIL` later never lowers them a second time.
- `src/checkout.ts`:
  - `takeFromSource` also reports how many copies came from each Waitlist record.
  - After `completeOrder` it posts a signed sale event to Hekla (`src/hekla.ts`): per-record lines, unit price, subtotal, shipping, tax and total, plus the Stripe fee when Stripe has settled it (`payment_intents/:id?expand[]=latest_charge.balance_transaction`).
  - Live keys only. A failure is logged and never affects the order.
- `src/db.ts`: `CT_DECREMENT_UNTIL`, `HEKLA_SALES_URL`, `HEKLA_SALES_SECRET`.

## Rollout checklist

1. Review and merge this PR (Dustin).
2. Apply `source/db/migrations/0005_sales.sql` to the production Neon database.
   - It is additive and safe to re-run.
   - One statement drops and re-creates the `tenant_connections_provider_check` constraint with a wider list. No rows are touched.
3. Deploy Hekla with every flag off. The new things you'll see are the Sales page and a "Sales sync" section on Settings.
4. On Settings, as an org admin:
   - Set up **Alert email** and send a test.
   - Create the **starfoil.store** secret.
5. starfoil-worker:
   - Apply the companion patch.
   - `wrangler secret put HEKLA_SALES_URL` (the address shown on Settings) and `HEKLA_SALES_SECRET`.
   - Leave `CT_DECREMENT_UNTIL` unset.
   - Deploy. Store sales now appear on the Sales page.
6. Hekla: set `CT_SALES_MODE = "log"` and deploy.
   - CardTrader sales appear within 5 minutes; compare them with CardTrader.
   - Optionally turn on the CardTrader webhook on Settings. Check the current address first.
7. Set `RECONCILE_MODE = "report"`. Watch the Stock check on the Sales page for a few days.
8. **Hand-over (CardTrader decrement moves to Hekla).** Pick an instant **T** at least 30 minutes ahead, in UTC.
   - Set Hekla `CT_SALES_MODE = "decrement"` and `CT_DECREMENT_FROM = "T"`, then deploy.
   - Set starfoil `CT_DECREMENT_UNTIL = "T"`, then deploy.
   - **Both must be live before T.** If one deploy fails, revert the other before T.
9. Later, optionally: `RECONCILE_MODE = "push"` and `TCGPLAYER_DAILY_EMAIL = "on"`. Add a `TCGplayer SKU` column to the Waitlist to make the import CSV useful.

**Rollback of step 8:**
1. Set Hekla `CT_SALES_MODE = "log"`.
2. Then clear starfoil `CT_DECREMENT_UNTIL`. Orders already handed over stay marked processed in starfoil, so none is lowered twice.

An order paid between those two deploys is lowered by neither system. It shows up in the Stock check as "CardTrader shows fewer"; fix its Qty by hand.

## Tests

- `npm run check`: typecheck plus unit tests. The new tests cover idempotency, the hand-over, oversell, leases, crash-retry (done / redo / conflict), cancels, reconcile, the TCGplayer CSV and HMAC.
- The Neon SQL in `src/salesdb.ts` and the migration were also run against real Postgres (PGlite) during development: re-runnable migration, idempotent insert, lease, ET day filters, `sync_state`.
