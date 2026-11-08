import { test } from "node:test";
import assert from "node:assert/strict";
import { diffStock, planPushes } from "./reconcile.ts";
import type { CtListing } from "./cardtrader.ts";

const A = "recAAAAAAAAAAAAAA", B = "recBBBBBBBBBBBBBB", C = "recCCCCCCCCCCCCCC", Z = "recZZZZZZZZZZZZZZ";
const L = (id: number, recordId: string | null, quantity: number): CtListing => ({ id, blueprintId: 1, quantity, recordId, priceCents: 100 });
const rows = [
  { id: A, name: "A", qty: 1, status: "Listed", cardTraderListingId: "10" },
  { id: B, name: "B", qty: 3, status: "Listed", cardTraderListingId: "20" },
  { id: C, name: "C", qty: 2, status: "Listed", cardTraderListingId: "30" },
];
const listings = [L(10, A, 3), L(11, A, 1), L(20, B, 2), L(99, Z, 1)];

test("diff finds over-listed, under-listed, missing and unknown rows", () => {
  const d = diffStock(rows, listings);
  const by = (k: string) => d.filter((x) => x.kind === k).map((x) => x.recordId);
  assert.deepEqual(by("over_listed"), [A]);
  assert.deepEqual(by("under_listed"), [B]);
  assert.deepEqual(by("missing_on_cardtrader"), [C]);
  assert.deepEqual(by("unknown_record"), [Z]);
  assert.equal(d.find((x) => x.recordId === A)!.cardTraderQty, 4);
});

test("manual and deck holds are not counted as listable, so a matching CardTrader quantity is not drift", () => {
  assert.deepEqual(diffStock([{ id: A, name: "A", qty: 5, reservedQty: 1, deckReservedQty: 1, status: "Listed", cardTraderListingId: "10" }], [L(10, A, 3)]), []);
  assert.deepEqual(diffStock([{ id: A, name: "A", qty: 2, status: "Listed", cardTraderListingId: "10" }], [L(10, A, 2)]), [], "blank holds are 0");
  assert.deepEqual(diffStock([{ id: A, name: "A", qty: 4, freeQty: 1, status: "Listed", cardTraderListingId: "10" }], [L(10, A, 1)]), [], "Free Qty is used when present");
  const over = diffStock([{ id: A, name: "A", qty: 4, freeQty: 0, status: "Listed", cardTraderListingId: "10" }], [L(10, A, 1)]);
  assert.equal(over[0]!.kind, "over_listed");
  assert.equal(over[0]!.airtableQty, 0);
});

test("a Sold row counts as 0 even if Qty was left behind", () => {
  const d = diffStock([{ id: A, name: "A", qty: 2, status: "Sold", cardTraderListingId: "10" }], [L(10, A, 1)]);
  assert.equal(d[0]!.kind, "over_listed"); assert.equal(d[0]!.airtableQty, 0);
});

test("push waits for a second run with the same excess, then lowers largest listings first", () => {
  const now = diffStock(rows, listings);
  assert.deepEqual(planPushes(now, null, listings), [], "first sighting: no push");
  const changed = diffStock(rows, [L(10, A, 2), L(11, A, 1), L(20, B, 2)]);
  assert.deepEqual(planPushes(now, changed, listings), [], "excess changed between runs: no push");
  assert.deepEqual(planPushes(now, now, listings), [{ recordId: A, listingId: 10, delta: -3 }]);
  assert.equal(planPushes(now, now, listings).some((p) => p.delta > 0), false, "never raises");
});
