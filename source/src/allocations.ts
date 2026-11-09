/**
 * Signed pick-list allocation. The deckbuilder asks Hekla to lower or raise the CardTrader listing for one
 * Waitlist row. Airtable Qty is not changed here. CT_SALES_MODE is not consulted: a deck sale is only a log line
 * with decrement_owner 'none', so the CardTrader sales decrement never lowers Qty for it.
 *
 * Listings are matched to the row by user_data_field or the row's saved CardTrader Listing ID, never by name. A
 * reserve deletes a listing it would leave at 0, and a listing that is gone is a stored 409 conflict, not a retry.
 * A release with no live listing creates one. A finalize deletes any listing for the row still sitting at 0.
 *
 * A release puts back only the released copies, capped by free stock less what is already listed.
 *
 * Each key is claimed (pending) before any CardTrader call, and its CardTrader plan is saved before the first write.
 * A retry after a timeout or 5xx re-reads the export and only does the steps not yet at their end state. A
 * duplicate in flight waits briefly, then gets a retryable 503. One request at a time holds a Waitlist row's
 * listings (allocation_row_locks). Migration 0013 adds both.
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
  /** The net CardTrader quantity change this request made (negative for a reserve). Set on conflicts too. */
  ct_delta?: number;
  note?: string;
};

/** The request a key was first used for. A repeat must match it, order_id and line_key included. */
export type ClaimRow = {
  allocationId: string;
  deckId: string;
  op: string;
  recordId: string;
  qty: number;
  orderId: string | null;
  lineKey: string | null;
};

export type StoredAllocation = ClaimRow & { httpStatus: number; body: AllocationResponse };

/**
 * claimed: this request owns the key until the lease ends. plan is non-null when an earlier try saved one and may
 * have changed CardTrader. done: the stored answer. busy: another request holds the key. mismatch: the key was
 * used for a different request.
 */
export type Claim =
  | { kind: "claimed"; plan: CtPlan | null }
  | { kind: "done"; stored: StoredAllocation }
  | { kind: "busy" }
  | { kind: "mismatch" };

export interface AllocationStore {
  claim(tenantId: string, key: string, row: ClaimRow, token: string, leaseSeconds: number): Promise<Claim>;
  savePlan(tenantId: string, key: string, token: string, plan: CtPlan): Promise<void>;
  finish(tenantId: string, key: string, token: string, httpStatus: number, body: AllocationResponse): Promise<void>;
  /** Gives the key back at once and keeps any plan, so the next try reconciles instead of waiting for the lease. */
  abandon(tenantId: string, key: string, token: string): Promise<void>;
  /** ct_price_cents from the newest finished reserve for this allocation, or null. */
  reservePrice(tenantId: string, allocationId: string): Promise<number | null>;
  /** A short lease on one Waitlist row's CardTrader listings. false means another request holds it. */
  lockRow(tenantId: string, recordId: string, holder: string, seconds: number): Promise<boolean>;
  unlockRow(tenantId: string, recordId: string, holder: string): Promise<void>;
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
  /** Waits between checks on a duplicate in flight. Tests replace it. */
  sleep?: (ms: number) => Promise<void>;
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

function replay(stored: StoredAllocation): { status: number; body: AllocationResponse } {
  return { status: stored.httpStatus, body: { ...stored.body, applied: false } };
}

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

/**
 * What one request means to do on CardTrader, saved before the first CardTrader write. A retry of the same key
 * re-reads the export and checks each step against it, so a change that landed before a timeout is not sent twice.
 * `set` moves one listing from `from` to `to` (0 deletes it). `create` lists the row again; `existing` are the
 * row's listing ids when the plan was made, so a listing that appeared since then is the one this step created.
 */
export type CtStep =
  | { kind: "set"; listingId: number; from: number; to: number }
  | { kind: "create"; quantity: number; priceCents: number | null; existing: number[] };
export type CtPlan = { steps: CtStep[]; status: number; body: AllocationResponse };

const finalOutcome = (status: number, body: AllocationResponse): CtPlan => ({ steps: [], status, body });

/** Works out the CardTrader steps and the answer for reserve and release. Makes no CardTrader write. */
async function planChange(input: AllocationRequest, tenantId: string, all: CtListing[], card: StockCard | null, deps: AllocationDeps): Promise<CtPlan | "record_not_found"> {
  const storedId = card?.cardTraderListingId ?? null;
  const mine = liveListings(all, input.waitlist_record_id, storedId);
  const before = mine.reduce((sum, listing) => sum + listing.quantity, 0);
  const ordered = [...mine].sort((a, b) => b.quantity - a.quantity || a.id - b.id);
  const priceCents = ordered.find((listing) => typeof listing.priceCents === "number" && listing.priceCents > 0)?.priceCents ?? null;
  if (input.op === "reserve") {
    if (mine.length === 0) {
      // The row says it has a CardTrader listing, but none is live: the listing was deleted or sits at 0.
      if (storedId) {
        return finalOutcome(409, { ok: false, applied: true, error: "ct_listing_missing", ct_listing_id: null, ct_qty_before: 0, ct_qty_after: 0, ct_delta: 0, note: `CardTrader listing ${storedId} is gone or at 0` });
      }
      return finalOutcome(200, { ok: true, applied: true, ct_listing_id: null, ct_qty_before: null, ct_qty_after: null, ct_delta: 0, note: "not_listed" });
    }
    if (before < input.qty) {
      // Take what CardTrader has, and say how much (ct_delta), so the deckbuilder can put exactly that back on release.
      return {
        steps: ordered.map((listing) => ({ kind: "set", listingId: listing.id, from: listing.quantity, to: 0 })),
        status: 409,
        body: { ok: false, applied: true, error: "insufficient_ct_qty", ct_listing_id: null, ct_qty_before: before, ct_qty_after: 0, ct_delta: -before, ct_price_cents: priceCents },
      };
    }
    let left = input.qty;
    const steps: CtStep[] = [];
    const still: [number, number][] = [];
    for (const listing of ordered) {
      const take = Math.min(listing.quantity, Math.max(0, left));
      left -= take;
      if (take > 0) steps.push({ kind: "set", listingId: listing.id, from: listing.quantity, to: listing.quantity - take });
      if (listing.quantity - take > 0) still.push([listing.id, listing.quantity - take]);
    }
    still.sort((a, b) => b[1] - a[1]);
    return {
      steps, status: 200,
      body: { ok: true, applied: true, ct_listing_id: still[0]?.[0] ?? null, ct_qty_before: before, ct_qty_after: before - input.qty, ct_delta: -input.qty, ct_price_cents: priceCents },
    };
  }
  // release: put back only the released copies, capped so the row's listings never exceed its free stock.
  if (!card) return "record_not_found";
  const free = listableQty(card);
  const add = Math.min(input.qty, Math.max(0, free - before));
  if (add < 1) return finalOutcome(200, { ok: true, applied: true, ct_listing_id: null, ct_qty_before: before, ct_qty_after: before, ct_delta: 0, note: "no_free_qty" });
  if (ordered.length > 0) {
    const into = ordered[0]!;
    return {
      steps: [{ kind: "set", listingId: into.id, from: into.quantity, to: into.quantity + add }],
      status: 200,
      body: { ok: true, applied: true, ct_listing_id: into.id, ct_qty_before: before, ct_qty_after: before + add, ct_delta: add },
    };
  }
  const lastPrice = await deps.store.reservePrice(tenantId, input.allocation_id).catch(() => null);
  return {
    steps: [{ kind: "create", quantity: add, priceCents: lastPrice, existing: rowListings(all, input.waitlist_record_id, storedId).map((listing) => listing.id) }],
    status: 200,
    body: { ok: true, applied: true, ct_listing_id: null, ct_qty_before: 0, ct_qty_after: add, ct_delta: add, note: "relisted" },
  };
}

/**
 * Runs a plan against the listings just read. A step already at its end state is skipped. A step at neither its
 * start nor its end state means someone else changed the listing: stop and flag it. A 404 while deleting is
 * already done; a 404 while lowering is a missing listing; a 404 while raising lists the copies again.
 */
async function runPlan(
  input: AllocationRequest, tenantId: string, plan: CtPlan, all: CtListing[], card: StockCard | null, deps: AllocationDeps,
  save: (plan: CtPlan) => Promise<void>,
): Promise<{ status: number; body: AllocationResponse }> {
  const body: AllocationResponse = { ...plan.body };
  let delta = 0;
  const conflict = (error: string, note: string) => ({ status: 409, body: { ...body, ok: false, applied: true, error, ct_delta: delta, ct_qty_after: typeof body.ct_qty_before === "number" ? body.ct_qty_before + delta : null, note } });
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    if (step.kind === "set") {
      const now = all.find((listing) => listing.id === step.listingId);
      const current = now?.quantity ?? 0;
      if (current === step.to || (step.to === 0 && !now)) { delta += step.to - step.from; continue; }
      if (current !== step.from) return conflict("ct_changed_during_retry", `CardTrader listing ${step.listingId} is at ${current}, expected ${step.from} or ${step.to}`);
      try {
        if (step.to <= 0) await deps.remove(tenantId, step.listingId);
        else await deps.increment(tenantId, step.listingId, step.to - step.from);
        delta += step.to - step.from;
      } catch (error) {
        if (statusOf(error) !== 404) throw error;
        if (step.to <= 0) { delta += step.to - step.from; continue; }
        if (step.to < step.from) return conflict("ct_listing_missing", `CardTrader listing ${step.listingId} disappeared during reserve`);
        // Deleted by hand after the export was read: list the released copies again instead.
        const replaced: CtStep = { kind: "create", quantity: step.to - step.from, priceCents: await deps.store.reservePrice(tenantId, input.allocation_id).catch(() => null), existing: all.filter((listing) => listing.recordId === input.waitlist_record_id).map((listing) => listing.id) };
        plan = { ...plan, steps: plan.steps.map((s, j) => (j === i ? replaced : s)) };
        await save(plan);
        body.ct_listing_id = null;
        body.ct_qty_before = 0;
        body.ct_qty_after = replaced.quantity;
        body.note = "relisted";
        i--;
      }
      continue;
    }
    // create
    const appeared = all.find((listing) => listing.recordId === input.waitlist_record_id && listing.quantity > 0 && !step.existing.includes(listing.id));
    if (appeared) { body.ct_listing_id = appeared.id; delta += step.quantity; continue; }
    if (!card) throw new AllocationError("record_not_found", 404);
    try {
      const created = await deps.relist(tenantId, card, step.quantity, step.priceCents);
      body.ct_listing_id = created.productId;
      if (created.note) body.note = created.note;
      delta += step.quantity;
    } catch (error) {
      // CardTrader or the row refused the listing (no usable price, no blueprint). Flag it; a retry would fail the same way.
      if (statusOf(error) === 422) {
        const message = error instanceof Error ? error.message : "relist refused";
        return { status: 409, body: { ok: false, applied: true, error: "ct_relist_failed", ct_listing_id: null, ct_qty_before: 0, ct_qty_after: 0, ct_delta: delta, note: message.slice(0, 200) } };
      }
      throw error;
    }
  }
  return { status: plan.status, body };
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

async function finalize(input: AllocationRequest, tenantId: string, deps: AllocationDeps): Promise<{ status: number; body: AllocationResponse }> {
  if (input.op === "finalize_built") {
    const cleanup = await deleteEmptyListings(input, tenantId, deps);
    return { status: 200, body: { ok: true, applied: true, ct_listing_id: null, ct_qty_before: null, ct_qty_after: null, note: cleanup ? `recorded;${cleanup}` : "recorded" } };
  }
  // Sales log only. TCGplayer has no API: this line reaches the manual TCGplayer pull list through the sales log.
  const card = await deps.loadCard(tenantId, input.waitlist_record_id).catch(() => null);
  await deps.insertSale(tenantId, allocationSaleLine(input, card, new Date().toISOString()));
  const cleanup = await deleteEmptyListings(input, tenantId, deps);
  return { status: 200, body: { ok: true, applied: true, ct_listing_id: null, ct_qty_before: null, ct_qty_after: null, note: cleanup ? `sale_logged;${cleanup}` : "sale_logged" } };
}

const CLAIM_SECONDS = 120;
const LOCK_SECONDS = 120;
const WAIT_TRIES = 8;
const WAIT_MS = 250;

function claimRow(input: AllocationRequest): ClaimRow {
  return {
    allocationId: input.allocation_id, deckId: input.deck_id, op: input.op, recordId: input.waitlist_record_id, qty: input.qty,
    orderId: input.order_id ?? null, lineKey: input.line_key ?? null,
  };
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
  const input = request.request;

  let tenant: { id: string } | null;
  try { tenant = await deps.tenant(); }
  catch (error) {
    console.error("allocation tenant lookup failed", error instanceof Error ? error.message : error);
    return { status: 503, body: { ok: false, error: "allocations_unavailable" } };
  }
  if (!tenant) return { status: 503, body: { ok: false, error: "allocations_tenant_missing" } };
  const tenantId = tenant.id;
  const key = input.idempotency_key;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Claim the key before any CardTrader call. A duplicate in flight waits briefly for the stored answer.
  const token = crypto.randomUUID();
  let claim = await deps.store.claim(tenantId, key, claimRow(input), token, CLAIM_SECONDS);
  for (let tries = 0; claim.kind === "busy" && tries < WAIT_TRIES; tries++) {
    await sleep(WAIT_MS);
    claim = await deps.store.claim(tenantId, key, claimRow(input), token, CLAIM_SECONDS);
  }
  if (claim.kind === "mismatch") return { status: 409, body: { ok: false, error: "idempotency_conflict" } };
  if (claim.kind === "done") return replay(claim.stored);
  if (claim.kind === "busy") return { status: 503, body: { ok: false, error: "allocation_in_progress" } };

  const finish = async (status: number, body: AllocationResponse) => {
    await deps.store.finish(tenantId, key, token, status, body);
    console.log(JSON.stringify({ event: "allocation", op: input.op, status, record: input.waitlist_record_id }));
    return { status, body };
  };

  // One CardTrader read-modify-write per Waitlist row at a time.
  const holder = `alloc:${token}`;
  if (!(await deps.store.lockRow(tenantId, input.waitlist_record_id, holder, LOCK_SECONDS))) {
    await deps.store.abandon(tenantId, key, token);
    return { status: 503, body: { ok: false, error: "row_busy" } };
  }
  try {
    if (input.op === "finalize_built" || input.op === "finalize_sold") {
      const result = await finalize(input, tenantId, deps);
      return await finish(result.status, result.body);
    }
    const card = await deps.loadCard(tenantId, input.waitlist_record_id).catch(() => null);
    const all = await deps.listings(tenantId);
    let plan = claim.plan;
    if (!plan) {
      const made = await planChange(input, tenantId, all, card, deps);
      if (made === "record_not_found") {
        await deps.store.abandon(tenantId, key, token);
        return { status: 404, body: { ok: false, error: "record_not_found" } };
      }
      if (made.steps.length === 0) return await finish(made.status, made.body);
      plan = made;
      await deps.store.savePlan(tenantId, key, token, plan);
    }
    const result = await runPlan(input, tenantId, plan, all, card, deps, (next) => deps.store.savePlan(tenantId, key, token, next));
    return await finish(result.status, result.body);
  } catch (error) {
    // The plan stays with the key, so the next try of this key reconciles against CardTrader before writing.
    await deps.store.abandon(tenantId, key, token).catch(() => undefined);
    if (error instanceof AllocationError) return { status: error.status, body: { ok: false, error: error.message } };
    const message = error instanceof Error ? error.message : "CardTrader request failed.";
    return { status: 502, body: { ok: false, error: "cardtrader_failed", note: message.slice(0, 200) } };
  } finally {
    await deps.store.unlockRow(tenantId, input.waitlist_record_id, holder).catch(() => undefined);
  }
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
