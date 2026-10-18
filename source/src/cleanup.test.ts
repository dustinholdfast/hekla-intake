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

import { previewJson, runCleanupBatch, survivorPatch, type ApplyGroup, type CleanupIO } from "./cleanup.ts";
import { restorableFields } from "./airtable.ts";

function fakeIO(failOn?: string) {
  const calls: string[] = []; let n = 0;
  const io: CleanupIO = {
    snapshot: async (id, action) => { calls.push(`snap ${action} ${id}`); return ++n; },
    applied: async (id) => { calls.push(`applied ${id}`); },
    update: async (id, f) => { calls.push(`update ${id} ${JSON.stringify(f)}`); },
    remove: async (id) => { if (id === failOn) throw new Error("Airtable down"); calls.push(`delete ${id}`); },
    archive: async (id) => { calls.push(`archive ${id}`); },
  };
  return { io, calls };
}
const merged = () => {
  const rows = [row("recAAAAAAAAAAAAAA", { cardTraderListingId: "100", qty: 1, costBasisUsd: 2 }), row("recBBBBBBBBBBBBBB", { cardTraderListingId: "101", qty: 1, costBasisUsd: 4 })];
  return planCleanup(rows, [L(100, 2, "recAAAAAAAAAAAAAA")]);
};
const input = (o: Partial<ApplyGroup> = {}): ApplyGroup => ({ key: merged().groups[0]!.key, survivorId: "recAAAAAAAAAAAAAA", listingId: 100, ctQty: 2, removeIds: ["recBBBBBBBBBBBBBB"], mode: "keep", ...o });

test("apply: snapshot before every write, survivor gets CardTrader qty + weighted cost, duplicate deleted", async () => {
  const { io, calls } = fakeIO();
  const [r] = await runCleanupBatch([input()], merged(), io);
  assert.equal(r!.status, "succeeded");
  assert.deepEqual(calls, ['snap update recAAAAAAAAAAAAAA', 'update recAAAAAAAAAAAAAA {"Qty":2,"Cost Basis USD":3}', "applied 1", "snap delete recBBBBBBBBBBBBBB", "delete recBBBBBBBBBBBBBB", "applied 2"]);
});

test("apply refuses stale or skipped groups and never writes for them", async () => {
  const { io, calls } = fakeIO();
  const res = await runCleanupBatch([input({ ctQty: 3 }), input({ removeIds: [] }), input({ survivorId: "recCCCCCCCCCCCCCC" }), input({ mode: "skip" }), input({ key: "nope" })], merged(), io);
  assert.deepEqual(res.map((r) => r.status), ["skipped", "skipped", "skipped", "skipped", "skipped"]);
  assert.match(res[0]!.reason!, /CardTrader now shows 2/);
  assert.deepEqual(calls, []);
});

test("apply: archive mode, and a failure is reported with what was already done", async () => {
  const a = fakeIO(); await runCleanupBatch([input()], merged(), a.io, "archive");
  assert.ok(a.calls.includes("archive recBBBBBBBBBBBBBB") && !a.calls.some((c) => c.startsWith("delete")));
  const f = fakeIO("recBBBBBBBBBBBBBB"); const [r] = await runCleanupBatch([input()], merged(), f.io);
  assert.equal(r!.status, "failed"); assert.match(r!.reason!, /Airtable down/); assert.deepEqual(r!.removed, []);
  assert.ok(!f.calls.includes("applied 2"), "snapshot of the failed delete is not marked applied");
});

test("preview JSON groups and survivor patch; restore drops computed fields", () => {
  const p = merged(); const j = previewJson(p);
  assert.deepEqual(j.counts, { merges: 1, deletes: 1, syncs: 0, goneNoSurvivor: 0, listingsNoRow: 0, qtyMismatches: 0, ambiguous: 0 });
  assert.deepEqual(survivorPatch(p.groups[0]!), { Qty: 2, "Cost Basis USD": 3 });
  assert.deepEqual(restorableFields({ "Card Name": "X", Qty: 1, "Finish description": { state: "generated", value: "…" }, "Finish condition summary": "x", Notes: null }), { "Card Name": "X", Qty: 1 });
});
