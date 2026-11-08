import { test } from "node:test";
import assert from "node:assert/strict";
import type { CtListing } from "./cardtrader.ts";
import { diffStock } from "./reconcile.ts";
import { parseCsv, parseTcgCondition, parseTcgExport, type TcgRow } from "./tcgcsv.ts";
import { applyCtChanges, applyPending, buildView, chunk, planReconcileAll, runCtBatch, filterView, livePending, matchScore, matchTcgplayer, normNumber, planCardTraderSet, reconciled, tcgplayerAdjustCsv, viewCounts, viewCsv, type ReconRow } from "./threeway.ts";
import { TCGPLAYER_HEADER } from "./tcgplayer.ts";

const HEADER = "TCGplayer Id,Product Line,Set Name,Product Name,Title,Number,Rarity,Condition,TCG Market Price,TCG Direct Low,TCG Low Price With Shipping,TCG Low Price,Total Quantity,Add to Quantity,TCG Marketplace Price,Photo URL";

/* ---------- CSV parser ---------- */

test("parseCsv handles quotes, embedded commas/newlines, CRLF and a BOM", () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"x, y","he said ""hi""\nthen"\r\n'), [["a", "b"], ["x, y", 'he said "hi"\nthen']]);
  assert.deepEqual(parseCsv("a,,c\n"), [["a", "", "c"]]);
});

test("parseTcgExport keeps stocked rows, converts prices, counts bad and duplicate ids", () => {
  const csv = [HEADER,
    '5551,Lorcana TCG,The First Chapter,"Elsa - Spirit of Winter",,42/204,Legendary,Near Mint,$12.50,,,,2,0,13.99,',
    "5552,Lorcana TCG,The First Chapter,Mickey Mouse - Brave Little Tailor,,115/204,Legendary,Near Mint Foil,9,,,,0,0,10,",
    "5551,Lorcana TCG,The First Chapter,dupe,,1/204,,Near Mint,1,,,,1,0,1,",
    "abc,Lorcana TCG,x,bad id,,1,,Near Mint,1,,,,1,0,1,",
  ].join("\r\n");
  const p = parseTcgExport(csv);
  assert.ok(p.ok);
  assert.equal(p.totalRows, 4);
  assert.equal(p.rows.length, 1);
  assert.deepEqual(p.rows[0], { tcgplayerId: "5551", productLine: "Lorcana TCG", setName: "The First Chapter", productName: "Elsa - Spirit of Winter", number: "42/204", rarity: "Legendary", condition: "Near Mint", totalQty: 2, priceCents: 1399, marketCents: 1250 });
  assert.equal(p.duplicateIds, 1);
  assert.equal(p.skippedBad, 1);
});

test("parseTcgExport finds columns by name in any order and tolerates extra columns", () => {
  const p = parseTcgExport("Total Quantity,My Store Price,product name,TCGPLAYER ID\n3,1.00,Sol Ring,77\n");
  assert.ok(p.ok);
  assert.equal(p.rows[0]!.tcgplayerId, "77");
  assert.equal(p.rows[0]!.totalQty, 3);
  assert.equal(p.rows[0]!.priceCents, null);
});

test("parseTcgExport rejects files that are not a pricing export", () => {
  const p = parseTcgExport("Order Number,Buyer\n1,x\n");
  assert.equal(p.ok, false);
  assert.match((p as { error: string }).error, /missing TCGplayer Id, Product Name, Total Quantity/);
  assert.equal(parseTcgExport("").ok, false);
});

test("parseTcgCondition reads condition, foil and language", () => {
  assert.deepEqual(parseTcgCondition("Near Mint"), { condition: "NM", foil: false, language: null });
  assert.deepEqual(parseTcgCondition("Lightly Played Holofoil - Japanese"), { condition: "LP", foil: true, language: "Japanese" });
  assert.deepEqual(parseTcgCondition("Damaged Foil"), { condition: "DMG", foil: true, language: null });
  assert.equal(parseTcgCondition("Unopened").condition, null);
});

/* ---------- matching ---------- */

const R = (o: Partial<ReconRow> & { id: string }): ReconRow => ({ name: "Elsa - Spirit of Winter", game: "Lorcana", setName: "The First Chapter", setIdentifier: null, setNumber: "1", collectorNumber: "42", finish: "Normal", condition: "NM", rarity: "Legendary", qty: 2, status: "Listed", marketPriceUsd: 12.5, cardTraderListingId: null, tcgplayerSku: null, ...o });
const T = (o: Partial<TcgRow> & { tcgplayerId: string }): TcgRow => ({ productLine: "Lorcana TCG", setName: "The First Chapter", productName: "Elsa - Spirit of Winter", number: "42/204", rarity: "Legendary", condition: "Near Mint", totalQty: 2, priceCents: 1399, marketCents: 1250, ...o });
const A = "recAAAAAAAAAAAAAA", B = "recBBBBBBBBBBBBBB", C = "recCCCCCCCCCCCCCC";

test("normNumber strips the set size and leading zeros", () => {
  assert.equal(normNumber("042/204"), "42");
  assert.equal(normNumber("SP6"), "sp6");
  assert.equal(normNumber(""), null);
});

test("matchScore: exact card scores high; wrong game, number, condition or foil lower or zero", () => {
  assert.ok(matchScore(R({ id: A }), T({ tcgplayerId: "1" })) >= 0.95);
  assert.equal(matchScore(R({ id: A }), T({ tcgplayerId: "1", productLine: "Magic" })), 0);
  assert.equal(matchScore(R({ id: A }), T({ tcgplayerId: "1", number: "43/204" })), 0);
  const foil = matchScore(R({ id: A }), T({ tcgplayerId: "1", condition: "Near Mint Foil" }));
  const lp = matchScore(R({ id: A }), T({ tcgplayerId: "1", condition: "Lightly Played" }));
  assert.ok(foil < 0.95 && lp < 0.95 && foil >= 0.6 && lp >= 0.6);
  assert.ok(matchScore(R({ id: A, finish: "Foil" }), T({ tcgplayerId: "1", condition: "Near Mint Foil" })) >= 0.95);
});

test("matchTcgplayer: SKU beats confirmed beats fuzzy, one TCGplayer row per Waitlist row", () => {
  const rows = [R({ id: A, tcgplayerSku: "9" }), R({ id: B }), R({ id: C, condition: "LP" })];
  const tcg = [T({ tcgplayerId: "9", condition: "Near Mint" }), T({ tcgplayerId: "10", condition: "Lightly Played" }), T({ tcgplayerId: "11" })];
  const m = matchTcgplayer(rows, tcg, new Map([[B, "11"]]));
  assert.deepEqual([m.get(A)!.source, m.get(A)!.tcgplayerId], ["sku", "9"]);
  assert.deepEqual([m.get(B)!.source, m.get(B)!.tcgplayerId], ["confirmed", "11"]);
  assert.deepEqual([m.get(C)!.source, m.get(C)!.tcgplayerId], ["suggested", "10"]);
  assert.ok(m.get(C)!.confidence >= 0.9);
});

test("a fuzzy match goes to the better row, the other row stays unmatched", () => {
  const m = matchTcgplayer([R({ id: A, condition: "LP" }), R({ id: B })], [T({ tcgplayerId: "1" })], new Map());
  assert.equal(m.get(B)?.tcgplayerId, "1");
  assert.equal(m.has(A), false);
});

test("a SKU that is not stocked on TCGplayer counts as 0 there", () => {
  const v = buildView([R({ id: A, tcgplayerSku: "404" })], null, [], new Map(), { ct: null, tcg: "t" });
  assert.equal(v.rows[0]!.tcg!.qty, 0);
  assert.equal(v.rows[0]!.tcgMismatch, true);
});

/* ---------- diff math ---------- */

const L = (id: number, recordId: string | null, quantity: number): CtListing => ({ id, blueprintId: 1, quantity, recordId, priceCents: 100 });

test("buildView: quantities, mismatches and unmatched lists on each side", () => {
  const rows = [
    R({ id: A, qty: 2, cardTraderListingId: "10" }),
    R({ id: B, qty: 1, name: "Mickey Mouse - Brave Little Tailor", collectorNumber: "115" }),
    R({ id: C, qty: 3, status: "Sold", name: "Stitch", collectorNumber: "1" }),
  ];
  const listings = [L(10, A, 1), L(11, A, 1), L(20, B, 3), L(99, null, 1)];
  const tcg = [T({ tcgplayerId: "1", totalQty: 2 }), T({ tcgplayerId: "2", productName: "Pikachu", productLine: "Pokemon", number: "25" })];
  const v = buildView(rows, listings, tcg, new Map(), { ct: "a", tcg: "b" });
  assert.equal(v.rows.length, 2, "a Sold row with nothing listed anywhere is not shown");
  const a = v.rows.find((r) => r.recordId === A)!, b = v.rows.find((r) => r.recordId === B)!;
  assert.deepEqual([a.ct!.qty, a.ct!.listingIds.sort(), a.ctMismatch], [2, [10, 11], false]);
  assert.deepEqual([a.tcg!.qty, a.tcgMismatch], [2, false]);
  assert.deepEqual([b.ct!.qty, b.ctMismatch, b.tcg, b.tcgMismatch], [3, true, null, true]);
  assert.deepEqual(v.unmatchedCardTrader.map((l) => l.id), [99]);
  assert.deepEqual(v.unmatchedTcgplayer.map((t) => t.tcgplayerId), ["2"]);
  assert.equal(v.counts.ctMismatch, 1);
  assert.equal(v.counts.tcgMismatch, 1);
  assert.deepEqual(filterView(v.rows, { mismatch: "cardtrader", game: null, showReconciled: false }).map((r) => r.recordId), [B]);
  assert.deepEqual(filterView(v.rows, { mismatch: "any", game: "Pokémon", showReconciled: true }), []);
});

test("manual and deck holds are not listable: CardTrader matching Qty minus both is not a mismatch", () => {
  const rows = [R({ id: A, qty: 5, reservedQty: 1, deckReservedQty: 1, cardTraderListingId: "10" })];
  const listings = [L(10, A, 3)];
  const v = buildView(rows, listings, null, new Map(), { ct: "a", tcg: null });
  assert.equal(v.rows[0]!.airtableQty, 5);
  assert.equal(v.rows[0]!.reservedQty, 1);
  assert.equal(v.rows[0]!.deckReservedQty, 1);
  assert.equal(v.rows[0]!.freeQty, null);
  assert.equal(v.rows[0]!.expectedQty, 3);
  assert.equal(v.rows[0]!.ctMismatch, false);
  assert.deepEqual(diffStock(rows, listings), []);
});

test("Free Qty wins when the formula returned a number, and blanks fall back to both holds", () => {
  const formula = buildView([R({ id: A, qty: 5, reservedQty: 1, deckReservedQty: 1, freeQty: 2 })], [L(1, A, 2)], null, new Map(), { ct: "a", tcg: null });
  assert.equal(formula.rows[0]!.expectedQty, 2);
  assert.equal(formula.rows[0]!.ctMismatch, false);
  const zero = buildView([R({ id: A, qty: 4, freeQty: 0 })], [L(1, A, 1)], null, new Map(), { ct: "a", tcg: null });
  assert.equal(zero.rows[0]!.expectedQty, 0);
  assert.equal(zero.rows[0]!.ctMismatch, true);
  const blank = buildView([R({ id: A, qty: 2, reservedQty: null, deckReservedQty: null, freeQty: null })], [L(1, A, 2)], null, new Map(), { ct: "a", tcg: null });
  assert.equal(blank.rows[0]!.expectedQty, 2);
  assert.equal(blank.rows[0]!.ctMismatch, false);
  const held = buildView([R({ id: A, qty: 2, reservedQty: 1, deckReservedQty: 9 })], [L(1, A, 1)], null, new Map(), { ct: "a", tcg: null });
  assert.equal(held.rows[0]!.expectedQty, 0);
  assert.equal(diffStock([{ id: A, name: "A", qty: 2, reservedQty: 1, deckReservedQty: 9, status: "Listed", cardTraderListingId: "1" }], [L(1, A, 1)])[0]!.kind, "over_listed");
});

test("a Sold row still listed on CardTrader shows as a mismatch (expected 0)", () => {
  const v = buildView([R({ id: A, status: "Sold", qty: 0, cardTraderListingId: "10" })], [L(10, A, 1)], null, new Map(), { ct: "a", tcg: null });
  assert.deepEqual([v.rows[0]!.expectedQty, v.rows[0]!.ct!.qty, v.rows[0]!.ctMismatch, v.rows[0]!.tcgMismatch], [0, 1, true, false]);
});

test("the CardTrader column agrees with the cron's diffStock", () => {
  const rows = [R({ id: A, qty: 1, cardTraderListingId: "10" }), R({ id: B, qty: 3, cardTraderListingId: "20" }), R({ id: C, qty: 2, cardTraderListingId: "30" })];
  const listings = [L(10, A, 3), L(11, A, 1), L(20, B, 2)];
  const cron = new Set(diffStock(rows, listings).filter((d) => d.kind !== "unknown_listing").map((d) => d.recordId));
  const page = new Set(buildView(rows, listings, null, new Map(), { ct: "a", tcg: null }).rows.filter((r) => r.ctMismatch).map((r) => r.recordId));
  assert.deepEqual(page, cron);
});

test("planCardTraderSet lowers the largest listing first and raises the stored listing", () => {
  const ls = [L(10, A, 1), L(11, A, 3)];
  assert.deepEqual(planCardTraderSet(ls, 10, 1), { ok: true, before: 4, changes: [{ listingId: 11, delta: -3 }] });
  assert.deepEqual(planCardTraderSet(ls, 10, 0), { ok: true, before: 4, changes: [{ listingId: 11, delta: -3 }, { listingId: 10, delta: -1 }] });
  assert.deepEqual(planCardTraderSet(ls, 10, 6), { ok: true, before: 4, changes: [{ listingId: 10, delta: 2 }] });
  assert.deepEqual(planCardTraderSet(ls, 10, 4), { ok: true, before: 4, changes: [] });
  assert.equal(planCardTraderSet([], null, 1).ok, false);
  assert.equal(planCardTraderSet(ls, 10, -1).ok, false);
});

test("tcgplayerAdjustCsv: Add to Quantity = Airtable − TCGplayer, only confirmed matches, current price", () => {
  const rows = [R({ id: A, qty: 3, tcgplayerSku: "1" }), R({ id: B, qty: 0, status: "Sold", tcgplayerSku: "2" }), R({ id: C, qty: 1 })];
  const tcg = [T({ tcgplayerId: "1", totalQty: 1, priceCents: 1399 }), T({ tcgplayerId: "2", totalQty: 2, priceCents: 500, number: "7" }), T({ tcgplayerId: "3", totalQty: 5 })];
  const v = buildView(rows, null, tcg, new Map(), { ct: null, tcg: "b" });
  const out = tcgplayerAdjustCsv(v.rows, new Map());
  const lines = out.csv.trim().split("\r\n");
  assert.equal(lines[0], TCGPLAYER_HEADER.join(","));
  assert.deepEqual(out.included.map((i) => [i.tcgplayerId, i.delta]), [["1", 2], ["2", -2]]);
  assert.deepEqual(out.skipped, [{ recordId: C, reason: "match not confirmed" }]);
  const cells = parseCsv(out.csv);
  assert.deepEqual([cells[1]![0], cells[1]![12], cells[1]![13], cells[1]![14]], ["1", "1", "2", "13.99"]);
  assert.deepEqual([cells[2]![13], cells[2]![14]], ["-2", "5.00"]);
});

test("tcgplayerAdjustCsv falls back to Hekla's price only for a SKU not stocked on TCGplayer", () => {
  const v = buildView([R({ id: A, qty: 2, tcgplayerSku: "8" }), R({ id: B, qty: 2, tcgplayerSku: "9" })], null, [], new Map(), { ct: null, tcg: "b" });
  const out = tcgplayerAdjustCsv(v.rows, new Map([[A, 4.5], [B, null]]));
  assert.deepEqual(out.included.map((i) => [i.tcgplayerId, i.delta, i.priceSource]), [["8", 2, "Hekla market price"]]);
  assert.deepEqual(out.skipped, [{ recordId: B, reason: "no price for the import" }]);
});

test("viewCsv has one line per row plus the header", () => {
  const v = buildView([R({ id: A })], [L(1, A, 2)], null, new Map(), { ct: "a", tcg: null });
  const cells = parseCsv(viewCsv(v.rows));
  assert.equal(cells.length, 2);
  assert.equal(cells[1]![9], "2");
});

/* ---------- reconciled rows leave the list ---------- */

test("filterView hides reconciled rows unless showReconciled; game still applies", () => {
  const rows = [R({ id: A, qty: 1, tcgplayerSku: "1" }), R({ id: B, qty: 2, tcgplayerSku: "2" }), R({ id: C, qty: 1, game: "Riftbound" })];
  const v = buildView(rows, [L(10, A, 1), L(20, B, 1), L(30, C, 1)], [T({ tcgplayerId: "1", totalQty: 1 }), T({ tcgplayerId: "2", totalQty: 2, number: "7" })], new Map(), { ct: "a", tcg: "b" });
  const ids = (f: Parameters<typeof filterView>[1]) => filterView(v.rows, f).map((r) => r.recordId);
  assert.deepEqual(ids({ mismatch: "any", game: null, showReconciled: false }), [B, C]);
  assert.deepEqual(ids({ mismatch: "tcgplayer", game: null, showReconciled: false }), [C]);
  assert.deepEqual(ids({ mismatch: "any", game: null, showReconciled: true }), [A, B, C]);
  assert.deepEqual(ids({ mismatch: "any", game: "Lorcana", showReconciled: true }), [A, B]);
});

test("an unconfirmed suggestion is not reconciled even when the numbers agree", () => {
  const v = buildView([R({ id: A, qty: 2 })], null, [T({ tcgplayerId: "1", totalQty: 2 })], new Map(), { ct: null, tcg: "b" });
  assert.equal(v.rows[0]!.tcg!.source, "suggested");
  assert.equal(reconciled(v.rows[0]!), false);
  const confirmed = buildView([R({ id: A, qty: 2 })], null, [T({ tcgplayerId: "1", totalQty: 2 })], new Map([[A, "1"]]), { ct: null, tcg: "b" });
  assert.equal(reconciled(confirmed.rows[0]!), true);
});

test("pending TCGplayer import: in force until a newer export or 24 hours", () => {
  const at = "2026-10-17T18:00:00.000Z", t = Date.parse(at);
  const p = { [A]: { at, tcgplayerId: "1", delta: 2 } };
  assert.deepEqual(Object.keys(livePending(p, "2026-10-17T12:00:00.000Z", t + 3600_000)), [A]);
  assert.deepEqual(Object.keys(livePending(p, null, t + 23 * 3600_000)), [A]);
  assert.deepEqual(Object.keys(livePending(p, null, t + 24 * 3600_000)), [], "expired");
  assert.deepEqual(Object.keys(livePending(p, "2026-10-17T18:30:00.000Z", t + 3600_000)), [], "a newer export decides");
});

test("a pending row is hidden and counted as pending; a SKU change drops the pending mark", () => {
  const v = buildView([R({ id: A, qty: 3, tcgplayerSku: "1" }), R({ id: B, qty: 3, tcgplayerSku: "9" })], null, [T({ tcgplayerId: "1", totalQty: 1 }), T({ tcgplayerId: "9", totalQty: 1, number: "8" })], new Map(), { ct: null, tcg: "b" });
  applyPending(v.rows, { [A]: { at: "x", tcgplayerId: "1", delta: 2 }, [B]: { at: "x", tcgplayerId: "5", delta: 2 } });
  assert.deepEqual(v.rows.map((r) => !!r.tcgPending), [true, false]);
  assert.deepEqual(filterView(v.rows, { mismatch: "any", game: null, showReconciled: false }).map((r) => r.recordId), [B]);
  const c = viewCounts(v.rows);
  assert.deepEqual([c.tcgMismatch, c.pendingUpload, c.open], [1, 1, 1]);
});

test("applyCtChanges patches the cached listings and drops listings at 0", () => {
  const out = applyCtChanges([L(10, A, 1), L(11, A, 3), L(20, B, 1)], [{ listingId: 11, delta: -3 }, { listingId: 10, delta: 1 }]);
  assert.deepEqual(out.map((l) => [l.id, l.quantity]), [[10, 2], [20, 1]]);
});

/* ---------- Reconcile All ---------- */

test("chunk splits into batches of 25 by default, keeping order", () => {
  const xs = Array.from({ length: 61 }, (_, i) => i);
  assert.deepEqual(chunk(xs).map((b) => b.length), [25, 25, 11]);
  assert.deepEqual(chunk(xs).flat(), xs);
  assert.deepEqual(chunk([]), []);
  assert.throws(() => chunk(xs, 0));
});

test("planReconcileAll: summary math for up, down, deletes, blocked and TCGplayer exclusions", () => {
  const D = "recDDDDDDDDDDDDDD", E = "recEEEEEEEEEEEEEE";
  const rows = [
    R({ id: A, qty: 3, cardTraderListingId: "10", tcgplayerSku: "1" }),               // CT 1 → 3 (up); TCG 1 → import +2
    R({ id: B, qty: 1, cardTraderListingId: "20" }),                // CT 2+1 → 1 (down, one listing deleted)
    R({ id: C, qty: 0, status: "Sold", cardTraderListingId: "30" }),                    // Airtable 0: CT 2 → 0, listing deleted
    R({ id: D, qty: 2, name: "Nobody - On CT", collectorNumber: "99" }),                // no listing: blocked
    R({ id: E, qty: 2, name: "Suggested Only", collectorNumber: "77" }),                // TCG suggestion: excluded, counted
  ];
  const listings = [L(10, A, 1), L(20, B, 2), L(21, B, 1), L(30, C, 2)];
  const tcg = [T({ tcgplayerId: "1", totalQty: 1 }), T({ tcgplayerId: "7", productName: "Suggested Only", number: "77", totalQty: 1 })];
  const v = buildView(rows, listings, tcg, new Map(), { ct: "a", tcg: "b" });
  v.rows.find((r) => r.recordId === D)!.ct = { qty: 0, listingIds: [], storedListingId: null };
  const plan = planReconcileAll(v.rows, listings, new Map(), { cardtrader: true, tcgplayer: true });
  assert.deepEqual(plan.cardtrader.map((i) => [i.recordId, i.before, i.target, i.deletes]), [[A, 1, 3, []], [B, 3, 1, [20]], [C, 2, 0, [30]]]);
  assert.deepEqual(plan.cardtraderBlocked.map((b) => b.recordId), [D, E], "no listing to raise");
  assert.deepEqual(plan.tcgplayer.recordIds, [A]);
  assert.deepEqual(plan.summary, { ctRows: 3, ctUp: 1, ctDown: 2, ctListingsChanged: 3, ctDeletes: 2, ctToZeroRows: 1, tcgRows: 1, tcgSuggested: 1, tcgSkipped: plan.tcgplayer.skipped.length });
  // Platform filter: CardTrader only / TCGplayer only.
  assert.equal(planReconcileAll(v.rows, listings, new Map(), { cardtrader: true, tcgplayer: false }).summary.tcgRows, 0);
  assert.equal(planReconcileAll(v.rows, listings, new Map(), { cardtrader: false, tcgplayer: true }).summary.ctRows, 0);
});

const card = (id: string, qty: number, listingId: string | null, status = "Listed") => ({ id, qty, status, cardTraderListingId: listingId });

test("runCtBatch applies sequentially, skips stale rows, and keeps going after a failure", async () => {
  const D = "recDDDDDDDDDDDDDD";
  const cards = new Map([[A, card(A, 3, "10")], [B, card(B, 5, "20")], [C, card(C, 1, "30")], [D, card(D, 2, "40")]]);
  const listings = [L(10, A, 1), L(20, B, 2), L(30, C, 2), L(40, D, 1)];
  const calls: string[] = []; const logged: string[] = [];
  const results = await runCtBatch(
    [
      { recordId: A, expectedTarget: 3, expectedCurrent: 1 },  // ok: +2
      { recordId: B, expectedTarget: 4, expectedCurrent: 2 },  // Airtable moved to 5: skip
      { recordId: C, expectedTarget: 1, expectedCurrent: 3 },  // CardTrader moved to 2: skip
      { recordId: D, expectedTarget: 2, expectedCurrent: 1 },  // CardTrader errors: failed
      { recordId: "recZZZZZZZZZZZZZZ", expectedTarget: 1, expectedCurrent: 0 },
    ],
    cards, listings,
    async (id, delta) => { calls.push(`${id}:${delta}`); if (id === 40) throw new Error("CardTrader 500"); },
    async (_i, r) => { logged.push(`${r.recordId}:${r.status}`); },
  );
  assert.deepEqual(results.map((r) => r.status), ["succeeded", "skipped", "skipped", "failed", "skipped"]);
  assert.match(results[1]!.reason!, /Airtable changed/);
  assert.match(results[2]!.reason!, /CardTrader changed \(now 2\)/);
  assert.equal(results[3]!.reason, "CardTrader 500");
  assert.deepEqual(calls, ["10:2", "40:1"], "stale rows are never touched");
  assert.equal(logged.length, 5, "every row is logged");
});

test("runCtBatch re-lists toward Qty minus manual and deck holds", async () => {
  const cards = new Map([[A, { ...card(A, 5, "10"), reservedQty: 1, deckReservedQty: 1 }]]);
  const applied: [number, number][] = [];
  const results = await runCtBatch([{ recordId: A, expectedTarget: 3, expectedCurrent: 5 }], cards, [L(10, A, 5)], async (id, delta) => { applied.push([id, delta]); }, async () => {});
  assert.equal(results[0]!.status, "succeeded");
  assert.equal(results[0]!.target, 3);
  assert.deepEqual(applied, [[10, -2]]);
});

test("runCtBatch sees its own earlier changes when two rows share a listing", async () => {
  const cards = new Map([[A, card(A, 1, "10")], [B, card(B, 1, "10")]]);
  const results = await runCtBatch([{ recordId: A, expectedTarget: 1, expectedCurrent: 3 }, { recordId: B, expectedTarget: 1, expectedCurrent: 3 }], cards, [L(10, null, 3)], async () => {}, async () => {});
  assert.deepEqual(results.map((r) => r.status), ["succeeded", "skipped"]);
});
