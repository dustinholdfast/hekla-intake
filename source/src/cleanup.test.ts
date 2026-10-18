import { test } from "node:test";
import assert from "node:assert/strict";
import { normCollector, planCleanup, weightedCost, type CleanupRow } from "./cleanup.ts";

const row = (id: string, o: Partial<CleanupRow> = {}): CleanupRow => ({ id, name: "Gust Monk", game: "Riftbound", setNumber: null, setIdentifier: "OGN", collectorNumber: "12", finish: "Normal", condition: "NM", qty: 1, status: "Listed", costBasisUsd: null, cardTraderListingId: null, ...o });
const L = (id: number, quantity: number, recordId: string | null) => ({ id, blueprintId: 1, quantity, recordId, priceCents: 100 });

test("survivor takes CardTrader's consolidated qty; gone duplicates are removed into it; qty mismatch flagged", () => {
  const rows = [row("recAAAAAAAAAAAAAA", { cardTraderListingId: "100", qty: 1 }), row("recBBBBBBBBBBBBBB", { cardTraderListingId: "101", qty: 2, collectorNumber: "012" })];
  const p = planCleanup(rows, [L(100, 3, "recAAAAAAAAAAAAAA")]);
  assert.equal(p.toRemove.length, 1); assert.equal(p.toRemove[0]!.intoRecordId, "recAAAAAAAAAAAAAA");
  assert.equal(p.toUpdate.length, 1); assert.equal(p.toUpdate[0]!.ctQty, 3);
  assert.equal(p.qtyMismatches.length, 0, "1 + 2 = 3");
  const q = planCleanup(rows, [L(100, 2, "recAAAAAAAAAAAAAA")]);
  assert.deepEqual([q.qtyMismatches.length, q.qtyMismatches[0]!.airtableQtySum, q.qtyMismatches[0]!.ctQty], [1, 3, 2]);
});

test("never 0 by omission: a gone row with no survivor, different condition, Sold rows and listings without rows", () => {
  const rows = [row("recAAAAAAAAAAAAAA", { cardTraderListingId: "100" }), row("recCCCCCCCCCCCCCC", { cardTraderListingId: "102", condition: "LP" }), row("recDDDDDDDDDDDDDD", { cardTraderListingId: "103", status: "Sold", qty: 0 })];
  const p = planCleanup(rows, [L(100, 1, "recAAAAAAAAAAAAAA"), L(999, 1, "recZZZZZZZZZZZZZZ")]);
  assert.deepEqual(p.toRemove, []);
  assert.deepEqual(p.goneNoSurvivor.map((r) => r.id), ["recCCCCCCCCCCCCCC"]);
  assert.deepEqual(p.listingsNoRow.map((l) => l.id), [999]);
  assert.equal(p.skippedSold, 1);
});

test("two live listings for one printing are ambiguous and left alone", () => {
  const rows = [row("recAAAAAAAAAAAAAA", { cardTraderListingId: "100" }), row("recBBBBBBBBBBBBBB", { cardTraderListingId: "101" }), row("recCCCCCCCCCCCCCC", { cardTraderListingId: "102" })];
  const p = planCleanup(rows, [L(100, 1, "recAAAAAAAAAAAAAA"), L(101, 1, "recBBBBBBBBBBBBBB")]);
  assert.equal(p.ambiguous.length, 1); assert.deepEqual(p.toRemove, []); assert.deepEqual(p.goneNoSurvivor, []);
});

test("weighted cost and collector normalising", () => {
  assert.deepEqual(weightedCost([{ qty: 1, costBasisUsd: 2 }, { qty: 3, costBasisUsd: 4 }]), { cost: 3.5, mixed: true });
  assert.deepEqual(weightedCost([{ qty: 1, costBasisUsd: null }]), { cost: null, mixed: false });
  assert.equal(normCollector("0249"), "249"); assert.equal(normCollector("42/204"), "42");
});
