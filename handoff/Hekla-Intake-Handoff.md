# Hekla Intake: Handoff Document

**Owner:** Dustin Perkins
**Audience:** Dustin, and any future developer or bot that picks up this app
**Rewritten:** Monday, October 12, 2026 (replaces the October 11 morning version, which described a passphrase-gated, TCGplayer-oriented, single-user app)
**Live URL:** https://hekla-intake.dustin-eef.workers.dev
**Source of truth:** private GitHub repo `dustinholdfast/hekla-intake`, branch `main`. The app is in `source/`. Dustin's working clone is `E:\Projects\Hekla Intake`.

> **How this was checked.** Against `main` at commit `91e1743`, the Cloudflare deployment and secret lists (names only), the live site signed out, a read of the Airtable Waitlist table through the Airtable connector on October 12, and read-only calls to CardTrader's API. The Neon database could not be read directly; what is said about its contents comes from results Dustin pasted. No secret values appear here. Anything unconfirmed is marked **Unknown**.

---

## 1. Summary

Hekla Intake is a web app for a trading-card seller. You enter cards, the app prices each one from CardTrader's marketplace and ranks it, and when you approve a batch it lists those cards on your CardTrader account and marks them Listed. Cards live in an Airtable table; accounts, plans, connections and the audit log live in Neon Postgres. It runs as one Cloudflare Worker (`hekla-intake`) and supports Lorcana, Magic: The Gathering, Riftbound, Pokémon and Yu-Gi-Oh!.

The app is multi-tenant in structure: sign-in is Clerk, each seller is a Clerk Organization with a row in Neon, and each seller connects their own CardTrader account. In practice there is one tenant today (Dustin's), and several things still stand between the app and a second seller (§11).

Between October 11 and 12 the app changed direction: it moved off TCGplayer entirely. TCGplayer prices, the 100-card listing cap and every TCGplayer reference were removed, and CardTrader became both the price source and the place cards are listed.

**Status at a glance (October 12)**

| Item | State |
|---|---|
| Code | `main` at `91e1743`. CI green. 42 of 42 tests pass; `tsc --noEmit` is clean. |
| Live | Version `27ebbd58-0560-4433-8119-3aee1aef7963`, deployed October 12 at 6:38 AM ET. No commits since `91e1743`, so it is presumed to be that code. |
| Sign-in | Clerk, development instance. Working. |
| CardTrader | Dustin's account is connected (CardTrader user 606904). The export has been used for real: 293 rows carry a CardTrader Listing ID. |
| Cards | 323 rows. Lorcana: 102 Listed, 28 Skip. Riftbound: 191 Listed, 2 Waitlist. No Magic, Pokémon or Yu-Gi-Oh! rows. |
| Biggest risks | Clerk is a development instance on a `workers.dev` address. Every tenant would share one Airtable token. The old TCGplayer listings may still be live (§11 #1). |
| Next actions | Confirm the TCGplayer listings are down. Decide what the Hekla bot does now. Then the multi-tenant work in §12. |

---

## 2. What it does

### 2.1 Features

- **Quick Add:** one card at a time. Lorcana uses a Set # picker; other games take a free-text set identifier, which must be CardTrader's own code for the set (for example `VEN`). You also enter collector number, finish, condition and quantity. Name, rarity, cost basis, priority and notes are optional.
- **Bulk paste:** up to 100 lines, one card per line as `set, collector #, finish, condition [, qty] [, name]`. Preview first, then commit.
- **Finishes:** Normal, Foil, Enchanted for most games; Normal, Foil, Special for Riftbound.
- **Riftbound numbering:** a plain number such as `006` means the main-set card. Showcase cards are `SP6`, runes are `R06`, alternate art is `019a`. These are different cards that share a number.
- **Duplicate guard:** same game, set, collector number and finish as an existing Waitlist or Listed row. You can merge quantity, add anyway, or cancel.
- **Queue:** filter by game and Status (Waitlist, Listed, Sold, Skip), with search. Waitlist rows can be edited inline (Finish, Condition, Qty) and deleted. An edit re-prices and re-ranks the row in the background.
- **Pricing and ranking:** each card gets a CardTrader market price, an Auto Rank from 0 to 100, and a recommendation (List, Hold or Skip; on Listed rows these read Keep, Watch, Pull). See §6.
- **Scan for changes:** re-checks the CardTrader price of every open card for the selected game and re-ranks the ones that moved. The same scan runs on a rotation every 10 minutes.
- **Export to CardTrader:** check a set of Waitlist cards against CardTrader, review what each would be listed as, then approve. Approved cards are listed, given a CardTrader Listing ID, and moved to Listed. See §7.
- **Settings:** connect or disconnect the account's CardTrader token.
- **Platform admin:** grant or remove complimentary Pro for an account. See §8.
- **Hover preview:** card image and text from the game's public catalog.
- **Hekla notes:** the Greenlight dialog still sends an informational note to the Hekla bot's webhook if one is set. It lists nothing.

### 2.2 Typical workflow

| Step | Who | What happens |
|---|---|---|
| 1 | Seller | Signs in through Clerk and picks an organization if asked |
| 2 | Seller | Adds cards with Quick Add or Bulk paste |
| 3 | App | Creates each row as Waitlist, then prices and ranks it in the background |
| 4 | App (cron) | Every 10 minutes: sorts any unsorted rows, then re-checks prices on one page of 20 rows |
| 5 | Seller | Reviews the queue, fixes mistakes, optionally clicks Scan for changes |
| 6 | Seller | Opens Export to CardTrader, runs the check, unticks anything unwanted, and approves |
| 7 | App | Lists each approved card on CardTrader, saves the listing ID, sets Status to Listed |

---

## 3. Architecture

### 3.1 Components

| Layer | Detail |
|---|---|
| Runtime | Cloudflare Worker `hekla-intake`, account `eef14117e342317b606fda458b144e58`, `compatibility_date = 2026-10-01`, `nodejs_compat` |
| URL | https://hekla-intake.dustin-eef.workers.dev (workers.dev only; no custom domain) |
| Framework | Hono 4 in TypeScript, entry `src/index.ts`. Static UI in `public/`, plain HTML, CSS and JS with no build step. |
| Sign-in | Clerk (`@clerk/hono` on the Worker; ClerkJS 6 and Clerk UI loaded from Clerk's CDN). Development instance `cute-gar-7802.clerk.accounts.dev`. Organizations on. |
| Card data | Airtable. Tenant one: base `app4Tjz72sZtVMQyp`, table **Waitlist** `tblvHPu7dgDHA91bc`. The IDs come from the tenant's row in Neon. |
| Accounts data | Neon Postgres over HTTP (`@neondatabase/serverless`): tenants, plans, connections, audit log |
| Prices and listing | CardTrader API v2, called with each tenant's own token |
| Card catalogs | Lorcast, Scryfall, pokemontcg.io, YGOPRODeck, Riftcodex. Used for name, type, rarity and the hover preview only, never for price. |
| AI | Google Gemini, called only to adjust a rank |
| Cache | Cloudflare `caches.default`: previews (7 days, or 6 hours when not found), CardTrader set list (24 hours), set contents (12 hours), market offers (30 minutes, per tenant) |
| Cron | `*/10 * * * *` |
| Observability | Workers Logs, sampling 1 |
| CI | GitHub Action `Check`: `npm ci` and `npm run check` on pushes to `main` and on pull requests |

### 3.2 Source layout (`source/`)

| Path | Purpose |
|---|---|
| `src/index.ts` | Routes, sign-in and tenant middleware, admin guard, export endpoints, audit calls, cron |
| `src/auth.ts` | Clerk host from the publishable key, "is sign-in configured", platform-admin check, CSP |
| `src/tenants.ts` | Neon client, tenant lookup (cached 60 seconds), per-tenant env, plans, audit writes |
| `src/connections.ts` | Per-tenant connection tokens: encryption, CardTrader token check, storage |
| `src/cardtrader.ts` | CardTrader API client, set and card matching, market price, export preview, listing |
| `src/pricing.ts` | Gets a card's price from CardTrader using the tenant's connection |
| `src/enrich.ts` | Catalog facts, the rules-based rank, the Gemini prompt and its checks, the enrichment write allowlist |
| `src/airtable.ts` | Airtable client, queue and summary, dedupe, create, merge, edit, delete, enrichment runs, re-scan, export reads and the listing write |
| `src/fields.ts`, `src/parse.ts`, `src/sets.ts` | Validation and allowlists, bulk-paste parser, games, sets, finishes, conditions |
| `src/preview.ts` | Per-game catalog resolvers, Riftbound number keys, image host allowlist |
| `src/*.test.ts` | 42 tests: auth, connections, CardTrader, enrichment, edit, delete |
| `public/index.html`, `app.js`, `export.js` | Intake page and the export dialog |
| `public/settings.html`, `settings.js` | Settings page |
| `public/admin.html`, `admin.js` | Platform admin page |
| `public/session.js` | Shared Clerk loader and API helper |
| `db/migrations/0001`–`0004` | Neon schema |

Also in the repo: `brand/` (brand sheet and logo files), `screenshots/` (all from before October 11), and `handoff/`.

### 3.3 Sign-in and tenant isolation

- Every `/api/*` route except `GET /api/config` needs a valid Clerk session (401 without one).
- Outside `/api/admin`, the session must also have an active Clerk Organization (403 `no_org`) with a row in Neon `tenants` (403 `no_tenant`).
- The browser sends a fresh Clerk token as a bearer header on every call.
- Each request runs with a per-tenant env. The Airtable base and table, the bot webhook and the tenant ID come only from the tenant's row; the Worker has no base or table settings to fall back to.
- **Organization admins only** (Clerk role `org:admin`): connecting or disconnecting CardTrader, and sending an export.
- **Platform admins** are a separate list of Clerk user IDs in `PLATFORM_ADMIN_USER_IDS`. Only they can use `/admin`.
- If the Clerk keys or `DATABASE_URL` are missing, the API returns 503.
- The CSP allows Clerk's hosts, its bot-protection hosts, `challenges.cloudflare.com` and inline styles, which Clerk's components need.

### 3.4 Neon tables

| Table | Holds |
|---|---|
| `tenants` | One row per seller: `clerk_org_id`, `name`, Airtable base and table, optional `bot_webhook_url`, and the plan columns (`plan` free or pro, `plan_source` comp or paid, who changed it, when, note) |
| `tenant_connections` | One row per tenant and provider (only `cardtrader` today): the encrypted token, its IV, the account label and ID, who connected and when |
| `audit_log` | `tenant_id`, `clerk_user_id`, `action` (create, merge, edit, delete, connect, disconnect, list), `record_id`, `snapshot`, `created_at` |

Tenant one is Clerk organization `org_3KYI7xB6yJInWU8sf5KbJ6x3mZx`, named "Hekla" in Neon and "The Royal Court of Princess Donut" in Clerk. Users and roles are not mirrored; they live in Clerk.

Connection tokens are encrypted with AES-256-GCM under the `CONNECTIONS_KEY` Worker secret, and each ciphertext is bound to its tenant and provider. A copy of the table alone cannot be used to read a token. **Never change `CONNECTIONS_KEY`:** every stored token would become unreadable.

---

## 4. Endpoints

"Tenant" means a signed-in user with an active organization that has a tenant row.

| Method | Path | Who | What it does |
|---|---|---|---|
| GET | `/api/config` | Public | Clerk publishable key and host for the sign-in page |
| GET | `/api/session` | Tenant | Tenant name, role, plan, platform-admin flag, base and table IDs, games, sets, finishes, conditions, rarities |
| GET | `/api/summary?game=` | Tenant | Listed quantity, Waitlist quantity, counts by Status |
| GET | `/api/queue?status=&game=` | Tenant | Rows for that Status and game (up to 2,000) |
| POST | `/api/intake` | Tenant | Creates a Waitlist row or merges quantity. 409 when a duplicate needs a choice. |
| POST | `/api/intake/bulk` | Tenant | Preview or commit a bulk paste |
| PATCH | `/api/cards/:id` | Tenant | Edits Finish, Condition or Qty on a Waitlist row, then re-prices it |
| DELETE | `/api/cards/:id` | Tenant | Deletes a Waitlist row |
| GET | `/api/preview` | Tenant | Card image and text from the game's catalog |
| POST | `/api/enrich/:id` | Tenant | Re-price and re-rank one row |
| POST | `/api/enrich` | Tenant | Sort unsorted Waitlist rows, up to 100 per click |
| POST | `/api/enrich-listed?game=&offset=` | Tenant | Re-rank Listed rows, 20 per call |
| POST | `/api/rescan?game=&offset=` | Tenant | Re-check prices on open rows, 20 per call |
| GET | `/api/connections` | Tenant | Whether CardTrader is connected and as whom. Never returns the token. |
| PUT | `/api/connections/cardtrader` | Org admin | Checks a pasted token with CardTrader, encrypts and stores it |
| DELETE | `/api/connections/cardtrader` | Org admin | Forgets the token |
| POST | `/api/export/cardtrader/preview` | Tenant | Read-only: what up to 15 cards would be listed as |
| POST | `/api/export/cardtrader/send` | Org admin | Lists up to 15 approved cards and marks them Listed |
| GET | `/api/admin/tenants` | Platform admin | Every tenant with its plan |
| POST | `/api/admin/tenants/:id/plan` | Platform admin | Grants or removes complimentary Pro |
| POST | `/api/hekla` | Tenant | Sends an informational note to the tenant's bot webhook, if set |
| GET | `*` | Public | Static pages, with security headers |
| — | cron | — | See §9.3 |

---

## 5. Airtable data model

Table **Waitlist** in base **Lorcana Card Waitlist**. It is the only table.

| Field | Type | Written by the app |
|---|---|---|
| Card Name (primary) | Text | On create, optional |
| Collector Number | Text | On create |
| Set # | Single select (Lorcana sets) | On create, Lorcana only |
| Set Identifier | Text | On create, other games |
| Game | Single select | On create. Blank is treated as Lorcana. |
| Finish | Single select: Normal, Foil, Enchanted, Special | On create and edit |
| Condition | Single select: NM, LP, MP, HP, DMG | On create and edit |
| Qty | Number | On create, edit and merge |
| Rarity | Single select | On create (optional); by enrichment only if blank |
| Cost Basis USD, Priority, Notes | Currency, number, long text | On create, optional |
| **Status** | Single select: Waitlist, Listed, Sold, Skip | Created as Waitlist. Set to **Listed** when CardTrader confirms a listing. Never otherwise. |
| Resolved Name | Text | By enrichment, only if blank |
| Market Price USD | Currency | By enrichment, only when CardTrader has a price. Never cleared. |
| Price Source | Text | By enrichment. Always starts with "CardTrader". |
| Card Type | Text | By enrichment |
| Auto Rank | Number 0–100 | By enrichment |
| Recommendation | Single select: List, Hold, Skip | By enrichment. Advisory. |
| Rank Reason | Text, 140 characters | By enrichment |
| Enriched At | Date/time | By enrichment. Blank means unsorted; clear it to re-queue a row. |
| **CardTrader Listing ID** | Text | By the export, when a card is listed. Added October 11. |
| Rank Score | Number | Never. It belonged to the Hekla bot. |
| Set Name (legacy) | Single select | Never |

Allowlists are enforced in code, and every write uses `typecast: false`, so a select value that doesn't exist in Airtable fails instead of creating a new option. Adding a finish or rarity means adding the Airtable choice first.

**Snapshot, October 12:** 323 rows. Lorcana 102 Listed and 28 Skip. Riftbound 191 Listed and 2 Waitlist (both recommended Skip). 293 rows have a CardTrader Listing ID.

---

## 6. Pricing and ranking

### 6.1 Price

- **Source:** CardTrader's marketplace, read with the tenant's own connected account. A tenant without a connection gets no price and a Price Source saying so.
- **Rule:** the median of the five cheapest current offers for the same card, finish and condition, English only. One lowball listing cannot set it.
- **Matching:** game, then set (Lorcana set numbers map to CardTrader's codes; other games use the set identifier as typed), then the printed collector number among single cards.
- **No offers:** if nobody is selling that exact card, finish and condition, there is no price. An existing price is kept, and the Price Source ends "kept existing price". Such a row cannot be exported.
- **Single-finish cards:** some cards exist in one finish only (Riftbound rares and above are foil). They are priced whatever Finish the row says, with a "check Finish" note.
- **Pace:** CardTrader asks for about one marketplace call a second, so the app spaces them a second apart.
- **Not supported:** Lorcana promos (set "P" spans several CardTrader sets).

### 6.2 Rank

1. **Base score, 0–100:** a price part (`min(60, 25 × log10(1 + price))`, or 15 with no price), plus margin when a cost basis is set, plus points for condition and rarity.
2. **Rules recommendation.** Waitlist: no price → Hold; under $1 → Skip; base 55 or more → List; 30 or more → Hold; otherwise Skip. Listed: no price → Watch; under $0.25 → Pull; base 40 or more → Keep; otherwise Watch.
3. **Gemini adjustment,** when `GEMINI_API_KEY` is set and the catalog found the card. The reply must match a strict schema and can move the score by at most 20 points. If Gemini fails, the rules decision is used and the reason says so.

There is no listing cap any more. Models are tried in the order `gemini-3.5-flash-lite`, then `gemini-3.6-flash`; the second was reported over quota on October 11 and that has not been re-checked.

### 6.3 Re-scan

A scan looks up each open card's current CardTrader price. A card is re-ranked and rewritten only if its price moved by a cent or more, it was never sorted, or its Price Source doesn't start with "CardTrader". Unchanged cards cost the lookups and nothing else. The button scans every open card for one game; the cron scans one page of 20 per tenant per run and moves to the next page each time.

---

## 7. CardTrader connection and export

### 7.1 Connection

In Settings, an organization admin pastes their CardTrader API token. The Worker checks it with a read-only call, encrypts it, stores it for that tenant, and clears the field. The page then shows only "Connected as …". Connecting and disconnecting are audited.

### 7.2 Export

1. On the Waitlist view, **Export to CardTrader**. Choose the cards recommended List, or everything shown in the queue (the search box acts as the filter). Up to 200 at a time.
2. **Check against CardTrader** (read-only). Each card comes back Ready, with the CardTrader card it matched, condition, finish, quantity and price, or held back with a reason.
3. Untick anything unwanted. **List N cards on CardTrader** shows the total and asks once more.
4. Each listed card gets its CardTrader Listing ID and Status = Listed in one Airtable write, and a `list` row in the audit log.

A card is held back when it isn't on the Waitlist, already has a listing ID, has no price, has a price that isn't from CardTrader, has a name that disagrees with CardTrader's card at that number, has a condition CardTrader doesn't accept, or is entered as Normal for a card that only exists in foil.

Other rules: the price sent is the stored Market Price, unchanged. Conditions map NM → Near Mint, LP → Slightly Played, MP → Moderately Played, HP → Played, DMG → Poor. Every row is re-checked on the server at send time. If CardTrader reports the first listing in a currency other than USD, the app removes that listing and stops. If Airtable can't be updated after a listing succeeds, the dialog says so and asks for the row to be fixed by hand, so the card isn't listed twice.

**What the export does not do:** it doesn't update or remove a listing later, doesn't notice when a card sells, and doesn't move anything to Sold. Repricing a Listed card in the app does not change its price on CardTrader.

---

## 8. Platform admin and plans

`/admin` lists every tenant with its plan. A platform admin can grant or remove **complimentary Pro**, with an optional note. A grant sets `plan = pro` and `plan_source = comp`. The screen never changes a plan whose source is `paid`.

**Pro unlocks nothing yet.** No feature checks the plan. There is no billing, no expiry and no history beyond the latest change.

---

## 9. Operations

### 9.1 Deploy

From Dustin's Windows PC, in PowerShell:

```powershell
Set-Location "E:\Projects\Hekla Intake\source"
npm ci                 # first time, or after dependencies change
npm run check          # typecheck + tests
npx wrangler deploy
```

- `wrangler` is not installed globally. Always run `npx wrangler` from `source/`.
- Commit and push before deploying, so the live code has a copy on GitHub.
- Run any new Neon migration **before** deploying code that depends on it.
- Claude Code is blocked from running production deploys in this project. Dustin deploys; Claude can verify afterwards.
- After changing `wrangler.toml`, run `npm run types`.

### 9.2 Secrets and settings (names only)

| Name | Kind | Purpose |
|---|---|---|
| `AIRTABLE_API_KEY` | Secret | Airtable token. Shared by every tenant today. |
| `CLERK_SECRET_KEY` | Secret | Verifies Clerk sessions. Must be the key currently listed in Clerk. |
| `DATABASE_URL` | Secret | Neon connection string |
| `CONNECTIONS_KEY` | Secret | Encrypts connection tokens. Never change it. |
| `GEMINI_API_KEY` | Secret | Gemini rank adjustment |
| `CLERK_PUBLISHABLE_KEY` | Var | Public. Encodes the Clerk instance. |
| `PLATFORM_ADMIN_USER_IDS` | Var | Clerk user IDs allowed into `/admin` |

To set a secret: `npx wrangler secret put NAME` from `source/`, and paste at the prompt. Never put secret values in chat, files or docs. A file `source/.dev.vars` on Dustin's PC holds a copy of his CardTrader token for local read-only checks; git ignores it, and it can be deleted.

### 9.3 Cron

Every 10 minutes, for each tenant in Neon:

1. Sorts up to 25 unsorted Waitlist rows.
2. Sorts unsorted Listed rows, with a budget of at least 10.
3. Re-scans one page of 20 open rows.

Log lines: `cron enrich`, `cron enrich listed`, `cron rescan`, `cron tenants failed`, `cron enrich failed`, `gemini error`, `enrich failed`, `audit failed`, `admin plan`, `cardtrader send`.

### 9.4 Migrations

Run by hand in Neon's SQL Editor, in order. The first three are confirmed run. Whether `0004` was run is **Unknown**; without it, listings still work but their audit rows fail quietly.

| File | Adds |
|---|---|
| `0001_tenants.sql` | `tenants`, `audit_log`, tenant one |
| `0002_plans.sql` | Plan columns on `tenants` |
| `0003_connections.sql` | `tenant_connections`; audit actions connect and disconnect |
| `0004_audit_list.sql` | Audit action list |

### 9.5 Rollback

`npx wrangler rollback <version-id>`. Do not go back before October 11's Clerk versions: the passphrase secret has been deleted, so older versions answer every API call with 503. Rolling back code does not roll back Airtable, Neon or CardTrader.

### 9.6 Testing

- `npm run check` runs `tsc --noEmit` and 42 tests. CI runs the same.
- There are no end-to-end or UI tests. Features were checked by hand as they shipped.
- Proven in production: Clerk sign-in, tenant lookup, audit writes for edits, the CardTrader connection, CardTrader pricing across every card, and the export (293 listings).

---

## 10. Guardrails

1. **Status changes in one place only.** Rows are created as Waitlist. The only later change the app makes is Waitlist → Listed, after CardTrader confirms a listing. Enrichment throws if Status appears in its write set.
2. **Nothing is listed without approval.** The export lists only the rows an organization admin ticked and confirmed, and re-checks each one on the server.
3. **Prices are never invented.** A price is written only from CardTrader offers for that exact card, finish and condition. An existing price is never cleared.
4. **The export lists only at a CardTrader price.**
5. **Recommendation is advisory.** It never triggers an action.
6. **AI output is fenced:** strict schema, at most ±20 points.
7. **Destructive actions are narrow.** Edit and delete work on Waitlist rows only.
8. **One tenant cannot reach another's cards or CardTrader account.** Base, table, webhook and connection come only from the signed-in tenant.
9. **Tokens stay server-side.** A connection token is encrypted at rest and never returned to the browser.
10. **Secrets stay in Cloudflare secrets.** Only names appear in code, docs or chat.

---

## 11. Known issues and limits

| # | Issue | Impact |
|---|---|---|
| 1 | **The old TCGplayer listings may still be live.** On October 11, 68 Lorcana rows were moved from Listed back to Waitlist in Airtable and have since been listed on CardTrader. Whether they were taken down on TCGplayer is **Unknown**. | A card could sell in two places |
| 2 | **The Hekla bot's role is undefined.** It read this table to rank and list on TCGplayer. Whether it is still running, and what it does with the new Status values, is **Unknown**. | It could act on stale assumptions |
| 3 | **Clerk is a development instance** on a `workers.dev` address. A production instance is believed to need a custom domain. | Not suitable for outside sellers |
| 4 | **All tenants share one Airtable token.** | A second seller with their own base can't be supported |
| 5 | **No self-serve onboarding.** A tenant is a Neon row inserted by hand. Anyone can sign up in Clerk but gets "not set up yet". | Manual work per seller |
| 6 | **Listings are write-once.** No repricing, delisting or sold-sync with CardTrader. | Listed prices drift; sold cards stay Listed |
| 7 | **Listed rows keep being re-priced and re-ranked** by the scan, which changes Airtable but not CardTrader. | The app and CardTrader can disagree on price |
| 8 | **Set identifiers must be CardTrader's codes** outside Lorcana. Lorcana promos aren't supported. Magic, Pokémon and Yu-Gi-Oh! have had almost no real use. | Cards with the wrong code get no price |
| 9 | **Finish and rarity options are coarse.** No reverse holo, etched, or per-game rarities. | Imprecise matching and rank points for some games |
| 10 | **Gemini fallback model may be over quota.** | Some reasons fall back to rules |
| 11 | **Enrichment is slow,** about a second per card, because of CardTrader's pace. | Large scans take minutes |
| 12 | **Pro does nothing,** and there is no billing. | Plans are a label only |
| 13 | **No organization switcher** in the app; no role rules beyond admin-only connect and export. | Awkward for multi-organization users |
| 14 | **Audit log is thin:** the row after a change only, no enrichment, no screen to read it. `list` rows have not been looked at in Neon. | Limited trail |
| 15 | **Copy still says "Hekla"** throughout, and the Greenlight note feature assumes the bot. | Confusing for another seller |
| 16 | **The CSP allows inline styles** for Clerk. | Slightly weaker policy |
| 17 | **Housekeeping:** an older CSS palette and unused cap styles remain in `app.css`; the logo is raster only; ten merged feature branches are still on GitHub; `handoff/Hekla-Intake-Handoff.docx` is the obsolete October 11 version. | Noise |
| 18 | **Queue reads stop at 2,000 rows,** and Airtable throttling is per isolate. | Fine at 323 rows |

---

## 12. Roadmap

Effort: **S** under half a day, **M** one to two days, **L** three days or more.

**Finish the move to CardTrader**

| # | Phase | Scope | Effort |
|---|---|---|---|
| 1 | Confirm TCGplayer is clear | Take down any remaining TCGplayer listings; decide whether the Hekla bot is retired, and remove the Greenlight note feature if so | S |
| 2 | Keep listings in step | Reprice or delist on CardTrader from the app; pull orders (CardTrader has an orders API and webhooks) to mark cards Sold and reduce quantity | L |
| 3 | Lorcana promos and set-code help | Map promo sets; offer a set picker fed from CardTrader's set list for every game | M |
| 4 | Price rule options | Let a tenant choose the rule (for example lowest offer, or a floor) | S–M |

**Make it ready for a second seller**

| # | Phase | Scope | Effort |
|---|---|---|---|
| 5 | Clerk production instance and custom domain | Domain, production keys, turn off the `workers.dev` address | S–M |
| 6 | Per-tenant card storage | An encrypted Airtable token per tenant (the connections table already supports this pattern), or move cards into Neon | M–L |
| 7 | Self-serve onboarding and billing | Create the tenant row when an organization is created; a setup screen; plans that do something | L |
| 8 | Roles and organization switcher | Staff can add and edit; owners list and delete | S–M |
| 9 | Tenant-neutral copy and branding | Remove "Hekla" from shared text | S |

**Quality**

| # | Phase | Scope | Effort |
|---|---|---|---|
| 10 | End-to-end tests | Smoke tests against `wrangler dev` | M |
| 11 | Audit screen and richer audit | Before values, a page to read the log | M |
| 12 | Per-game finishes and rarities | Needs Airtable choices added first | S–M |
| 13 | Housekeeping | Old CSS, merged branches, vector logo, delete the obsolete `.docx` | S |

---

## Appendix A: Open unknowns

- Whether the TCGplayer listings were taken down.
- Whether the Hekla bot is still running and what it does now.
- Whether the live version is exactly `91e1743` (presumed; there are no later commits).
- Whether migration `0004` was run, and so whether `list` (and `connect`) rows are landing in the audit log.
- Current Gemini quota for the fallback model.
- Whether a Clerk production instance can be used without a custom domain.
- What the Cloudflare API token on Dustin's PC is allowed to do beyond reading deployments and secret names.

## Appendix B: Quick reference

| Thing | Value |
|---|---|
| Worker | `hekla-intake` |
| URL | https://hekla-intake.dustin-eef.workers.dev |
| Pages | `/` intake, `/settings`, `/admin` |
| Cloudflare account | `eef14117e342317b606fda458b144e58` |
| Repo | GitHub `dustinholdfast/hekla-intake` (private), app in `source/`, branch `main` |
| Local clone | `E:\Projects\Hekla Intake` |
| Airtable base / table | `app4Tjz72sZtVMQyp` / `tblvHPu7dgDHA91bc` |
| Clerk instance | `cute-gar-7802.clerk.accounts.dev` (development) |
| Tenant one | Clerk organization `org_3KYI7xB6yJInWU8sf5KbJ6x3mZx` |
| Platform admin | Clerk user `user_3KYHxnl1WPPJkOIR8PQhr8gzOxD` |
| CardTrader | User 606904; game IDs Lorcana 18, Riftbound 22, Magic 1, Pokémon 5, Yu-Gi-Oh! 4 |
| Cron | `*/10 * * * *` |
| Hekla bot id | `4590aafc-366c-4a4c-ac9c-6e3eb8d9968b` |

## Appendix C: What changed on October 11–12

| Commit | Change |
|---|---|
| `ad5b64b` | Source imported to GitHub from the shared agent box |
| `eb7ebd2` | Clerk sign-in and Neon tenants replace the passphrase gate |
| `ed0a291` | CI |
| `3fa716b` | Platform admin and complimentary Pro |
| `2ae5ef5` | Scan for changes, every 10 minutes or on demand |
| `5f5e12c` | Riftbound number prefixes (006, SP6 and R06 are different cards) |
| `70a3ddb` | Riftbound finishes: Normal, Foil, Special |
| `edb7974` | Per-account CardTrader connection |
| `133a807` | CardTrader export |
| `23d0c1f` | A confirmed listing sets Status to Listed |
| `91e1743` | CardTrader pricing; listing cap and TCGplayer removed |
