import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { allocationSaleLine, allocationsEnabled, asExportCard, handleAllocation, parseAllocation, relistPrice, rowListings, type AllocationDeps, type AllocationResponse, type AllocationStore, type StoredAllocation } from "./allocations.ts";
import type { CtListing } from "./cardtrader.ts";
import type { StockCard } from "./airtable.ts";
import worker from "./index.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const REC = "recAAAAAAAAAAAAAA";
const SECRET = "test-allocation-secret";
const NOW = 1_800_000_000_000;

function memoryStore(): AllocationStore {
  const rows = new Map<string, StoredAllocation>();
  return {
    async get(tenantId, key) { return rows.get(`${tenantId}:${key}`) ?? null; },
    async put(tenantId, key, row) {
      const id = `${tenantId}:${key}`;
      if (rows.has(id)) return "exists";
      rows.set(id, row);
      return "stored";
    },
    async reservePrice(tenantId, allocationId) {
      const hits = [...rows.entries()].filter(([id, row]) => id.startsWith(`${tenantId}:`) && row.allocationId === allocationId && row.op === "reserve" && typeof row.body.ct_price_cents === "number");
      return hits.length ? hits[hits.length - 1]![1].body.ct_price_cents ?? null : null;
    },
  };
}

function stock(over: Partial<StockCard> = {}): StockCard {
  return {
    id: REC, name: "Oasis Raider", cardName: "Oasis Raider", resolvedName: "Oasis Raider", game: "Riftbound",
    setNumber: null, setIdentifier: "OGN", setName: "Origins", collectorNumber: "006", finish: "Normal", condition: "NM",
    qty: 4, reservedQty: 1, status: "Listed", rankScore: null, marketPriceUsd: 1.25, notes: null, priority: null,
    createdTime: "", autoRank: null, rarity: null, costBasisUsd: null, cardType: null, recommendation: null,
    rankReason: null, enrichedAt: null, priceSource: "CardTrader market (Near Mint non-foil, 4 offers)",
    cardTraderListingId: "50", tcgplayerSku: null, ...over,
  };
}

const listing = (id: number, quantity: number, recordId: string | null = REC): CtListing => ({ id, blueprintId: 1, quantity, recordId, priceCents: 125 });

const notFound = () => Object.assign(new Error("CardTrader said: not found"), { status: 404 });

type World = { listings: CtListing[]; card: StockCard | null; failIncrement: boolean; missing: number[]; refuseRelist: boolean };
function world(over: Partial<World> = {}) {
  const state: World = { listings: [listing(50, 4)], card: stock(), failIncrement: false, missing: [], refuseRelist: false, ...over };
  const calls = { listings: 0, increment: [] as [number, number][], remove: [] as number[], relist: [] as number[], relistPrice: [] as (number | null)[], sales: 0 };
  const deps: AllocationDeps = {
    async tenant() { return { id: TENANT }; },
    store: memoryStore(),
    async listings() { calls.listings++; return state.listings; },
    async increment(_tenant, id, delta) {
      calls.increment.push([id, delta]);
      if (state.failIncrement) throw new Error("CardTrader said: down");
      if (state.missing.includes(id)) throw notFound();
    },
    async remove(_tenant, id) {
      calls.remove.push(id);
      if (state.missing.includes(id)) throw notFound();
    },
    async loadCard() { return state.card; },
    async relist(_tenant, _card, quantity, price) {
      calls.relist.push(quantity);
      calls.relistPrice.push(price);
      if (state.refuseRelist) throw Object.assign(new Error("No market price yet."), { status: 422 });
      return { productId: 77 };
    },
    async insertSale() { calls.sales++; },
  };
  return { state, calls, deps };
}

const payload = (over: Record<string, unknown> = {}) => JSON.stringify({
  op: "reserve", idempotency_key: "key-1", allocation_id: "alloc-1", deck_id: "deck-1",
  waitlist_record_id: REC, qty: 1, game: "riftbound", ...over,
});

const sign = (raw: string, ts: string, secret = SECRET) => createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");

async function post(raw: string, deps: AllocationDeps, opts: { ts?: string; sig?: string | null; enabled?: string; secret?: string | null; now?: number } = {}) {
  const now = opts.now ?? NOW;
  const ts = opts.ts ?? String(now / 1000);
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  const sig = opts.sig === undefined ? (secret ? sign(raw, ts, secret) : null) : opts.sig;
  return handleAllocation({ ALLOCATIONS_ENABLED: opts.enabled ?? "on", ALLOCATION_HMAC_SECRET: secret ?? undefined }, raw, ts, sig, deps, now);
}

test("allocations stay closed unless the var is on", () => {
  assert.equal(allocationsEnabled({}), false);
  assert.equal(allocationsEnabled({ ALLOCATIONS_ENABLED: "false" }), false);
  assert.equal(allocationsEnabled({ ALLOCATIONS_ENABLED: "off" }), false);
  assert.equal(allocationsEnabled({ ALLOCATIONS_ENABLED: "on" }), true);
  assert.equal(allocationsEnabled({ ALLOCATIONS_ENABLED: "true" }), true);
  assert.equal(allocationsEnabled({ ALLOCATIONS_ENABLED: "1" }), true);
});

test("the endpoint rejects a bad body before it touches CardTrader", async () => {
  const { calls, deps } = world();
  const bad = await post(payload({ game: "magic" }), deps);
  assert.equal(bad.status, 400);
  assert.equal(calls.listings, 0);
  assert.equal(parseAllocation({ op: "reserve", qty: 0 }).ok, false);
});

test("unsigned, wrongly signed, and stale requests are 401 and make no CardTrader call", async () => {
  const { calls, deps } = world();
  const raw = payload();
  const missing = await post(raw, deps, { sig: null });
  const wrong = await post(raw, deps, { sig: sign(raw, String(NOW / 1000), "other") });
  const stale = await post(raw, deps, { ts: String(NOW / 1000), now: NOW + 301_000 });
  const early = await post(raw, deps, { ts: String(NOW / 1000 - 301) });
  for (const res of [missing, wrong, stale, early]) {
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "unauthorized");
  }
  assert.equal(calls.listings, 0);
  assert.equal(calls.increment.length, 0);
});

test("a closed endpoint does not call CardTrader even with a valid signature", async () => {
  const { calls, deps } = world();
  const res = await post(payload(), deps, { enabled: "false" });
  assert.deepEqual(res, { status: 503, body: { ok: false, error: "allocations_disabled" } });
  assert.equal(calls.listings, 0);
});

test("reserve lowers the listing, deletes it instead of leaving 0, and a repeat does not call CardTrader", async () => {
  const { calls, deps } = world();
  const raw = payload({ qty: 1 });
  const first = await post(raw, deps);
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.applied, true);
  assert.equal(first.body.ct_listing_id, 50);
  assert.equal(first.body.ct_qty_before, 4);
  assert.equal(first.body.ct_qty_after, 3);
  assert.deepEqual(calls.increment, [[50, -1]]);
  const again = await post(raw, deps, { now: NOW + 5_000 });
  assert.equal(again.status, 200);
  assert.equal(again.body.applied, false);
  assert.equal(again.body.ct_listing_id, 50);
  assert.equal(calls.listings, 1);
  assert.equal(calls.increment.length, 1);

  const gone = world({ listings: [listing(50, 2)] });
  const removed = await post(payload({ idempotency_key: "key-zero", qty: 2 }), gone.deps);
  assert.equal(removed.body.ct_listing_id, null);
  assert.equal(removed.body.ct_qty_after, 0);
  assert.equal(removed.body.ct_price_cents, 125);
  assert.deepEqual(gone.calls.increment, [], "never lowered to 0");
  assert.deepEqual(gone.calls.remove, [50]);
});

test("reserve lowers the largest listing first when a row has more than one", async () => {
  const { calls, deps } = world({ listings: [listing(1, 1), listing(2, 3)] });
  const res = await post(payload({ qty: 3 }), deps);
  assert.deepEqual(calls.remove, [2]);
  assert.deepEqual(calls.increment, []);
  assert.equal(res.body.ct_listing_id, 1);
  assert.equal(res.body.ct_qty_before, 4);
  assert.equal(res.body.ct_qty_after, 1);
});

test("reserve with less on CardTrader than requested lowers to 0 and a repeat does not call CardTrader", async () => {
  const { calls, deps } = world({ listings: [listing(50, 2), listing(51, 1)] });
  const raw = payload({ qty: 4, idempotency_key: "short" });
  const first = await post(raw, deps);
  assert.equal(first.status, 409);
  assert.deepEqual(first.body, { ok: false, applied: true, error: "insufficient_ct_qty", ct_listing_id: null, ct_qty_before: 3, ct_qty_after: 0, ct_price_cents: 125 });
  assert.deepEqual(calls.remove, [50, 51]);
  assert.deepEqual(calls.increment, []);
  const again = await post(raw, deps);
  assert.equal(again.status, 409);
  assert.equal(again.body.applied, false);
  assert.equal(again.body.error, "insufficient_ct_qty");
  assert.equal(again.body.ct_qty_before, 3);
  assert.equal(calls.listings, 1);
  assert.equal(calls.remove.length, 2);
});

test("a row that is not on CardTrader is a no-op success", async () => {
  const { calls, deps } = world({ listings: [listing(9, 4, "recBBBBBBBBBBBBBB")], card: stock({ cardTraderListingId: null, status: "Waitlist" }) });
  const res = await post(payload(), deps);
  assert.equal(res.status, 200);
  assert.equal(res.body.ct_listing_id, null);
  assert.equal(res.body.note, "not_listed");
  assert.equal(calls.increment.length, 0);
});

test("reserve flags a conflict when the row's CardTrader listing is gone or at 0, and a repeat does not retry", async () => {
  const deleted = world({ listings: [listing(9, 4, "recBBBBBBBBBBBBBB")] });
  const raw = payload({ idempotency_key: "gone-1" });
  const first = await post(raw, deleted.deps);
  assert.equal(first.status, 409);
  assert.equal(first.body.error, "ct_listing_missing");
  assert.equal(deleted.calls.increment.length + deleted.calls.remove.length, 0);
  const again = await post(raw, deleted.deps);
  assert.equal(again.status, 409);
  assert.equal(again.body.applied, false);
  assert.equal(deleted.calls.listings, 1, "the stored conflict is replayed, CardTrader is not read again");

  const zero = world({ listings: [listing(50, 0)] });
  const atZero = await post(payload({ idempotency_key: "zero-1" }), zero.deps);
  assert.equal(atZero.status, 409);
  assert.equal(atZero.body.error, "ct_listing_missing");
});

test("a 404 while lowering a listing is a stored conflict, not a CardTrader failure", async () => {
  const box = world({ missing: [50] });
  const raw = payload({ idempotency_key: "race-1" });
  const res = await post(raw, box.deps);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "ct_listing_missing");
  assert.equal(res.body.ct_qty_before, 4);
  assert.equal(res.body.ct_qty_after, 4);
  const again = await post(raw, box.deps);
  assert.equal(again.body.applied, false);
  assert.equal(box.calls.increment.length, 1);
});

test("a row with several listings is matched by user_data_field or the saved listing id, never by name, and stale ones are skipped", async () => {
  // Rakelstake: 463637803 and 463637918 are live, 463889655 is stale at 0 but still marked Listed.
  const other = "recBBBBBBBBBBBBBB";
  const listings = [listing(463637803, 1), listing(463637918, 2), listing(463889655, 0), listing(463000001, 5, other)];
  const box = world({ listings, card: stock({ cardTraderListingId: "463889655" }) });
  const res = await post(payload({ qty: 3, idempotency_key: "rakel-1" }), box.deps);
  assert.equal(res.status, 200);
  assert.equal(res.body.ct_qty_before, 3);
  assert.equal(res.body.ct_qty_after, 0);
  assert.deepEqual(box.calls.remove, [463637918, 463637803]);
  assert.equal(box.calls.increment.length, 0);

  const tagged = rowListings(listings, REC, "463637918").map((l) => l.id);
  assert.deepEqual(tagged, [463637803, 463637918, 463889655]);
  const untagged = [listing(70, 2, null), listing(71, 2, null)];
  assert.deepEqual(rowListings(untagged, REC, "71").map((l) => l.id), [71], "an untagged listing counts only when its id is saved on the row");
  assert.deepEqual(rowListings([listing(463000001, 5, other)], REC, "463000001"), [], "a listing tagged for another row is never taken");
});

test("the same idempotency key with a different request does not apply again", async () => {
  const { calls, deps } = world();
  await post(payload({ qty: 1 }), deps);
  const clash = await post(payload({ qty: 2 }), deps);
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, "idempotency_conflict");
  assert.equal(calls.increment.length, 1);
});

test("release raises an existing listing and recreates a removed one at Qty minus Reserved Qty", async () => {
  const raised = world();
  const up = await post(payload({ op: "release", qty: 2 }), raised.deps);
  assert.equal(up.status, 200);
  assert.deepEqual(raised.calls.increment, [[50, 2]]);
  assert.equal(up.body.ct_qty_before, 4);
  assert.equal(up.body.ct_qty_after, 6);
  assert.equal(raised.calls.relist.length, 0);

  const gone = world({ listings: [] });
  const again = await post(payload({ op: "release", idempotency_key: "rel-1", qty: 1 }), gone.deps);
  assert.deepEqual(gone.calls.increment, []);
  assert.equal(again.status, 200);
  assert.equal(again.body.note, "relisted");
  assert.equal(again.body.ct_listing_id, 77);
  assert.equal(again.body.ct_qty_before, 0);
  assert.equal(again.body.ct_qty_after, 3, "free = 4 on hand minus 1 manual hold");
  assert.deepEqual(gone.calls.relist, [3]);
  assert.equal(gone.calls.increment.length, 0);

  const both = world({ listings: [], card: stock({ qty: 5, reservedQty: 1, deckReservedQty: 2 }) });
  const split = await post(payload({ op: "release", idempotency_key: "rel-both", qty: 1 }), both.deps);
  assert.equal(split.body.ct_qty_after, 2);
  assert.deepEqual(both.calls.relist, [2]);

  const formula = world({ listings: [], card: stock({ qty: 5, reservedQty: 1, deckReservedQty: 1, freeQty: 1 }) });
  const fromFormula = await post(payload({ op: "release", idempotency_key: "rel-free", qty: 1 }), formula.deps);
  assert.equal(fromFormula.body.ct_qty_after, 1);
  assert.deepEqual(formula.calls.relist, [1]);

  const held = world({ listings: [], card: stock({ qty: 4, freeQty: 0 }) });
  const none = await post(payload({ op: "release", idempotency_key: "rel-0", qty: 1 }), held.deps);
  assert.equal(none.body.note, "no_free_qty");
  assert.equal(held.calls.relist.length, 0);
});

test("release after a delete re-creates the listing at the price the reserve took down", async () => {
  const box = world({ listings: [listing(50, 1)], card: stock({ qty: 1, reservedQty: 0, marketPriceUsd: null, priceSource: null }) });
  const reserved = await post(payload({ idempotency_key: "res-a", allocation_id: "alloc-a" }), box.deps);
  assert.equal(reserved.status, 200);
  assert.deepEqual(box.calls.remove, [50]);
  box.state.listings = [];
  const released = await post(payload({ op: "release", idempotency_key: "rel-a", allocation_id: "alloc-a" }), box.deps);
  assert.equal(released.status, 200);
  assert.equal(released.body.note, "relisted");
  assert.deepEqual(box.calls.relist, [1]);
  assert.deepEqual(box.calls.relistPrice, [125]);
  assert.equal(box.calls.increment.length, 0, "never incremented on a deleted listing");
});

test("release re-creates the listing when CardTrader says the one in the export was deleted", async () => {
  const box = world({ listings: [listing(50, 2)], missing: [50], card: stock({ qty: 4, reservedQty: 1 }) });
  const res = await post(payload({ op: "release", idempotency_key: "rel-404" }), box.deps);
  assert.equal(res.status, 200);
  assert.equal(res.body.note, "relisted");
  assert.deepEqual(box.calls.increment, [[50, 1]]);
  assert.deepEqual(box.calls.relist, [3]);
});

test("a relist CardTrader refuses is a stored conflict", async () => {
  const box = world({ listings: [], refuseRelist: true });
  const raw = payload({ op: "release", idempotency_key: "rel-refused" });
  const res = await post(raw, box.deps);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "ct_relist_failed");
  const again = await post(raw, box.deps);
  assert.equal(again.body.applied, false);
  assert.equal(box.calls.relist.length, 1);
});

test("the relist price is the Waitlist CardTrader market price, else the last listing price", () => {
  const card = stock();
  assert.deepEqual(relistPrice(card, 300), { marketPriceUsd: 1.25, priceSource: card.priceSource });
  assert.deepEqual(relistPrice(stock({ priceSource: "TCGplayer market" }), 300), { marketPriceUsd: 3, priceSource: "CardTrader market (last listing)" });
  assert.deepEqual(relistPrice(stock({ marketPriceUsd: null }), 300), { marketPriceUsd: 3, priceSource: "CardTrader market (last listing)" });
  assert.deepEqual(relistPrice(stock({ marketPriceUsd: null, priceSource: null }), null), { marketPriceUsd: null, priceSource: null });
  const row = asExportCard(stock(), 2);
  assert.equal(row.id, REC, "the export row id becomes user_data_field");
  assert.equal(row.qty, 2);
});

test("release does not store a missing Waitlist row, so a later retry can still relist", async () => {
  const box = world({ listings: [], card: null });
  const missing = await post(payload({ op: "release", idempotency_key: "rel-missing" }), box.deps);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "record_not_found");
  box.state.card = stock({ qty: 2, reservedQty: 0 });
  const retry = await post(payload({ op: "release", idempotency_key: "rel-missing" }), box.deps);
  assert.equal(retry.status, 200);
  assert.deepEqual(box.calls.relist, [2]);
});

test("a CardTrader failure is not stored, so the same key can succeed on retry", async () => {
  const box = world({ failIncrement: true });
  const failed = await post(payload(), box.deps);
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error, "cardtrader_failed");
  box.state.failIncrement = false;
  const retry = await post(payload(), box.deps);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.applied, true);
  assert.equal(box.calls.increment.length, 2);
});

test("finalize deletes a listing left at 0 and never changes a live quantity; finalize_sold logs once", async () => {
  const built = world({ listings: [listing(50, 0), listing(51, 2), listing(52, 0, "recBBBBBBBBBBBBBB")] });
  const kept = await post(payload({ op: "finalize_built", idempotency_key: "built-1" }), built.deps);
  assert.equal(kept.status, 200);
  assert.equal(kept.body.note, "recorded;deleted_empty_listings:50");
  assert.deepEqual(built.calls.remove, [50]);
  assert.equal(built.calls.increment.length, 0);
  assert.equal(built.calls.sales, 0);
  const repeat = await post(payload({ op: "finalize_built", idempotency_key: "built-1" }), built.deps);
  assert.equal(repeat.body.applied, false);

  const sold = world();
  let line: ReturnType<typeof allocationSaleLine> | null = null;
  sold.deps.insertSale = async (_tenant, next) => { sold.calls.sales++; line = next; };
  const raw = payload({ op: "finalize_sold", idempotency_key: "sold-1", qty: 2, order_id: "deck-1", line_key: "alloc-1" });
  const first = await post(raw, sold.deps);
  assert.equal(first.body.note, "sale_logged");
  assert.equal(sold.calls.increment.length, 0);
  assert.equal(sold.calls.remove.length, 0);
  assert.equal(sold.calls.sales, 1);
  assert.equal(line!.platform, "allocation");
  assert.equal(line!.lineKey, "alloc-1");
  assert.equal(line!.decrementOwner, "none");
  assert.equal(line!.qty, 2);
  assert.equal(line!.grossCents, 250);
  assert.equal(line!.externalOrderId, "deck-1");
  const again = await post(raw, sold.deps);
  assert.equal(again.body.applied, false);
  assert.equal(sold.calls.sales, 1, "a repeat makes no second sales insert");

  const unkeyed = await post(payload({ op: "finalize_sold", idempotency_key: "sold-2" }), sold.deps);
  assert.equal(unkeyed.status, 400);
  assert.equal(unkeyed.body.error, "finalize_sold needs order_id and line_key.");
  assert.equal(sold.calls.sales, 1);

  const broken = world();
  broken.deps.listings = async () => { throw new Error("CardTrader said: down"); };
  const cleanupDown = await post(payload({ op: "finalize_built", idempotency_key: "built-down" }), broken.deps);
  assert.equal(cleanupDown.status, 200, "a failed cleanup never fails the finalize");
  assert.equal(cleanupDown.body.note, "recorded;empty_listing_cleanup_failed");
});

test("a deck sale line is not a CardTrader decrement", () => {
  const line = allocationSaleLine({
    op: "finalize_sold", idempotency_key: "sold-9", allocation_id: "alloc-9", deck_id: "deck-9",
    waitlist_record_id: REC, qty: 1, game: "riftbound",
  }, null, "2026-11-08T00:00:00.000Z");
  assert.equal(line.decrementOwner, "none");
  assert.equal(line.platform, "allocation");
  assert.equal(line.lineKey, "sold-9");
  assert.equal(line.grossCents, 0);
  assert.equal(line.game, "Riftbound");
});

test("the worker route is signed and closed by default, and it does not require Clerk", async () => {
  const closed = await worker.fetch(new Request("https://hekla.test/api/allocations", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), { ALLOCATIONS_ENABLED: "false" });
  assert.equal(closed.status, 503);
  assert.deepEqual(await closed.json(), { ok: false, error: "allocations_disabled" });

  const open = await worker.fetch(new Request("https://hekla.test/api/allocations", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), { ALLOCATIONS_ENABLED: "on", ALLOCATION_HMAC_SECRET: SECRET });
  assert.equal(open.status, 401);
  const denied = await open.json() as AllocationResponse;
  assert.equal(denied.error, "unauthorized");
  assert.equal(JSON.stringify(denied).includes("Sign in"), false);

  const raw = payload();
  const ts = String(Math.floor(Date.now() / 1000));
  const authed = await worker.fetch(new Request("https://hekla.test/api/allocations", {
    method: "POST", body: raw, headers: { "content-type": "application/json", "x-alloc-timestamp": ts, "x-alloc-signature": sign(raw, ts) },
  }), { ALLOCATIONS_ENABLED: "on", ALLOCATION_HMAC_SECRET: SECRET });
  assert.equal(authed.status, 503);
  assert.equal((await authed.json() as AllocationResponse).error, "allocations_unavailable");
});
