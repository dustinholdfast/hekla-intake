# Hekla Intake: Handoff Document

**Owner:** Dustin Perkins
**Audience:** Dustin, and any future developer or bot that picks up this app
**Prepared:** Sunday, October 11, 2026, about 9:35 AM ET
**Updated:** Sunday, October 11, 2026, about 10:55 AM ET (GitHub repo, Clerk sign-in, Neon tenants and audit log)
**Live URL:** https://hekla-intake.dustin-eef.workers.dev
**Source of truth:** private GitHub repo `dustinholdfast/hekla-intake`. The app is in `source/`. `main` matches what is deployed; a GitHub Action runs `npm run check` on every push to `main` and on pull requests. Dustin's working clone is `E:\Projects\Hekla Intake`.

> **How this was checked.** The original 9:35 AM version was checked against the source code in `/workspace/hekla-intake` (src/, public/, wrangler.toml, package.json, tests), the live Airtable schema and rows (read through the Airtable connector), `wrangler secret list` (names only), `wrangler deployments list`, and the local wrangler logs. No secret values appear in this document. Anything I couldn't confirm is marked **Unknown**.
>
> **About the 10:55 AM update.** The sections on sign-in, tenants, secrets, deploys, known issues and the roadmap were rewritten after the move to Clerk and Neon. They were checked against the `clerk-auth` branch, the Cloudflare deployment and secret lists (names only), and the live site. The Airtable numbers in §5.2 and §6 are still the 9:33 AM snapshot unless a line says otherwise. The Neon database itself could not be read while writing this.

---

## 1. Executive summary

Hekla Intake is a small web app. Dustin uses it to type or paste trading cards into the Airtable **Waitlist** table. Hekla, Dustin's Lorcana/TCGPlayer selling bot (Grok Bot id `4590aafc-366c-4a4c-ac9c-6e3eb8d9968b`), reads that table. It runs as one Cloudflare Worker (`hekla-intake`) and supports five games: Lorcana, Magic: The Gathering, Riftbound, Pokémon, and Yu-Gi-Oh!.

Since Oct 11 the app is built for more than one seller. Sign-in is handled by Clerk. Each seller is a **tenant**: a Clerk Organization with a matching row in a Neon Postgres `tenants` table that says which Airtable base and table hold that seller's cards. Dustin's organization is tenant one and points at the original base, so Hekla is unaffected. Cards still live in Airtable; Neon holds only tenants and an audit log.

Besides adding cards, the app does advisory **auto-sort**. It looks up each card in a public catalog, records a market price when a real one exists, and writes an **Auto Rank** (0–100) plus a **Recommendation** (List / Hold / Skip). The rank is a fixed rules-based score that Gemini can adjust by up to 20 points. For cards that are already listed, the same values mean **Keep / Watch / Pull**.

The app is deliberately limited. **It never changes Status, never writes Hekla's Rank Score, never posts to TCGPlayer, and never sends buyer messages.** Hekla owns waitlist ranking under the L1 cap (100 listed per game) and the L2 unlock path. Nothing gets listed, priced, or sent to buyers without Dustin's explicit go.

**Status at a glance (Oct 11, about 10:55 AM ET)**

| Item | State |
|---|---|
| Deployed version | `52ed2e0e-5c23-41e4-9cd3-09d3bcf10f9b` (Oct 11, 10:50 AM ET). Code from commit `40b2de6`, now on `main`. |
| Tests / typecheck | 22 of 22 tests pass. `tsc --noEmit` is clean. |
| Sign-in | Clerk, development instance. Dustin signed in and reached the queue on Oct 11. |
| Lorcana L1 cap | **Full**: 68 Listed rows, total qty 100 out of 100 |
| Listed re-rank | All 68 Listed rows have an Enriched At from today: **62 Pull, 6 Watch, 0 Keep** |
| Riftbound pricing (tcgcsv) | **Landed and live.** 49 of 55 Riftbound Waitlist rows were re-priced by about 10:00 AM ET; the cron was working through the last 6. |
| Biggest risk | Not ready for a second seller yet: Clerk is a development instance on a `workers.dev` address, every tenant would share one Airtable token, and new tenants are added by hand (§10 #22–#28) |
| Next actions | Check Gemini billing. Check the Acceleration Gate finish (§10 #3). Decide Rank Score vs. Auto Rank. |

---

## 2. What it does and the user workflow

### 2.1 What the app does

- **Quick Add:** add one card. Lorcana uses a Set # picker (sets 1–14, Q1–Q3, P). Other games use a free-text Set Identifier. You also enter collector number, finish, condition, and qty. Card name, rarity, cost basis, priority, and notes are optional.
- **Bulk paste:** paste up to 100 lines (20,000 characters) at a time, one card per line in the form `set, collector #, finish, condition [, qty] [, name]`. Tabs, commas, and spaces all work as separators. Blank lines and `#` comments are ignored. Bulk paste has two steps: **Preview** first, then **Add these to waitlist**.
- **Duplicate guard:** a card counts as a duplicate when game, set, collector number, and finish all match a row that is already Waitlist or Listed. Collector numbers are compared loosely, so `7`, `007`, and `7/204` match. You can then **Merge qty**, **Add anyway**, or Cancel. Bulk paste offers skip, merge, or add.
- **Queue view:** filter by game and by Status (Waitlist, Listed, Sold, Skip), with search.
  - Waitlist is sorted by Auto Rank (unranked rows last), then Priority, then newest.
  - Listed is sorted weakest first, so pull candidates appear on top.
- **Inline edits:** change Finish, Condition, or Qty. Waitlist rows only.
- **Delete:** with a confirm step. Waitlist rows only.
- **Hover preview:** hover over a row (or focus it) for about 250 ms to see the card image and text from that game's public catalog.
- **Auto-sort:** the **Auto-sort pending** button, a per-row **Sort now / Re-sort** button, automatic sorting right after each add, and a cron every 15 minutes.
- **Re-rank listed cards:** a button on the Listed view. It re-scores every Listed row for the selected game, 20 rows per request.
- **Hekla handoff notes:** the **Greenlight shortlist** dialog, plus a "process new rows" action in the code. Each sends a note to Hekla through an optional webhook. If the webhook isn't set, the app gives Dustin text to copy and a mailto link. These notes are informational only and list nothing.
- **L1 cap meter:** shows Listed qty against 100 for the selected game. The meter reads Airtable, not live TCGPlayer inventory.

### 2.2 Typical workflow

| Step | Who | What happens |
|---|---|---|
| 1 | Dustin | Opens the URL and signs in through Clerk (Google or email). If no organization is active, he picks one. |
| 2 | Dustin | Picks a game tab, then adds cards with Quick Add or Bulk paste |
| 3 | Intake | Creates the row with `Status = Waitlist`. Checks for duplicates first. |
| 4 | Intake | Auto-sorts the new row in the background: catalog lookup, price, Auto Rank, Recommendation |
| 5 | Intake (cron) | Every 15 minutes, picks up any Waitlist or Listed rows whose `Enriched At` is blank |
| 6 | Dustin | Reviews the queue, fixes Finish/Condition/Qty, deletes mistakes |
| 7 | Hekla | Ranks the Waitlist under the L1 cap. Hekla writes `Rank Score` and owns Status changes. |
| 8 | Dustin | Gives Hekla an explicit go (the Greenlight dialog is just a note) |
| 9 | Hekla | Lists or prices on TCGPlayer **only after Dustin's go**. Intake is never involved in this step. |

---

## 3. Architecture and hosting

### 3.1 Components

| Layer | Detail |
|---|---|
| Runtime | Cloudflare Worker `hekla-intake`, with `compatibility_date = 2026-10-01` and the `nodejs_compat` flag |
| Account | `eef14117e342317b606fda458b144e58` |
| URL | https://hekla-intake.dustin-eef.workers.dev (workers.dev only. No custom domain is set in wrangler.toml.) |
| Framework | Hono 4 (`hono ^4.9.6`) in TypeScript, entry point `src/index.ts` |
| Static UI | `public/` served through the `ASSETS` binding with `run_worker_first = true`. The Worker adds security headers. Plain HTML, CSS, and JS with no build step. |
| Card data | Airtable. Tenant one uses base **Lorcana Card Waitlist** `app4Tjz72sZtVMQyp`, table **Waitlist** `tblvHPu7dgDHA91bc`. The IDs come from the tenant's row in Neon; they are no longer `[vars]` in wrangler.toml. |
| Sign-in | Clerk (`@clerk/hono` on the Worker, ClerkJS 6 and Clerk UI loaded from Clerk's CDN in the browser). Development instance `cute-gar-7802.clerk.accounts.dev`. Organizations are turned on. |
| Tenants and audit log | Neon Postgres, reached with `@neondatabase/serverless` over HTTP. Tables `tenants` and `audit_log` (§3.4). |
| AI | Google Gemini API (`generativelanguage.googleapis.com/v1beta`), called only during enrichment |
| Catalog / price sources | Lorcast, Scryfall, pokemontcg.io, YGOPRODeck, Riftcodex, and tcgcsv.com (Riftbound prices). See §6. |
| Cache | Cloudflare `caches.default`. Card previews are cached 7 days when found and 6 hours when not. tcgcsv files are cached 12 hours. |
| Cron | `*/15 * * * *` runs `scheduled()`, which loops over every tenant in Neon and enriches that tenant's pending Waitlist rows, then pending Listed rows |
| Observability | `[observability] enabled = true`, `head_sampling_rate = 1` (Workers Logs) |
| Tooling | wrangler 4.145.0 (installed in the project; run it with `npx wrangler`). TypeScript 5.9. Tests use Node's built-in test runner. Node 24 on Dustin's PC. |

### 3.2 Source layout

| Path | Purpose |
|---|---|
| `src/index.ts` | Routes, Clerk and tenant middleware, audit calls, security headers, cron handler, bot webhook |
| `src/auth.ts` | Reads Clerk's Frontend API host from the publishable key, checks that sign-in is configured, and builds the CSP |
| `src/tenants.ts` | Neon client: tenant lookup by Clerk Organization ID (cached 60 seconds per isolate), tenant list for the cron, the per-tenant env, audit-log writes |
| `db/migrations/0001_tenants.sql` | Creates `tenants` and `audit_log` and inserts tenant one |
| `src/airtable.ts` | Airtable client (throttled to about 1 call per 220 ms, one retry on 429), queue/summary, dedupe, create/merge/edit/delete, enrichment orchestration |
| `src/fields.ts` | Validation, plus the allowlists of fields intake may create or edit and the list it must never write |
| `src/sets.ts` | Games, Lorcana sets, finishes, conditions, rarities, statuses, `LISTED_CAP = 100` |
| `src/parse.ts` | Bulk-paste line parser |
| `src/preview.ts` | Per-game catalog resolvers, plus the image host allowlist used by the CSP |
| `src/enrich.ts` | Price extraction, the rules-based rank, the Gemini prompt and checks on its output, the field write allowlist |
| `src/tcgcsv.ts` | Riftbound TCGplayer market prices from tcgcsv.com (new Oct 11) |
| `src/*.test.ts` | `auth.test.ts`, `delete.test.ts`, `edit.test.ts`, `enrich.test.ts` (22 tests in total) |
| `public/index.html`, `app.js`, `app.css` | The UI |
| `public/fonts/` | Self-hosted Inter (400–700) and JetBrains Mono (400, 500), WOFF2 |
| `public/hekla-logo-dark.png`, `hekla-icon-dark.png` | Raster logo (480×522) and icon (160×234) used in the UI |
| `public/hekla-wordmark.svg`, favicons | Wordmark SVG (in public/ but not referenced by index.html), plus favicon.svg/.ico/32px and the apple-touch icon |

### 3.3 Sign-in and tenant isolation

- **Clerk replaces the passphrase.** The passphrase gate, the `hekla_session` cookie and the Cloudflare Access mode were removed on Oct 11. `POST /api/login` and `POST /api/logout` no longer exist.
- **Every `/api/*` route except `GET /api/config` needs three things:** a valid Clerk session (401 if missing), an active Clerk Organization on that session (403, code `no_org`), and a row in Neon `tenants` for that organization (403, code `no_tenant`).
- **The browser sends a fresh session token** as `Authorization: Bearer …` on every API call (`Clerk.session.getToken()`), so a stale cookie in a background tab doesn't sign the user out.
- **Tenant isolation.** After the checks pass, the request runs with a per-tenant env built by `tenantEnv()`. The Airtable base, table and bot webhook come only from the tenant's row. The Worker has no base or table vars to fall back to.
- **Not isolated yet:** the Airtable token. All tenants use the one `AIRTABLE_API_KEY` secret (§10 #23).
- **Roles.** The Clerk organization role is returned by `/api/session` but nothing is restricted by role yet.
- **Not configured means closed.** If `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` or `DATABASE_URL` is missing, the API returns 503.
- **Sign-in page.** `app.js` reads `/api/config`, loads Clerk's two scripts from the instance's Frontend API host, and mounts Clerk's sign-in form. A signed-in user with no active organization, or whose organization has no tenant row, sees Clerk's organization picker with the reason underneath.
- **Security headers on all responses:** CSP, `nosniff`, `referrer-policy: no-referrer`, `x-frame-options: DENY`, and `cache-control: no-store` on API routes. With Clerk configured the CSP also allows the Clerk Frontend API host, `challenges.cloudflare.com`, `cdn.protect.clerk.com`, `img.clerk.com`, blob workers, and inline styles (`style-src 'unsafe-inline'`, which Clerk's components need).

### 3.4 Neon tables

| Table | Columns | Notes |
|---|---|---|
| `tenants` | `id` (uuid), `clerk_org_id` (unique), `name`, `airtable_base_id`, `airtable_table_id`, `bot_webhook_url` (https only, nullable), `created_at` | One row per seller. Tenant one: `clerk_org_id = org_3KYI7xB6yJInWU8sf5KbJ6x3mZx`, name Hekla. In Clerk that organization is called "The Royal Court of Princess Donut". |
| `audit_log` | `id`, `tenant_id`, `clerk_user_id`, `action` (create, merge, edit, delete), `record_id` (Airtable), `snapshot` (the row after the change; null for delete), `created_at` | Written in the background after each change. A failed audit write is logged as `audit failed` and never fails the request. Enrichment is not audited. |

Users, memberships and roles are not mirrored in Neon; they live in Clerk.

---

## 4. Endpoints

"Tenant" means a valid Clerk session with an active organization that has a row in Neon `tenants` (§3.3). All Airtable access goes through that tenant's one table.

| Method | Path | Auth | Reads | Writes | Notes |
|---|---|---|---|---|---|
| GET | `/api/config` | Public | Env | — | Returns the Clerk publishable key and Frontend API host for the sign-in page. Neither is secret. |
| GET | `/api/session` | Tenant | Tenant row | — | Returns the tenant name, the user's organization role, the cap, base/table IDs, games, sets, finishes by game, conditions, and rarities for the UI |
| GET | `/api/summary?game=` | Tenant | Airtable: Status, Qty, Game for that game | — | Listed qty, Waitlist qty, remaining slots, counts by status |
| GET | `/api/queue?status=&game=` | Tenant | Airtable rows for that status and game | — | Reads at most 20 pages × 100 rows, and sets a `truncated` flag past that |
| POST | `/api/intake` | Tenant | Airtable duplicate check | **Creates** a Waitlist row, or **merges Qty** into a matching Waitlist **or Listed** row | 409 with the matches when a duplicate needs a choice. Starts background enrichment. |
| POST | `/api/intake/bulk` | Tenant | Airtable open rows (Waitlist and Listed) for the game | Creates rows in batches of 10, or merges Qty | `mode=preview` or `commit`. Commit needs `onDuplicate` set to skip, merge, or add. Stops at the first write failure. |
| PATCH | `/api/cards/:id` | Tenant | The row (must be Waitlist) | Finish, Condition, Qty only | Checked against the game's allowed values. Qty 1–999. |
| DELETE | `/api/cards/:id` | Tenant | The row (must be Waitlist) | **Deletes** the row | The record id must match `rec` + 14 characters. The UI asks for confirmation. **No undo.** |
| GET | `/api/preview?game=&set=&number=&name=` | Tenant | External catalogs (§6) | Edge cache only | Inputs are capped at 120 characters. Images only from allowlisted hosts. |
| POST | `/api/enrich/:id` | Tenant | The row (Waitlist or Listed), the catalog, Gemini | Enrichment fields (§5.3) | Per-row "Sort now / Re-sort" |
| POST | `/api/enrich` | Tenant | Pending Waitlist rows (`Enriched At` blank) | Enrichment fields | Up to 4 rounds of 25 per click |
| POST | `/api/enrich-listed?game=&offset=` | Tenant | All Listed rows for the game, in record-id order | Enrichment fields (Keep/Watch/Pull) | 20 per page. The client keeps calling with `nextOffset` until done. |
| POST | `/api/hekla` | Tenant | The tenant's `bot_webhook_url` (if set) | Nothing in Airtable | `action` is `process` or `greenlight`. Posts `{listsCards:false,...}` to the webhook, which must be https. **Tenant one has no webhook set**, so the app returns copy text and a mailto link instead. |
| GET | `*` | Public | Static assets | — | Adds the CSP and other security headers. The page itself is public; it shows only the sign-in form until Clerk has a session. |
| — | `scheduled` (cron) | — | The tenant list in Neon, then each tenant's pending Waitlist and Listed rows | Enrichment fields | Per tenant: a batch of 25 Waitlist rows, then Listed rows with a budget of `max(10, 25 − Waitlist rows enriched)` |

`/api/intake`, `/api/intake/bulk`, `PATCH /api/cards/:id` and `DELETE /api/cards/:id` also write one `audit_log` row per changed card.

---

## 5. Airtable data model

**Base:** Lorcana Card Waitlist (`app4Tjz72sZtVMQyp`). **Table:** Waitlist (`tblvHPu7dgDHA91bc`), described in Airtable as "Disney Lorcana TCG card waitlist for buying/selling intake." This is the only table in the base.

### 5.1 Fields and who writes them

Legend: **C** = written on create, **E** = inline edit, **M** = qty merge, **AS** = written by auto-sort (enrichment), **H** = owned by Hekla or Dustin, **—** = never written by intake.

| Field | Type | Options / format | Intake writes | Owner / notes |
|---|---|---|---|---|
| Card Name (primary) | Single line text | Optional. Can be resolved later from set + #. | C (optional) | Dustin |
| Collector Number | Single line text | e.g. `42/204` | C | Dustin |
| Set # | Single select | 1, 2, 3, 4, Q1, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, Q2, Q3, P | C (Lorcana only) | Dustin |
| Set Identifier | Single line text | Free text for games other than Lorcana | C (non-Lorcana only) | Dustin |
| Game | Single select | Lorcana, Magic: The Gathering, Riftbound, Pokémon, Yu-Gi-Oh! | C | Blank is treated as Lorcana (legacy rows) |
| Finish | Single select | Normal, Foil, Enchanted | C, E | Same three for every game |
| Condition | Single select | NM, LP, MP, HP, DMG | C, E | |
| Qty | Number | Whole number | C, E, M | **Merge can also add qty to Listed rows** (see §10) |
| Rarity | Single select | Common, Uncommon, Rare, Super Rare, Legendary, Enchanted, Promo, Special | C (optional), AS (only if blank) | The options are Lorcana-shaped (§10) |
| Cost Basis USD | Currency ($, 2 dp) | | C (optional) | Feeds the margin part of the rank |
| Priority | Number | Lower means sooner | C (optional) | Waitlist tie-breaker |
| Notes | Long text | | C (optional) | |
| Status | Single select | Waitlist, Listed, Sold, Skip | **C = "Waitlist" only. Never changed afterwards.** | **H.** Hekla and Dustin own every status change. |
| Resolved Name | Single line text | "Filled after catalog lookup" | AS (only if blank). Blocked on create. | Shared. Hekla may also fill it. |
| Market Price USD | Currency ($, 2 dp) | "For ranking later" | AS, **only when a catalog has a real price**. Blocked on create. | Shared. Intake never clears an existing price, but it **does overwrite** it when a catalog price exists. |
| Rank Score | Number (2 dp) | "For ranking later" | **—** (blocked) | **H.** Hekla's scale. Live values range 0.03 to 6.86 across 155 rows. |
| Set Name (legacy) | Single select | Full Lorcana set names | **—** (blocked) | Legacy. Kept for migration reference only. |
| Card Type | Single line text | Type line plus (source rarity) | AS | Intake |
| Recommendation | Single select | List, Hold, Skip | AS | Advisory only. On Listed rows it means Keep / Watch / Pull. |
| Rank Reason | Single line text | 140 characters or fewer | AS | Listed reasons start with "Keep:", "Watch:", or "Pull:" |
| Enriched At | Date/time | ISO date, 24-hour, America/New_York | AS | **Blank = pending.** Clear it to queue a row for re-enrichment. |
| Price Source | Single line text | | AS | Where the price came from, or "price unavailable (…)" |
| Auto Rank | Number (0 dp) | 0–100 | AS | Intake's rank. It is **not** Rank Score. |

The allowlists are enforced in code:
- Create allows only `CREATE_FIELDS`, and `assertCreateFields` requires `Status = Waitlist`.
- `FORBIDDEN_FIELDS` blocks Resolved Name, Market Price USD, Rank Score, Set Name, and Set Name (legacy) on create.
- Edit allows only Finish, Condition, and Qty.
- Merge allows only Qty.
- Enrichment allows only `ENRICH_WRITABLE`: Auto Rank, Recommendation, Rank Reason, Market Price USD, Price Source, Card Type, Enriched At, Rarity, Resolved Name. `assertEnrichFields` throws on anything else, including Status.
- Every write sends `typecast: false`, so a value that isn't a valid select option fails instead of creating a new option.

### 5.2 Live data snapshot (read Oct 11, about 9:33 AM ET)

| Game | Waitlist | Listed (rows / qty) | Sold | Skip (status) |
|---|---|---|---|---|
| Lorcana | 34 | 68 / **100** (cap full) | 0 | 28 |
| Riftbound | 55 (all set VEN) | 0 / 0 | 0 | 0 |
| Magic, Pokémon, Yu-Gi-Oh! | 0 | 0 | 0 | 0 |

Total: 185 rows.

- **Lorcana Waitlist:** all 34 rows were enriched on Oct 10. Every one is recommended **Skip** (low-value cards).
  - The Oct 10 run reported 78 Waitlist rows, all Skip. The table now has 34 Lorcana Waitlist rows, plus 28 Lorcana rows with Status Skip that were never enriched.
  - The gap was presumably caused by Status changes made outside intake, plus possibly deletes, but nothing on record shows it: **Unknown.**
- **Lorcana Listed:** see §6.5.
- **Riftbound:** the new tcgcsv pricing is being applied. See §6.4.

---

## 6. AI auto-sort / re-rank logic and price sources

### 6.1 Pipeline (per row), from `enrichOne` in `src/enrich.ts`

1. **Catalog lookup.** The game's resolver (§6.3) runs on set + collector number first, then falls back to name. An upstream 5xx or 429 throws, so the row stays pending and is retried later.
2. **Price extraction.** The price must match the row's finish. Foil and Enchanted count as foil. **A price is never invented.** If no price exists, Price Source records why. For Riftbound, if the catalog has no price, **tcgcsv** is tried next.
3. **Rarity.** If the row's Rarity is blank, the source rarity is mapped onto the Airtable options:
   - mythic → Legendary
   - anything unrecognised (e.g. "Ultra Rare") → Special
4. **Rules-based base score (0–100):**
   - Price part: `min(60, 25 × log10(1 + price))`, or 15 when there is no price
   - Plus margin, when a cost basis is set: `clamp((price − cost) / cost × 10, −15, +15)`
   - Plus condition points: NM 15, LP 10, MP 4, HP 0, DMG −5
   - Plus rarity points: Common 0, Uncommon 2, Rare 5, Super Rare 7, Legendary 10, Enchanted 12, Promo 6, Special 8
   - The total is clamped to 0–100 and rounded
   - When no catalog price exists, an existing Airtable Market Price (for example one Hekla wrote) is used for ranking
5. **Rules recommendation (the fallback when Gemini isn't used):**
   - *Waitlist:* no price → Hold. Price under $1 → Skip. Cap full → Hold. Base ≥ 55 → List. Base ≥ 30 → Hold. Otherwise → Skip.
   - *Listed:* no price → Watch. Price under $0.25 → Pull. Base ≥ 40 → Keep. Otherwise → Watch.
6. **Gemini adjustment.** This runs only when `GEMINI_API_KEY` is set **and** the catalog found the card.
   - The prompt includes the card facts, the base score, listed count, cap, and slots left.
   - The reply must be JSON matching a fixed schema. `validateGemini` rejects any extra key, a score that isn't an integer from 0 to 100, a recommendation that isn't List/Hold/Skip, or a reason over 140 characters.
   - The final `Auto Rank` is `base + clamp(gemini − base, −20, +20)`.
   - **Waitlist mode only:** if Gemini says List while the cap is full, the result is forced to **Hold** with a "Cap full (n/100)" prefix.
   - If Gemini fails, the rules decision is used and " (rules; AI unavailable)" is added to the reason.
7. **No catalog match:** the result is Hold/Watch, with the reason "No catalog match for this set/number; check entry."
8. **Write.** Only allowlisted fields are written (§5.1). `Market Price USD` is written only when a catalog price exists. Rarity and Resolved Name are written only if they were blank.

**The app never writes Status or Rank Score, and the tests check this.**

### 6.2 Gemini models

| Order | Model | Behaviour |
|---|---|---|
| 1 (primary) | `gemini-3.5-flash-lite` | Tried first, up to 2 attempts |
| 2 (fallback) | `gemini-3.6-flash` | **Over quota (429) on Dustin's Google AI account until billing or plan is checked.** This status comes from the handoff brief. The code can't confirm it. |

- Settings: `responseMimeType: application/json`, `thinkingLevel: low`, `maxOutputTokens: 2048`, 20-second timeout.
- A 400 or 404 skips to the next model. A 429 or 5xx is retried with backoff.
- The code comment above `GEMINI_MODELS` says "call 3.6 directly, fall back to 3.5 Flash-Lite", but the array actually tries Flash-Lite first. The comment is out of date.
- Live evidence: 2 of the 68 Listed reasons carry "(rules; AI unavailable)", so Gemini failed for those two. Whether quota caused it is **Unknown** (check Workers Logs for `gemini error`).

### 6.3 Price and catalog sources by game

| Game | Catalog (preview + type/rarity) | Price used | Notes / limits |
|---|---|---|---|
| Lorcana | Lorcast `api.lorcast.com/v0/cards/{set}/{num}`, then name search | Lorcast `usd` (Normal) or `usd_foil` (Foil/Enchanted) | When the price for the matching finish is missing, the price is left unavailable |
| Magic: The Gathering | Scryfall `/cards/{set}/{num}`, then fuzzy name | Scryfall `usd`, or `usd_foil` with `usd_etched` as a fallback | Set code is lowercased |
| Pokémon | pokemontcg.io v2 `set.id` or `set.ptcgoCode` + number, then name | TCGplayer prices embedded in pokemontcg.io. Foil order: holofoil, reverse, 1st Ed, unlimited. Normal order: normal, unlimited, 1st Ed normal, holofoil. Uses `market`, falling back to `mid`. | Set-code mapping such as SVI → sv1 is not handled explicitly (§10) |
| Yu-Gi-Oh! | YGOPRODeck: set code → name, then `cardinfo.php` | `card_prices[0].tcgplayer_price` | **Card-level price for any printing**, not this specific printing |
| Riftbound | Riftcodex `api.riftcodex.com/cards?set_id=` (scans up to 6 pages), then fuzzy name | **tcgcsv.com TCGplayer market** (category 89): set abbreviation → group → products + prices. Matches by collector number, then by name. Prefers the plain printing. Picks Normal or Foil to match the finish. | New Oct 11. See §6.4. |

### 6.4 Riftbound pricing (tcgcsv): current state

- **The code has landed and is deployed.** `src/tcgcsv.ts` changed at 9:27:03 AM ET. The wrangler deploy at 9:27 AM produced version `3899a4e1…`. A backup taken two minutes earlier (`hekla-intake-backup-1011-0925-rift`) is identical except for the "check finish" mismatch flag added in the final edit.
- `matchPrice` has unit tests covering number-then-finish matching and the no-invention rule.
- **Live result.** The 55 Riftbound Waitlist rows (all VEN) had their `Enriched At` cleared so they would be re-queued. The 9:30 AM cron run re-priced **24 of 55**, all through tcgcsv: 18 "VEN Normal", 5 "VEN Foil", 1 "VEN Foil; only Foil printing exists, check finish". Of those 24, 23 came out **Skip** and 1 came out **List**.
  - The List row is **Sona, Harmonious** (VEN 002, `rec1OLlcT3GPPVGck`): $20.81, Auto Rank 65. It was entered as **Normal**, but TCGplayer only has a Foil printing, so the foil price was used. **Dustin should check the finish before trusting this row.**
- **The other 31 rows were still pending at 9:33 AM.** At 25 rows per run they should finish on the next cron run or two (9:45, maybe 10:00 AM ET). Until then their Price Source still reads the old "price unavailable (no free Riftbound price source)".
- **Limits:**
  - Only the Riftbound category is mapped in `TCGCSV_CATEGORY`.
  - The Set Identifier must equal a tcgcsv abbreviation. On Oct 11 those were OGN, OGS, SFD, UNL, VEN, RAD, SGN, LGC, PR, JDG, OPP, RWB, GRFT, T12025.
  - Prices are tcgcsv's daily republish, cached for 12 hours, so they can be up to about a day old.

### 6.5 Listed re-rank (Keep / Watch / Pull)

- The **Re-rank listed cards** button (`POST /api/enrich-listed`) re-scores every Listed row for the selected game in pages of 20. The cron also processes Listed rows whose `Enriched At` is blank.
- In listed mode the cap rule doesn't force Hold. Gemini is told the card is already listed and is asked which cards are weakest.
- **Current Lorcana result:** all 68 Listed rows were stamped today by the 8:45, 9:00, and 9:15 AM ET cron runs (25, 25, and 18 rows).
  - **62 Pull, 6 Watch, 0 Keep.** Auto Rank ranges from 5 to 43.
  - Weakest: Cruella De Vil – Fashionable Cruiser, The Nokk – Water Spirit, and Painting the Roses Red, all at $0.04 (Auto Rank 10).
  - Strongest: The Return of Hercules, $4.25, Watch, Auto Rank 43.
- **Reconciling with the earlier report.** An earlier report said 50 of 68 were re-ranked (45 Pull, 5 Watch) and 18 were "skipped by the 9:15 cron." The live data now shows 18 rows stamped at 9:15–9:16 AM ET, and every Listed row has today's timestamp. So the 18 appear to have been processed after all. Whether some rows failed in a run and were retried, and why, is **Unknown**: failures are logged only as counts (`cron enrich listed {picked, enriched, failed}`). Retrying and diagnosing this is still on the roadmap (§11).

---

## 7. Branding / UI

| Element | Current state |
|---|---|
| Palette (brand sheet, Oct 10) | Deep Navy `#0A1628` (page background), Slate Blue `#1A365D`, Ice White `#E2E8F0`, Lava Red `#E53E3E`. Also Cool `#4A5568`, Snow `#F7FAFC`, Divider `#2D3748`. These are set as CSS variables in a later block of `app.css`, which overrides an older palette (`#0b1220`, gold `#e8b84a`, and so on) that is still in the file. |
| Type | Inter 400–700 for UI text, JetBrains Mono 400/500 for collector numbers and samples. Both self-hosted WOFF2 in `public/fonts/`. |
| Logo | `hekla-logo-dark.png` (480×522) and `hekla-icon-dark.png` (160×234), cut from a black background. A faint halo around the edges is possible. **A vector SVG of the mountain mark is still needed.** `hekla-wordmark.svg` (labelled "Hekla Card Catalog") is in public/ but not used by index.html. |
| Layout | Sidebar plus compact game tabs (Oct 10 fix). Full-width menu. Breakpoints at 980, 860, and 690 px. A mobile cap meter appears at 860 px and below. |
| Brand source files | `brand/` in the repo (brand sheet pages, logo/lockup PNGs, favicons 16–512) |
| Screenshots | `screenshots/` in the repo (before and after shots at 1280 and 390 px from the Oct 10 layout fix, plus brand, hover and live-after shots). They all predate Clerk sign-in. |
| Mock | `/workspace/hekla-intake-mock/index.html` on the agent box (early mock-up). It is not in the repo. |
| Images | PNG/SVG/ICO only. No AVIF or WebP assets are in the current source. |

---

## 8. Operations

### 8.1 Deploy

Deploys run from Dustin's Windows PC, in PowerShell, from the `source` folder of the clone:

```powershell
Set-Location "E:\Projects\Hekla Intake\source"
npm ci                 # first time, or after dependencies change
npm run check          # typecheck + tests
npx wrangler deploy
```

- `wrangler` is not installed globally; always run it as `npx wrangler` from `source/`. Run from any other folder it fails with "Required Worker name missing".
- If wrangler isn't authenticated, run `npx wrangler login`.
- Commit and push before deploying, so the deployed code always has a copy on GitHub.
- Claude Code is blocked from running production deploys in this project. Dustin runs `npx wrangler deploy` himself; Claude can verify the result afterwards.
- After changing `wrangler.toml`, run `npm run types` to regenerate `worker-configuration.d.ts`.
- The agent box (`/workspace/hekla-intake`) is no longer the place to deploy from. Anything changed there after the 10:00 AM push is not in the repo.

### 8.2 Secrets and config (names only)

| Name | Kind | Set? | Purpose |
|---|---|---|---|
| `AIRTABLE_API_KEY` | Secret | **Yes** | Airtable personal access token. Shared by every tenant today. |
| `CLERK_SECRET_KEY` | Secret | **Yes** | Verifies Clerk sessions on the Worker. Must be the key currently listed in the Clerk dashboard; a deleted or mismatched key makes every API call return 401. |
| `DATABASE_URL` | Secret | **Yes** | Neon Postgres connection string (tenants and audit log) |
| `GEMINI_API_KEY` | Secret | **Yes** | Gemini enrichment |
| `CLERK_PUBLISHABLE_KEY` | Var | Yes (wrangler.toml) | Public by design. Encodes the Clerk instance host. |
| `AIRTABLE_PAT` | Secret (optional) | No | Fallback when `AIRTABLE_API_KEY` is unset |

Removed on Oct 11: `APP_PASSWORD` (deleted from the Worker), and the unused `SESSION_SECRET`, `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` settings. `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE_ID` and `HEKLA_WEBHOOK_URL` are no longer Worker settings; they are columns on the tenant's row in Neon.

To set or rotate a secret, from `source/`: `npx wrangler secret put NAME`, then paste the value at the prompt. A secret change applies to the live Worker immediately and creates a new version. Never commit `.dev.vars` or paste secret values into chat or docs. On Oct 11 a Clerk test secret key was pasted into a chat by mistake; Dustin rotated it.

### 8.3 Cron

- `*/15 * * * *` (UTC schedule, every 15 minutes).
- Each run reads the tenant list from Neon, then does two things for each tenant:
  1. Enriches up to 25 Waitlist rows whose `Enriched At` is blank, across all games.
  2. Enriches Listed rows whose `Enriched At` is blank, with a budget of `max(10, 25 − Waitlist rows enriched)`.
- Failed rows stay pending and are picked again on the next run.
- To re-queue rows, clear `Enriched At` in Airtable.
- Log lines to look for: `cron enrich`, `cron enrich listed` (both now include the tenant id), `cron tenants failed` (Neon unreachable; the run does nothing), `cron enrich failed`, `gemini error`, `enrich failed`, `audit failed`.

### 8.4 Backups on the box

| Path | Taken (ET; times inferred from folder names) | Contents |
|---|---|---|
| `/workspace/hekla-app.css.bak` | Oct 10 (file date) | Older `app.css`, from before the restyle |
| `/workspace/hekla-public-backup-1019` | Oct 10 ~10:19 | `public/` only (app.css, app.js, favicon.svg, wordmark SVG, index.html) |
| `/workspace/hekla-intake-backup-1025` | Oct 10 ~10:25 | Full source. No preview, delete, or enrich code yet. |
| `/workspace/hekla-intake-backup-1036` | Oct 10 ~10:36 | Adds `preview.ts` and `edit.test.ts` |
| `/workspace/hekla-intake-backup-1147` | Oct 10 ~11:47 | Adds delete, `enrich.ts`, and enrich tests |
| `/workspace/hekla-intake-backup-1011-0837` | Oct 11 08:37 | Before the Listed re-rank deploy |
| `/workspace/hekla-intake-backup-1011-0925-rift` | Oct 11 09:25 | Includes `tcgcsv.ts`, but not the final "check finish" tweak |

These backups all sit on the agent box and predate the repo. The off-box copy is now the GitHub repo `dustinholdfast/hekla-intake`. Whether the box copies still exist is **Unknown**.

### 8.5 Recent deployments (Cloudflare versions)

| Deployed (ET) | Version ID |
|---|---|
| Oct 10, 11:47 AM | `296dfe9b-6099-4bd2-b7bb-b3047e64abf4` |
| Oct 10, 12:01 PM | `caf13624-7c56-4d0f-a159-a37aeda44913` |
| Oct 10, 12:20 PM | `402ada90-ab36-4933-919c-7d7ae2c334a4` |
| Oct 11, 8:38 AM | `35cc4ea2-b191-4223-9ca7-994cbfb211a6` (Listed re-rank) |
| Oct 11, 9:26 AM | `ac6e7b46-637f-4706-adf2-d113b2ebcdfa` (tcgcsv, first cut) |
| Oct 11, 9:27 AM | `3899a4e1-d33e-42b3-8ec5-94cf79263959` (tcgcsv + finish flag; last passphrase version) |
| Oct 11, 10:41 AM | `a3e5084d-28a5-47d6-8213-7348711da233` (Clerk sign-in + Neon tenants, commit `4756c16`) |
| Oct 11, 10:49 AM | `c1e1e50b-0b98-4e68-9952-81bdabf9a3c9` (CSP allows Clerk's bot-protection script, commit `40b2de6`) |
| Oct 11, 10:50 AM | `52ed2e0e-5c23-41e4-9cd3-09d3bcf10f9b` (**current**; same code, created by a secret change) |

Secret changes also create versions. Four others from Oct 11 (10:25, 10:30 and 10:47 AM) are omitted here.

### 8.6 Rollback

- **Fast:** `npx wrangler rollback <version-id>` (or `npx wrangler versions deploy`) using an ID from §8.5. Roll back to `a3e5084d` or later only. The passphrase versions (`3899a4e1` and earlier) no longer work as a fallback: `APP_PASSWORD` has been deleted, so they would answer every API call with 503.
- **From source:** check out an earlier commit of the repo, run `npm ci`, then run the deploy steps above.
- **Data isn't rolled back.** Airtable writes such as enrichment fields and prices stay in place, and so do Neon rows. To redo enrichment, clear `Enriched At`.

### 8.7 Testing

- `npm test`: Node's built-in test runner with `--experimental-strip-types`. 22 tests cover:
  - delete guard
  - edit allowlist
  - preview helpers
  - rarity mapping
  - finish-aware price picking
  - rank bounds
  - Gemini allowlist and the ±20 clamp
  - cap override
  - "never writes Status / Rank Score"
  - Listed paging (68 rows)
  - the tcgcsv matcher
  - reading the Clerk host from the publishable key, and rejecting anything that isn't a plain host
  - the "sign-in is configured" check
  - the CSP with and without Clerk
  - the per-tenant env taking base, table and webhook only from the tenant row
- `npm run typecheck` runs `tsc --noEmit`, and `npm run check` runs both. Both passed on Oct 11 at about 10:45 AM ET.
- `npm run dev` starts local wrangler on port 47231. Local secrets need a `.dev.vars` file, which doesn't exist; never commit one.
- **CI runs `npm run check` on GitHub** for every push to `main` and every pull request (first run passed Oct 11). **There is no end-to-end or UI test.** Checked by hand on Oct 11: signed out, the live API returns 401 on every route; Dustin signed in through Clerk and reached the queue. Two inline edits on Oct 11 at 11:52 AM ET each wrote an `edit` row to `audit_log` with Dustin's Clerk user ID. **Not checked:** audit rows for create, merge and delete, and the cron's tenant loop in production logs.

---

## 9. Guardrails

1. **Status is off-limits.** Intake creates rows only as `Waitlist` and never changes Status afterwards. Enrichment throws if Status shows up in its write set.
2. **Rank Score belongs to Hekla.** Intake never writes it. Its own score goes in Auto Rank.
3. **No TCGPlayer calls.** No code path calls TCGPlayer's seller API. The only TCGplayer-related data is read-only market prices from public mirrors (pokemontcg.io, YGOPRODeck, tcgcsv).
4. **No listing, pricing, or buyer messages without Dustin's explicit go.** The Greenlight dialog only sends a note (`listsCards: false`). Listing stays in Hekla, after Dustin approves.
5. **Recommendation is advisory.** It isn't an action.
6. **The cap is respected.** In Waitlist mode, a full L1 cap forces List down to Hold.
7. **Destructive actions are narrow.** Edit and delete work on Waitlist rows only, with record-id checks. Delete asks for confirmation.
8. **Prices are never invented.** A price is written only from a real catalog. Hekla's price is never cleared. Gemini is told never to claim a price that is null.
9. **AI output is fenced.** Gemini output must match a strict schema and allowlist, can move the score by at most ±20, and the cap rule overrides it.
10. **Secrets stay in Cloudflare secrets.** Only names appear in code, docs, or chat.
11. **One tenant can't reach another's cards.** The Airtable base, table and bot webhook come only from the signed-in organization's tenant row. Tests check that Worker-level values are never used in their place.

---

## 10. Known issues and limits

| # | Issue | Impact | Where |
|---|---|---|---|
| 1 | **Resolved Oct 11.** The source is in the private GitHub repo `dustinholdfast/hekla-intake`. Still open: the repo's first commit differs slightly from the 9:27 AM deployment (the page title reads "TCG intake", not "Lorcana intake"), so the box source changed after this document was first written. What else changed is **Unknown**. | Possible unreviewed changes in the source | GitHub |
| 2 | Gemini `gemini-3.6-flash` is over quota (429), per the brief. 2 of the 68 Listed rows fell back to rules. | Lower-quality reasons, and slower retries | `enrich.ts` |
| 3 | **Sona, Harmonious** (VEN 002): its Finish now reads Foil, which matches the Foil-only TCGplayer printing ($20.81), so the List recommendation is consistent. Its Price Source still carries a stale "check finish" note. **Acceleration Gate** (VEN 150) has the same flag and is still entered as Normal while priced from the Foil-only printing ($0.71, Hold). | Could mislead ranking | Airtable `rec1OLlcT3GPPVGck`, `recejB4nyDnBKWxcQ` |
| 4 | 6 of 55 Riftbound rows were still waiting for tcgcsv re-pricing at about 10:00 AM | They show stale "price unavailable" until the cron catches up | cron |
| 5 | The cause of the "18 Listed rows skipped" report is unknown. All 68 now carry today's timestamp. | Possible silent failures. Failures are logged only as counts. | `index.ts` scheduled |
| 6 | Rarity options are Lorcana-shaped (Legendary, Enchanted). Other games are mapped loosely, e.g. Ultra Rare → Special. | Imprecise rarity points for MTG, Pokémon, YGO, and Riftbound | `enrich.ts mapRarity` |
| 7 | Finish options are only Normal, Foil, and Enchanted for every game. Holofoil, Reverse Holo, and Etched aren't in Airtable. | Pokémon reverse holo vs. holo can't be told apart. MTG etched isn't selectable. | `sets.ts`, Airtable Finish |
| 8 | No explicit Pokémon set-code mapping (e.g. SVI → sv1). The resolver only tries `set.id` or `ptcgoCode`. | Some lookups may find nothing | `preview.ts` |
| 9 | Yu-Gi-Oh! prices are card-level (any printing) | Rare printings get mispriced | `enrich.ts` |
| 10 | Inline edits don't re-run enrichment. A Finish change leaves the old price and rank in place until a manual Re-sort. | Stale ranks | `app.js`, `airtable.ts editCard` |
| 11 | Enrichment **overwrites** Market Price USD whenever a catalog price exists, including a price Hekla set | Possible conflict with Hekla's pricing | `enrich.ts` |
| 12 | A qty **merge can target a Listed row**, raising Listed qty past the cap with no warning | Cap meter can exceed 100 | `airtable.ts mergeQty` |
| 13 | Auto Rank (0–100) and Rank Score (0.03–6.86) sit side by side, and the UI shows Auto Rank with Rank Score in a tooltip | Confusing to have two ranks | UI and Airtable |
| 14 | **Mostly resolved Oct 11.** Sign-in is Clerk's, so there is no passphrase endpoint to brute-force. An audit log exists, but it stores only the row after a change (no "before" values) and doesn't cover enrichment. Edits were confirmed landing in the live database on Oct 11. | Thin trail of changes | `index.ts audit`, `tenants.ts` |
| 15 | **Resolved Oct 11.** Cloudflare Access mode was removed. | — | — |
| 16 | Delete is one row at a time, with no undo | Tedious, and mistakes are permanent | `airtable.ts deleteCard` |
| 17 | Queue reads cap out at 2,000 rows (20 pages), and the Airtable throttle is per isolate | Fine at today's 185 rows | `airtable.ts` |
| 18 | Raster logo with a possible halo, and no vector mark | Edges look soft on light or high-DPI backgrounds | `public/` |
| 19 | A stale Gemini comment and an older CSS palette are still in the source. (The `.orig`/`.rej` files were deleted Oct 11.) | Housekeeping noise | `enrich.ts`, `app.css` |
| 20 | No UI or end-to-end tests (CI runs the typecheck and unit tests only). Sign-in was checked by hand once, on desktop only. | Regressions found by hand | — |
| 21 | The L2 unlock path is not modelled in intake (`LISTED_CAP` is fixed at 100) | The cap meter is wrong once L2 unlocks | `sets.ts` |
| 22 | **Clerk is a development instance.** The sign-in form says "Development mode". As far as is known, a Clerk production instance needs a domain Dustin controls, which a `workers.dev` address isn't. | Not suitable for outside sellers as is | Clerk, `wrangler.toml` |
| 23 | **All tenants share one Airtable token.** Isolation relies on each tenant row naming the right base. A second seller with their own Airtable account can't be supported. | Blocks a real second tenant | `airtable.ts tokenOf` |
| 24 | **No self-serve onboarding.** A new tenant is a row inserted into Neon by hand. Anyone can sign up in Clerk and create an organization, but it gets "not set up for intake yet" until that row exists. | Manual work per seller | `tenants` table |
| 25 | No organization switcher inside the app. A user in two organizations has to sign out to change. | Awkward for staff of two shops | `app.js` |
| 26 | The cap (100), the game list, the rank rules and the copy on the sign-in page ("Hekla ranks them") are the same for every tenant. | Other sellers see Hekla-specific behaviour | `sets.ts`, `index.html` |
| 27 | The CSP allows inline styles when Clerk is configured, because Clerk's components need them. | Slightly weaker than the old policy | `auth.ts` |
| 28 | The cron does nothing if Neon is unreachable, and a tenant lookup result (including "no tenant") is cached for 60 seconds per isolate. | A new tenant row can take a minute to work. A Neon outage stops enrichment. | `tenants.ts`, `index.ts scheduled` |

---

## 11. Unenacted improvement phases (prioritized roadmap)

Effort: **S** is under half a day, **M** is 1–2 days, **L** is 3 days or more. Phase 1 is done and phases 5, 11, 12 and 16 changed on Oct 11, as marked. Nothing else has been started. Phases that touch TCGPlayer, listing, or pricing still need Dustin's explicit go before anything goes out.

### Priority 0: protect and unblock (do first)

| # | Phase | Goal | Scope | Effort | Dependencies | Risks |
|---|---|---|---|---|---|---|
| 1 | **Put the source in a GitHub repo** (**done Oct 11**) | End the single-box risk | Done: private repo, `.gitignore`, `.orig`/`.rej` files deleted, `clerk-auth` merged into `main`, and a GitHub Action for `npm run check`. Left over: a README pointing to this handoff. | S | — | — |
| 2 | **Gemini quota / billing** | Get reliable AI adjustments | Check the plan and billing on Dustin's Google AI account. Confirm both models work, or reorder or replace the fallback. Fix the stale comment. Count `gemini error` 429s in the logs. | S | Dustin's access to the Google AI account | Cost. Model names change or get deprecated. |
| 3 | **Riftbound pricing completeness** | Every Riftbound row has a real price or a clear reason why not | Confirm the last 6 VEN rows finish. Resolve the Acceleration Gate finish and re-sort Sona, Harmonious to clear its stale flag. Check other sets (OGN, SFD, UNL, …) and the Set Identifier ↔ tcgcsv abbreviation mapping. Show the "check finish" flag in the UI. Consider using tcgcsv as a fallback for the other games. | S–M | tcgcsv availability | tcgcsv is an unofficial mirror that can change or go away. Prices can be up to a day old. |
| 4 | **Retry skipped / failed Listed rows** | No silent enrichment failures | Log the failed record ids and errors (not just counts). Show a "pending / failed" count in the UI. Add a one-click retry for failed rows. Find the root cause of the 9:15 report. | S | Workers Logs access | Retry loops that keep using up Gemini or Airtable quota |
| 5 | **Sign-in QA** (replaces the passphrase QA) | Confirm Clerk sign-in works end to end on desktop and mobile | Desktop sign-in worked on Oct 11. Still to do: screenshots at 1280 and 390 px, the organization picker, Sign out, and a second user who is not in the organization. | S | Dustin signs in himself | — |
| 6 | **Decide Rank Score vs. Auto Rank** | One clear ranking source of truth | Options: (a) keep both, with Auto Rank labelled advisory; (b) Hekla reads Auto Rank as an input; (c) map Auto Rank onto Hekla's scale. Update UI labels to match. | S (decision) + S–M (build) | Dustin and Hekla's ranking logic | Breaking how Hekla ranks today |

### Priority 1: correctness and safety

| # | Phase | Goal | Scope | Effort | Dependencies | Risks |
|---|---|---|---|---|---|---|
| 7 | **Re-sort the queue after edits** | Ranks stay current after Finish, Condition, or Qty changes | After a successful PATCH, clear `Enriched At` or call `enrichRecord` in the background, then refresh the row | S | — | Extra Gemini calls |
| 8 | **Re-enrich when Hekla writes prices** | Auto Rank reflects Hekla's newer prices | Detect a Market Price change (store the last-seen price or a "Price Updated At" field) and re-queue the row. Decide whether a catalog price may overwrite Hekla's (§10 #11). | M | A new Airtable field (needs Dustin's OK). Agreement with Hekla. | Two writers fighting over the same field |
| 9 | **Rarity options per game** | Accurate rarity for every game | Add options (e.g. Mythic, Ultra Rare, Secret Rare, Showcase, Epic) or a per-game rarity field. Update `RARITIES`, `mapRarity`, and the rank points. | S–M | Airtable schema change (`typecast:false` means the options must exist first) | Messing up existing rows. Stale options. |
| 10 | **Pokémon set-code mapping** | Pokémon lookups resolve reliably | A mapping table of printed or PTCGO codes to pokemontcg.io set ids (e.g. SVI → sv1), used by preview and enrichment. Add tests. | M | A pokemontcg.io sets list | The mapping needs upkeep as new sets release |
| 11 | **Observability** | See failures | The login rate limit is no longer needed (Clerk handles sign-in). Still to do: structured logs for each enrichment outcome, a saved Workers Logs query or dashboard, and an optional alert on cron failures. | S–M | Cloudflare bindings | — |
| 12 | **Audit log** (**first cut done Oct 11**) | A trail of every change intake makes | Done: create, merge, edit and delete are logged to Neon `audit_log` with the Clerk user and the row after the change. Edits confirmed landing in production. Still to do: add "before" values, decide whether to log enrichment, and add a way to read the log in the app. | S–M | — | Storage growth. Could capture personal data if notes are logged. |
| 13 | **Bulk delete / undo** | Safer, faster cleanup | Multi-select delete for Waitlist rows only, with confirmation. Keep a soft-delete or snapshot so changes can be undone within N minutes. | M | Audit log (#12) helps | Deleting the wrong rows. Undo making Status messy. |
| 14 | **Vector logo** | Crisp branding without a halo | Get or trace an SVG of the mountain mark, replace the PNGs in the UI and favicons, and remove the halo | S–M | The brand sheet source art in the repo's `brand/` folder | Tracing errors. Needs Dustin's sign-off on the art. |
| 15 | **Merge-into-Listed guard** | The cap can't be broken from intake | Warn or block when a merge would push Listed qty over the cap | S | — | Getting in the way of legitimate restocks |
| 16 | **Cloudflare Access hardening** (**dropped Oct 11**) | — | Access mode was removed when Clerk replaced the passphrase. | — | — | — |

### Priority 2: experience and growth

| # | Phase | Goal | Scope | Effort | Dependencies | Risks |
|---|---|---|---|---|---|---|
| 17 | **Mobile polish** | Comfortable phone intake | Bigger tap targets. Sticky add bar. Queue rows as cards at 390 px. Touch alternative for the hover preview. | M | QA screenshots (#5) | Desktop layout regressions |
| 18 | **AVIF fallback for old browsers** | Safe if AVIF images are introduced | No AVIF exists in the source today. If logo or brand images move to AVIF, serve them in `<picture>` with a PNG/WebP fallback. | S | The vector logo (#14) may make this unnecessary | Doing work that turns out not to be needed |
| 19 | **L2 unlock path support** | Intake reflects the cap after L2 | Make the cap configurable per game (a var or Airtable setting), show the L1/L2 state, and adjust the cap rule. The L2 criteria come from Hekla. | M–L | Hekla's L2 definition (**Unknown** to intake today) | Mis-stating the cap and over-recommending List |
| 20 | **TCGPlayer listing integration (gated)** | Fewer manual steps, **only with explicit approval** | Probably none in intake. If ever built: a draft-only flow where Hekla prepares listings and Dustin approves each batch explicitly. No automatic listing, pricing, or buyer messages. | L | TCGPlayer seller API access. Dustin's written go. Hekla ownership. | Breaking the core guardrail. Account or policy risk. Pricing mistakes. |
| 21 | **Housekeeping and CI** | A clean, maintainable codebase | Remove the old palette block. Update wrangler. Add basic UI smoke tests (e.g. Playwright against `wrangler dev`). Document `.dev.vars`. | S–M | The repo (#1) | Small style regressions |

### Multi-tenant go-to-market (added Oct 11)

The first step, real accounts and tenant isolation, shipped on Oct 11 (§3.3). These are what remain before a second seller can use the app.

| # | Phase | Goal | Scope | Effort | Dependencies | Risks |
|---|---|---|---|---|---|---|
| 22 | **Clerk production instance and custom domain** | Sign-in fit for outside sellers | Buy or pick a domain, route the Worker to it, create a Clerk production instance, swap the keys, and turn off the `workers.dev` address | S–M | A domain Dustin controls | Locking everyone out during the switch |
| 23 | **Per-tenant card storage** | Each seller's cards are reachable only with that seller's credentials | Either store an encrypted Airtable token per tenant, or move cards into Neon with a `tenant_id` on every row and keep Airtable as an optional sync. Hekla reads Airtable today, so tenant one needs a sync or a bot change if cards move. | M–L | Decision on Airtable vs. Neon. Hekla's owner. | Breaking Hekla's read path |
| 24 | **Per-tenant settings** | Each seller has their own cap, games and bot | Add cap, enabled games and rank thresholds to the tenant row and use them in place of `LISTED_CAP` and the fixed game list. Covers phases 9 and 19 for other sellers. Make the sign-in page copy tenant-neutral. | M | #23 helps | Mis-stating a cap and over-recommending List |
| 25 | **Self-serve onboarding and billing** | A seller can sign up without Dustin | Create the tenant row when a Clerk organization is created (Clerk webhook), a setup screen for the card store, and plan-based billing | L | #22, #23 | Abuse of free sign-ups. Billing mistakes. |
| 26 | **Roles and organization switcher** | Shops with staff | Owner-only greenlight and delete, staff can add and edit, and Clerk's organization switcher in the sidebar | S–M | — | Locking an owner out of their own actions |
| 27 | **Pricing data and AI that can be sold on** | Commercially safe inputs | Check each catalog's commercial-use terms, replace tcgcsv with a licensed source if needed, share the catalog cache across tenants, and meter Gemini calls per tenant | M–L | Legal review of terms | Cost. A source withdrawing access. |

**Suggested order:** 2 → 3 → 4 → 5 → 6, then 7, 15, 11, 9, 10, 8, 12, 13, 14, then the Priority 2 phases. Start the multi-tenant phases with 22 and 23; 24 to 27 depend on them. Phase 20 stays blocked until Dustin explicitly approves it.

---

## Appendix A: Open unknowns

- Why the 18 Listed rows were reported as skipped by the 9:15 cron (they now carry 9:15–9:16 AM timestamps).
- Current Gemini quota and billing state for each model.
- What happened between the Oct 10 report of 78 Waitlist rows and today's 34 Lorcana Waitlist + 28 Skip-status rows.
- Hekla's exact Rank Score formula and its L2 unlock criteria.
- Whether create, merge and delete write rows to `audit_log` in Neon. Only edits have been observed.
- Whether Hekla has a webhook endpoint that could be set as tenant one's `bot_webhook_url`.
- What changed in the box source between the 9:27 AM deployment and the push to GitHub (§10 #1).
- Whether a Clerk production instance can be used without a custom domain (believed not; unconfirmed).
- What the Cloudflare API token on Dustin's PC is allowed to do. It can read deployments and secret names; nothing else was tested.

## Appendix B: Quick reference

| Thing | Value |
|---|---|
| Worker | `hekla-intake` |
| URL | https://hekla-intake.dustin-eef.workers.dev |
| Cloudflare account | `eef14117e342317b606fda458b144e58` |
| Airtable base / table | `app4Tjz72sZtVMQyp` / `tblvHPu7dgDHA91bc` (Lorcana Card Waitlist / Waitlist) |
| Hekla bot id | `4590aafc-366c-4a4c-ac9c-6e3eb8d9968b` |
| Source | GitHub `dustinholdfast/hekla-intake` (private), app in `source/`, branch `main` |
| Local clone | `E:\Projects\Hekla Intake` |
| Clerk instance | `cute-gar-7802.clerk.accounts.dev` (development) |
| Tenant one | Clerk organization `org_3KYI7xB6yJInWU8sf5KbJ6x3mZx`, Neon `tenants.name` = Hekla |
| Tenant database | Neon Postgres, tables `tenants` and `audit_log` |
| Node | Node 24 on Dustin's PC; run wrangler as `npx wrangler` from `source/` |
| Cron | `*/15 * * * *` |
| L1 cap | 100 Listed qty per game (`LISTED_CAP`) |
