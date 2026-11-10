import { clerkMiddleware, getAuth } from "@clerk/hono";
import { Hono, type Context } from "hono";
import {
  AirtableError,
  readStock,
  inventoryStock,
  reconcileRows,
  stockCardsByIds,
  writeStock,
  writeTcgplayerSku,
  cardsForExport,
  createCards,
  deleteCard,
  editCard,
  enrichListedPage,
  enrichPending,
  enrichPendingListed,
  enrichRecord,
  duplicatesAmong,
  findDuplicates,
  listByStatus,
  listOpenPrintings,
  mergeQty,
  recordCardTraderListing,
  rescanPage,
  rescanSlotOffset,
  summary,
  toQueueCard,
  type QueueCard, createRecordRaw, deleteRecordRaw, getRecordRaw, patchRecordFields, restorableFields } from "./airtable.ts";
import { authConfigured, clerkFrontendApi, contentSecurityPolicy, isPlatformAdmin } from "./auth.ts";
import { appInfo, CardTraderError, createProduct, deleteProduct, expansionsFor, exportListings, incrementListing, magicFinishesFor, previewExport, resolveMagicDraft, setWebhookUrl, type CtListing } from "./cardtrader.ts";
import { cleanToken, ConnectionError, connectionSecret, connectionSettings, connectionsReady, connectionStatus, deleteConnection, saveConnection, verifyCardTrader } from "./connections.ts";
import { sendEmail, validFrom, validTo } from "./alerts.ts";
import { newSecret, verifyCardTraderSignature, verifyStarfoil } from "./hmac.ts";
import { readSalesFilter, salesCsv, totalsByPlatform } from "./sales.ts";
import { getState, listSales, setState } from "./salesdb.ts";
import { onHand, WAITLIST_BASE_ID, type BuyListInput, type InventoryFilter, type MovementDraft, type WaitlistInput } from "./inventory.ts";
import { buildLiveDetail, buildLiveInventory, InventoryReadError } from "./live-inventory.ts";
import { isMissingLedger, isMissingPhase2Settings, listMovements, readInventorySettings, readThresholds, saveInventorySettings } from "./inventorydb.ts";
import { applyReceiveWrites, fetchSellRequest, matchLines, planAcceptance, planReceipt, draftRedemption, splitCardList, type CatalogLine, type SellRequestView } from "./purchases.ts";
import { purchasesAllowed } from './purchase-access.ts';
import { PurchaseSafetyError, purchaseDatabase, requirePurchaseSafety } from './purchase-safety.ts';
import { customerBalance, isMissingPurchases, listCredit, loadPurchase, readLiability, saveAcceptance, saveReceipt, saveRedemption } from "./purchasesdb.ts";
import { presentSettings, SettingsError, validateInventorySettings } from "./inventory-settings.ts";
import { loadBuyList } from "./opening.ts";
import { claimRestore, confirmedMatches, confirmMatch, finishRestore, getRecordSnapshot, latestSnapshot, listRecordSnapshots, logAction, markSnapshotApplied, recentActions, removeMatch, saveRecordSnapshot, saveSnapshot, type ReconAction } from "./recondb.ts";
import { ARCHIVE_FIELDS, CLEANUP_BATCH, CLEANUP_REASON, planCleanup, previewJson, runCleanupBatch, type ApplyGroup, type RemoveMode } from "./cleanup.ts";
import { reconcileSummary, type ReconcileReport } from "./reconcile.ts";
import { parseTcgExport } from "./tcgcsv.ts";
import { groupMagicSets, refreshScryfallStore, scryfallIndexWithSource, setIconSvg, withIcons, type ScryfallSet, type ScryfallStore } from "./scryfall.ts";

/** Bump when /api/sets changes shape; the browser drops cached lists of another shape. */
export const SETS_SHAPE = 4;
const SCRYFALL_STATE_KEY = "scryfall:sets";
/** Scryfall's public set list is global; it is kept as one sync_state row (under the oldest tenant). */
function scryfallStore(env: Env): ScryfallStore | null {
  if (!env.DATABASE_URL?.trim()) return null;
  return {
    async load() {
      const rows = await db(env).query("select value, updated_at from sync_state where key = $1 order by updated_at desc limit 1", [SCRYFALL_STATE_KEY]);
      const v = rows[0]?.value as { sets?: ScryfallSet[] } | undefined;
      return v && Array.isArray(v.sets) ? { sets: v.sets, at: new Date(String(rows[0]!.updated_at)).getTime() } : null;
    },
    async save(sets) {
      await db(env).query(
        `insert into sync_state (tenant_id, key, value, updated_at)
         select id, $1, $2::jsonb, now() from tenants order by created_at limit 1
         on conflict (tenant_id, key) do update set value = excluded.value, updated_at = now()`,
        [SCRYFALL_STATE_KEY, JSON.stringify({ sets })],
      );
    },
  };
}
import { applyCtChanges, applyPending, buildView, expectedQty, filterView, livePending, planCardTraderSet, planReconcileAll, RECONCILE_BATCH, runCtBatch, tcgplayerAdjustCsv, viewCounts, viewCsv, type BatchItem, type PendingTcg, type ViewFilter } from "./threeway.ts";
import { allocationsEnabled, clearAllocationRow, handleAllocation, productionAllocationDeps, resolveStaleRow, sweepStaleAllocations, takeRowLease, type RowLease } from "./allocations.ts";
import { neonAllocationAlerts, neonAllocationStore } from "./allocationsdb.ts";
import { withListableQuantity } from "./listable.ts";
import { cronJobs, dailyEmailOn, decrementFrom, handleCardTraderEvent, ingestStarfoil, pollCardTrader, reconcileMode, runDecrements, runReconcile, salesMode, sendDailyPull, tcgplayerPull } from "./sync.ts";
import { checklistCsv, tcgplayerCsv } from "./tcgplayer.ts";
import { parseDraft, parseIntakeBody, type DraftCard } from "./fields.ts";
import { MAGIC_FALLBACK_FINISHES } from "./magic-finish.ts";
import { PREVIEW_IMAGE_HOSTS, resolvePreview, riftboundNumberKey } from "./preview.ts";
import { parseBulk, type ParsedRow } from "./parse.ts";
import { canonicalGame, CONDITIONS, effectiveGame, FINISHES, FINISHES_BY_GAME, GAMES, isStatus, RARITIES, SETS, type Game } from "./sets.ts";
import { assetVersion, versionedUrl } from "./assets.ts";
import { pageAssetRequest } from "./pages.ts";
import { db, listTenantPlans, listTenants, recordAudit, setCompPlan, tenantById, tenantEnv, tenantForOrg, type AuditAction, type Tenant } from "./tenants.ts";

type Variables = { tenant: Tenant; tenantEnv: Env; userId: string; orgRole: string | null };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  c.header("x-frame-options", "DENY");
});

app.use("/api/*", async (c, next) => {
  c.header("cache-control", "no-store");
  await next();
});

// Signed by the deckbuilder (X-Alloc-Signature). Registered before Clerk so it is not a user session.
app.post("/api/allocations", async (c) => {
  const body = await rawBody(c);
  const result = await handleAllocation(c.env, body, c.req.header("x-alloc-timestamp") ?? null, c.req.header("x-alloc-signature") ?? null, productionAllocationDeps(c.env));
  return c.json(result.body, result.status as 200);
});

// Public: the sign-in page needs these before anyone has a session. Neither value is secret.
app.get("/api/config", (c) => {
  const clerkPublishableKey = c.env.CLERK_PUBLISHABLE_KEY?.trim() || null;
  return c.json({ clerkPublishableKey, clerkFrontendApi: clerkFrontendApi(c.env.CLERK_PUBLISHABLE_KEY) });
});

app.use("/api/*", async (c, next) => {
  if (!authConfigured(c.env)) {
    return c.json({ error: "Set CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, and DATABASE_URL before using intake." }, 503);
  }
  return clerkMiddleware({ secretKey: c.env.CLERK_SECRET_KEY, publishableKey: c.env.CLERK_PUBLISHABLE_KEY })(c, next);
});

// Every route below runs as one signed-in user. Outside /api/admin it also runs inside one tenant
// (their active Clerk Organization); the admin routes act across tenants and are guarded separately.
app.use("/api/*", async (c, next) => {
  const auth = getAuth(c);
  if (!auth.userId) return c.json({ error: "Sign in required." }, 401);
  c.set("userId", auth.userId);
  if (c.req.path.startsWith("/api/admin/")) return next();
  if (!auth.orgId) return c.json({ error: "Choose an organization to continue.", code: "no_org" }, 403);
  const tenant = await tenantForOrg(c.env, auth.orgId);
  if (!tenant) return c.json({ error: "This organization has not been set up for intake yet.", code: "no_tenant" }, 403);
  if ((c.req.path === '/api/purchases' || c.req.path.startsWith('/api/purchases/')) && !purchasesAllowed(tenant)) {
    return c.json({ error: 'Purchasing is available only for the shop whose Airtable purchase tables are configured.', code: 'purchases_unavailable' }, 403);
  }
  c.set("tenant", tenant);
  c.set("tenantEnv", tenantEnv(c.env, tenant));
  c.set("orgRole", auth.orgRole ?? null);
  await next();
});

app.use("/api/admin/*", async (c, next) => {
  if (!isPlatformAdmin(c.env, c.var.userId)) return c.json({ error: "Platform admins only." }, 403);
  await next();
});

app.get("/api/admin/tenants", async (c) => {
  return c.json({ tenants: await listTenantPlans(c.env) });
});

// Settles a Waitlist row blocked by an allocation write whose answer was never recorded (row_busy). Re-checks the
// retry proof against CardTrader now: landed releases the row; anything it cannot prove is a 409 for a manual
// check. It never sends a CardTrader write. Works with ALLOCATIONS_ENABLED off, so a row is never stuck.
app.post("/api/admin/allocations/clear", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const result = await clearAllocationRow(productionAllocationDeps(c.env), String(body.value.waitlist_record_id ?? ""), c.var.userId);
  return c.json(result.body, result.status as 200);
});

const missingAllocationTables = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /allocation_results|allocation_row_locks|sync_state/.test(message) && /does not exist/.test(message);
};

// Owner alerts: every stored ct_retry_unverifiable (an allocation write Hekla could not prove landed and did not send
// again), newest first, until an admin marks it checked. The listing may be too high or too low; reconcile is off.
app.get("/api/admin/allocations/alerts", async (c) => {
  const tenant = await productionAllocationDeps(c.env).tenant();
  if (!tenant) return c.json({ alerts: [], note: "allocations_tenant_missing" });
  try { return c.json({ alerts: await neonAllocationAlerts(c.env).open(tenant.id) }); }
  catch (error) {
    if (missingAllocationTables(error)) return c.json({ alerts: [], note: "allocation tables not migrated" });
    throw error;
  }
});

// Live preflight: POST /api/allocations refuses every request until this is ready (alert email on and set up).
app.get("/api/admin/allocations/preflight", async (c) => {
  const deps = productionAllocationDeps(c.env);
  const tenant = await deps.tenant();
  const missing = tenant ? await deps.preflight(tenant.id) : ["no shop tenant"];
  return c.json({ allocationsEnabled: allocationsEnabled(c.env), ready: missing.length === 0, missing });
});

app.post("/api/admin/allocations/alerts/ack", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const key = typeof body.value.key === "string" ? body.value.key : "";
  if (!key || key.length > 200) return c.json({ error: "key is required." }, 400);
  const tenant = await productionAllocationDeps(c.env).tenant();
  if (!tenant) return c.json({ error: "allocations_tenant_missing" }, 503);
  if (!(await neonAllocationAlerts(c.env).ack(tenant.id, key, c.var.userId))) return c.json({ error: "No open alert for that key." }, 404);
  console.log(JSON.stringify({ event: "allocation_alert_checked", key, by: c.var.userId }));
  return c.json({ ok: true });
});

app.post("/api/admin/tenants/:id/plan", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return c.json({ error: "That is not a tenant id." }, 400);
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const plan = body.value.plan;
  if (plan !== "pro" && plan !== "free") return c.json({ error: "Plan must be pro or free." }, 400);
  const note = typeof body.value.note === "string" ? body.value.note.trim().slice(0, 280) || null : null;
  const tenant = await setCompPlan(c.env, id, plan, c.var.userId, note);
  if (!tenant) return c.json({ error: "No tenant was changed. It may not exist, or it is on a paid plan." }, 404);
  console.log("admin plan", JSON.stringify({ tenant: tenant.id, plan, by: c.var.userId }));
  return c.json({ tenant });
});

app.get("/api/session", (c) => {
  return c.json({
    ok: true,
    via: "clerk",
    tenant: c.var.tenant.name,
    role: c.var.orgRole,
    plan: c.var.tenant.plan,
    platformAdmin: isPlatformAdmin(c.env, c.var.userId),
    baseId: c.var.tenant.airtableBaseId,
    tableId: c.var.tenant.airtableTableId,
    games: GAMES,
    sets: SETS,
    finishes: FINISHES,
    finishesByGame: FINISHES_BY_GAME,
    conditions: CONDITIONS,
    rarities: RARITIES,
    conditionLabels: {
      NM: "Near Mint",
      LP: "Lightly Played",
      MP: "Moderately Played",
      HP: "Heavily Played",
      DMG: "Damaged",
    },
  });
});

// Connections: each tenant links its own outside accounts. Only an organization admin may change them,
// and a stored token is never returned to the browser.
const canManageConnections = (c: AppContext) => c.var.orgRole === "org:admin";

app.get("/api/connections", async (c) => {
  return c.json({ ready: connectionsReady(c.env), canManage: canManageConnections(c), cardtrader: await connectionStatus(c.env, c.var.tenant.id, "cardtrader") });
});

app.put("/api/connections/cardtrader", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can connect CardTrader." }, 403);
  if (!connectionsReady(c.env)) return c.json({ error: "Connections are not set up on this server yet (CONNECTIONS_KEY is missing)." }, 503);
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const token = cleanToken(body.value.token);
  if (!token) return c.json({ error: "Paste the CardTrader API token on one line." }, 400);
  const account = await verifyCardTrader(token);
  if (!account.ok) return c.json({ error: account.error }, 400);
  await saveConnection(c.env, c.var.tenant.id, "cardtrader", token, account, c.var.userId);
  audit(c, "connect", [{ id: "cardtrader" }]);
  return c.json({ cardtrader: await connectionStatus(c.env, c.var.tenant.id, "cardtrader") });
});

app.delete("/api/connections/cardtrader", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can disconnect CardTrader." }, 403);
  if (await deleteConnection(c.env, c.var.tenant.id, "cardtrader")) audit(c, "disconnect", [{ id: "cardtrader" }]);
  return c.json({ cardtrader: { connected: false } });
});

// CardTrader export. Preview is read-only. Send lists cards for sale, so it is limited to organization
// admins and to the batch they just reviewed; every row is re-checked on the server before it is sent.
const EXPORT_BATCH = 15;

function readRecordIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > EXPORT_BATCH) return null;
  return value.every((id) => typeof id === "string") ? value as string[] : null;
}

async function cardTraderToken(c: AppContext): Promise<string> {
  const token = await connectionSecret(c.env, c.var.tenant.id, "cardtrader");
  if (!token) throw new ConnectionError("Connect CardTrader in Settings first.", 409);
  return token;
}

// The sets the intake form offers for a game. Lorcana uses its Set # list; every other game's Set Identifier is
// CardTrader's expansion code (the same codes blueprint lookup and enrichment use), cached 24 h with the catalogue.
app.get("/api/sets", async (c) => {
  const game = canonicalGame(c.req.query("game") ?? "");
  if (!game) return c.json({ error: "Unknown game." }, 400);
  if (game === "Lorcana") return c.json({ game, source: "hekla", shape: SETS_SHAPE, complete: true, sets: SETS.map((s) => ({ code: s.id, name: s.name })) });
  const token = await connectionSecret(c.env, c.var.tenant.id, "cardtrader");
  if (!token) return c.json({ game, source: "none", shape: SETS_SHAPE, complete: false, sets: [], hint: "Connect CardTrader in Settings to get the set list." });
  try {
    const sets = await expansionsFor(token, game);
    if (game !== "Magic: The Gathering") return c.json({ game, source: "cardtrader", shape: SETS_SHAPE, complete: true, sets });
    // Magic: Scryfall set symbols and core-first grouping. Scryfall's list comes from the edge cache or the copy
    // stored in Neon; only when neither exists is the list sent bare, marked incomplete so the browser won't keep it.
    let found;
    try { found = await scryfallIndexWithSource({ store: scryfallStore(c.env) }); }
    catch (error) {
      console.error("SET SYMBOLS UNAVAILABLE: Magic list sent without symbols or grouping", JSON.stringify({ error: String(error), total: sets.length }));
      return c.json({ game, source: "cardtrader", shape: SETS_SHAPE, complete: false, sets, icons: { matched: 0, total: sets.length }, hint: "Set symbols are unavailable right now; Hekla will retry shortly." });
    }
    const { sets: withSymbols, matched } = withIcons(sets, found.index);
    // Core sets first (oldest → Reality Fracture), then a divider, then the rest newest first.
    const grouped = groupMagicSets(withSymbols, found.index);
    const coreSets = grouped.sets.slice(0, grouped.core);
    const fra = withSymbols.filter((s) => /reality fracture/i.test(s.name)).map((s) => `${s.code}=${s.name}`);
    console.log("set symbols", JSON.stringify({
      game, matched, total: sets.length, core: grouped.core, coreEnd: grouped.end, scryfall: found.source, scryfallAgeHours: Math.round((Date.now() - found.at) / 3600_000),
      coreTail: coreSets.slice(-3).map((s) => s.code), ctRealityFracture: fra,
      unmatchedSample: withSymbols.filter((s) => !s.icon).slice(0, 25).map((s) => `${s.code}=${s.name}`),
    }));
    return c.json({ game, source: "cardtrader", shape: SETS_SHAPE, complete: true, sets: grouped.sets, icons: { matched, total: sets.length }, core: { count: grouped.core, end: grouped.end } });
  } catch (error) {
    if (error instanceof CardTraderError) return c.json({ game, source: "none", sets: [], hint: "CardTrader's set list is unavailable right now; type the set code." });
    throw error;
  }
});

/** Finishes CardTrader sells for one Magic card. Read-only. Lorcana and Riftbound do not use this. */
app.get("/api/magic-finishes", async (c) => {
  const set = (c.req.query("set") ?? "").trim();
  const number = (c.req.query("number") ?? "").trim();
  const fallback = [...MAGIC_FALLBACK_FINISHES];
  if (!set || !number) return c.json({ ok: false, options: [], fallback, hint: "Enter a set and collector number to load this card's CardTrader finishes." });
  const token = await connectionSecret(c.env, c.var.tenant.id, "cardtrader");
  if (!token) return c.json({ ok: false, options: [], fallback, hint: "Connect CardTrader in Settings to load this card's finishes." });
  try {
    const found = await magicFinishesFor(token, set, number);
    if (!found.options.length) return c.json({ ok: false, options: [], fallback, cardName: found.cardName, hint: found.reason ?? "CardTrader has no finishes for this card." });
    return c.json({
      ok: true,
      cardName: found.cardName,
      options: found.options.map(({ finish, label, blueprintId, foil, collectorNumber }) => ({ finish, label, blueprintId, foil, collectorNumber })),
    });
  } catch (error) {
    if (error instanceof CardTraderError) return c.json({ ok: false, options: [], fallback, hint: "CardTrader's finishes are unavailable right now. Normal and Foil still work." });
    throw error;
  }
});

app.post("/api/export/cardtrader/preview", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const ids = readRecordIds(body.value.recordIds);
  if (!ids) return c.json({ error: `Send 1 to ${EXPORT_BATCH} record ids.` }, 400);
  const token = await cardTraderToken(c);
  const rows = await previewExport(token, withListableQuantity(await cardsForExport(c.var.tenantEnv, ids)));
  return c.json({ canSend: canManageConnections(c), rows: rows.map((row) => (row.ready ? { ...row, product: undefined } : row)) });
});

app.post("/api/export/cardtrader/send", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can list cards on CardTrader." }, 403);
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const ids = readRecordIds(body.value.recordIds);
  if (!ids) return c.json({ error: `Send 1 to ${EXPORT_BATCH} record ids.` }, 400);
  const token = await cardTraderToken(c);
  const rows = await previewExport(token, withListableQuantity(await cardsForExport(c.var.tenantEnv, ids)));
  const results: { id: string; name: string; listed: boolean; listingId?: number; price?: number; reason?: string; warning?: string }[] = [];
  let stopped: string | null = null;
  for (const row of rows) {
    if (stopped) { results.push({ id: row.id, name: row.name, listed: false, reason: stopped }); continue; }
    if (!row.ready) { results.push({ id: row.id, name: row.name, listed: false, reason: row.reason }); continue; }
    try {
      const listing = await createProduct(token, row.product);
      if (listing.currency !== "USD") {
        // Prices here are US dollars. If the account prices in anything else, undo and stop before listing more.
        const removed = await deleteProduct(token, listing.productId).then(() => true, () => false);
        stopped = `Your CardTrader account prices in ${listing.currency || "another currency"}, not USD, so nothing was listed.`;
        results.push({ id: row.id, name: row.name, listed: false, reason: removed ? stopped : `${stopped} Listing ${listing.productId} could not be removed; delete it on CardTrader.` });
        continue;
      }
      const result: (typeof results)[number] = { id: row.id, name: row.name, listed: true, listingId: listing.productId, price: row.price };
      try { await recordCardTraderListing(c.var.tenantEnv, row.id, listing.productId); }
      catch { result.warning = `Listed as ${listing.productId}, but Airtable could not be updated. Set this row to Listed and add the listing id by hand so it is not listed twice.`; }
      results.push(result);
      audit(c, "list", [{ id: row.id, marketplace: "cardtrader", listingId: listing.productId, blueprintId: row.product.blueprint_id, price: row.price, quantity: row.quantity } as { id: string }]);
    } catch (error) {
      const reason = error instanceof CardTraderError ? error.message : "Could not list this card.";
      results.push({ id: row.id, name: row.name, listed: false, reason });
      if (error instanceof CardTraderError && (error.status === 401 || error.status === 429)) stopped = "Stopped after an earlier CardTrader error.";
    }
  }
  console.log("cardtrader send", JSON.stringify({ tenant: c.var.tenant.id, by: c.var.userId, asked: ids.length, listed: results.filter((r) => r.listed).length }));
  return c.json({ results });
});

app.get("/api/summary", async (c) => {
  const game = readGame(c.req.query("game"));
  if (!game) return c.json({ error: gameError() }, 400);
  return c.json(await summary(c.var.tenantEnv, game));
});

app.get("/api/queue", async (c) => {
  const status = c.req.query("status") ?? "Waitlist";
  if (!isStatus(status)) return c.json({ error: "Status must be Waitlist, Listed, Sold, or Skip." }, 400);
  const game = readGame(c.req.query("game"));
  if (!game) return c.json({ error: gameError() }, 400);
  const result = await listByStatus(c.var.tenantEnv, status, game);
  return c.json(result);
});

app.post("/api/intake", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsedBody = parseIntakeBody(body.value);
  if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
  const draft = parseDraft(parsedBody.body);
  if (!draft.ok) return c.json({ error: draft.error }, 400);
  if (draft.card.game === "Magic: The Gathering") {
    const resolvedDraft = await resolveMagicDraft(await connectionSecret(c.env, c.var.tenant.id, "cardtrader"), draft.card);
    if (!resolvedDraft.ok) return c.json({ error: resolvedDraft.error }, 400);
    draft.card = resolvedDraft.card;
  }

  const choice = parsedBody.body.onDuplicate ?? "ask";
  if (choice !== "add") {
    const matches = await findDuplicates(c.var.tenantEnv, draft.card);
    if (matches.length > 0) {
      if (choice === "ask" || (choice === "merge" && matches.length > 1 && !parsedBody.body.mergeRecordId)) {
        return c.json(
          {
            error: "duplicate",
            message: "This game, set, collector number, and finish is already Waitlist or Listed.",
            matches,
          },
          409,
        );
      }
      const target = parsedBody.body.mergeRecordId
        ? matches.find((match) => match.id === parsedBody.body.mergeRecordId)
        : matches[0];
      if (!target) return c.json({ error: "That row is not a matching Waitlist or Listed card." }, 400);
      const card = await mergeQty(c.var.tenantEnv, target.id, draft.card.qty);
      audit(c, "merge", [card]);
      backgroundEnrich(c, card.id);
      return c.json({ card, merged: true });
    }
  }

  const [card] = await createCards(c.var.tenantEnv, [draft.card]);
  if (!card) return c.json({ error: "Airtable did not return the new row." }, 502);
  audit(c, "create", [card]);
  backgroundEnrich(c, card.id);
  return c.json({ card, merged: false }, 201);
});

app.post("/api/intake/bulk", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const text = body.value.text;
  if (typeof text !== "string") return c.json({ error: "Paste the cards as text." }, 400);
  if (text.length > 20_000) return c.json({ error: "That paste is too long." }, 400);
  const mode = body.value.mode === "commit" ? "commit" : "preview";
  const onDuplicate = body.value.onDuplicate;
  if (mode === "commit" && onDuplicate !== "skip" && onDuplicate !== "merge" && onDuplicate !== "add") {
    return c.json({ error: "Choose skip, merge, or add for duplicates." }, 400);
  }

  const game = readGame(typeof body.value.game === "string" ? body.value.game : "Lorcana");
  if (!game) return c.json({ error: gameError() }, 400);

  const parsed = parseBulk(text, game);
  if (parsed.length === 0) return c.json({ error: "No card lines found." }, 400);
  if (parsed.length > 100) return c.json({ error: "Paste at most 100 cards at a time." }, 400);
  const rows = game === "Magic: The Gathering"
    ? await resolveMagicBulk(await connectionSecret(c.env, c.var.tenant.id, "cardtrader"), parsed)
    : parsed;

  if (mode === "preview") {
    const open = await listOpenPrintings(c.var.tenantEnv, game).catch((error: unknown) => {
      if (error instanceof AirtableError && error.status === 503) return null;
      throw error;
    });
    return c.json({
      preview: true,
      dedupeChecked: open !== null,
      warning: open === null ? "Airtable is not configured, so existing rows were not checked." : undefined,
      rows: previewRows(rows, open ?? []),
    });
  }

  const open = await listOpenPrintings(c.var.tenantEnv, game);
  const created: QueueCard[] = [];
  const merged: QueueCard[] = [];
  const skipped: { line: number; raw: string; reason: string }[] = [];
  const errors: { line: number; raw: string; error: string }[] = [];
  let pending: { line: number; raw: string; card: DraftCard }[] = [];
  let writeFailed = false;

  const flush = async () => {
    if (writeFailed || pending.length === 0) return;
    const batch = pending;
    pending = [];
    try {
      const cards = await createCards(c.var.tenantEnv, batch.map((item) => item.card));
      cards.forEach((card) => {
        created.push(card);
        open.push(card);
      });
      if (cards.length !== batch.length) {
        writeFailed = true;
        errors.push({ line: batch[0]?.line ?? 0, raw: batch[0]?.raw ?? "", error: "Airtable returned an unexpected number of rows. Stopped the rest of the paste." });
      }
    } catch (error) {
      writeFailed = true;
      const message = error instanceof AirtableError ? error.message : "Airtable write failed. Stopped the rest of the paste.";
      for (const item of batch) errors.push({ line: item.line, raw: item.raw, error: message });
    }
  };

  for (const row of rows) {
    if (writeFailed) {
      if (row.card && !row.error) errors.push({ line: row.line, raw: row.raw, error: "Skipped because an earlier Airtable write failed." });
      else errors.push({ line: row.line, raw: row.raw, error: row.error ?? "Could not read this line." });
      continue;
    }
    if (!row.card || row.error) {
      errors.push({ line: row.line, raw: row.raw, error: row.error ?? "Could not read this line." });
      continue;
    }
    if (onDuplicate === "add") {
      pending.push({ line: row.line, raw: row.raw, card: row.card });
      if (pending.length === 10) await flush();
      continue;
    }

    const stagedHit = pending.some((item) => duplicatesAmong([draftAsCard(item.card, `pending-${item.line}`)], row.card!).length > 0);
    if (stagedHit) await flush();
    if (writeFailed) {
      errors.push({ line: row.line, raw: row.raw, error: "Skipped because an earlier Airtable write failed." });
      continue;
    }
    const matches = duplicatesAmong(open, row.card);
    if (matches.length === 0) {
      pending.push({ line: row.line, raw: row.raw, card: row.card });
      if (pending.length === 10) await flush();
      continue;
    }
    if (onDuplicate === "skip") {
      skipped.push({ line: row.line, raw: row.raw, reason: `Already ${matches.map((match) => match.status).join(" / ")}.` });
      continue;
    }
    if (matches.length > 1) {
      errors.push({
        line: row.line,
        raw: row.raw,
        error: "Several matching rows. Merge this card from Quick Add so you can pick the row.",
      });
      continue;
    }
    const target = matches[0];
    if (!target) continue;
    try {
      const updated = await mergeQty(c.var.tenantEnv, target.id, row.card.qty);
      const index = open.findIndex((card) => card.id === updated.id);
      if (index >= 0) open[index] = updated;
      else open.push(updated);
      merged.push(updated);
    } catch (error) {
      writeFailed = true;
      const message = error instanceof AirtableError ? error.message : "Could not merge that row.";
      errors.push({ line: row.line, raw: row.raw, error: message });
    }
  }
  await flush();
  audit(c, "create", created);
  audit(c, "merge", merged);
  if (created.length || merged.length) {
    const env = c.var.tenantEnv;
    try { c.executionCtx.waitUntil((async () => { for (const m of merged) await enrichRecord(env, m.id).catch(() => null); await enrichPending(env).catch(() => null); })()); } catch { /* no ctx in tests */ }
  }

  return c.json({ preview: false, created, merged, skipped, errors });
});

app.patch("/api/cards/:id", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  if (typeof body.value.finish === "string") {
    const raw = await getRecordRaw(c.var.tenantEnv, c.req.param("id"));
    const existing = toQueueCard({ id: raw.id, createdTime: raw.createdTime ?? "", fields: raw.fields });
    if (effectiveGame(existing.game) === "Magic: The Gathering") {
      const resolved = await resolveMagicDraft(await connectionSecret(c.env, c.var.tenant.id, "cardtrader"), {
        game: "Magic: The Gathering",
        setIdentifier: existing.setIdentifier ?? "",
        collectorNumber: existing.collectorNumber ?? "",
        finish: body.value.finish,
      });
      if (!resolved.ok) return c.json({ error: resolved.error }, 400);
      if (riftboundNumberKey(resolved.card.collectorNumber) !== riftboundNumberKey(existing.collectorNumber ?? "")) {
        return c.json({ error: `${resolved.card.finish} is collector #${resolved.card.collectorNumber}, not #${existing.collectorNumber}. Add that printing as its own row.` }, 400);
      }
      body.value.finish = resolved.card.finish;
    }
  }
  const card = await editCard(c.var.tenantEnv, c.req.param("id"), body.value);
  audit(c, "edit", [card]);
  backgroundEnrich(c, card.id); // a new finish or condition changes the price and rank
  return c.json({ card });
});

app.delete("/api/cards/:id", async (c) => {
  const result = await deleteCard(c.var.tenantEnv, c.req.param("id"));
  if (result.deleted) audit(c, "delete", [{ id: result.id }]);
  return c.json(result);
});

app.get("/api/preview", async (c) => {
  const game = readGame(c.req.query("game"));
  if (!game) return c.json({ error: gameError() }, 400);
  const cap = (v: string | undefined) => (v ?? "").trim().slice(0, 120);
  const query = { game, set: cap(c.req.query("set")), number: cap(c.req.query("number")), name: cap(c.req.query("name")) };
  if (!query.name && !(query.set && query.number)) return c.json({ found: false, source: "none" });
  return c.json(await resolvePreview(query, c.executionCtx));
});

app.post("/api/enrich/:id", async (c) => {
  const result = await enrichRecord(c.var.tenantEnv, c.req.param("id"));
  return c.json(result);
});

app.post("/api/enrich-listed", async (c) => {
  const game = readGame(c.req.query("game"));
  if (!game) return c.json({ error: gameError() }, 400);
  const offset = Number.parseInt(c.req.query("offset") ?? "0", 10) || 0;
  return c.json(await enrichListedPage(c.var.tenantEnv, game, offset));
});

app.post("/api/rescan", async (c) => {
  const game = readGame(c.req.query("game"));
  if (!game) return c.json({ error: gameError() }, 400);
  const offset = Number.parseInt(c.req.query("offset") ?? "0", 10) || 0;
  return c.json(await rescanPage(c.var.tenantEnv, game, offset));
});

app.post("/api/enrich", async (c) => {
  // Run now for everything pending (up to 4 batches per click to stay inside request limits).
  let enriched = 0; let picked = 0; const failed: { id: string; error: string }[] = []; let remaining = false; let ai = false;
  for (let round = 0; round < 4; round++) {
    const r = await enrichPending(c.var.tenantEnv);
    enriched += r.enriched; picked += r.picked; failed.push(...r.failed); remaining = r.remaining; ai = r.ai;
    if (!r.remaining || r.enriched === 0) break;
  }
  return c.json({ picked, enriched, failed, remaining, ai });
});

app.post("/api/hekla", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const action = body.value.action === "greenlight" ? "greenlight" : body.value.action === "process" ? "process" : null;
  if (!action) return c.json({ error: "Action must be process or greenlight." }, 400);

  const payload = {
    source: "hekla-intake",
    action: action === "process" ? "process_new_rows" : "greenlight_shortlist",
    at: new Date().toISOString(),
    listsCards: false,
    message:
      action === "process"
        ? "Please rank new Waitlist rows. Do not list anything from this request."
        : "Dustin greenlit the shortlist. Listing still happens in Hekla, not in this intake app.",
  };

  const webhook = c.var.tenantEnv.HEKLA_WEBHOOK_URL?.trim();
  if (!webhook) {
    return c.json({ delivered: false, copyText: payload.message, payload, mailto: mailtoLink(payload.message) });
  }

  let target: URL;
  try {
    target = new URL(webhook);
  } catch {
    return c.json({ error: "HEKLA_WEBHOOK_URL is not a valid URL." }, 500);
  }
  if (target.protocol !== "https:") return c.json({ error: "HEKLA_WEBHOOK_URL must use https." }, 500);

  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  await response.body?.cancel();
  if (!response.ok) {
    return c.json({
      delivered: false,
      copyText: payload.message,
      payload,
      mailto: mailtoLink(payload.message),
      webhookStatus: response.status,
    });
  }
  return c.json({ delivered: true, copyText: payload.message, payload });
});

/* ---------- sales log, cross-delist and TCGplayer pull (see docs/SALES-SYNC.md) ---------- */

const MAX_HOOK_BODY = 1_000_000;
async function rawBody(c: { req: { text: () => Promise<string> } }): Promise<string | null> {
  try { const t = await c.req.text(); return t.length > MAX_HOOK_BODY ? null : t; } catch { return null; }
}
const hookUrl = (c: AppContext, kind: "cardtrader" | "starfoil") => `${new URL(c.req.url).origin}/hooks/${kind}/${c.var.tenant.id}`;

// CardTrader calls this for order.create / order.update / order.destroy. Signed with the app's shared_secret.
app.post("/hooks/cardtrader/:tenantId", async (c) => {
  const tenant = await tenantById(c.env, c.req.param("tenantId")).catch(() => null);
  if (!tenant) return c.json({ error: "Unknown tenant." }, 404);
  const body = await rawBody(c);
  if (body == null) return c.json({ error: "Too large." }, 413);
  const secret = await connectionSecret(c.env, tenant.id, "cardtrader_webhook").catch(() => null);
  if (!secret) return c.json({ error: "Webhooks are not enabled for this account." }, 404);
  if (!(await verifyCardTraderSignature(secret, body, c.req.header("signature")))) return c.json({ error: "Bad signature." }, 401);
  let event: Record<string, unknown>;
  try { event = JSON.parse(body) as Record<string, unknown>; } catch { return c.json({ error: "Not JSON." }, 400); }
  // Answer at once; the order is logged in the background. The 5-minute poll catches anything missed.
  const work = handleCardTraderEvent(c.env, tenant, event).catch((e) => console.error("cardtrader webhook failed", tenant.id, e instanceof Error ? e.message : e));
  try { c.executionCtx.waitUntil(work); } catch { await work; }
  return c.json({ ok: true });
});

// starfoil-lgs posts each paid starfoil.store order here after it has lowered CardTrader and Airtable.
app.post("/hooks/starfoil/:tenantId", async (c) => {
  const tenant = await tenantById(c.env, c.req.param("tenantId")).catch(() => null);
  if (!tenant) return c.json({ error: "Unknown tenant." }, 404);
  const body = await rawBody(c);
  if (body == null) return c.json({ error: "Too large." }, 413);
  const secret = await connectionSecret(c.env, tenant.id, "starfoil").catch(() => null);
  if (!secret) return c.json({ error: "starfoil.store sales are not enabled for this account." }, 404);
  if (!(await verifyStarfoil(secret, body, c.req.header("x-hekla-timestamp"), c.req.header("x-hekla-signature")))) return c.json({ error: "Bad signature." }, 401);
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return c.json({ error: "Not JSON." }, 400); }
  const result = await ingestStarfoil(c.env, tenant.id, parsed);
  return result.ok ? c.json(result) : c.json({ error: result.error }, 400);
});

function syncModes(env: Env) {
  return { salesMode: salesMode(env), decrementFrom: decrementFrom(env), reconcileMode: reconcileMode(env), dailyEmail: dailyEmailOn(env) };
}

app.get("/api/connections/sales", async (c) => {
  const id = c.var.tenant.id;
  const [cardtraderWebhook, starfoil, resend, resendSettings] = await Promise.all([
    connectionStatus(c.env, id, "cardtrader_webhook"), connectionStatus(c.env, id, "starfoil"), connectionStatus(c.env, id, "resend"),
    connectionSettings(c.env, id, "resend").catch(() => null),
  ]);
  return c.json({
    canManage: canManageConnections(c), modes: syncModes(c.env), cardtraderWebhook, starfoil,
    starfoilUrl: hookUrl(c, "starfoil"), cardtraderWebhookUrl: hookUrl(c, "cardtrader"),
    resend: resend.connected ? { ...resend, to: resendSettings?.to ?? null, from: resendSettings?.from ?? null } : resend,
  });
});

// Shows what CardTrader currently has as the account's webhook URL. Read-only.
app.get("/api/connections/cardtrader-webhook", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can see this." }, 403);
  const info = await appInfo(await cardTraderToken(c));
  const target = hookUrl(c, "cardtrader");
  return c.json({ currentUrl: info.webhookUrl, heklaUrl: target, pointsAtHekla: info.webhookUrl === target });
});

// Points the CardTrader account's one webhook at Hekla. Refuses to replace a different URL unless confirmed.
app.post("/api/connections/cardtrader-webhook", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can turn on CardTrader webhooks." }, 403);
  if (!connectionsReady(c.env)) return c.json({ error: "Connections are not set up on this server yet (CONNECTIONS_KEY is missing)." }, 503);
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const token = await cardTraderToken(c);
  const info = await appInfo(token);
  const target = hookUrl(c, "cardtrader");
  if (info.webhookUrl && info.webhookUrl !== target && body.value.replace !== info.webhookUrl) {
    return c.json({ error: "CardTrader already sends webhooks somewhere else. Replacing it stops them going there.", code: "webhook_in_use", currentUrl: info.webhookUrl }, 409);
  }
  if (!info.sharedSecret) return c.json({ error: "CardTrader did not return the app's shared secret." }, 502);
  await saveConnection(c.env, c.var.tenant.id, "cardtrader_webhook", info.sharedSecret, { accountLabel: target, accountId: info.id == null ? null : String(info.id) }, c.var.userId, { previousUrl: info.webhookUrl });
  if (info.webhookUrl !== target) await setWebhookUrl(token, target);
  audit(c, "connect", [{ id: "cardtrader_webhook" }]);
  return c.json({ cardtraderWebhook: await connectionStatus(c.env, c.var.tenant.id, "cardtrader_webhook"), previousUrl: info.webhookUrl });
});

app.delete("/api/connections/cardtrader-webhook", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can turn off CardTrader webhooks." }, 403);
  const token = await connectionSecret(c.env, c.var.tenant.id, "cardtrader");
  let cleared = false;
  if (token) {
    const info = await appInfo(token);
    // Only clear the URL if it is still Hekla's; never touch someone else's.
    if (info.webhookUrl === hookUrl(c, "cardtrader")) { await setWebhookUrl(token, ""); cleared = true; }
  }
  if (await deleteConnection(c.env, c.var.tenant.id, "cardtrader_webhook")) audit(c, "disconnect", [{ id: "cardtrader_webhook" }]);
  return c.json({ cardtraderWebhook: { connected: false }, cleared });
});

// Creates the secret starfoil-lgs signs sale events with. Shown once; Hekla keeps only the sealed copy.
app.post("/api/connections/starfoil", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can connect starfoil.store." }, 403);
  if (!connectionsReady(c.env)) return c.json({ error: "Connections are not set up on this server yet (CONNECTIONS_KEY is missing)." }, 503);
  const secret = newSecret();
  await saveConnection(c.env, c.var.tenant.id, "starfoil", secret, { accountLabel: "starfoil.store (starfoil-lgs)", accountId: null }, c.var.userId, {});
  audit(c, "connect", [{ id: "starfoil" }]);
  return c.json({ starfoil: await connectionStatus(c.env, c.var.tenant.id, "starfoil"), secret, url: hookUrl(c, "starfoil") });
});

app.delete("/api/connections/starfoil", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can disconnect starfoil.store." }, 403);
  if (await deleteConnection(c.env, c.var.tenant.id, "starfoil")) audit(c, "disconnect", [{ id: "starfoil" }]);
  return c.json({ starfoil: { connected: false } });
});

app.put("/api/connections/resend", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can set up alert email." }, 403);
  if (!connectionsReady(c.env)) return c.json({ error: "Connections are not set up on this server yet (CONNECTIONS_KEY is missing)." }, 503);
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const token = cleanToken(body.value.token);
  if (!token || !token.startsWith("re_")) return c.json({ error: "Paste a Resend API key (it starts with re_)." }, 400);
  const to = validTo(body.value.to); const from = validFrom(body.value.from);
  if (!to) return c.json({ error: "Alert email: one to five addresses, separated by commas." }, 400);
  if (!from) return c.json({ error: "From: an address on a domain verified in Resend, e.g. Hekla <alerts@starfoil.store>." }, 400);
  await saveConnection(c.env, c.var.tenant.id, "resend", token, { accountLabel: `Resend → ${to}`, accountId: null }, c.var.userId, { to, from });
  audit(c, "connect", [{ id: "resend" }]);
  return c.json({ resend: { ...(await connectionStatus(c.env, c.var.tenant.id, "resend")), to, from } });
});

app.post("/api/connections/resend/test", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can send a test." }, 403);
  const result = await sendEmail(c.env, c.var.tenant.id, "[Hekla] Test alert", "This is a test of Hekla's sales alerts. Oversells and stock problems will arrive like this.");
  return result === "sent" ? c.json({ ok: true }) : c.json({ error: result === "not_configured" ? "Set up alert email first." : "Resend did not accept the email. Check the key and the from address." }, 400);
});

app.delete("/api/connections/resend", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can remove alert email." }, 403);
  if (await deleteConnection(c.env, c.var.tenant.id, "resend")) audit(c, "disconnect", [{ id: "resend" }]);
  return c.json({ resend: { connected: false } });
});

app.get("/api/inventory/settings", async (c) => {
  try {
    const loaded = await readInventorySettings(c.env, c.var.tenant.id);
    return c.json({ ...presentSettings(loaded.settings), stored: loaded.stored, phase2: loaded.phase2, canManage: canManageConnections(c) });
  } catch (error) {
    if (isMissingLedger(error)) return c.json({ error: "The inventory ledger is not in this database yet. Apply migration 0008 before go-live. Nothing was written." }, 503);
    throw error;
  }
});

app.put("/api/inventory/settings", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can change inventory settings." }, 403);
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  let settings;
  try {
    settings = validateInventorySettings(body.value);
  } catch (error) {
    if (error instanceof SettingsError) return c.json({ error: error.message }, 400);
    throw error;
  }
  try {
    const saved = await saveInventorySettings(c.env, c.var.tenant.id, settings);
    return c.json({ ...presentSettings(saved), stored: true, phase2: true, canManage: true });
  } catch (error) {
    if (isMissingPhase2Settings(error) || isMissingLedger(error)) {
      return c.json({ error: "Inventory settings are not in this database yet. Apply migration 0009 before saving. Nothing was written." }, 503);
    }
    throw error;
  }
});

app.get("/api/inventory", async (c) => {
  try {
    return c.json(await inventoryPayload(c, inventoryQuery(c.req.query())));
  } catch (error) {
    if (isMissingLedger(error)) return c.json({ error: "The inventory ledger is not in this database yet. Apply migration 0008 before go-live. Nothing was written." }, 503);
    throw error;
  }
});

app.get("/api/inventory/:recordId", async (c) => {
  const recordId = c.req.param("recordId");
  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) return c.json({ error: "That is not a stock row." }, 400);
  try {
    const [loaded, stock] = await Promise.all([loadLedger(c, recordId), inventoryStock(c.var.tenantEnv, recordId)]);
    const payload = buildLiveInventory({ tenantId: c.var.tenant.id, stock, movements: loaded.movements,
      buyList: loaded.buyList, thresholds: loaded.thresholds, wantQtyState: loaded.wantQtyState });
    const detail = buildLiveDetail(payload, loaded.movements, recordId);
    if (!detail) return c.json({ error: "That stock row was not found." }, 404);
    return c.json(detail);
  } catch (error) {
    if (isMissingLedger(error)) return c.json({ error: "The inventory ledger is not in this database yet. Apply migration 0008 before go-live. Nothing was written." }, 503);
    throw error;
  }
});

app.get("/api/sales", async (c) => {
  const filter = readSalesFilter(c.req.query());
  const { rows, truncated } = await listSales(c.env, c.var.tenant.id, filter, 1000);
  const lastPoll = await getState(c.env, c.var.tenant.id, "cardtrader:last_poll").catch(() => null);
  return c.json({ rows, truncated, totals: totalsByPlatform(rows), filter, modes: syncModes(c.env), lastPoll });
});

app.get("/api/sales/export", async (c) => {
  const filter = readSalesFilter(c.req.query());
  const { rows, truncated } = await listSales(c.env, c.var.tenant.id, filter, 50_000);
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return new Response(salesCsv(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="sales-${day}.csv"`, "cache-control": "no-store", "x-truncated": truncated ? "1" : "0" } });
});

app.post("/api/sales/poll", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can poll CardTrader." }, 403);
  if (salesMode(c.env) === "off") return c.json({ error: "CardTrader sales are off (CT_SALES_MODE)." }, 409);
  const result = await pollCardTrader(c.env, c.var.tenant);
  const decrements = await runDecrements(c.env, c.var.tenant);
  return c.json({ result, decrements: decrements && { applied: decrements.applied, oversold: decrements.oversold, skipped: decrements.skipped, flagged: decrements.flagged } });
});

const pullHours = (v: string | undefined) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 168 ? n : 24; };

app.get("/api/tcgplayer/pull", async (c) => {
  const { since, items } = await tcgplayerPull(c.env, c.var.tenant, pullHours(c.req.query("hours")));
  const { included, skipped } = tcgplayerCsv(items);
  return c.json({ since, items, importable: included, notImportable: skipped.map((i) => ({ recordId: i.recordId, name: i.name, reason: !i.tcgplayerSku ? "no TCGplayer SKU" : i.priceUsd == null ? "no market price" : "duplicate SKU" })) });
});

app.get("/api/tcgplayer/pull.csv", async (c) => {
  const { items } = await tcgplayerPull(c.env, c.var.tenant, pullHours(c.req.query("hours")));
  const checklist = c.req.query("format") === "checklist";
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const csv = checklist ? checklistCsv(items) : tcgplayerCsv(items).csv;
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="tcgplayer-${checklist ? "pull-list" : "import"}-${day}.csv"`, "cache-control": "no-store" } });
});

app.get("/api/reconcile", async (c) => {
  return c.json({ report: await getState(c.env, c.var.tenant.id, "reconcile:last").catch(() => null), mode: reconcileMode(c.env) });
});

// A report-only check on demand. It never changes CardTrader, whatever RECONCILE_MODE says.
app.post("/api/reconcile", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can run a check." }, 403);
  return c.json({ report: await runReconcile(c.env, c.var.tenant, "report") });
});

/* ---------- three-way reconcile: Airtable vs CardTrader vs TCGplayer (docs/RECONCILE.md) ---------- */

type CtCache = { at: string; listings: CtListing[] };
const CT_CACHE = "reconcile:ct_listings";
// Rows put in a downloaded TCGplayer import: hidden as pending until a newer export or 24 hours (threeway.livePending).
const TCG_PENDING = "reconcile:tcg_pending";

async function reconView(c: AppContext) {
  const id = c.var.tenant.id;
  const [{ rows, hasSkuColumn }, cache, snapshot, confirmed] = await Promise.all([
    reconcileRows(c.var.tenantEnv), getState<CtCache>(c.env, id, CT_CACHE), latestSnapshot(c.env, id), confirmedMatches(c.env, id),
  ]);
  const view = buildView(rows, cache?.listings ?? null, snapshot?.rows ?? null, confirmed, { ct: cache?.at ?? null, tcg: snapshot?.info.uploadedAt ?? null });
  const pending = livePending(await getState<PendingTcg>(c.env, id, TCG_PENDING), snapshot?.info.uploadedAt ?? null, Date.now());
  applyPending(view.rows, pending);
  view.counts = { ...view.counts, ...viewCounts(view.rows) };
  return { pending, listings: cache?.listings ?? [], view, hasSkuColumn, snapshot: snapshot?.info ?? null, prices: new Map(rows.map((r) => [r.id, r.marketPriceUsd])) };
}
function readViewFilter(q: Record<string, string | undefined>): ViewFilter {
  const m = q.mismatch;
  return { mismatch: m === "cardtrader" || m === "tcgplayer" ? m : "any", game: q.game?.trim() ? q.game.trim().slice(0, 60) : null, showReconciled: q.reconciled === "1" };
}
const reconAudit = (c: AppContext, action: ReconAction, recordId: string | null, detail: Record<string, unknown>) => logAction(c.env, c.var.tenant.id, c.var.userId, action, recordId, detail);

app.get("/api/reconcile/view", async (c) => {
  const { view, hasSkuColumn, snapshot } = await reconView(c);
  const filter = readViewFilter(c.req.query());
  const mode = reconcileMode(c.env);
  const cron = mode === "off" ? null : await getState<ReconcileReport>(c.env, c.var.tenant.id, "reconcile:last");
  return c.json({
    rows: filterView(view.rows, filter), counts: view.counts, filter, ctAt: view.ctAt, tcgAt: view.tcgAt, snapshot, hasSkuColumn,
    unmatchedCardTrader: view.unmatchedCardTrader, unmatchedTcgplayer: view.unmatchedTcgplayer.slice(0, 500), unmatchedTcgplayerTotal: view.unmatchedTcgplayer.length,
    cron: cron ? { mode, at: cron.at, summary: reconcileSummary(cron), errors: cron.errors } : { mode, at: null, summary: null, errors: [] },
    canManage: canManageConnections(c), actions: await recentActions(c.env, c.var.tenant.id, 25),
  });
});

app.get("/api/reconcile/view.csv", async (c) => {
  const { view } = await reconView(c);
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return new Response(viewCsv(filterView(view.rows, readViewFilter(c.req.query()))), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="reconcile-${day}.csv"`, "cache-control": "no-store" } });
});

// Read-only: one CardTrader products export, cached for the page. Works whatever RECONCILE_MODE says.
app.post("/api/reconcile/check", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can run a check." }, 403);
  const listings = await exportListings(await cardTraderToken(c));
  const at = new Date().toISOString();
  await setState(c.env, c.var.tenant.id, CT_CACHE, { at, listings } satisfies CtCache);
  await reconAudit(c, "check_cardtrader", null, { listings: listings.length });
  return c.json({ at, listings: listings.length });
});

app.post("/api/reconcile/tcgplayer/upload", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can upload a TCGplayer export." }, 403);
  let body: string;
  try { body = await c.req.text(); } catch { return c.json({ error: "Could not read the file." }, 400); }
  const parsed = parseTcgExport(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const filename = (c.req.header("x-filename") ?? "").replace(/[^\w .()-]/g, "").slice(0, 120) || null;
  const info = await saveSnapshot(c.env, c.var.tenant.id, c.var.userId, filename, parsed.totalRows, parsed.columns, parsed.rows);
  await reconAudit(c, "tcgplayer_upload", null, { filename, totalRows: parsed.totalRows, stockedRows: parsed.rows.length, skippedBad: parsed.skippedBad, duplicateIds: parsed.duplicateIds, columns: parsed.columns });
  return c.json({ snapshot: info, skippedBad: parsed.skippedBad, duplicateIds: parsed.duplicateIds });
});

app.post("/api/reconcile/tcgplayer/confirm", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can confirm a match." }, 403);
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const recordId = String(body.value.recordId ?? ""); const tcgplayerId = String(body.value.tcgplayerId ?? "");
  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId) || !/^\d{1,12}$/.test(tcgplayerId)) return c.json({ error: "Pick a Waitlist row and a TCGplayer SKU." }, 400);
  await confirmMatch(c.env, c.var.tenant.id, recordId, tcgplayerId, c.var.userId);
  await reconAudit(c, "tcgplayer_confirm", recordId, { tcgplayerId, confidence: body.value.confidence ?? null });
  let sku: "written" | "no_column" | "not_requested" = "not_requested";
  if (body.value.writeSku === true) {
    sku = await writeTcgplayerSku(c.var.tenantEnv, recordId, tcgplayerId);
    await reconAudit(c, "tcgplayer_sku_write", recordId, { tcgplayerId, result: sku });
  }
  return c.json({ ok: true, sku });
});

app.delete("/api/reconcile/tcgplayer/confirm/:recordId", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can remove a match." }, 403);
  const recordId = c.req.param("recordId");
  if (await removeMatch(c.env, c.var.tenant.id, recordId)) await reconAudit(c, "tcgplayer_unconfirm", recordId, {});
  return c.json({ ok: true });
});

// Builds (does not send) a Seller Portal import that brings the selected rows to their Airtable quantity.
app.post("/api/reconcile/tcgplayer/import", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can build a TCGplayer import." }, 403);
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const ids = Array.isArray(body.value.recordIds) ? new Set((body.value.recordIds as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 2000)) : new Set<string>();
  if (!ids.size) return c.json({ error: "Select at least one row." }, 400);
  const { view, prices, pending } = await reconView(c);
  if (!view.tcgAt) return c.json({ error: "Upload a TCGplayer export first." }, 409);
  const result = tcgplayerAdjustCsv(view.rows.filter((r) => ids.has(r.recordId)), prices);
  const at = new Date().toISOString();
  for (const i of result.included) pending[i.recordId] = { at, tcgplayerId: i.tcgplayerId, delta: i.delta };
  if (result.included.length) await setState(c.env, c.var.tenant.id, TCG_PENDING, pending);
  await reconAudit(c, "tcgplayer_import_csv", null, { included: result.included, skipped: result.skipped.length, snapshotAt: view.tcgAt, batchId: typeof body.value.batchId === "string" ? body.value.batchId.slice(0, 64) : null });
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return c.json({ csv: result.csv, filename: `tcgplayer-reconcile-${day}.csv`, included: result.included, skipped: result.skipped, pendingAt: at });
});

// Sets CardTrader to the Airtable quantity for one row. Re-reads both sides first; refuses if either moved.
app.post("/api/reconcile/cardtrader/set", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can change CardTrader." }, 403);
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const recordId = String(body.value.recordId ?? "");
  const [card] = await stockCardsByIds(c.var.tenantEnv, [recordId]);
  if (!card) return c.json({ error: "That Waitlist row was not found." }, 404);
  const token = await cardTraderToken(c);
  // The allocation row lease, taken before the export is read, so the read-modify-write cannot interleave with an allocation.
  const lease = await takeRowLease(neonAllocationStore(c.env), c.var.tenant.id, recordId, `reconcile:${crypto.randomUUID()}`,
    () => resolveStaleRow(c.var.tenant.id, recordId, productionAllocationDeps(c.env)));
  if (typeof lease === "string") return c.json({ error: `Not changed: ${lease}. Try again in a minute.`, code: "row_busy" }, 409);
  try {
    const listings = await exportListings(token);
    const stored = Number(card.cardTraderListingId);
    const mine = listings.filter((l) => l.recordId === recordId || l.id === stored);
    const target = expectedQty(card);
    if (body.value.expectedTarget !== target) return c.json({ error: `Airtable now says ${target} for this card. Reload and check again.`, code: "changed" }, 409);
    const plan = planCardTraderSet(mine, Number.isInteger(stored) ? stored : null, target);
    if (!plan.ok) return c.json({ error: plan.error }, 400);
    if (body.value.expectedCurrent !== plan.before) return c.json({ error: `CardTrader now shows ${plan.before}. Reload and check again.`, code: "changed" }, 409);
    const done: { listingId: number; delta: number }[] = [];
    try {
      for (const change of plan.changes) {
        if (!(await lease.renew())) throw new Error("Stopped: an allocation took this row. Reload and check again.");
        await incrementListing(token, change.listingId, change.delta); done.push(change);
      }
    } finally {
      await reconAudit(c, "cardtrader_set", recordId, { before: plan.before, target, planned: plan.changes, applied: done });
      // Patch the cache from the fresh read plus what was applied; CardTrader's export can lag the write.
      await setState(c.env, c.var.tenant.id, CT_CACHE, { at: new Date().toISOString(), listings: applyCtChanges(listings, done) } satisfies CtCache);
    }
    return c.json({ ok: true, before: plan.before, target, ctQty: target, changes: done });
  } finally {
    await lease.release();
  }
});

// Reconcile All, step 1: what would change for these rows (from the last check; nothing is changed).
app.post("/api/reconcile/all/plan", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can reconcile." }, 403);
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const ids = new Set(Array.isArray(body.value.recordIds) ? (body.value.recordIds as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 5000) : []);
  const { view, prices, listings } = await reconView(c);
  const plan = planReconcileAll(view.rows.filter((r) => ids.has(r.recordId)), listings, prices, { cardtrader: body.value.cardtrader === true && !!view.ctAt, tcgplayer: body.value.tcgplayer === true && !!view.tcgAt });
  return c.json({ ...plan, ctAt: view.ctAt, tcgAt: view.tcgAt, batchSize: RECONCILE_BATCH });
});

// Reconcile All, step 2 (repeated by the page, at most RECONCILE_BATCH rows per request so no request runs long):
// CardTrader to the Airtable quantity, sequentially, each row re-checked first and logged with the batch id.
app.post("/api/reconcile/all/cardtrader", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can change CardTrader." }, 403);
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const batchId = String(body.value.batchId ?? "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(batchId)) return c.json({ error: "Missing batch id." }, 400);
  const raw = Array.isArray(body.value.items) ? (body.value.items as Record<string, unknown>[]) : [];
  if (!raw.length || raw.length > RECONCILE_BATCH) return c.json({ error: `Send 1 to ${RECONCILE_BATCH} rows per request.` }, 400);
  const items: BatchItem[] = [];
  for (const i of raw) {
    if (!i || typeof i.recordId !== "string" || !/^rec[A-Za-z0-9]{14}$/.test(i.recordId) || !Number.isInteger(i.expectedTarget) || !Number.isInteger(i.expectedCurrent)) return c.json({ error: "Each row needs recordId, expectedTarget and expectedCurrent." }, 400);
    items.push({ recordId: i.recordId, expectedTarget: i.expectedTarget as number, expectedCurrent: i.expectedCurrent as number });
  }
  const token = await cardTraderToken(c);
  // Take every row's allocation lease before the export is read; a row an allocation holds is skipped.
  const store = neonAllocationStore(c.env);
  const allocationDeps = productionAllocationDeps(c.env);
  const leases = new Map<string, RowLease>();
  const busy: { recordId: string; status: "skipped"; reason: string; applied: [] }[] = [];
  try {
    for (const item of items) {
      if (leases.has(item.recordId)) continue;
      const lease = await takeRowLease(store, c.var.tenant.id, item.recordId, `reconcile:${batchId}:${crypto.randomUUID()}`,
        () => resolveStaleRow(c.var.tenant.id, item.recordId, allocationDeps));
      if (typeof lease === "string") busy.push({ recordId: item.recordId, status: "skipped", reason: lease, applied: [] });
      else leases.set(item.recordId, lease);
    }
    const free = items.filter((item) => leases.has(item.recordId));
    const [cards, listings] = await Promise.all([stockCardsByIds(c.var.tenantEnv, free.map((i) => i.recordId)), exportListings(token)]);
    const ran = await runCtBatch(free, new Map(cards.map((k) => [k.id, k])), listings,
      (listingId, delta) => incrementListing(token, listingId, delta).then(() => undefined),
      (_item, r) => reconAudit(c, "cardtrader_set", r.recordId, { batchId, status: r.status, reason: r.reason ?? null, before: r.before ?? null, target: r.target ?? null, applied: r.applied }),
      (recordId) => leases.get(recordId)?.renew() ?? Promise.resolve(false));
    for (const r of busy) await reconAudit(c, "cardtrader_set", r.recordId, { batchId, status: r.status, reason: r.reason, before: null, target: null, applied: [] });
    const applied = ran.flatMap((r) => r.applied);
    await setState(c.env, c.var.tenant.id, CT_CACHE, { at: new Date().toISOString(), listings: applyCtChanges(listings, applied) } satisfies CtCache);
    return c.json({ batchId, results: [...ran, ...busy] });
  } finally {
    for (const lease of leases.values()) await lease.release();
  }
});

// Sets Airtable Qty for one row, only when Airtable still shows what the admin saw.
app.post("/api/reconcile/airtable/set", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can change Airtable." }, 403);
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const recordId = String(body.value.recordId ?? ""); const qty = body.value.qty; const expectedCurrent = body.value.expectedCurrent;
  if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 0 || qty > 9999) return c.json({ error: "Qty must be a whole number from 0 to 9999." }, 400);
  const current = await readStock(c.var.tenantEnv, recordId);
  if (current == null) return c.json({ error: "That Waitlist row was not found." }, 404);
  if (current !== expectedCurrent) return c.json({ error: `Airtable now shows ${current}. Reload and check again.`, code: "changed" }, 409);
  await writeStock(c.var.tenantEnv, recordId, qty);
  await reconAudit(c, "airtable_set", recordId, { before: current, after: qty, soldStatus: qty === 0 });
  return c.json({ ok: true, before: current, after: qty });
});

/* ---------- CardTrader cleanup → Airtable (merged/removed CardTrader listings; docs in src/cleanup.ts) ---------- */

const removeMode = (env: Env): RemoveMode => ((env as { CLEANUP_REMOVE_MODE?: string }).CLEANUP_REMOVE_MODE === "archive" ? "archive" : "delete");
/** A fresh, successful CardTrader export plus the Airtable rows; throws (no plan) when CardTrader fails. */
async function cleanupPlan(c: AppContext) {
  const listings = await exportListings(await cardTraderToken(c));
  const at = new Date().toISOString();
  await setState(c.env, c.var.tenant.id, CT_CACHE, { at, listings } satisfies CtCache);
  const { rows } = await reconcileRows(c.var.tenantEnv);
  return { at, plan: planCleanup(rows, listings) };
}

// Preview only: nothing in Airtable or CardTrader changes.
app.post("/api/reconcile/cleanup/preview", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can preview the cleanup." }, 403);
  const { at, plan } = await cleanupPlan(c);
  const preview = previewJson(plan);
  console.log("cleanup preview", JSON.stringify({ tenant: c.var.tenant.id, ctAt: at, ...preview.counts }));
  return c.json({ ctAt: at, removeMode: removeMode(c.env), batchSize: CLEANUP_BATCH, ...preview });
});

// Apply, at most CLEANUP_BATCH groups per request (the page drives the batches). Every group is re-planned from a
// fresh CardTrader export and Airtable read; a group that changed since the preview is skipped, not guessed.
app.post("/api/reconcile/cleanup/apply", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can apply the cleanup." }, 403);
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const batchId = String(body.value.batchId ?? "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(batchId)) return c.json({ error: "Missing batch id." }, 400);
  const raw = Array.isArray(body.value.groups) ? (body.value.groups as Record<string, unknown>[]) : [];
  if (!raw.length || raw.length > CLEANUP_BATCH) return c.json({ error: `Send 1 to ${CLEANUP_BATCH} groups per request.` }, 400);
  const inputs: ApplyGroup[] = [];
  for (const g of raw) {
    const ids = Array.isArray(g?.removeIds) ? (g.removeIds as unknown[]) : null;
    if (!g || typeof g.key !== "string" || g.key.length > 300 || typeof g.survivorId !== "string" || !/^rec[A-Za-z0-9]{14}$/.test(g.survivorId) || !Number.isInteger(g.listingId) || !Number.isInteger(g.ctQty)
      || !ids || ids.length > 50 || !ids.every((x) => typeof x === "string" && /^rec[A-Za-z0-9]{14}$/.test(x)) || (g.mode !== "keep" && g.mode !== "skip")) return c.json({ error: "Each group needs key, survivorId, listingId, ctQty, removeIds and mode (keep or skip)." }, 400);
    inputs.push({ key: g.key, survivorId: g.survivorId, listingId: g.listingId as number, ctQty: g.ctQty as number, removeIds: ids as string[], mode: g.mode });
  }
  const { plan } = await cleanupPlan(c);
  const mode = removeMode(c.env);
  const env = c.var.tenantEnv; const tenantId = c.var.tenant.id; const userId = c.var.userId;
  const results = await runCleanupBatch(inputs, plan, {
    async snapshot(recordId, action, detail) {
      const rec = await getRecordRaw(env, recordId);
      return saveRecordSnapshot(c.env, tenantId, { recordId, baseId: env.AIRTABLE_BASE_ID, tableId: env.AIRTABLE_TABLE_ID, fields: rec.fields, createdTime: rec.createdTime, action, reason: CLEANUP_REASON, batchId, detail, takenBy: userId });
    },
    applied: (id) => markSnapshotApplied(c.env, tenantId, id),
    update: (recordId, fields) => patchRecordFields(env, recordId, fields),
    remove: (recordId) => deleteRecordRaw(env, recordId),
    archive: (recordId) => patchRecordFields(env, recordId, { ...ARCHIVE_FIELDS }),
  }, mode);
  for (const r of results) {
    console.log("cleanup", JSON.stringify({ tenant: tenantId, batchId, mode, key: r.key, name: r.name, status: r.status, reason: r.reason ?? null, updated: r.updated, removed: r.removed, snapshots: r.snapshotIds }));
    if (r.updated) await reconAudit(c, "cleanup_update", plan.groups.find((g) => g.key === r.key)?.survivor.id ?? null, { batchId, key: r.key, fields: r.updated, reason: CLEANUP_REASON });
    for (const id of r.removed) await reconAudit(c, mode === "archive" ? "cleanup_archive" : "cleanup_delete", id, { batchId, key: r.key, reason: CLEANUP_REASON });
    if (r.status !== "succeeded") await reconAudit(c, "cleanup_skip", null, { batchId, key: r.key, status: r.status, reason: r.reason ?? null, partial: r.removed });
  }
  return c.json({ batchId, mode, results });
});

app.get("/api/reconcile/cleanup/snapshots", async (c) => {
  return c.json({ snapshots: (await listRecordSnapshots(c.env, c.var.tenant.id, 300)).map((s) => ({ ...s, name: String(s.fields["Card Name"] ?? s.fields["Resolved Name"] ?? s.recordId), qty: s.fields.Qty ?? null, fields: undefined })), canManage: canManageConnections(c) });
});

// Re-creates a deleted (or un-archives an archived) record from its snapshot. Once per snapshot.
app.post("/api/reconcile/cleanup/restore", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can restore a record." }, 403);
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const id = Number(body.value.snapshotId);
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Pick a snapshot." }, 400);
  const snap = await getRecordSnapshot(c.env, c.var.tenant.id, id);
  if (!snap) return c.json({ error: "That snapshot was not found." }, 404);
  if (!(await claimRestore(c.env, c.var.tenant.id, id, c.var.userId))) return c.json({ error: "Already restored, or that change was never applied." }, 409);
  let newId: string | null = null;
  try {
    const fields = restorableFields(snap.fields);
    if (snap.action === "archive") { await patchRecordFields(c.var.tenantEnv, snap.recordId, { Status: fields.Status ?? "Listed", Qty: fields.Qty ?? 0 }); newId = snap.recordId; }
    else newId = await createRecordRaw(c.var.tenantEnv, fields);
  } finally { await finishRestore(c.env, c.var.tenant.id, id, newId); }
  console.log("cleanup restore", JSON.stringify({ tenant: c.var.tenant.id, snapshotId: id, from: snap.recordId, to: newId }));
  await reconAudit(c, "cleanup_restore", newId, { snapshotId: id, from: snap.recordId });
  return c.json({ ok: true, recordId: newId });
});

// Magic set symbols, same-origin so the CSP needs no new image host. Public (they are Scryfall's public icons);
// only files Scryfall lists are fetched, and each is cached for a week.
app.get("/set-icons/:file", async (c) => {
  const m = /^([a-z0-9]{1,12})\.svg$/.exec(c.req.param("file"));
  const svg = m ? await setIconSvg(m[1]!, fetch, scryfallStore(c.env)).catch((e) => { console.error("set icon failed", m[1], String(e)); return null; }) : null;
  if (!svg) return c.body(null, 404, { "cache-control": "public, max-age=300" }); // short: a Scryfall hiccup must not stick
  return c.body(svg, 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400, stale-while-revalidate=604800", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
});

app.get("/api/purchases/draft", async (c) => {
  const sellRequestId = c.req.query("sr") ?? "";
  try {
    const opened = await openSellRequest(c, sellRequestId);
    if (!opened.ok) return c.json({ error: opened.error }, opened.status);
    const saved = await loadPurchase(c.env, c.var.tenant.id, sellRequestId).catch((error: unknown) => {
      if (isMissingPurchases(error)) return null;
      throw error;
    });
    let preview = null;
    let planError: string | null = null;
    try {
      const settings = await readInventorySettings(c.env, c.var.tenant.id);
      const planned = planAcceptance({ tenantId: c.var.tenant.id, request: opened.request, lines: opened.lines, settings: settings.settings });
      if (planned.ok) preview = planned.purchase;
      else planError = planned.error;
    } catch (error) {
      if (!isMissingPhase2Settings(error) && !isMissingLedger(error)) throw error;
      planError = "Inventory settings are not in this database yet. Apply migration 0009 before go-live. Nothing was written.";
    }
    return c.json({ request: opened.request, lines: opened.lines, preview, purchase: saved, error: planError, liability: await safeLiability(c) });
  } catch (error) {
    if (isMissingLedger(error)) return c.json({ error: "The inventory ledger is not in this database yet. Apply migration 0008 before go-live. Nothing was written." }, 503);
    throw error;
  }
});

app.post("/api/purchases", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const sellRequestId = typeof body.value.sellRequestId === "string" ? body.value.sellRequestId : "";
  const overrides = Array.isArray(body.value.overrides)
    ? body.value.overrides.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const lineNo = Number((row as { lineNo?: unknown }).lineNo);
      const marketRefCents = Number((row as { marketRefCents?: unknown }).marketRefCents);
      return Number.isInteger(lineNo) && Number.isInteger(marketRefCents) && marketRefCents >= 0 ? [{ lineNo, marketRefCents }] : [];
    })
    : [];
  try {
    const opened = await openSellRequest(c, sellRequestId);
    if (!opened.ok) return c.json({ error: opened.error }, opened.status);
    const settings = await readInventorySettings(c.env, c.var.tenant.id);
    const planned = planAcceptance({ tenantId: c.var.tenant.id, request: opened.request, lines: opened.lines, settings: settings.settings, overrides });
    if (!planned.ok) return c.json({ error: planned.error }, 400);
    const saved = await saveAcceptance(c.env, planned.purchase);
    return c.json({ purchase: planned.purchase, created: saved.created, stockChanged: false, wantChanged: false });
  } catch (error) {
    if (isMissingPurchases(error)) return c.json({ error: "Purchases are not in this database yet. Apply migration 0010 before go-live. Nothing was written." }, 503);
    throw error;
  }
});

app.post("/api/purchases/receive", async (c) => {
  // Check before any Airtable write, including when migration 0010 was previously installed.
  await requirePurchaseSafety(purchaseDatabase(c.env));
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const sellRequestId = typeof body.value.sellRequestId === "string" ? body.value.sellRequestId : "";
  const receivedOn = typeof body.value.receivedOn === "string" ? body.value.receivedOn : "";
  const confirms = Array.isArray(body.value.lines)
    ? body.value.lines.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const lineNo = Number((row as { lineNo?: unknown }).lineNo);
      const condition = String((row as { condition?: unknown }).condition ?? "");
      return Number.isInteger(lineNo) && condition ? [{ lineNo, condition }] : [];
    })
    : [];
  const token = c.env.AIRTABLE_API_KEY?.trim() || c.env.AIRTABLE_PAT?.trim() || "";
  if (!token) return c.json({ error: "Airtable is not configured on this server. Nothing was received." }, 503);
  try {
    const purchase = await loadPurchase(c.env, c.var.tenant.id, sellRequestId);
    if (!purchase) return c.json({ error: "Save the sell request before receiving it." }, 404);
    for (const line of purchase.lines) {
      if (!line.stockRecordId) continue;
      const qty = await readStock(c.var.tenantEnv, line.stockRecordId);
      if (qty != null) line.onHand = qty;
    }
    const balance = await customerBalance(c.env, c.var.tenant.id, sellRequestId);
    const planned = planReceipt({
      purchase,
      receivedOn,
      now: new Date().toISOString(),
      confirms,
      balanceCents: balance,
      mintRecordId: (lineNo) => `recPendCreate${String(lineNo).padStart(4, "0")}`,
    });
    if (!planned.ok) return c.json({ error: planned.error }, 400);
    const stockWrites = planned.plan.writes.filter((write) => write.kind !== "create_purchase");
    const stockApplied = await applyReceiveWrites({ token, writes: stockWrites });
    for (const made of stockApplied.stock) {
      const lineNo = Number(made.lineKey.split(":").pop());
      const temp = `recPendCreate${String(lineNo).padStart(4, "0")}`;
      for (const line of planned.plan.purchase.lines) if (line.stockRecordId === temp) line.stockRecordId = made.recordId;
      for (const movement of planned.plan.movements) if (movement.recordId === temp) movement.recordId = made.recordId;
      for (const lot of planned.plan.lots) if (lot.recordId === temp) lot.recordId = made.recordId;
      for (const write of planned.plan.writes) {
        if (write.kind === "create_purchase" && write.lineKey === made.lineKey && Array.isArray(write.fields["Stock row"])) {
          write.fields["Stock row"] = [made.recordId];
        }
      }
    }
    const purchaseWrites = planned.plan.writes.filter((write) => write.kind === "create_purchase");
    const purchaseApplied = await applyReceiveWrites({ token, writes: purchaseWrites });
    const stored = await saveReceipt(c.env, planned.plan);
    const applied = { created: [...stockApplied.created, ...purchaseApplied.created], patched: [...stockApplied.patched, ...purchaseApplied.patched], stock: stockApplied.stock };
    return c.json({ purchase: planned.plan.purchase, movementsInserted: stored.movementsInserted, creditsInserted: stored.creditsInserted, airtable: applied });
  } catch (error) {
    if (isMissingPurchases(error)) return c.json({ error: "Purchases are not in this database yet. Apply migration 0010 before go-live. Nothing was written." }, 503);
    throw error;
  }
});

app.get("/api/credit", async (c) => {
  try {
    const entries = await listCredit(c.env, c.var.tenant.id);
    const liability = await readLiability(c.env, c.var.tenant.id);
    return c.json({ ...liability, entries, readOnly: true });
  } catch (error) {
    if (isMissingPurchases(error)) return c.json({ error: "The store credit ledger is not in this database yet. Apply migration 0010 before go-live. Nothing was written." }, 503);
    throw error;
  }
});

app.post("/api/credit/redeem", async (c) => {
  if (!canManageConnections(c)) return c.json({ error: "Only an organization admin can redeem store credit." }, 403);
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const customerRef = typeof body.value.customerRef === "string" ? body.value.customerRef : "";
  const sourceRef = typeof body.value.sourceRef === "string" ? body.value.sourceRef : "";
  const amountCents = Number(body.value.amountCents);
  const occurredOn = typeof body.value.occurredOn === "string" ? body.value.occurredOn : new Date().toISOString().slice(0, 10);
  try {
    const planned = draftRedemption({ tenantId: c.var.tenant.id, customerRef, amountCents, sourceRef, now: new Date().toISOString(), occurredOn });
    if (!planned.ok) return c.json({ error: planned.error }, 400);
    const saved = await saveRedemption(c.env, planned.entry);
    return c.json({ entry: saved.entry, created: saved.created });
  } catch (error) {
    if (isMissingPurchases(error)) return c.json({ error: "The store credit ledger is not in this database yet. Apply migration 0010 before go-live. Nothing was written." }, 503);
    throw error;
  }
});

app.get("*", async (c) => {
  const raw = pageAssetRequest(c.req.raw);
  let response = await c.env.ASSETS.fetch(raw);
  const headers = new Headers(response.headers);
  if ((headers.get("content-type") ?? "").includes("text/html") && response.status === 200) {
    // Cache-bust: every same-origin script and stylesheet gets ?v=<deployed version>, and the HTML itself is never
    // reused without revalidating, so a deploy shows up on the next page load.
    response = withAssetVersion(response, assetVersion(c.env));
    headers.set("cache-control", "no-cache");
    headers.delete("etag"); headers.delete("content-length");
  }
  headers.set("content-security-policy", contentSecurityPolicy(c.env, PREVIEW_IMAGE_HOSTS));
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
});

app.onError((error, c) => {
  if (error instanceof PurchaseSafetyError) return c.json({ error: error.message }, error.status);
  if (error.message.includes('purchase_no_longer_accepted')) return c.json({ error: 'This purchase is no longer an editable draft.' }, 409);
  if (error instanceof InventoryReadError) return c.json({ error: error.message }, 503);
  if (error instanceof ConnectionError) return c.json({ error: error.message }, error.status === 503 ? 503 : error.status === 409 ? 409 : 400);
  if (error instanceof CardTraderError) return c.json({ error: error.message }, 502);
  if (error instanceof AirtableError) {
    const status = error.status === 503 ? 503 : error.status >= 500 ? 502 : 400;
    return c.json({ error: error.message }, status);
  }
  console.log(JSON.stringify({ level: "error", message: error instanceof Error ? error.message : "unknown" }));
  return c.json({ error: "Something went wrong." }, 500);
});

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

function inventoryQuery(query: Record<string, string>): InventoryFilter {
  const flag = query.flag;
  const cost = query.cost;
  return {
    game: query.game || undefined,
    condition: query.condition || undefined,
    finish: query.finish || undefined,
    q: query.q || undefined,
    flag: flag === "low" || flag === "overstock" || flag === "slow" || flag === "review" ? flag : undefined,
    cost: cost === "known" || cost === "unknown" ? cost : undefined,
  };
}

/** Ledger rows plus an optional read-only Buy List match. Never writes Airtable. */
async function loadLedger(c: AppContext, recordId: string | null = null): Promise<{ movements: Awaited<ReturnType<typeof listMovements>>; buyList: BuyListInput[]; thresholds: Awaited<ReturnType<typeof readThresholds>>; wantQtyState: "matched" | "unread"; now: Date }> {
  const movements = await listMovements(c.env, c.var.tenant.id, recordId);
  const thresholds = await readThresholds(c.env, c.var.tenant.id);
  let buyList: BuyListInput[] = [];
  let wantQtyState: "matched" | "unread" = "unread";
  const token = c.env.AIRTABLE_API_KEY?.trim() || c.env.AIRTABLE_PAT?.trim() || "";
  if (token && c.var.tenant.airtableBaseId === WAITLIST_BASE_ID) {
    try {
      buyList = await loadBuyList(token);
      wantQtyState = "matched";
    } catch (error) {
      console.error("inventory buy list read failed", error instanceof Error ? error.message : "read failed");
    }
  }
  return { movements, buyList, thresholds, wantQtyState, now: new Date() };
}

async function safeLiability(c: AppContext) {
  try {
    return await readLiability(c.env, c.var.tenant.id);
  } catch (error) {
    if (isMissingPurchases(error)) return null;
    throw error;
  }
}

function stockRowsFromLedger(movements: readonly MovementDraft[]): { rows: WaitlistInput[]; onHandByRecord: Map<string, number>; known: Set<string> } {
  const grouped = new Map<string, MovementDraft[]>();
  for (const movement of movements) {
    const list = grouped.get(movement.recordId) ?? [];
    list.push(movement);
    grouped.set(movement.recordId, list);
  }
  const rows: WaitlistInput[] = [];
  const onHandByRecord = new Map<string, number>();
  const known = new Set<string>();
  for (const [recordId, list] of grouped) {
    const snap = [...list].reverse().find((row) => row.snapshot)?.snapshot;
    if (!snap) continue;
    if (list.some((row) => row.unitCostCents != null)) known.add(recordId);
    const qty = onHand(list);
    onHandByRecord.set(recordId, qty);
    rows.push({
      id: recordId,
      fields: {
        "Card Name": snap.cardName,
        Game: snap.game,
        "Set #": snap.setNumber,
        "Set Identifier": snap.setIdentifier,
        "Collector Number": snap.collectorNumber,
        Finish: snap.finishRaw,
        Condition: snap.condition,
        Language: snap.language,
        Qty: qty,
        "Market Price USD": snap.marketPriceUsd,
        Status: snap.status,
      },
    });
  }
  return { rows, onHandByRecord, known };
}

async function openSellRequest(c: AppContext, sellRequestId: string): Promise<{ ok: true; request: SellRequestView; lines: CatalogLine[] } | { ok: false; error: string; status: 400 | 503 }> {
  const token = c.env.AIRTABLE_API_KEY?.trim() || c.env.AIRTABLE_PAT?.trim() || "";
  if (!token) return { ok: false, error: "Airtable is not configured on this server. Nothing was read.", status: 503 };
  const opened = await fetchSellRequest(token, sellRequestId);
  if (!opened.ok) return { ok: false, error: opened.error, status: 400 };
  const loaded = await loadLedger(c);
  const stock = stockRowsFromLedger(loaded.movements);
  const game = (effectiveGame(opened.request.game) ?? "Lorcana") as Game;
  const lines = matchLines(splitCardList(opened.request.cardsText, game), loaded.buyList, stock.rows, stock.onHandByRecord, stock.known);
  return { ok: true, request: opened.request, lines };
}

async function inventoryPayload(c: AppContext, filter: InventoryFilter) {
  const [loaded, stock] = await Promise.all([loadLedger(c), inventoryStock(c.var.tenantEnv)]);
  let liability = null;
  try {
    liability = await readLiability(c.env, c.var.tenant.id);
  } catch (error) {
    if (!isMissingPurchases(error)) throw error;
  }
  return buildLiveInventory({ tenantId: c.var.tenant.id, stock, movements: loaded.movements,
    buyList: loaded.buyList, thresholds: loaded.thresholds, filter, wantQtyState: loaded.wantQtyState, liability });
}

function backgroundEnrich(c: AppContext, id: string): void {
  const env = c.var.tenantEnv;
  try { c.executionCtx.waitUntil(enrichRecord(env, id).catch((e) => console.error("enrich failed", id, e instanceof Error ? e.message : e))); } catch { /* no ctx */ }
}

/** Best-effort trail of who changed what. A failed audit write never fails the request. */
function audit(c: AppContext, action: AuditAction, cards: { id: string }[]): void {
  const entries = cards.map((card) => ({ tenantId: c.var.tenant.id, userId: c.var.userId, action, recordId: card.id, snapshot: action === "delete" || action === "disconnect" ? null : card }));
  const work = recordAudit(c.env, entries).catch((e) => console.error("audit failed", action, e instanceof Error ? e.message : e));
  try { c.executionCtx.waitUntil(work); } catch { /* no ctx */ }
}

function withAssetVersion(response: Response, version: string): Response {
  return new HTMLRewriter()
    .on("script[src]", { element(el) { const u = versionedUrl(el.getAttribute("src"), version); if (u) el.setAttribute("src", u); } })
    .on('link[rel="stylesheet"][href]', { element(el) { const u = versionedUrl(el.getAttribute("href"), version); if (u) el.setAttribute("href", u); } })
    .transform(response);
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // One "*/5" trigger keeps a single schedule: enrichment rides on it every 10th minute instead of
    // having its own "*/10".
    const at = new Date(event.scheduledTime);
    const jobs = cronJobs(event.cron, at);
    if (jobs.sales) ctx.waitUntil(salesCron(env, at));
    if (jobs.sweep) ctx.waitUntil(allocationSweepCron(env));
    // Keep the stored Scryfall set list fresh off the request path (no-op while it is under 24 h old).
    { const store = scryfallStore(env); if (store) ctx.waitUntil(refreshScryfallStore(store).then((r) => { if (r === "refreshed") console.log("scryfall sets refreshed"); }).catch((e) => console.error("SCRYFALL REFRESH FAILED", String(e)))); }
    if (!jobs.enrich) return;
    ctx.waitUntil((async () => {
      let tenants: Tenant[];
      try { tenants = await listTenants(env); } catch (e) { console.error("cron tenants failed", e instanceof Error ? e.message : e); return; }
      for (const tenant of tenants) {
        try {
          const scoped = tenantEnv(env, tenant);
          const r = await enrichPending(scoped);
          console.log("cron enrich", JSON.stringify({ tenant: tenant.id, picked: r.picked, enriched: r.enriched, failed: r.failed.length, firstError: r.failed[0]?.error, ai: r.ai }));
          // Failed Waitlist rows stay pending and are re-picked every run; always leave Listed a budget.
          {
            const l = await enrichPendingListed(scoped, Math.max(10, 25 - r.enriched));
            if (l.picked) console.log("cron enrich listed", JSON.stringify({ tenant: tenant.id, picked: l.picked, enriched: l.enriched, failed: l.failed.length }));
          }
          // Then re-check prices on one page of already-sorted rows; the page moves on every run.
          const s = await rescanPage(scoped, null, (total) => rescanSlotOffset(total, Date.now()));
          console.log("cron rescan", JSON.stringify({ tenant: tenant.id, offset: s.offset, total: s.total, scanned: s.scanned, changed: s.changed.length, failed: s.failed.length, firstError: s.failed[0]?.error }));
        } catch (e) { console.error("cron enrich failed", tenant.id, e instanceof Error ? e.message : e); }
      }
    })());
  },
} satisfies ExportedHandler<Env>;

/**
 * Every 15 minutes: settle stale unanswered allocation writes by proof (sweepStaleAllocations). Read-only toward
 * CardTrader, and runs with ALLOCATIONS_ENABLED off too (see allocations.ts). No-op before migration 0013.
 */
export async function allocationSweepCron(env: Env, deps = productionAllocationDeps(env)): Promise<void> {
  try { await sweepStaleAllocations(deps); }
  catch (e) {
    if (missingAllocationTables(e)) return;
    console.error("cron allocation sweep failed", e instanceof Error ? e.message.slice(0, 200) : e);
  }
}

/** True at the daily email's minute: 9:00 AM America/New_York (EDT or EST). */
export function isDailyEmailSlot(at: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value); const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return hour === 9 && minute < 5;
}

async function salesCron(env: Env, at: Date): Promise<void> {
  const reconcileDue = at.getUTCMinutes() % 15 === 0;
  const dailyDue = isDailyEmailSlot(at);
  if (salesMode(env) === "off" && (!reconcileDue || reconcileMode(env) === "off") && (!dailyDue || !dailyEmailOn(env))) return;
  let tenants: Tenant[];
  try { tenants = await listTenants(env); } catch (e) { console.error("sales cron tenants failed", e instanceof Error ? e.message : e); return; }
  for (const tenant of tenants) {
    try {
      const polled = await pollCardTrader(env, tenant);
      const dec = await runDecrements(env, tenant);
      if (polled || dec) console.log("cron sales", JSON.stringify({ tenant: tenant.id, polled, applied: dec?.applied, oversold: dec?.oversold, flagged: dec?.flagged, skipped: dec?.skipped }));
    } catch (e) { console.error("cron sales failed", tenant.id, e instanceof Error ? e.message : e); }
    if (reconcileDue) { try { await runReconcile(env, tenant); } catch (e) { console.error("cron reconcile failed", tenant.id, e instanceof Error ? e.message : e); } }
    if (dailyDue) { try { await sendDailyPull(env, tenant); } catch (e) { console.error("cron tcgplayer email failed", tenant.id, e instanceof Error ? e.message : e); } }
  }
}

function mailtoLink(message: string): string {
  return `mailto:?subject=${encodeURIComponent("Hekla intake")}&body=${encodeURIComponent(message)}`;
}

async function readJson(c: { req: { text: () => Promise<string> } }): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  let text = "";
  try {
    text = await c.req.text();
  } catch {
    return { ok: false, error: "Could not read the request." };
  }
  if (text.length > 100_000) return { ok: false, error: "Request is too large." };
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Expected a JSON object." };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: "That was not valid JSON." };
  }
}

function readGame(input: string | undefined): Game | null {
  return canonicalGame(input?.trim() ? input : "Lorcana");
}

function gameError(): string {
  return "Game must be Lorcana, Magic: The Gathering, Riftbound, Pokémon, or Yu-Gi-Oh!.";
}

function draftAsCard(card: DraftCard, id: string): QueueCard {
  return {
    id,
    name: card.cardName ?? "",
    cardName: card.cardName ?? null,
    resolvedName: null,
    autoRank: null, rarity: card.rarity ?? null, costBasisUsd: card.costBasisUsd ?? null, cardType: null, recommendation: null, rankReason: null, enrichedAt: null, priceSource: null,
    game: card.game,
    setNumber: card.game === "Lorcana" ? card.setNumber : null,
    setIdentifier: card.game === "Lorcana" ? null : card.setIdentifier,
    setName: null,
    collectorNumber: card.collectorNumber,
    finish: card.finish,
    condition: card.condition,
    qty: card.qty,
    status: "Waitlist",
    rankScore: null,
    marketPriceUsd: null,
    notes: card.notes ?? null,
    priority: card.priority ?? null,
    createdTime: "",
  };
}

async function resolveMagicBulk(token: string | null, rows: ParsedRow[]): Promise<ParsedRow[]> {
  const out: ParsedRow[] = [];
  for (const row of rows) {
    if (!row.card) { out.push(row); continue; }
    const resolved = await resolveMagicDraft(token, row.card);
    out.push(resolved.ok ? { ...row, card: resolved.card } : { line: row.line, raw: row.raw, error: resolved.error });
  }
  return out;
}

function previewRows(rows: ParsedRow[], open: QueueCard[]) {
  const virtual: QueueCard[] = [];
  return rows.map((row) => {
    if (!row.card) return { line: row.line, raw: row.raw, error: row.error, matches: [], alsoInPaste: [] as number[] };
    const matches = duplicatesAmong(open, row.card);
    const alsoInPaste = duplicatesAmong(virtual, row.card)
      .map((card) => Number(card.id.replace("line-", "")))
      .filter((line) => Number.isFinite(line));
    virtual.push(draftAsCard(row.card, `line-${row.line}`));
    return {
      line: row.line,
      raw: row.raw,
      card: row.card,
      matches,
      alsoInPaste,
    };
  });
}
