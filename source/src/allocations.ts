/**
 * Signed pick-list allocation. The deckbuilder asks Hekla to lower or raise the CardTrader listing for one
 * Waitlist row. Airtable Qty is not changed here. CT_SALES_MODE is not consulted: a deck sale is only a log line
 * with decrement_owner 'none', so the CardTrader sales decrement never lowers Qty for it.
 *
 * Listings are matched to the row by user_data_field or the row's saved CardTrader Listing ID, never by name. A
 * reserve deletes a listing it would leave at 0, and a listing that is gone is a stored 409 conflict, not a retry.
 * A release with no live listing creates one. A finalize deletes any listing for the row still sitting at 0.
 *
 * The endpoint stays dark until ALLOCATIONS_ENABLED is on. Repeating an idempotency key returns the stored
 * result and does not call CardTrader again.
 */
import type { CtListing } from "./cardtrader.ts";
import { deleteProduct, exportListings, incrementListing, relistProduct } from "./cardtrader.ts";
import { purchasesAllowed } from "./purchase-access.ts";
import { verifyStarfoil } from "./hmac.ts";
import { listableQty } from "./listable.ts";
import type { SaleLine } from "./sales.ts";
import { neonSaleStore } from "./salesdb.ts";
import { recordCardTraderListing, stockCardsByIds, type StockCard } from "./airtable.ts";
import { connectionSecret } from "./connections.ts";
import { listTenants, tenantById, tenantEnv } from "./tenants.ts";
import { neonAllocationStore } from "./allocationsdb.ts";

export type AllocationOp = "reserve" | "release" | "finalize_built" | "finalize_sold";

export type AllocationRequest = {
  op: AllocationOp;
  idempotency_key: string;
  allocation_id: string;
  deck_id: string;
  waitlist_record_id: string;
  qty: number;
  game: "riftbound";
  /** finalize_sold only: the sale's order id and line key. The sales log dedupes on (order_id, line_key). */
  order_id?: string;
  line_key?: string;
};

export type AllocationResponse = {
  ok: boolean;
  applied?: boolean;
  error?: string;
  ct_listing_id?: number | null;
  ct_qty_before?: number | null;
  ct_qty_after?: number | null;
  /** Price of the listing a reserve lowered or deleted, so a later release can list it again at that price. */
  ct_price_cents?: number | null;
  note?: string;
};

export type StoredAllocation = {
  httpStatus: number;
  body: AllocationResponse;
  allocationId: string;
  deckId: string;
  op: string;
  recordId: string;
  qty: number;
};

export interface AllocationStore {
  get(tenantId: string, key: string): Promise<StoredAllocation | null>;
  /** Inserts the result once. "exists" means another request already stored this key. */
  put(tenantId: string, key: string, row: StoredAllocation): Promise<"stored" | "exists">;
  /** ct_price_cents from the newest stored reserve for this allocation, or null. */
  reservePrice(tenantId: string, allocationId: string): Promise<number | null>;
}

export type AllocationDeps = {
  tenant: () => Promise<{ id: string } | null>;
  store: AllocationStore;
  listings: (tenantId: string) => Promise<CtListing[]>;
  increment: (tenantId: string, productId: number, delta: number) => Promise<void>;
  /** Deletes a CardTrader listing. A listing at qty 0 is never left behind. */
  remove: (tenantId: string, productId: number) => Promise<void>;
  loadCard: (tenantId: string, recordId: string) => Promise<StockCard | null>;
  relist: (tenantId: string, card: StockCard, quantity: number, fallbackPriceCents: number | null) => Promise<{ productId: number; note?: string }>;
  insertSale: (tenantId: string, line: SaleLine) => Promise<void>;
};

const OPS = new Set<AllocationOp>(["reserve", "release", "finalize_built", "finalize_sold"]);

/** Off unless the var is on, true, or 1. Unset and "false" both keep the endpoint closed. */
export function allocationsEnabled(env: { ALLOCATIONS_ENABLED?: string }): boolean {
  const v = (env.ALLOCATIONS_ENABLED ?? "").trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

function textId(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || /[\u0000-\u001f]/.test(value)) return null;
  return value;
}

export function parseAllocation(value: unknown): { ok: true; request: AllocationRequest } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Expected a JSON object." };
  const body = value as Record<string, unknown>;
  if (!OPS.has(body.op as AllocationOp)) return { ok: false, error: "op must be reserve, release, finalize_built, or finalize_sold." };
  const idempotency_key = textId(body.idempotency_key);
  const allocation_id = textId(body.allocation_id);
  const deck_id = textId(body.deck_id);
  if (!idempotency_key || !allocation_id || !deck_id) return { ok: false, error: "idempotency_key, allocation_id, and deck_id are required." };
  if (typeof body.waitlist_record_id !== "string" || !/^rec[A-Za-z0-9]{14}$/.test(body.waitlist_record_id)) return { ok: false, error: "waitlist_record_id must be an Airtable record id." };
  if (!Number.isInteger(body.qty) || (body.qty as number) < 1 || (body.qty as number) > 9999) return { ok: false, error: "qty must be a whole number from 1 to 9999." };
  if (body.game !== "riftbound") return { ok: false, error: "game must be riftbound." };
  const order_id = body.order_id === undefined ? undefined : textId(body.order_id);
  const line_key = body.line_key === undefined ? undefined : textId(body.line_key);
  if (order_id === null || line_key === null) return { ok: false, error: "order_id and line_key must be short text." };
  if (body.op === "finalize_sold" && (!order_id || !line_key)) return { ok: false, error: "finalize_sold needs order_id and line_key." };
  return {
    ok: true,
    request: {
      op: body.op as AllocationOp,
      idempotency_key,
      allocation_id,
      deck_id,
      waitlist_record_id: body.waitlist_record_id,
      qty: body.qty as number,
      game: "riftbound",
      ...(order_id ? { order_id } : {}),
      ...(line_key ? { line_key } : {}),
    },
  };
}

/** A deck sale in the existing sales log. Deduped on (order_id, line_key), falling back to deck_id and idempotency_key. Never a Qty decrement. */
export function allocationSaleLine(input: AllocationRequest, card: Pick<StockCard, "name" | "resolvedName" | "marketPriceUsd"> | null, soldAt: string): SaleLine {
  const price = card?.marketPriceUsd;
  const unit = typeof price === "number" && Number.isFinite(price) && price > 0 ? Math.round(price * 100) : 0;
  const name = (card?.resolvedName || card?.name || "").trim();
  return {
    platform: "allocation",
    externalOrderId: input.order_id ?? input.deck_id,
    orderCode: input.allocation_id,
    lineKey: input.line_key ?? input.idempotency_key,
    recordId: input.waitlist_record_id,
    game: "Riftbound",
    cardName: name ? name.slice(0, 200) : null,
    qty: input.qty,
    currency: "USD",
    grossCents: unit * input.qty,
    feeCents: null,
    netCents: null,
    soldAt,
    orderState: "sold",
    decrementOwner: "none",
    raw: { source: "allocation", op: input.op, allocationId: input.allocation_id, deckId: input.deck_id, idempotencyKey: input.idempotency_key },
  };
}

function sameRequest(stored: StoredAllocation, input: AllocationRequest): boolean {
  return stored.op === input.op && stored.allocationId === input.allocation_id && stored.deckId === input.deck_id
    && stored.recordId === input.waitlist_record_id && stored.qty === input.qty;
}

function replay(stored: StoredAllocation): { status: number; body: AllocationResponse } {
  return { status: stored.httpStatus, body: { ...stored.body, applied: false } };
}

function done(status: number, body: AllocationResponse): { status: number; body: AllocationResponse; persist: boolean } {
  return { status, body, persist: true };
}

type Outcome = { status: number; body: AllocationResponse; persist: boolean };

/**
 * The CardTrader listings that hold this Waitlist row: user_data_field is the record id, or the listing id is the
 * one saved on the row (and the listing is not tagged for another row). Never matched by card name.
 */
export function rowListings(all: CtListing[], recordId: string, storedListingId: string | null | undefined): CtListing[] {
  const stored = storedListingId?.trim() || null;
  return all.filter((listing) => listing.recordId === recordId || (stored !== null && String(listing.id) === stored && listing.recordId === null));
}

/** Live listings only: a qty-0 or stale listing is skipped. */
function liveListings(all: CtListing[], recordId: string, storedListingId: string | null | undefined): CtListing[] {
  return rowListings(all, recordId, storedListingId).filter((listing) => listing.quantity > 0);
}

const statusOf = (error: unknown): number | null =>
  error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : null;

/** A reserve that finds the listing gone is a conflict to flag, not a CardTrader failure to retry. */
function listingMissing(before: number, after: number, priceCents: number | null, note: string): Outcome {
  return done(409, { ok: false, applied: true, error: "ct_listing_missing", ct_listing_id: null, ct_qty_before: before, ct_qty_after: after, ct_price_cents: priceCents, note });
}

/** Lowers a listing by take, or deletes it when take is all of it. */
async function lower(tenantId: string, listing: CtListing, take: number, deps: AllocationDeps): Promise<void> {
  if (take >= listing.quantity) await deps.remove(tenantId, listing.id);
  else await deps.increment(tenantId, listing.id, -take);
}

/** After a finalize, deletes any listing for the row that is still at qty 0. Best effort: never fails the finalize. */
async function deleteEmptyListings(input: AllocationRequest, tenantId: string, deps: AllocationDeps): Promise<string | null> {
  try {
    const card = await deps.loadCard(tenantId, input.waitlist_record_id).catch(() => null);
    const empty = rowListings(await deps.listings(tenantId), input.waitlist_record_id, card?.cardTraderListingId).filter((listing) => listing.quantity <= 0);
    const deleted: number[] = [];
    for (const listing of empty) {
      try { await deps.remove(tenantId, listing.id); deleted.push(listing.id); }
      catch (error) { if (statusOf(error) === 404) deleted.push(listing.id); else throw error; }
    }
    return deleted.length ? `deleted_empty_listings:${deleted.join(",")}` : null;
  } catch (error) {
    console.error("allocation finalize cleanup failed", error instanceof Error ? error.message : error);
    return "empty_listing_cleanup_failed";
  }
}

async function changeCardTrader(input: AllocationRequest, tenantId: string, deps: AllocationDeps): Promise<Outcome> {
  if (input.op === "finalize_built") {
    const cleanup = await deleteEmptyListings(input, tenantId, deps);
    return done(200, { ok: true, applied: true, ct_listing_id: null, ct_qty_before: null, ct_qty_after: null, note: cleanup ? `recorded;${cleanup}` : "recorded" });
  }
  if (input.op === "finalize_sold") {
    // Sales log only. TCGplayer has no API: this line reaches the manual TCGplayer pull list through the sales log.
    const card = await deps.loadCard(tenantId, input.waitlist_record_id).catch(() => null);
    await deps.insertSale(tenantId, allocationSaleLine(input, card, new Date().toISOString()));
    const cleanup = await deleteEmptyListings(input, tenantId, deps);
    return done(200, { ok: true, applied: true, ct_listing_id: null, ct_qty_before: null, ct_qty_after: null, note: cleanup ? `sale_logged;${cleanup}` : "sale_logged" });
  }
  const card = await deps.loadCard(tenantId, input.waitlist_record_id).catch(() => null);
  const storedId = card?.cardTraderListingId ?? null;
  const mine = liveListings(await deps.listings(tenantId), input.waitlist_record_id, storedId);
  const before = mine.reduce((sum, listing) => sum + listing.quantity, 0);
  const ordered = [...mine].sort((a, b) => b.quantity - a.quantity || a.id - b.id);
  const priceCents = ordered.find((listing) => typeof listing.priceCents === "number" && listing.priceCents > 0)?.priceCents ?? null;
  if (input.op === "reserve") {
    if (mine.length === 0) {
      // The row says it has a CardTrader listing, but none is live: the listing was deleted or sits at 0.
      if (storedId) return listingMissing(0, 0, null, `CardTrader listing ${storedId} is gone or at 0`);
      return done(200, { ok: true, applied: true, ct_listing_id: null, ct_qty_before: null, ct_qty_after: null, note: "not_listed" });
    }
    let taken = 0;
    try {
      if (before < input.qty) {
        for (const listing of ordered) { await deps.remove(tenantId, listing.id); taken += listing.quantity; }
        return done(409, { ok: false, applied: true, error: "insufficient_ct_qty", ct_listing_id: null, ct_qty_before: before, ct_qty_after: 0, ct_price_cents: priceCents });
      }
      let left = input.qty;
      for (const listing of ordered) {
        if (left <= 0) break;
        const take = Math.min(listing.quantity, left);
        await lower(tenantId, listing, take, deps);
        taken += take;
        left -= take;
      }
    } catch (error) {
      if (statusOf(error) === 404) return listingMissing(before, before - taken, priceCents, "CardTrader listing disappeared during reserve");
      throw error;
    }
    let left = input.qty;
    const still: [number, number][] = [];
    for (const listing of ordered) {
      const take = Math.min(listing.quantity, Math.max(0, left));
      left -= take;
      if (listing.quantity - take > 0) still.push([listing.id, listing.quantity - take]);
    }
    still.sort((a, b) => b[1] - a[1]);
    return done(200, {
      ok: true, applied: true, ct_listing_id: still[0]?.[0] ?? null, ct_qty_before: before, ct_qty_after: before - input.qty, ct_price_cents: priceCents,
    });
  }
  if (mine.length > 0) {
    const into = ordered[0]!;
    try {
      await deps.increment(tenantId, into.id, input.qty);
      return done(200, { ok: true, applied: true, ct_listing_id: into.id, ct_qty_before: before, ct_qty_after: before + input.qty });
    } catch (error) {
      // Deleted by hand after the export was read: list it again below.
      if (statusOf(error) !== 404 || mine.length > 1) throw error;
    }
  }
  if (!card) return { status: 404, body: { ok: false, error: "record_not_found" }, persist: false };
  const free = listableQty(card);
  if (free < 1) {
    return done(200, { ok: true, applied: true, ct_listing_id: null, ct_qty_before: null, ct_qty_after: null, note: "no_free_qty" });
  }
  const lastPrice = await deps.store.reservePrice(tenantId, input.allocation_id).catch(() => null);
  let created: { productId: number; note?: string };
  try { created = await deps.relist(tenantId, card, free, lastPrice); }
  catch (error) {
    // CardTrader or the row refused the listing (no usable price, no blueprint). Flag it; a retry would fail the same way.
    if (statusOf(error) === 422) {
      const message = error instanceof Error ? error.message : "relist refused";
      return done(409, { ok: false, applied: true, error: "ct_relist_failed", ct_listing_id: null, ct_qty_before: 0, ct_qty_after: 0, note: message.slice(0, 200) });
    }
    throw error;
  }
  return done(200, {
    ok: true, applied: true, ct_listing_id: created.productId, ct_qty_before: 0, ct_qty_after: free, note: created.note ?? "relisted",
  });
}

export async function handleAllocation(
  env: { ALLOCATIONS_ENABLED?: string; ALLOCATION_HMAC_SECRET?: string },
  rawBody: string | null,
  timestamp: string | null,
  signature: string | null,
  deps: AllocationDeps,
  nowMs = Date.now(),
): Promise<{ status: number; body: AllocationResponse }> {
  if (!allocationsEnabled(env)) return { status: 503, body: { ok: false, error: "allocations_disabled" } };
  if (rawBody == null) return { status: 413, body: { ok: false, error: "Too large." } };
  const secret = env.ALLOCATION_HMAC_SECRET?.trim();
  if (!secret) return { status: 503, body: { ok: false, error: "allocations_not_configured" } };
  // Same construction as starfoil: hex HMAC-SHA256 of `${timestamp}.${rawBody}`, refused when the clock is off by more than 5 minutes.
  if (!(await verifyStarfoil(secret, rawBody, timestamp, signature, nowMs))) return { status: 401, body: { ok: false, error: "unauthorized" } };
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); } catch { return { status: 400, body: { ok: false, error: "That was not valid JSON." } }; }
  const request = parseAllocation(parsed);
  if (!request.ok) return { status: 400, body: { ok: false, error: request.error } };

  let tenant: { id: string } | null;
  try { tenant = await deps.tenant(); }
  catch (error) {
    console.error("allocation tenant lookup failed", error instanceof Error ? error.message : error);
    return { status: 503, body: { ok: false, error: "allocations_unavailable" } };
  }
  if (!tenant) return { status: 503, body: { ok: false, error: "allocations_tenant_missing" } };

  const stored = await deps.store.get(tenant.id, request.request.idempotency_key);
  if (stored) {
    if (!sameRequest(stored, request.request)) return { status: 409, body: { ok: false, error: "idempotency_conflict" } };
    return replay(stored);
  }

  let outcome: Outcome;
  try { outcome = await changeCardTrader(request.request, tenant.id, deps); }
  catch (error) {
    if (error instanceof AllocationError) return { status: error.status, body: { ok: false, error: error.message } };
    const message = error instanceof Error ? error.message : "CardTrader request failed.";
    return { status: 502, body: { ok: false, error: "cardtrader_failed", note: message.slice(0, 200) } };
  }
  if (!outcome.persist) return { status: outcome.status, body: outcome.body };

  const row: StoredAllocation = {
    httpStatus: outcome.status,
    body: outcome.body,
    allocationId: request.request.allocation_id,
    deckId: request.request.deck_id,
    op: request.request.op,
    recordId: request.request.waitlist_record_id,
    qty: request.request.qty,
  };
  const saved = await deps.store.put(tenant.id, request.request.idempotency_key, row);
  if (saved === "exists") {
    const winner = await deps.store.get(tenant.id, request.request.idempotency_key);
    if (winner && sameRequest(winner, request.request)) return replay(winner);
    return { status: 409, body: { ok: false, error: "idempotency_conflict" } };
  }
  console.log(JSON.stringify({ event: "allocation", op: request.request.op, status: outcome.status, record: request.request.waitlist_record_id }));
  return { status: outcome.status, body: outcome.body };
}

export class AllocationError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

async function sellerToken(env: Env, tenantId: string): Promise<string> {
  const token = await connectionSecret(env, tenantId, "cardtrader");
  if (!token) throw new AllocationError("cardtrader_not_connected", 503);
  return token;
}

/**
 * The relist price: the Waitlist Market Price USD when Export would accept it (a CardTrader market price),
 * otherwise the price of the listing the reserve took down.
 */
export function relistPrice(card: Pick<StockCard, "marketPriceUsd" | "priceSource">, fallbackPriceCents: number | null): { marketPriceUsd: number | null; priceSource: string | null } {
  const waitlist = card.marketPriceUsd;
  if (typeof waitlist === "number" && waitlist >= 0.01 && (card.priceSource ?? "").startsWith("CardTrader market")) {
    return { marketPriceUsd: waitlist, priceSource: card.priceSource };
  }
  if (typeof fallbackPriceCents === "number" && fallbackPriceCents >= 1) {
    return { marketPriceUsd: fallbackPriceCents / 100, priceSource: "CardTrader market (last listing)" };
  }
  return { marketPriceUsd: card.marketPriceUsd, priceSource: card.priceSource };
}

export function asExportCard(card: StockCard, quantity: number, fallbackPriceCents: number | null = null) {
  return {
    id: card.id, game: card.game, setNumber: card.setNumber, setIdentifier: card.setIdentifier, collectorNumber: card.collectorNumber,
    name: card.name, resolvedName: card.resolvedName, finish: card.finish, condition: card.condition, qty: quantity, status: card.status,
    ...relistPrice(card, fallbackPriceCents), cardTraderListingId: null,
  };
}

export function productionAllocationDeps(env: Env): AllocationDeps {
  const store = neonAllocationStore(env);
  return {
    async tenant() {
      // The deckbuilder does not name a tenant. This is the shop organization, the same gate purchasing uses.
      const tenants = await listTenants(env);
      return tenants.find((tenant) => purchasesAllowed(tenant)) ?? null;
    },
    store,
    async listings(tenantId) {
      return exportListings(await sellerToken(env, tenantId));
    },
    async increment(tenantId, productId, delta) {
      await incrementListing(await sellerToken(env, tenantId), productId, delta);
    },
    async remove(tenantId, productId) {
      await deleteProduct(await sellerToken(env, tenantId), productId);
    },
    async loadCard(tenantId, recordId) {
      const tenant = await tenantById(env, tenantId);
      if (!tenant) return null;
      const [card] = await stockCardsByIds(tenantEnv(env, tenant), [recordId]);
      return card ?? null;
    },
    async relist(tenantId, card, quantity, fallbackPriceCents) {
      const tenant = await tenantById(env, tenantId);
      if (!tenant) throw new AllocationError("allocations_tenant_missing", 503);
      const listing = await relistProduct(await sellerToken(env, tenantId), asExportCard(card, quantity, fallbackPriceCents));
      let note: string | undefined;
      try { await recordCardTraderListing(tenantEnv(env, tenant), card.id, listing.productId); }
      catch { note = "listing_id_not_saved"; }
      return { productId: listing.productId, note };
    },
    async insertSale(tenantId, line) {
      await neonSaleStore(env).insertLines(tenantId, [line]);
    },
  };
}
