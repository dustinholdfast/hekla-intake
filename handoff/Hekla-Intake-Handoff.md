# Hekla Intake: Handoff Document

**Owner:** Dustin Perkins
**Audience:** Dustin, and any future developer or bot that picks up this app
**Prepared:** Sunday, October 11, 2026, about 9:35 AM ET
**Live URL:** https://hekla-intake.dustin-eef.workers.dev
**Source of truth:** `/workspace/hekla-intake` on the shared agent box. There is no GitHub repo.

> **How this was checked.** Everything here was checked against the source code in `/workspace/hekla-intake` (src/, public/, wrangler.toml, package.json, tests), the live Airtable schema and rows (read through the Airtable connector), `wrangler secret list` (names only), `wrangler deployments list`, and the local wrangler logs. No secret values appear in this document. Anything I couldn't confirm is marked **Unknown**.

---

## 1. Executive summary

Hekla Intake is a small private web app. Dustin uses it to type or paste trading cards into the Airtable **Waitlist** table. Hekla, Dustin's Lorcana/TCGPlayer selling bot (Grok Bot id `4590aafc-366c-4a4c-ac9c-6e3eb8d9968b`), reads that table. It runs as one Cloudflare Worker (`hekla-intake`) with a passphrase gate, and it supports five games: Lorcana, Magic: The Gathering, Riftbound, Pokémon, and Yu-Gi-Oh!.

Besides adding cards, the app does advisory **auto-sort**. It looks up each card in a public catalog, records a market price when a real one exists, and writes an **Auto Rank** (0–100) plus a **Recommendation** (List / Hold / Skip). The rank is a fixed rules-based score that Gemini can adjust by up to 20 points. For cards that are already listed, the same values mean **Keep / Watch / Pull**.

The app is deliberately limited. **It never changes Status, never writes Hekla's Rank Score, never posts to TCGPlayer, and never sends buyer messages.** Hekla owns waitlist ranking under the L1 cap (100 listed per game) and the L2 unlock path. Nothing gets listed, priced, or sent to buyers without Dustin's explicit go.

**Status at a glance (Oct 11, about 9:33 AM ET)**

| Item | State |
|---|---|
| Deployed version | `3899a4e1-d33e-42b3-8ec5-94cf79263959`, deployed Oct 11 at 9:27 AM ET. It matches the source on disk. |
| Tests / typecheck | 17 of 17 tests pass. `tsc --noEmit` is clean. |
| Lorcana L1 cap | **Full**: 68 Listed rows, total qty 100 out of 100 |
| Listed re-rank | All 68 Listed rows have an Enriched At from today: **62 Pull, 6 Watch, 0 Keep** |
| Riftbound pricing (tcgcsv) | **Landed and live.** 24 of 55 Riftbound Waitlist rows are re-priced so far. The 15-minute cron is working through the other 31. |
| Biggest risk | The source exists only on one shared box, with no repo and no off-box backup |
| Next actions | Put the source in GitHub. Check Gemini billing. Check the Sona, Harmonious finish (see §10). Decide Rank Score vs. Auto Rank. |

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
| 1 | Dustin | Opens the URL and unlocks it with the passphrase. The session cookie lasts 14 days. |
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
| Data store | Airtable base **Lorcana Card Waitlist** `app4Tjz72sZtVMQyp`, table **Waitlist** `tblvHPu7dgDHA91bc`. Both IDs are set as `[vars]` in wrangler.toml. |
| AI | Google Gemini API (`generativelanguage.googleapis.com/v1beta`), called only during enrichment |
| Catalog / price sources | Lorcast, Scryfall, pokemontcg.io, YGOPRODeck, Riftcodex, and tcgcsv.com (Riftbound prices). See §6. |
| Cache | Cloudflare `caches.default`. Card previews are cached 7 days when found and 6 hours when not. tcgcsv files are cached 12 hours. |
| Cron | `*/15 * * * *` runs `scheduled()`, which enriches pending Waitlist rows, then pending Listed rows |
| Observability | `[observability] enabled = true`, `head_sampling_rate = 1` (Workers Logs) |
| Tooling | wrangler 4.145.0 is installed (4.149.0 is available). TypeScript 5.9. Tests use Node's built-in test runner. |

### 3.2 Source layout

| Path | Purpose |
|---|---|
| `src/index.ts` | Routes, auth middleware, security headers, cron handler, Hekla webhook |
| `src/auth.ts` | Passphrase login, HMAC-signed session cookie, optional Cloudflare Access mode |
| `src/airtable.ts` | Airtable client (throttled to about 1 call per 220 ms, one retry on 429), queue/summary, dedupe, create/merge/edit/delete, enrichment orchestration |
| `src/fields.ts` | Validation, plus the allowlists of fields intake may create or edit and the list it must never write |
| `src/sets.ts` | Games, Lorcana sets, finishes, conditions, rarities, statuses, `LISTED_CAP = 100` |
| `src/parse.ts` | Bulk-paste line parser |
| `src/preview.ts` | Per-game catalog resolvers, plus the image host allowlist used by the CSP |
| `src/enrich.ts` | Price extraction, the rules-based rank, the Gemini prompt and checks on its output, the field write allowlist |
| `src/tcgcsv.ts` | Riftbound TCGplayer market prices from tcgcsv.com (new Oct 11) |
| `src/*.test.ts` | `delete.test.ts`, `edit.test.ts`, `enrich.test.ts` (17 tests in total) |
| `src/*.orig`, `src/*.rej` | Leftovers from an earlier patch: `airtable.ts.orig`, `airtable.ts.rej`, `sets.ts.rej`. They aren't imported. Delete them during cleanup. |
| `public/index.html`, `app.js`, `app.css` | The UI |
| `public/fonts/` | Self-hosted Inter (400–700) and JetBrains Mono (400, 500), WOFF2 |
| `public/hekla-logo-dark.png`, `hekla-icon-dark.png` | Raster logo (480×522) and icon (160×234) used in the UI |
| `public/hekla-wordmark.svg`, favicons | Wordmark SVG (in public/ but not referenced by index.html), plus favicon.svg/.ico/32px and the apple-touch icon |

### 3.3 Authentication

- **Passphrase mode (current).** `POST /api/login` compares SHA-256 digests of the submitted passphrase and `APP_PASSWORD` in constant time. On success it sets the cookie `hekla_session`: HMAC-SHA256 signed, 14-day expiry, HttpOnly, Secure on https, SameSite=Lax.
- **`SESSION_SECRET` is not set.** The signing key is therefore derived from `APP_PASSWORD`, so changing the passphrase signs everyone out.
- **Cloudflare Access mode (available, not enabled).** It turns on when both `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are set. Neither is set today. Caveat: in this mode the code only checks that an Access token or cookie is **present**. It does not verify the token's signature or audience. Don't enable it unless Access actually sits in front of every route, including workers.dev.
- Every `/api/*` route needs a session except `POST /api/login`. If no auth method is configured, the API returns 503.
- Security headers on all responses: CSP (`default-src 'self'`, images allowed only from the catalog hosts), `nosniff`, `referrer-policy: no-referrer`, `x-frame-options: DENY`, and `cache-control: no-store` on API routes.

---

## 4. Endpoints

"Session" means a valid `hekla_session` cookie (or an Access token if Access mode were on). All Airtable access goes through the single Waitlist table.

| Method | Path | Auth | Reads | Writes | Notes |
|---|---|---|---|---|---|
| POST | `/api/login` | Public | `APP_PASSWORD` | Session cookie | 401 on a wrong passphrase, 503 if no passphrase is configured. **No rate limit.** |
| POST | `/api/logout` | Session | — | Clears cookie | |
| GET | `/api/session` | Session | Env | — | Returns the cap, base/table IDs, games, sets, finishes by game, conditions, and rarities for the UI |
| GET | `/api/summary?game=` | Session | Airtable: Status, Qty, Game for that game | — | Listed qty, Waitlist qty, remaining slots, counts by status |
| GET | `/api/queue?status=&game=` | Session | Airtable rows for that status and game | — | Reads at most 20 pages × 100 rows, and sets a `truncated` flag past that |
| POST | `/api/intake` | Session | Airtable duplicate check | **Creates** a Waitlist row, or **merges Qty** into a matching Waitlist **or Listed** row | 409 with the matches when a duplicate needs a choice. Starts background enrichment. |
| POST | `/api/intake/bulk` | Session | Airtable open rows (Waitlist and Listed) for the game | Creates rows in batches of 10, or merges Qty | `mode=preview` or `commit`. Commit needs `onDuplicate` set to skip, merge, or add. Stops at the first write failure. |
| PATCH | `/api/cards/:id` | Session | The row (must be Waitlist) | Finish, Condition, Qty only | Checked against the game's allowed values. Qty 1–999. |
| DELETE | `/api/cards/:id` | Session | The row (must be Waitlist) | **Deletes** the row | The record id must match `rec` + 14 characters. The UI asks for confirmation. **No undo.** |
| GET | `/api/preview?game=&set=&number=&name=` | Session | External catalogs (§6) | Edge cache only | Inputs are capped at 120 characters. Images only from allowlisted hosts. |
| POST | `/api/enrich/:id` | Session | The row (Waitlist or Listed), the catalog, Gemini | Enrichment fields (§5.3) | Per-row "Sort now / Re-sort" |
| POST | `/api/enrich` | Session | Pending Waitlist rows (`Enriched At` blank) | Enrichment fields | Up to 4 rounds of 25 per click |
| POST | `/api/enrich-listed?game=&offset=` | Session | All Listed rows for the game, in record-id order | Enrichment fields (Keep/Watch/Pull) | 20 per page. The client keeps calling with `nextOffset` until done. |
| POST | `/api/hekla` | Session | `HEKLA_WEBHOOK_URL` (if set) | Nothing in Airtable | `action` is `process` or `greenlight`. Posts `{listsCards:false,...}` to the webhook, which must be https. **The webhook isn't set**, so the app returns copy text and a mailto link instead. |
| GET | `*` | Public | Static assets | — | Adds the CSP and other security headers |
| — | `scheduled` (cron) | — | Pending Waitlist rows, then pending Listed rows | Enrichment fields | Batch of 25 Waitlist rows, then Listed rows with a budget of `max(10, 25 − Waitlist rows enriched)` |

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
| Brand source files | `/workspace/hekla-brand/` (brand sheet pages, logo/lockup PNGs, favicons 16–512) |
| Screenshots | `/workspace/hekla-shots/` (before-1280, after-1280, after-390; from the Oct 10 layout fix) |
| Mock | `/workspace/hekla-intake-mock/index.html` (early mock-up) |
| Images | PNG/SVG/ICO only. No AVIF or WebP assets are in the current source. |

---

## 8. Operations

### 8.1 Deploy

```bash
# 1. Node 22. The box has no xz, so use the .tar.gz build.
ls /tmp/node-v22.20.0-linux-x64/bin/node || (
  cd /tmp && curl -LO https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.gz &&
  tar -xzf node-v22.20.0-linux-x64.tar.gz )
export PATH=/tmp/node-v22.20.0-linux-x64/bin:$PATH

# 2. Account
export CLOUDFLARE_ACCOUNT_ID=eef14117e342317b606fda458b144e58

# 3. Check, back up, deploy
cd /workspace/hekla-intake
npm run check                      # typecheck + tests
cp -a /workspace/hekla-intake /workspace/hekla-intake-backup-$(date +%m%d-%H%M)
./node_modules/.bin/wrangler deploy
```

- `/tmp` doesn't survive every box reset. When Node is missing, download it again (the commands above do this). A `.tar.xz` copy also exists in /tmp, but it can't be unpacked without xz.
- Wrangler authenticates through the box's existing wrangler login (`~/.config/.wrangler`). Who that login belongs to, and when it expires, is **Unknown**.

### 8.2 Secrets and config (names only)

| Name | Kind | Set? | Purpose |
|---|---|---|---|
| `AIRTABLE_API_KEY` | Secret | **Yes** | Airtable personal access token for base `app4Tjz72sZtVMQyp` (fixed Oct 1) |
| `APP_PASSWORD` | Secret | **Yes** | Passphrase gate. Also the source of the session signing key. |
| `GEMINI_API_KEY` | Secret | **Yes** | Gemini enrichment |
| `AIRTABLE_PAT` | Secret (optional) | No | Fallback when `AIRTABLE_API_KEY` is unset |
| `SESSION_SECRET` | Secret (optional) | No | A separate cookie signing key |
| `HEKLA_WEBHOOK_URL` | Secret (optional) | No | https webhook for the Hekla notes (notify-only) |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | Vars (optional) | No | Turn on Cloudflare Access mode (see the §3.3 caveat) |
| `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE_ID` | Vars | Yes (wrangler.toml) | `app4Tjz72sZtVMQyp` / `tblvHPu7dgDHA91bc` |

To set or rotate a secret: `./node_modules/.bin/wrangler secret put NAME`. Never commit `.dev.vars` or paste secret values into chat or docs.

### 8.3 Cron

- `*/15 * * * *` (UTC schedule, every 15 minutes).
- Each run does two things:
  1. Enriches up to 25 Waitlist rows whose `Enriched At` is blank, across all games.
  2. Enriches Listed rows whose `Enriched At` is blank, with a budget of `max(10, 25 − Waitlist rows enriched)`.
- Failed rows stay pending and are picked again on the next run.
- To re-queue rows, clear `Enriched At` in Airtable.
- Log lines to look for: `cron enrich`, `cron enrich listed`, `cron enrich failed`, `gemini error`, `enrich failed`.

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

All backups sit on the **same box** as the live source. None of them protects against losing the box.

### 8.5 Recent deployments (Cloudflare versions)

| Deployed (ET) | Version ID |
|---|---|
| Oct 10, 11:47 AM | `296dfe9b-6099-4bd2-b7bb-b3047e64abf4` |
| Oct 10, 12:01 PM | `caf13624-7c56-4d0f-a159-a37aeda44913` |
| Oct 10, 12:20 PM | `402ada90-ab36-4933-919c-7d7ae2c334a4` |
| Oct 11, 8:38 AM | `35cc4ea2-b191-4223-9ca7-994cbfb211a6` (Listed re-rank) |
| Oct 11, 9:26 AM | `ac6e7b46-637f-4706-adf2-d113b2ebcdfa` (tcgcsv, first cut) |
| Oct 11, 9:27 AM | `3899a4e1-d33e-42b3-8ec5-94cf79263959` (**current**, tcgcsv + finish flag) |

### 8.6 Rollback

- **Fast:** `./node_modules/.bin/wrangler rollback <version-id>` (or `wrangler versions deploy`) using an ID from §8.5. Rolling back to `35cc4ea2` removes Riftbound tcgcsv pricing but keeps the Listed re-rank.
- **From source:** copy a backup folder over `/workspace/hekla-intake`. Move `node_modules` across if the backup lacks one, or run `npm ci`. Then run the deploy steps above.
- **Data isn't rolled back.** Airtable writes such as enrichment fields and prices stay in place. To redo enrichment, clear `Enriched At`.

### 8.7 Testing

- `npm test`: Node's built-in test runner with `--experimental-strip-types`. 17 tests cover:
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
- `npm run typecheck` runs `tsc --noEmit`, and `npm run check` runs both. Both passed on Oct 11 at about 9:30 AM ET.
- `npm run dev` starts local wrangler on port 47231. Local secrets need a `.dev.vars` file, which doesn't exist; never commit one.
- **There is no CI and no end-to-end or UI test.** Login with the real passphrase hasn't been QA'd in this document.

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

---

## 10. Known issues and limits

| # | Issue | Impact | Where |
|---|---|---|---|
| 1 | **The source exists only on one shared box.** No repo, and every backup is on the same machine. | Losing the box loses the app source | `/workspace/hekla-intake` |
| 2 | Gemini `gemini-3.6-flash` is over quota (429), per the brief. 2 of the 68 Listed rows fell back to rules. | Lower-quality reasons, and slower retries | `enrich.ts` |
| 3 | **Sona, Harmonious** (VEN 002) is entered as Normal but priced from the Foil-only TCGplayer printing ($20.81). It is the only Riftbound List. | Could mislead ranking | Airtable `rec1OLlcT3GPPVGck` |
| 4 | 31 of 55 Riftbound rows are still waiting for tcgcsv re-pricing (as of 9:33 AM) | They show stale "price unavailable" until the cron catches up | cron |
| 5 | The cause of the "18 Listed rows skipped" report is unknown. All 68 now carry today's timestamp. | Possible silent failures. Failures are logged only as counts. | `index.ts` scheduled |
| 6 | Rarity options are Lorcana-shaped (Legendary, Enchanted). Other games are mapped loosely, e.g. Ultra Rare → Special. | Imprecise rarity points for MTG, Pokémon, YGO, and Riftbound | `enrich.ts mapRarity` |
| 7 | Finish options are only Normal, Foil, and Enchanted for every game. Holofoil, Reverse Holo, and Etched aren't in Airtable. | Pokémon reverse holo vs. holo can't be told apart. MTG etched isn't selectable. | `sets.ts`, Airtable Finish |
| 8 | No explicit Pokémon set-code mapping (e.g. SVI → sv1). The resolver only tries `set.id` or `ptcgoCode`. | Some lookups may find nothing | `preview.ts` |
| 9 | Yu-Gi-Oh! prices are card-level (any printing) | Rare printings get mispriced | `enrich.ts` |
| 10 | Inline edits don't re-run enrichment. A Finish change leaves the old price and rank in place until a manual Re-sort. | Stale ranks | `app.js`, `airtable.ts editCard` |
| 11 | Enrichment **overwrites** Market Price USD whenever a catalog price exists, including a price Hekla set | Possible conflict with Hekla's pricing | `enrich.ts` |
| 12 | A qty **merge can target a Listed row**, raising Listed qty past the cap with no warning | Cap meter can exceed 100 | `airtable.ts mergeQty` |
| 13 | Auto Rank (0–100) and Rank Score (0.03–6.86) sit side by side, and the UI shows Auto Rank with Rank Score in a tooltip | Confusing to have two ranks | UI and Airtable |
| 14 | No rate limit on `/api/login`, and no audit log of edits or deletes | Brute-force exposure. No trail of changes. | `index.ts`, `auth.ts` |
| 15 | Cloudflare Access mode only checks that a token is present; it doesn't verify it | Unsafe if turned on without Access in front of every route | `auth.ts` |
| 16 | Delete is one row at a time, with no undo | Tedious, and mistakes are permanent | `airtable.ts deleteCard` |
| 17 | Queue reads cap out at 2,000 rows (20 pages), and the Airtable throttle is per isolate | Fine at today's 185 rows | `airtable.ts` |
| 18 | Raster logo with a possible halo, and no vector mark | Edges look soft on light or high-DPI backgrounds | `public/` |
| 19 | Leftover `.orig`/`.rej` files, a stale Gemini comment, and an older CSS palette still in `app.css` | Housekeeping noise | `src/`, `app.css` |
| 20 | No CI and no UI or end-to-end tests. Login hasn't been screenshot-QA'd with the real passphrase. | Regressions found by hand | — |
| 21 | The L2 unlock path is not modelled in intake (`LISTED_CAP` is fixed at 100) | The cap meter is wrong once L2 unlocks | `sets.ts` |

---

## 11. Unenacted improvement phases (prioritized roadmap)

Effort: **S** is under half a day, **M** is 1–2 days, **L** is 3 days or more. None of these phases has been started. Phases that touch TCGPlayer, listing, or pricing still need Dustin's explicit go before anything goes out.

### Priority 0: protect and unblock (do first)

| # | Phase | Goal | Scope | Effort | Dependencies | Risks |
|---|---|---|---|---|---|---|
| 1 | **Put the source in a GitHub repo** | End the single-box risk | Create a private repo. Add `.gitignore` (node_modules, .wrangler, .dev.vars). Delete the `.orig`/`.rej` files. Push. Add a README pointing to this handoff. Optionally add a GitHub Action for `npm run check`. | S | Dustin picks the account or org and approves creating the repo | Accidentally committing secrets (none are in the source today, but `.dev.vars` must be ignored) |
| 2 | **Gemini quota / billing** | Get reliable AI adjustments | Check the plan and billing on Dustin's Google AI account. Confirm both models work, or reorder or replace the fallback. Fix the stale comment. Count `gemini error` 429s in the logs. | S | Dustin's access to the Google AI account | Cost. Model names change or get deprecated. |
| 3 | **Riftbound pricing completeness** | Every Riftbound row has a real price or a clear reason why not | Confirm the other 31 VEN rows finish. Resolve the Sona, Harmonious finish. Check other sets (OGN, SFD, UNL, …) and the Set Identifier ↔ tcgcsv abbreviation mapping. Show the "check finish" flag in the UI. Consider using tcgcsv as a fallback for the other games. | S–M | tcgcsv availability | tcgcsv is an unofficial mirror that can change or go away. Prices can be up to a day old. |
| 4 | **Retry skipped / failed Listed rows** | No silent enrichment failures | Log the failed record ids and errors (not just counts). Show a "pending / failed" count in the UI. Add a one-click retry for failed rows. Find the root cause of the 9:15 report. | S | Workers Logs access | Retry loops that keep using up Gemini or Airtable quota |
| 5 | **Login screen QA with the real passphrase** | Confirm the gate works end to end on desktop and mobile | Dustin (or a bot he authorizes) logs in, takes screenshots at 1280 and 390 px, and checks the error message, Lock, and the 14-day cookie | S | Dustin supplies the passphrase in person, never in docs | Passphrase exposure. Do it in a browser session, not in chat. |
| 6 | **Decide Rank Score vs. Auto Rank** | One clear ranking source of truth | Options: (a) keep both, with Auto Rank labelled advisory; (b) Hekla reads Auto Rank as an input; (c) map Auto Rank onto Hekla's scale. Update UI labels to match. | S (decision) + S–M (build) | Dustin and Hekla's ranking logic | Breaking how Hekla ranks today |

### Priority 1: correctness and safety

| # | Phase | Goal | Scope | Effort | Dependencies | Risks |
|---|---|---|---|---|---|---|
| 7 | **Re-sort the queue after edits** | Ranks stay current after Finish, Condition, or Qty changes | After a successful PATCH, clear `Enriched At` or call `enrichRecord` in the background, then refresh the row | S | — | Extra Gemini calls |
| 8 | **Re-enrich when Hekla writes prices** | Auto Rank reflects Hekla's newer prices | Detect a Market Price change (store the last-seen price or a "Price Updated At" field) and re-queue the row. Decide whether a catalog price may overwrite Hekla's (§10 #11). | M | A new Airtable field (needs Dustin's OK). Agreement with Hekla. | Two writers fighting over the same field |
| 9 | **Rarity options per game** | Accurate rarity for every game | Add options (e.g. Mythic, Ultra Rare, Secret Rare, Showcase, Epic) or a per-game rarity field. Update `RARITIES`, `mapRarity`, and the rank points. | S–M | Airtable schema change (`typecast:false` means the options must exist first) | Messing up existing rows. Stale options. |
| 10 | **Pokémon set-code mapping** | Pokémon lookups resolve reliably | A mapping table of printed or PTCGO codes to pokemontcg.io set ids (e.g. SVI → sv1), used by preview and enrichment. Add tests. | M | A pokemontcg.io sets list | The mapping needs upkeep as new sets release |
| 11 | **Rate limiting and observability** | Resist brute force and see failures | Rate-limit `/api/login` (Workers Rate Limiting binding or KV counter). Structured logs for each enrichment outcome. A saved Workers Logs query or dashboard. Optional alert on cron failures. | M | Cloudflare bindings | Locking Dustin out by mistake |
| 12 | **Audit log** | A trail of every change intake makes | Log create, merge, edit, delete, and enrich (who, when, which record, before and after) to an Airtable "Audit" table or D1 | M | A new table (Dustin's OK) | Storage growth. Could capture personal data if notes are logged. |
| 13 | **Bulk delete / undo** | Safer, faster cleanup | Multi-select delete for Waitlist rows only, with confirmation. Keep a soft-delete or snapshot so changes can be undone within N minutes. | M | Audit log (#12) helps | Deleting the wrong rows. Undo making Status messy. |
| 14 | **Vector logo** | Crisp branding without a halo | Get or trace an SVG of the mountain mark, replace the PNGs in the UI and favicons, and remove the halo | S–M | The brand sheet source art in `/workspace/hekla-brand` | Tracing errors. Needs Dustin's sign-off on the art. |
| 15 | **Merge-into-Listed guard** | The cap can't be broken from intake | Warn or block when a merge would push Listed qty over the cap | S | — | Getting in the way of legitimate restocks |
| 16 | **Cloudflare Access hardening (optional)** | Proper SSO, if wanted | Verify the Access JWT (JWKS, audience, expiry) before relying on Access mode. Turn off workers.dev or route it through Access. | M | A Cloudflare Zero Trust setup | Locking everyone out during setup |

### Priority 2: experience and growth

| # | Phase | Goal | Scope | Effort | Dependencies | Risks |
|---|---|---|---|---|---|---|
| 17 | **Mobile polish** | Comfortable phone intake | Bigger tap targets. Sticky add bar. Queue rows as cards at 390 px. Touch alternative for the hover preview. | M | QA screenshots (#5) | Desktop layout regressions |
| 18 | **AVIF fallback for old browsers** | Safe if AVIF images are introduced | No AVIF exists in the source today. If logo or brand images move to AVIF, serve them in `<picture>` with a PNG/WebP fallback. | S | The vector logo (#14) may make this unnecessary | Doing work that turns out not to be needed |
| 19 | **L2 unlock path support** | Intake reflects the cap after L2 | Make the cap configurable per game (a var or Airtable setting), show the L1/L2 state, and adjust the cap rule. The L2 criteria come from Hekla. | M–L | Hekla's L2 definition (**Unknown** to intake today) | Mis-stating the cap and over-recommending List |
| 20 | **TCGPlayer listing integration (gated)** | Fewer manual steps, **only with explicit approval** | Probably none in intake. If ever built: a draft-only flow where Hekla prepares listings and Dustin approves each batch explicitly. No automatic listing, pricing, or buyer messages. | L | TCGPlayer seller API access. Dustin's written go. Hekla ownership. | Breaking the core guardrail. Account or policy risk. Pricing mistakes. |
| 21 | **Housekeeping and CI** | A clean, maintainable codebase | Remove the old palette block. Update wrangler. Add basic UI smoke tests (e.g. Playwright against `wrangler dev`). Document `.dev.vars`. | S–M | The repo (#1) | Small style regressions |

**Suggested order:** 1 → 2 → 3 → 4 → 5 → 6, then 7, 15, 11, 9, 10, 8, 12, 13, 14, then the Priority 2 phases. Phase 20 stays blocked until Dustin explicitly approves it.

---

## Appendix A: Open unknowns

- Why the 18 Listed rows were reported as skipped by the 9:15 cron (they now carry 9:15–9:16 AM timestamps).
- Current Gemini quota and billing state for each model.
- What happened between the Oct 10 report of 78 Waitlist rows and today's 34 Lorcana Waitlist + 28 Skip-status rows.
- Hekla's exact Rank Score formula and its L2 unlock criteria.
- Which Cloudflare user the box's wrangler login belongs to, and when it expires.
- Whether Hekla has a webhook endpoint that could be set as `HEKLA_WEBHOOK_URL`.

## Appendix B: Quick reference

| Thing | Value |
|---|---|
| Worker | `hekla-intake` |
| URL | https://hekla-intake.dustin-eef.workers.dev |
| Cloudflare account | `eef14117e342317b606fda458b144e58` |
| Airtable base / table | `app4Tjz72sZtVMQyp` / `tblvHPu7dgDHA91bc` (Lorcana Card Waitlist / Waitlist) |
| Hekla bot id | `4590aafc-366c-4a4c-ac9c-6e3eb8d9968b` |
| Source | `/workspace/hekla-intake` |
| Node | `/tmp/node-v22.20.0-linux-x64` |
| Cron | `*/15 * * * *` |
| L1 cap | 100 Listed qty per game (`LISTED_CAP`) |
