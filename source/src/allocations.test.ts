import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { allocationSaleLine, allocationsEnabled, clearAllocationRow, resolveStaleRow, saleSinceOnCardTrader, STALE_SECONDS, takeRowLease, asExportCard, handleAllocation, parseAllocation, relistPrice, rowListings, type AllocationDeps, type AllocationResponse, type AllocationStore, type Claim, type ClaimRow, type CtPlan } from "./allocations.ts";
import type { CtListing } from "./cardtrader.ts";
import type { StockCard } from "./airtable.ts";
import worker from "./index.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const REC = "recAAAAAAAAAAAAAA";
const SECRET = "test-allocation-secret";
const NOW = 1_800_000_000_000;

type MemRow = ClaimRow & { state: "pending" | "done"; token: string | null; until: number; plan: CtPlan | null; httpStatus: number | null; body: AllocationResponse | null };
const sameClaim = (a: ClaimRow, b: ClaimRow) => a.allocationId === b.allocationId && a.deckId === b.deckId && a.op === b.op && a.recordId === b.recordId && a.qty === b.qty && a.orderId === b.orderId && a.lineKey === b.lineKey;

/** The same claim, plan, finish, and lock rules as allocationsdb.ts, in memory. */
function memoryStore(clock = { skew: 0 }): AllocationStore & { rows: Map<string, MemRow>; clock: { skew: number }; logged: { recordId: string; at: string }[] } {
  const rows = new Map<string, MemRow>();
  const locks = new Map<string, { holder: string; until: number }>();
  const logged: { recordId: string; at: string }[] = [];
  const Date = { now: () => globalThis.Date.now() + clock.skew };
  return {
    rows, clock, logged,
    async claim(tenantId, key, row, token, lease): Promise<Claim> {
      const id = `${tenantId}:${key}`;
      const now = Date.now();
      const have = rows.get(id);
      if (!have) {
        rows.set(id, { ...row, state: "pending", token, until: now + lease * 1000, plan: null, httpStatus: null, body: null });
        return { kind: "claimed", plan: null };
      }
      if (!sameClaim(have, row)) return { kind: "mismatch" };
      if (have.state === "done") return { kind: "done", stored: { ...have, httpStatus: have.httpStatus!, body: have.body! } };
      if (have.until > now) return { kind: "busy" };
      have.token = token;
      have.until = now + lease * 1000;
      return { kind: "claimed", plan: have.plan ? structuredClone(have.plan) : null };
    },
    async savePlan(tenantId, key, token, plan) {
      const have = rows.get(`${tenantId}:${key}`);
      if (!have || have.token !== token || have.state !== "pending") throw new Error("Allocation claim was lost before the plan was saved.");
      have.plan = structuredClone(plan);
    },
    async finish(tenantId, key, token, httpStatus, body) {
      const have = rows.get(`${tenantId}:${key}`);
      if (!have || have.token !== token || have.state !== "pending") return false;
      Object.assign(have, { state: "done", httpStatus, body: structuredClone(body), token: null, until: 0 });
      return true;
    },
    async renew(tenantId, key, token, lease) {
      const have = rows.get(`${tenantId}:${key}`);
      if (!have || have.token !== token || have.state !== "pending" || have.until <= Date.now()) return false;
      have.until = Date.now() + lease * 1000;
      return true;
    },
    async renewRow(tenantId, recordId, holder, seconds) {
      const have = locks.get(`${tenantId}:${recordId}`);
      if (!have || have.holder !== holder || have.until <= Date.now()) return false;
      have.until = Date.now() + seconds * 1000;
      return true;
    },
    async rowUnresolved(tenantId, recordId, exceptKey) {
      return [...rows.entries()].some(([id, row]) => id.startsWith(`${tenantId}:`) && id !== `${tenantId}:${exceptKey}` && row.recordId === recordId
        && row.state === "pending" && Boolean(row.plan?.steps.some((step) => step.attemptedAt && !step.done)));
    },
    async unresolvedOnRow(tenantId, recordId, exceptKey) {
      return [...rows.entries()]
        .filter(([id, row]) => id.startsWith(`${tenantId}:`) && id !== `${tenantId}:${exceptKey}` && row.recordId === recordId
          && row.state === "pending" && Boolean(row.plan?.steps.some((step) => step.attemptedAt && !step.done)))
        .map(([id, row]) => ({ key: id.slice(tenantId.length + 1), plan: structuredClone(row.plan!), leaseLive: row.until > Date.now() }));
    },
    async takeOver(tenantId, key, token, lease) {
      const have = rows.get(`${tenantId}:${key}`);
      if (!have || have.state !== "pending" || have.until > Date.now()) return null;
      have.token = token;
      have.until = Date.now() + lease * 1000;
      const { allocationId, deckId, op, recordId, qty, orderId, lineKey } = have;
      return { row: { allocationId, deckId, op, recordId, qty, orderId, lineKey }, plan: have.plan ? structuredClone(have.plan) : null };
    },
    async saleLogged(_tenantId, recordId, sinceIso) {
      return logged.some((sale) => sale.recordId === recordId && sale.at >= sinceIso);
    },
    async abandon(tenantId, key, token) {
      const have = rows.get(`${tenantId}:${key}`);
      if (have && have.token === token && have.state === "pending") Object.assign(have, { token: null, until: 0 });
    },
    async reservePrice(tenantId, allocationId) {
      const hits = [...rows.entries()].filter(([id, row]) => id.startsWith(`${tenantId}:`) && row.allocationId === allocationId && row.op === "reserve" && row.state === "done" && typeof row.body?.ct_price_cents === "number");
      return hits.length ? hits[hits.length - 1]![1].body!.ct_price_cents ?? null : null;
    },
    async lockRow(tenantId, recordId, holder, seconds) {
      const id = `${tenantId}:${recordId}`;
      const have = locks.get(id);
      if (have && have.until > Date.now() && have.holder !== holder) return false;
      locks.set(id, { holder, until: Date.now() + seconds * 1000 });
      return true;
    },
    async unlockRow(tenantId, recordId, holder) {
      const id = `${tenantId}:${recordId}`;
      if (locks.get(id)?.holder === holder) locks.delete(id);
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

/** CardTrader in memory: increment, delete, and create change `listings`. `landThenFail` applies a write, then throws a 504. */
/** `orders` are CardTrader seller orders the evidence check reads; `ordersDown` makes that read fail. */
type World = { listings: CtListing[]; card: StockCard | null; failIncrement: boolean; failNoLand: number; missing: number[]; refuseRelist: boolean; landThenFail: number; gate: Promise<void> | null; orders: { productId: number | null; recordId: string | null; at: string }[]; ordersDown: boolean };
function world(over: Partial<World> = {}) {
  const state: World = { listings: [listing(50, 4)], card: stock(), failIncrement: false, failNoLand: 0, missing: [], refuseRelist: false, landThenFail: 0, gate: null, orders: [], ordersDown: false, ...over };
  let nextId = 77;
  const timeout = () => {
    if (state.landThenFail > 0) { state.landThenFail--; throw Object.assign(new Error("CardTrader said: gateway timeout"), { status: 504 }); }
  };
  const calls = { listings: 0, increment: [] as [number, number][], remove: [] as number[], relist: [] as number[], relistPrice: [] as (number | null)[], sales: 0, evidence: 0 };
  const store = memoryStore();
  const deps: AllocationDeps = {
    async tenant() { return { id: TENANT }; },
    store,
    async listings() { calls.listings++; return state.listings.map((l) => ({ ...l })); },
    async increment(_tenant, id, delta) {
      calls.increment.push([id, delta]);
      if (state.gate) await state.gate;
      if (state.failIncrement) throw Object.assign(new Error("CardTrader said: bad request"), { status: 400 });
      if (state.failNoLand > 0) { state.failNoLand--; throw Object.assign(new Error("CardTrader said: gateway timeout"), { status: 504 }); }
      if (state.missing.includes(id)) throw notFound();
      const hit = state.listings.find((l) => l.id === id);
      if (hit) hit.quantity += delta;
      timeout();
      return hit?.quantity ?? null;
    },
    async remove(_tenant, id) {
      calls.remove.push(id);
      if (state.gate) await state.gate;
      if (state.missing.includes(id)) throw notFound();
      state.listings = state.listings.filter((l) => l.id !== id);
      timeout();
    },
    async loadCard() { return state.card; },
    async relist(_tenant, card, quantity, price) {
      calls.relist.push(quantity);
      calls.relistPrice.push(price);
      if (state.gate) await state.gate;
      if (state.refuseRelist) throw Object.assign(new Error("No market price yet."), { status: 422 });
      const productId = nextId++;
      state.listings.push({ id: productId, blueprintId: 1, quantity, recordId: card.id, priceCents: price });
      timeout();
      return { productId };
    },
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    async insertSale() { calls.sales++; },
    async salesEvidence(tenantId, recordId, ids, since) {
      calls.evidence++;
      if (state.ordersDown) throw new Error("CardTrader said: down");
      return state.orders.some((o) => (o.recordId === recordId || (o.productId != null && ids.includes(o.productId))) && o.at >= since)
        || store.saleLogged(tenantId, recordId, since);
    },
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
  assert.deepEqual(first.body, { ok: false, applied: true, error: "insufficient_ct_qty", ct_listing_id: null, ct_qty_before: 3, ct_qty_after: 0, ct_delta: -3, ct_price_cents: 125 });
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

test("release puts back only the released copies, capped by free stock less what is already listed", async () => {
  // free = 6 on hand - 1 manual hold = 5; 3 are listed, so 2 more can go up even though 3 were released.
  const raised = world({ listings: [listing(50, 3)], card: stock({ qty: 6, reservedQty: 1 }) });
  const up = await post(payload({ op: "release", qty: 3 }), raised.deps);
  assert.equal(up.status, 200);
  assert.deepEqual(raised.calls.increment, [[50, 2]]);
  assert.equal(up.body.ct_qty_before, 3);
  assert.equal(up.body.ct_qty_after, 5);
  assert.equal(up.body.ct_delta, 2);
  assert.equal(raised.calls.relist.length, 0);

  const gone = world({ listings: [] });
  const again = await post(payload({ op: "release", idempotency_key: "rel-1", qty: 1 }), gone.deps);
  assert.equal(again.status, 200);
  assert.equal(again.body.note, "relisted");
  assert.equal(again.body.ct_listing_id, 77);
  assert.equal(again.body.ct_qty_before, 0);
  assert.equal(again.body.ct_qty_after, 1, "the released copy, not all 3 free copies");
  assert.deepEqual(gone.calls.relist, [1]);
  assert.equal(gone.calls.increment.length, 0);

  const both = world({ listings: [], card: stock({ qty: 5, reservedQty: 1, deckReservedQty: 3 }) });
  const capped = await post(payload({ op: "release", idempotency_key: "rel-both", qty: 2 }), both.deps);
  assert.equal(capped.body.ct_qty_after, 1, "free = 5 - 1 - 3");
  assert.deepEqual(both.calls.relist, [1]);

  const formula = world({ listings: [], card: stock({ qty: 5, reservedQty: 1, deckReservedQty: 1, freeQty: 1 }) });
  const fromFormula = await post(payload({ op: "release", idempotency_key: "rel-free", qty: 2 }), formula.deps);
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
  assert.deepEqual(box.calls.relist, [1], "only the released copy");
  assert.equal(res.body.ct_listing_id, 77);
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
  assert.deepEqual(box.calls.relist, [1]);
});

test("a CardTrader timeout after the change landed is not applied twice on retry", async () => {
  // Reserve 1 of 4: the increment lands, then CardTrader times out.
  const lowered = world({ landThenFail: 1 });
  const raw = payload({ idempotency_key: "t-res" });
  const first = await post(raw, lowered.deps);
  assert.equal(first.status, 502);
  assert.equal(lowered.state.listings[0]!.quantity, 3);
  const retry = await post(raw, lowered.deps);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.ct_qty_after, 3);
  assert.deepEqual(lowered.calls.increment, [[50, -1]], "the retry read the export and did not lower again");
  assert.equal(lowered.state.listings[0]!.quantity, 3);
  assert.equal(lowered.calls.listings, 2);

  // Release after a delete: the relist lands, then times out. The retry finds the new listing and does not list again.
  const relisted = world({ listings: [], landThenFail: 1 });
  const rel = payload({ op: "release", idempotency_key: "t-rel", qty: 1 });
  assert.equal((await post(rel, relisted.deps)).status, 502);
  const again = await post(rel, relisted.deps);
  assert.equal(again.status, 200);
  assert.equal(again.body.ct_listing_id, 77);
  assert.deepEqual(relisted.calls.relist, [1]);
  assert.equal(relisted.state.listings.length, 1);

  // Raise an existing listing: lands, times out, retry is a no-op.
  const raised = world({ listings: [listing(50, 1)], card: stock({ qty: 4, reservedQty: 0 }), landThenFail: 1 });
  const up = payload({ op: "release", idempotency_key: "t-up", qty: 2 });
  assert.equal((await post(up, raised.deps)).status, 502);
  assert.equal((await post(up, raised.deps)).status, 200);
  assert.deepEqual(raised.calls.increment, [[50, 2]]);
  assert.equal(raised.state.listings[0]!.quantity, 3);
});

test("a retry flags a listing someone else changed instead of writing over it", async () => {
  const box = world({ landThenFail: 1 });
  const raw = payload({ idempotency_key: "t-moved", qty: 2 });
  assert.equal((await post(raw, box.deps)).status, 502);
  box.state.listings[0]!.quantity = 1; // Hekla pulled one more by hand: neither 4 nor 2.
  const retry = await post(raw, box.deps);
  assert.equal(retry.status, 409);
  assert.equal(retry.body.error, "ct_retry_unverifiable");
  assert.equal(retry.body.ct_delta, 0);
  assert.equal(box.calls.increment.length, 1);
});

test("a step that was never sent still checks its start state on retry", async () => {
  // Two deletes; the first lands and times out. Before the retry someone sets listing 51 to 5 by hand.
  const box = world({ listings: [listing(50, 2), listing(51, 1)], landThenFail: 1 });
  const raw = payload({ idempotency_key: "t-two", qty: 3 });
  assert.equal((await post(raw, box.deps)).status, 502);
  box.state.listings.find((l) => l.id === 51)!.quantity = 5;
  const retry = await post(raw, box.deps);
  assert.equal(retry.status, 409);
  assert.equal(retry.body.error, "ct_changed_during_retry");
  assert.equal(retry.body.ct_delta, -2, "the first delete is proven (gone, no sale since) and counted once");
  assert.deepEqual(box.calls.remove, [50]);
});

test("a write with no answer is not sent again when the listing still looks untouched", async () => {
  // CardTrader timed out; the export still shows 4. The write may have landed and been undone by a sale, or the
  // export may lag. Neither can be told apart from "never landed", so the retry stops for a manual check.
  const box = world({ failNoLand: 1 });
  const raw = payload({ idempotency_key: "t-unknown" });
  assert.equal((await post(raw, box.deps)).status, 502);
  const retry = await post(raw, box.deps);
  assert.equal(retry.status, 409);
  assert.equal(retry.body.error, "ct_retry_unverifiable");
  assert.equal(box.calls.increment.length, 1);
  assert.equal(box.state.listings[0]!.quantity, 4);
});

test("a sale during the retry window: reserve that never landed is not taken as landed", async () => {
  // Reserve 1 of 4 times out without landing; a CardTrader buyer takes one (4 -> 3). Quantity alone says "landed".
  const box = world({ failNoLand: 1 });
  const raw = payload({ idempotency_key: "t-sale-res" });
  assert.equal((await post(raw, box.deps)).status, 502);
  box.state.listings[0]!.quantity = 3;
  box.state.orders.push({ productId: 50, recordId: REC, at: new Date().toISOString() });
  const retry = await post(raw, box.deps);
  assert.equal(retry.status, 409);
  assert.equal(retry.body.error, "ct_retry_unverifiable");
  assert.equal(box.calls.increment.length, 1);

  // Same with the sale only in Hekla's sales log (a starfoil sale that cross-delisted one).
  const logged = world({ failNoLand: 1 });
  const raw2 = payload({ idempotency_key: "t-sale-log" });
  assert.equal((await post(raw2, logged.deps)).status, 502);
  logged.state.listings[0]!.quantity = 3;
  (logged.deps.store as ReturnType<typeof memoryStore>).logged.push({ recordId: REC, at: new Date().toISOString() });
  assert.equal((await post(raw2, logged.deps)).body.error, "ct_retry_unverifiable");

  // When the orders cannot be read, the retry fails and writes nothing.
  const down = world({ failNoLand: 1 });
  const raw3 = payload({ idempotency_key: "t-sale-down" });
  assert.equal((await post(raw3, down.deps)).status, 502);
  down.state.listings[0]!.quantity = 3;
  down.state.ordersDown = true;
  assert.equal((await post(raw3, down.deps)).status, 502);
  assert.equal(down.calls.increment.length, 1);

  // An older sale does not count: with no sale since the attempt, a listing at its end state is proof enough.
  const quiet = world({ landThenFail: 1, orders: [{ productId: 50, recordId: REC, at: "2020-01-01T00:00:00.000Z" }] });
  const raw4 = payload({ idempotency_key: "t-quiet" });
  assert.equal((await post(raw4, quiet.deps)).status, 502);
  assert.equal((await post(raw4, quiet.deps)).status, 200);
  assert.equal(quiet.calls.increment.length, 1);
});

test("a sale during the retry window: release that landed is not raised twice", async () => {
  // Release 1 onto listing 50 (2 -> 3) lands, then times out; a buyer takes one (3 -> 2), back at the start state.
  const box = world({ listings: [listing(50, 2)], card: stock({ qty: 4, reservedQty: 0 }), landThenFail: 1 });
  const raw = payload({ op: "release", idempotency_key: "t-sale-rel", qty: 1 });
  assert.equal((await post(raw, box.deps)).status, 502);
  assert.equal(box.state.listings[0]!.quantity, 3);
  box.state.listings[0]!.quantity = 2;
  box.state.orders.push({ productId: 50, recordId: REC, at: new Date().toISOString() });
  const retry = await post(raw, box.deps);
  assert.equal(retry.status, 409);
  assert.equal(retry.body.error, "ct_retry_unverifiable");
  assert.deepEqual(box.calls.increment, [[50, 1]], "the released copy was not listed a second time");
  assert.equal(box.state.listings[0]!.quantity, 2);
});

const tick = async (n = 1) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

test("a key lease that runs out mid-call stops the next CardTrader write", async () => {
  // Reserve 3 across two listings: two deletes. The first hangs past the 120s claim lease.
  let open!: () => void;
  const box = world({ listings: [listing(50, 2), listing(51, 1)], gate: new Promise<void>((resolve) => { open = resolve; }) });
  const store = box.deps.store as ReturnType<typeof memoryStore>;
  const raw = payload({ idempotency_key: "t-lease", qty: 3 });
  const first = post(raw, box.deps);
  while (box.calls.remove.length < 1) await tick();
  store.clock.skew += 121_000;
  open();
  const res = await first;
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "lease_lost");
  assert.deepEqual(box.calls.remove, [50], "the second delete was not sent after the lease ran out");
});

test("a row lease taken by someone else mid-call stops the next CardTrader write", async () => {
  let open!: () => void;
  const box = world({ listings: [listing(50, 2), listing(51, 1)], gate: new Promise<void>((resolve) => { open = resolve; }) });
  const store = box.deps.store as ReturnType<typeof memoryStore>;
  const first = post(payload({ idempotency_key: "t-row-a", qty: 3 }), box.deps);
  while (box.calls.remove.length < 1) await tick();
  // The row lease expires; another job takes the row (the key claim is still renewed in time).
  assert.equal(await store.renew(TENANT, "t-row-a", [...store.rows.values()][0]!.token!, 600), true);
  store.clock.skew += 121_000;
  assert.equal(await store.lockRow(TENANT, REC, "someone-else", 120), true);
  open();
  const res = await first;
  assert.equal(res.body.error, "lease_lost");
  assert.deepEqual(box.calls.remove, [50]);
});

test("the answer is not reported as saved when the claim was lost before finish", async () => {
  const box = world();
  const store = box.deps.store as ReturnType<typeof memoryStore>;
  const finish = store.finish.bind(store);
  store.finish = async (tenantId, key, _token, status, body) => {
    store.rows.get(`${TENANT}:${key}`)!.token = "someone-else";
    return finish(tenantId, key, "not-mine", status, body);
  };
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const res = await post(payload({ idempotency_key: "t-finish" }), box.deps);
    assert.equal(res.status, 500);
    assert.equal(res.body.error, "claim_lost");
  } finally { console.error = original; }
  assert.ok(errors.some((line) => line.includes("allocation_finish_lost")));
  assert.equal(store.rows.get(`${TENANT}:t-finish`)!.state, "pending");
});

test("a fresh allocation waits while another key on the row has an unverified write", async () => {
  const box = world({ failNoLand: 1 });
  assert.equal((await post(payload({ idempotency_key: "t-unres-a" }), box.deps)).status, 502);
  const other = await post(payload({ idempotency_key: "t-unres-b", allocation_id: "alloc-2" }), box.deps);
  assert.equal(other.status, 503);
  assert.equal(other.body.error, "row_busy");
  assert.equal(box.calls.increment.length, 1);
});

test("concurrent duplicates of one key make one CardTrader change and share one answer", async () => {
  let open!: () => void;
  const box = world({ gate: new Promise<void>((resolve) => { open = resolve; }) });
  const raw = payload({ idempotency_key: "dup-1" });
  const a = post(raw, box.deps);
  const b = post(raw, box.deps);
  await new Promise((resolve) => setImmediate(resolve));
  open();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(box.calls.increment.length, 1);
  assert.deepEqual(box.calls.increment, [[50, -1]]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  assert.equal(ra.body.ct_qty_after, 3);
  assert.equal(rb.body.ct_qty_after, 3);
  assert.equal([ra.body.applied, rb.body.applied].filter(Boolean).length, 1, "one applied, one replayed");
});

test("a duplicate still in flight after the wait is a retryable 503, not a second write", async () => {
  const box = world({ gate: new Promise<void>(() => undefined) });
  const raw = payload({ idempotency_key: "dup-stuck" });
  void post(raw, box.deps);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await post(raw, box.deps);
  assert.equal(second.status, 503);
  assert.equal(second.body.error, "allocation_in_progress");
  assert.equal(box.calls.increment.length, 1);
});

test("two releases on the same row never both re-create a listing", async () => {
  let open!: () => void;
  const box = world({ listings: [], card: stock({ qty: 4, reservedQty: 0 }), gate: new Promise<void>((resolve) => { open = resolve; }) });
  const first = post(payload({ op: "release", idempotency_key: "rel-x", allocation_id: "alloc-x" }), box.deps);
  while (box.calls.relist.length < 1) await new Promise((resolve) => setImmediate(resolve));
  let settled = false;
  const pending = post(payload({ op: "release", idempotency_key: "rel-y", allocation_id: "alloc-y" }), box.deps).finally(() => { settled = true; });
  // Without the row lock the second would block at the gate; give it a bounded number of ticks, then open.
  for (let i = 0; i < 500 && !settled; i++) await new Promise((resolve) => setImmediate(resolve));
  open();
  const [one, second] = await Promise.all([first, pending]);
  assert.equal(one.status, 200);
  assert.equal(second.status, 503);
  assert.equal(second.body.error, "row_busy");
  box.state.gate = null;
  const later = await post(payload({ op: "release", idempotency_key: "rel-y", allocation_id: "alloc-y" }), box.deps);
  assert.equal(later.status, 200);
  assert.deepEqual(box.calls.relist, [1], "the second release raised the listing the first one created");
  assert.deepEqual(box.calls.increment, [[77, 1]]);
  assert.equal(box.state.listings.filter((l) => l.recordId === REC).length, 1);
});

test("a key reused with a different order_id or line_key is a conflict", async () => {
  const { deps } = world();
  const first = await post(payload({ op: "finalize_sold", idempotency_key: "sold-x", order_id: "deck-1", line_key: "a" }), deps);
  assert.equal(first.status, 200);
  const other = await post(payload({ op: "finalize_sold", idempotency_key: "sold-x", order_id: "deck-1", line_key: "b" }), deps);
  assert.equal(other.status, 409);
  assert.equal(other.body.error, "idempotency_conflict");
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

test("a reconcile set-to-target takes the allocation row lease, and waits on an unverified allocation", async () => {
  const box = world();
  const store = box.deps.store as ReturnType<typeof memoryStore>;
  const lease = await takeRowLease(store, TENANT, REC, "reconcile:1");
  assert.equal(typeof lease, "object");
  // While reconcile holds the row, an allocation on it is row_busy and makes no CardTrader write.
  const res = await post(payload({ idempotency_key: "t-recon" }), box.deps);
  assert.equal(res.body.error, "row_busy");
  assert.equal(box.calls.increment.length, 0);
  assert.equal(typeof (await takeRowLease(store, TENANT, REC, "reconcile:2")), "string", "a second reconcile is refused too");
  assert.equal(await (lease as { renew(): Promise<boolean> }).renew(), true);
  await (lease as { release(): Promise<void> }).release();

  // An allocation write with no answer blocks reconcile from moving the row until it is verified.
  const unknown = world({ failNoLand: 1 });
  assert.equal((await post(payload({ idempotency_key: "t-recon-u" }), unknown.deps)).status, 502);
  assert.match(String(await takeRowLease(unknown.deps.store, TENANT, REC, "reconcile:3")), /waiting to be verified/);

  // Before migration 0013 there is no lease table: reconcile keeps working.
  const missing = Object.assign(Object.create(store), {
    rowUnresolved: async () => { throw new Error('relation "allocation_results" does not exist'); },
  }) as typeof store;
  const noop = await takeRowLease(missing, TENANT, REC, "reconcile:4");
  assert.equal(typeof noop, "object");
  await assert.rejects(takeRowLease(Object.assign(Object.create(store), { rowUnresolved: async () => { throw new Error("connection reset"); } }), TENANT, REC, "r"));
});

const later = (box: ReturnType<typeof world>, ms: number) => { box.deps.now = () => Date.now() + ms; };
const STALE_MS = STALE_SECONDS * 1000 + 1000;
const ctWrites = (box: ReturnType<typeof world>) => box.calls.increment.length + box.calls.remove.length + box.calls.relist.length;

test("expiry: a stale unanswered write that landed is settled by proof, and the row takes new allocations", async () => {
  // Reserve 1 of 4 lands (4 -> 3) and times out. The deckbuilder never retries the key (mode back to off, job lost).
  const box = world({ landThenFail: 1 });
  const store = box.deps.store as ReturnType<typeof memoryStore>;
  assert.equal((await post(payload({ idempotency_key: "t-stale-a" }), box.deps)).status, 502);
  const blocked = await post(payload({ idempotency_key: "t-stale-b", allocation_id: "alloc-2" }), box.deps);
  assert.equal(blocked.body.error, "row_busy", "before the expiry the row still waits");

  later(box, STALE_MS);
  const next = await post(payload({ idempotency_key: "t-stale-b", allocation_id: "alloc-2" }), box.deps);
  assert.equal(next.status, 200);
  assert.deepEqual(box.calls.increment, [[50, -1], [50, -1]], "key a was not sent again; key b made its own change");
  assert.equal(box.state.listings[0]!.quantity, 2);
  const a = store.rows.get(`${TENANT}:t-stale-a`)!;
  assert.equal(a.state, "done");
  assert.equal(a.httpStatus, 200);
  assert.equal(a.body!.ct_delta, -1);
  // The deckbuilder's late retry of key a gets the stored answer and writes nothing.
  const retry = await post(payload({ idempotency_key: "t-stale-a" }), box.deps);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.applied, false);
  assert.equal(box.calls.increment.length, 2);
});

test("expiry: a stale unanswered write with no proof is stored as a 409 for review and never re-sent", async () => {
  const box = world({ failNoLand: 1 });
  const store = box.deps.store as ReturnType<typeof memoryStore>;
  assert.equal((await post(payload({ idempotency_key: "t-stale-u" }), box.deps)).status, 502);
  later(box, STALE_MS);
  const next = await post(payload({ idempotency_key: "t-stale-v", allocation_id: "alloc-2" }), box.deps);
  assert.equal(next.status, 200);
  const stale = store.rows.get(`${TENANT}:t-stale-u`)!;
  assert.equal(stale.state, "done");
  assert.equal(stale.httpStatus, 409);
  assert.equal(stale.body!.error, "ct_retry_unverifiable");
  assert.deepEqual(box.calls.increment, [[50, -1], [50, -1]], "only the first try of key u and key v's own change");
  const retry = await post(payload({ idempotency_key: "t-stale-u" }), box.deps);
  assert.equal(retry.body.error, "ct_retry_unverifiable");
  assert.equal(box.calls.increment.length, 2);
});

test("expiry: reconcile set-to-target settles a stale write instead of waiting on it forever", async () => {
  const box = world({ landThenFail: 1 });
  assert.equal((await post(payload({ idempotency_key: "t-stale-r" }), box.deps)).status, 502);
  const settle = () => resolveStaleRow(TENANT, REC, box.deps);
  assert.match(String(await takeRowLease(box.deps.store, TENANT, REC, "reconcile:s1", settle)), /waiting to be verified/, "not yet stale");
  later(box, STALE_MS);
  const lease = await takeRowLease(box.deps.store, TENANT, REC, "reconcile:s2", settle);
  assert.equal(typeof lease, "object");
  await (lease as { release(): Promise<void> }).release();
  assert.equal(ctWrites(box), 1);
});

test("admin clear: an unanswered write proven landed is marked landed and the row is released, with no CardTrader write", async () => {
  const box = world({ landThenFail: 1 });
  const store = box.deps.store as ReturnType<typeof memoryStore>;
  assert.equal((await post(payload({ idempotency_key: "t-clear-ok" }), box.deps)).status, 502);
  const res = await clearAllocationRow(box.deps, REC, "user_admin");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual((res.body.results as { outcome: string }[]).map((r) => r.outcome), ["landed"]);
  assert.equal(await store.rowUnresolved(TENANT, REC, ""), false);
  assert.equal(ctWrites(box), 1, "the clear only read CardTrader");
  assert.equal((await post(payload({ idempotency_key: "t-clear-next", allocation_id: "alloc-2" }), box.deps)).status, 200);

  // A row with nothing unanswered is a no-op success.
  const idle = await clearAllocationRow(box.deps, REC, "user_admin");
  assert.equal(idle.status, 200);
  assert.equal(idle.body.note, "nothing_unresolved");
  assert.equal((await clearAllocationRow(box.deps, "not-a-record", "user_admin")).status, 400);
});

test("admin clear: an unanswered write it cannot prove is a 409 for manual review, and nothing is sent", async () => {
  // The write never landed, and a buyer took one copy (4 -> 3): quantity alone would say "landed".
  const box = world({ failNoLand: 1 });
  assert.equal((await post(payload({ idempotency_key: "t-clear-no" }), box.deps)).status, 502);
  box.state.listings[0]!.quantity = 3;
  box.state.orders.push({ productId: 50, recordId: REC, at: new Date().toISOString() });
  const res = await clearAllocationRow(box.deps, REC, "user_admin");
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "ct_retry_unverifiable");
  assert.deepEqual(box.calls.increment, [[50, -1]], "no CardTrader write from the clear");
  assert.deepEqual([box.calls.remove, box.calls.relist], [[], []]);
  assert.equal(box.state.listings[0]!.quantity, 3);
  const retry = await post(payload({ idempotency_key: "t-clear-no" }), box.deps);
  assert.equal(retry.body.error, "ct_retry_unverifiable");
  assert.equal(box.calls.increment.length, 1, "the key's own retry does not send it either");
});

test("admin clear: a failed read leaves the row blocked, and a busy row or live key is refused", async () => {
  const box = world({ failNoLand: 1 });
  const store = box.deps.store as ReturnType<typeof memoryStore>;
  assert.equal((await post(payload({ idempotency_key: "t-clear-down" }), box.deps)).status, 502);
  box.state.listings[0]!.quantity = 3;
  box.state.ordersDown = true;
  const down = await clearAllocationRow(box.deps, REC, "user_admin");
  assert.equal(down.status, 502);
  assert.equal(await store.rowUnresolved(TENANT, REC, ""), true);
  assert.equal(store.rows.get(`${TENANT}:t-clear-down`)!.state, "pending");

  assert.equal(await store.lockRow(TENANT, REC, "someone", 120), true);
  assert.equal((await clearAllocationRow(box.deps, REC, "user_admin")).body.error, "row_busy");
  await store.unlockRow(TENANT, REC, "someone");

  // A request still holds the key: not touched.
  store.rows.get(`${TENANT}:t-clear-down`)!.until = Date.now() + 60_000;
  box.state.ordersDown = false;
  const live = await clearAllocationRow(box.deps, REC, "user_admin");
  assert.equal(live.status, 409);
  assert.equal(live.body.error, "allocation_in_progress");
  assert.equal(box.calls.increment.length, 1);
});

test("admin clear: steps never sent are left for the key's own retry", async () => {
  // Reserve 3 across two listings: the first delete lands and times out; the second was never sent.
  const box = world({ listings: [listing(50, 2), listing(51, 1)], landThenFail: 1 });
  const store = box.deps.store as ReturnType<typeof memoryStore>;
  const raw = payload({ idempotency_key: "t-clear-part", qty: 3 });
  assert.equal((await post(raw, box.deps)).status, 502);
  const res = await clearAllocationRow(box.deps, REC, "user_admin");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results, [{ key: "t-clear-part", outcome: "landed", finished: false }]);
  assert.deepEqual(box.calls.remove, [50], "the second delete was not sent by the clear");
  assert.equal(store.rows.get(`${TENANT}:t-clear-part`)!.state, "pending");
  assert.equal(await store.rowUnresolved(TENANT, REC, ""), false);
  const retry = await post(raw, box.deps);
  assert.equal(retry.status, 200);
  assert.deepEqual(box.calls.remove, [50, 51]);
  assert.equal(retry.body.ct_delta, -3);
});

test("the admin clear route is behind sign-in", async () => {
  const res = await worker.fetch(new Request("https://hekla.test/api/admin/allocations/clear", { method: "POST", body: JSON.stringify({ waitlist_record_id: REC }), headers: { "content-type": "application/json" } }), { ALLOCATIONS_ENABLED: "on" });
  assert.notEqual(res.status, 200);
  assert.ok(res.status === 401 || res.status === 403 || res.status === 503);
});

test("the retry sale check decides coverage by the oldest order returned, not by how many came back", async () => {
  const since = "2026-11-09T12:00:00.000Z";
  const order = (at: string, item: Record<string, unknown> = { product_id: 9 }) => ({ order_as: "seller", paid_at: at, order_items: [{ ...item, created_at: at }] });
  const newer = Array.from({ length: 50 }, (_, i) => order(new Date(Date.parse(since) + (i + 1) * 60_000).toISOString()));
  const older = [order("2026-11-09T11:00:00.000Z")];
  const pages = (list: unknown[][]) => { const asked: number[] = []; return { asked, page: async (n: number) => { asked.push(n); return (list[n - 1] ?? []) as never[]; } }; };

  // CardTrader capped the page at 50, all newer than the attempt: read on until an older order shows up.
  const a = pages([newer, older]);
  assert.equal(await saleSinceOnCardTrader(a.page, REC, [50], since), false);
  assert.deepEqual(a.asked, [1, 2]);
  // A sale of this listing on the second page is found.
  const b = pages([newer, [order("2026-11-09T12:00:30.000Z", { product_id: 50 }), ...older]]);
  assert.equal(await saleSinceOnCardTrader(b.page, REC, [50], since), true);
  // Matched by record id too.
  assert.equal(await saleSinceOnCardTrader(pages([[order("2026-11-09T12:30:00.000Z", { user_data_field: REC })]]).page, REC, [], since), true);
  // Never reaches back past the attempt within the page budget: cannot tell, so true (409 upstream).
  assert.equal(await saleSinceOnCardTrader(pages([newer, newer, newer]).page, REC, [50], since, 3), true);
  // A short page followed by an empty one is the end of the list: covered.
  assert.equal(await saleSinceOnCardTrader(pages([newer.slice(0, 7), []]).page, REC, [50], since), false);
  assert.equal(await saleSinceOnCardTrader(pages([[]]).page, REC, [50], since), false);
  // An undated matching item counts as a sale.
  assert.equal(await saleSinceOnCardTrader(pages([[{ order_as: "seller", order_items: [{ product_id: 50 }] }, ...older]]).page, REC, [50], since), true);
});
