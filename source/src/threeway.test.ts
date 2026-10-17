import { test } from "node:test";
import assert from "node:assert/strict";
import type { CtListing } from "./cardtrader.ts";
import { diffStock } from "./reconcile.ts";
import { parseCsv, parseTcgCondition, parseTcgExport, type TcgRow } from "./tcgcsv.ts";
import { buildView, filterView, matchScore, matchTcgplayer, normNumber, planCardTraderSet, tcgplayerAdjustCsv, viewCsv, type ReconRow } from "./threeway.ts";
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
  assert.deepEqual(filterView(v.rows, { mismatch: "cardtrader", game: null }).map((r) => r.recordId), [B]);
  assert.deepEqual(filterView(v.rows, { mismatch: null, game: "Pokémon" }), []);
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
