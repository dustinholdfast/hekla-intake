import { test } from "node:test";
import assert from "node:assert/strict";
import { assertEnrichFields, baseRank, combine, enrichOne, extractCatalog, mapRarity, rulesDecision, validateGemini } from "./enrich.ts";

test("rarity maps onto Airtable choices only", () => {
  assert.equal(mapRarity("Enchanted"), "Enchanted");
  assert.equal(mapRarity("mythic"), "Legendary");
  assert.equal(mapRarity("Super_rare"), "Super Rare");
  assert.equal(mapRarity("Ultra Rare"), "Special");
  assert.equal(mapRarity("common"), "Common");
  assert.equal(mapRarity(""), null);
});

test("price is picked by finish and never invented", () => {
  const mtg = { name: "X", type_line: "Creature", rarity: "rare", prices: { usd: "1.50", usd_foil: "4.00" } };
  assert.equal(extractCatalog("Magic: The Gathering", mtg, "Normal").price, 1.5);
  assert.equal(extractCatalog("Magic: The Gathering", mtg, "Foil").price, 4);
  assert.equal(extractCatalog("Magic: The Gathering", { ...mtg, prices: { usd: null } }, "Normal").price, null);
  const lor = extractCatalog("Lorcana", { name: "Elsa", version: "Spirit of Winter", type: ["Character"], rarity: "Enchanted", prices: { usd_foil: "952.84" } }, "Normal");
  assert.equal(lor.price, null); assert.match(lor.priceSource, /unavailable/);
  const pk = extractCatalog("Pokémon", { name: "P", tcgplayer: { prices: { normal: { market: 0.2 }, reverseHolofoil: { market: 0.9 } } } }, "Foil");
  assert.equal(pk.price, 0.9);
  assert.equal(extractCatalog("Riftbound", { name: "R", classification: { type: "Unit", rarity: "Rare" } }, "Normal").price, null);
  assert.equal(extractCatalog("Yu-Gi-Oh!", { name: "Y", card_prices: [{ tcgplayer_price: "0.16" }] }, "Normal").price, 0.16);
});

test("deterministic rank is stable and bounded", () => {
  assert.equal(baseRank(null, null, "NM", null), 30);
  assert.ok(baseRank(100, 10, "NM", "Enchanted") > baseRank(100, 10, "DMG", "Common"));
  assert.ok(baseRank(100000, 1, "NM", "Enchanted") <= 100);
  assert.equal(baseRank(10, null, "NM", "Rare"), baseRank(10, null, "NM", "Rare"));
});

test("Gemini output is allowlisted", () => {
  assert.deepEqual(validateGemini({ rankScore: 70, recommendation: "List", reason: "Good margin." }), { rankScore: 70, recommendation: "List", reason: "Good margin." });
  assert.equal(validateGemini({ rankScore: 70.5, recommendation: "List", reason: "x" }), null);
  assert.equal(validateGemini({ rankScore: 70, recommendation: "Sell", reason: "x" }), null);
  assert.equal(validateGemini({ rankScore: 70, recommendation: "List", reason: "x".repeat(141) }), null);
  assert.equal(validateGemini({ rankScore: 70, recommendation: "List", reason: "x", status: "Listed" }), null);
  assert.equal(validateGemini("nope"), null);
});

test("Gemini adjusts base by at most ±20 and respects cap", () => {
  assert.equal(combine(40, { rankScore: 95, recommendation: "List", reason: "r" }, 10).rankScore, 60);
  assert.equal(combine(40, { rankScore: 0, recommendation: "Skip", reason: "r" }, 10).rankScore, 20);
  assert.equal(combine(60, { rankScore: 70, recommendation: "List", reason: "r" }, 100).recommendation, "Hold");
  assert.equal(rulesDecision(70, 20, 100).recommendation, "Hold");
  assert.equal(rulesDecision(70, null, 0).recommendation, "Hold");
  assert.equal(rulesDecision(10, 0.5, 0).recommendation, "Skip");
});

test("enrichment never writes Status", () => {
  assert.throws(() => assertEnrichFields({ Status: "Listed" }));
  assert.throws(() => assertEnrichFields({ Recommendation: "Sell" }));
  assertEnrichFields({ "Auto Rank": 50, Recommendation: "Hold", Rarity: "Rare" });
});

test("enrichOne end-to-end with mocked catalog + Gemini", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("scryfall")) return new Response(JSON.stringify({ object: "card", name: "Ancestral Katana", type_line: "Artifact — Equipment", rarity: "common", prices: { usd: "0.10", usd_foil: "0.40" } }));
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const gem = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ rankScore: 5, recommendation: "Skip", reason: "Bulk common." }) }] } }] }))) as unknown as typeof fetch;
  try {
    const r = await enrichOne({ id: "recAAAAAAAAAAAAAA", game: "Magic: The Gathering", setNumber: null, setIdentifier: "NEO", collectorNumber: "1", name: "", finish: "Foil", condition: "NM", qty: 1, costBasisUsd: null, rarity: null, resolvedName: null },
      3, { GEMINI_API_KEY: "test" }, { fetcher: gem, now: () => new Date("2026-10-10T14:00:00Z") });
    assert.equal(r.fields["Market Price USD"], 0.4);
    assert.equal(r.fields.Recommendation, "Skip");
    assert.equal(r.fields.Rarity, "Common");
    assert.equal(r.fields["Resolved Name"], "Ancestral Katana");
    assert.equal(r.decision.via, "gemini");
    assert.ok(!("Status" in r.fields));
    assert.ok(!("Rank Score" in r.fields));
  } finally { globalThis.fetch = realFetch; }
});

test("missing catalog price keeps Hekla's existing price", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ items: [{ name: "Ol' Poro", collector_number: 29, classification: { type: "Unit", rarity: "Common" }, metadata: {} }], pages: 1 }))) as typeof fetch;
  try {
    const r = await enrichOne({ id: "recBBBBBBBBBBBBBB", game: "Riftbound", setNumber: null, setIdentifier: "VEN", collectorNumber: "029", name: "Ol' Poro", finish: "Normal", condition: "NM", qty: 1, costBasisUsd: null, rarity: "Common", resolvedName: "Ol' Poro", marketPriceUsd: 0.06 }, 0, {});
    assert.ok(!("Market Price USD" in r.fields));
    assert.match(String(r.fields["Price Source"]), /kept existing/);
    assert.equal(r.decision.via, "rules");
  } finally { globalThis.fetch = realFetch; }
});

import { combine as combine2, listedRulesDecision, LISTED_LABELS } from "./enrich.ts";
import { pageWindow } from "./airtable.ts";
test("listed mode: keep/watch/pull rules and no cap override", () => {
  assert.equal(listedRulesDecision(50, 3).recommendation, "List");
  assert.equal(listedRulesDecision(20, 0.1).recommendation, "Skip");
  assert.equal(listedRulesDecision(30, null).recommendation, "Hold");
  assert.equal(combine2(60, { rankScore: 70, recommendation: "List", reason: "Keep: good." }, 100, 100, "listed").recommendation, "List");
  assert.equal(combine2(60, { rankScore: 70, recommendation: "List", reason: "r" }, 100, 100, "waitlist").recommendation, "Hold");
  assert.deepEqual(LISTED_LABELS, { List: "Keep", Hold: "Watch", Skip: "Pull" });
});
test("listed paging covers all 68 rows in order", () => {
  const seen: number[] = []; let offset: number | null = 0;
  while (offset !== null) { const w = pageWindow(68, offset); for (let i = w.start; i < w.end; i++) seen.push(i); offset = w.nextOffset; }
  assert.equal(seen.length, 68); assert.equal(new Set(seen).size, 68);
  assert.deepEqual(pageWindow(68, 999), { start: 68, end: 68, nextOffset: null });
  assert.deepEqual(pageWindow(5, -3), { start: 0, end: 5, nextOffset: null });
});
test("listed enrichment never writes Status", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ name: "Rafiki", version: "Mysterious Sage", type: ["Character"], rarity: "Uncommon", prices: { usd: "0.08" } }))) as typeof fetch;
  try {
    const r = await enrichOne({ id: "recCCCCCCCCCCCCCC", game: "Lorcana", setNumber: "1", setIdentifier: null, collectorNumber: "54", name: "Rafiki", finish: "Normal", condition: "NM", qty: 1, costBasisUsd: null, rarity: "Uncommon", resolvedName: "Rafiki - Mysterious Sage" }, 100, {}, { mode: "listed" });
    assert.equal(r.fields.Recommendation, "Skip");
    assert.match(String(r.fields["Rank Reason"]), /^Pull:/);
    assert.ok(!("Status" in r.fields) && !("Rank Score" in r.fields));
  } finally { globalThis.fetch = realFetch; }
});

import { matchPrice } from "./tcgcsv.ts";
test("tcgcsv matcher picks by number then finish, never invents", () => {
  const products = [
    { productId: 1, name: "Blazing Scorcher", extendedData: [{ name: "Number", value: "001/298" }] },
    { productId: 2, name: "Blazing Scorcher (Alternate Art)", extendedData: [{ name: "Number", value: "001/298" }] },
    { productId: 3, name: "Booster Box", extendedData: [] },
  ];
  const prices = [
    { productId: 1, subTypeName: "Normal", marketPrice: 0.08 }, { productId: 1, subTypeName: "Foil", marketPrice: 0.22 },
    { productId: 2, subTypeName: "Foil", marketPrice: 9.5 },
  ];
  assert.equal(matchPrice(products, prices, { number: "1", name: "Blazing Scorcher", finish: "Normal" }).price, 0.08);
  assert.equal(matchPrice(products, prices, { number: "001", name: "", finish: "Foil" }).price, 0.22);
  assert.equal(matchPrice(products, prices, { number: "", name: "Blazing Scorcher", finish: "Foil" }).price, 0.22);
  assert.equal(matchPrice(products, prices, { number: "77", name: "Nope", finish: "Normal" }).price, null);
  assert.equal(matchPrice(products, [{ productId: 1, subTypeName: "Normal", marketPrice: null }], { number: "1", name: "", finish: "Normal" }).price, null);
});

import { lookupCatalog as _lookupCatalog, priceMove } from "./enrich.ts";
import { rescanSlotOffset, RESCAN_BATCH } from "./airtable.ts";
test("price move: only a real, different catalog price counts as a change", () => {
  assert.deepEqual(priceMove(1.2, 1.45), { changed: true, from: 1.2, to: 1.45 });
  assert.deepEqual(priceMove(null, 0.5), { changed: true, from: null, to: 0.5 });
  assert.equal(priceMove(1.2, 1.2).changed, false);
  assert.equal(priceMove(0.1 + 0.2, 0.3).changed, false);
  assert.deepEqual(priceMove(4.25, null), { changed: false, from: 4.25, to: 4.25 });
  assert.deepEqual(priceMove(undefined, null), { changed: false, from: null, to: null });
});
test("cron re-scan visits every page in turn and wraps", () => {
  const slot = 600_000; const seen = new Set<number>();
  for (let run = 0; run < 8; run++) seen.add(rescanSlotOffset(157, run * slot));
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 20, 40, 60, 80, 100, 120, 140]);
  assert.equal(rescanSlotOffset(157, 8 * slot), 0);
  assert.equal(rescanSlotOffset(RESCAN_BATCH, 5 * slot), 0);
  assert.equal(rescanSlotOffset(0, 5 * slot), 0);
});
test("enrichOne re-ranks from a supplied catalog without a lookup, and still never writes Status", async () => {
  assert.equal(typeof _lookupCatalog, "function");
  const card = { id: "rec1", game: "Lorcana", setNumber: "1", setIdentifier: null, collectorNumber: "1", name: "Test", finish: "Normal", condition: "NM", qty: 1, costBasisUsd: null, rarity: "Rare", resolvedName: "Test", marketPriceUsd: 1 };
  const r = await enrichOne(card, 0, {}, { mode: "listed", catalog: { found: true, name: "Test", price: 9.5, priceSource: "Lorcast usd" }, fetcher: (() => { throw new Error("no network in a re-rank"); }) as never, now: () => new Date("2026-10-11T00:00:00Z") });
  assert.equal(r.fields["Market Price USD"], 9.5);
  assert.equal(r.fields.Status, undefined);
  assert.match(String(r.fields["Rank Reason"]), /^(Keep|Watch|Pull):/);
  assertEnrichFields(r.fields);
});

import { riftboundNumberKey } from "./preview.ts";
test("riftbound numbers keep their prefix so 006, SP6 and R06 stay different cards", () => {
  assert.equal(riftboundNumberKey("006"), "6");
  assert.equal(riftboundNumberKey("6/166"), "6");
  assert.equal(riftboundNumberKey("SP6/006"), "sp6");
  assert.equal(riftboundNumberKey("sp6"), "sp6");
  assert.equal(riftboundNumberKey("R06"), "r6");
  assert.equal(riftboundNumberKey("R06a"), "r6a");
  assert.equal(riftboundNumberKey("019a/166"), "19a");
  assert.notEqual(riftboundNumberKey("006"), riftboundNumberKey("SP6/006"));
});
test("tcgcsv matcher does not price a main-set card from the showcase card with the same number", () => {
  const products = [
    { productId: 1, name: "Lux, Crownguard", extendedData: [{ name: "Number", value: "SP6/006" }] },
    { productId: 2, name: "Oasis Raider", extendedData: [{ name: "Number", value: "006/166" }] },
    { productId: 3, name: "Order Rune", extendedData: [{ name: "Number", value: "R06" }] },
  ];
  const prices = [
    { productId: 1, subTypeName: "Foil", marketPrice: 21.65 },
    { productId: 2, subTypeName: "Normal", marketPrice: 0.05 }, { productId: 2, subTypeName: "Foil", marketPrice: 0.13 },
    { productId: 3, subTypeName: "Normal", marketPrice: 0.11 }, { productId: 3, subTypeName: "Foil", marketPrice: 9.51 },
  ];
  assert.deepEqual([matchPrice(products, prices, { number: "006", name: "", finish: "Normal" }).price, matchPrice(products, prices, { number: "006", name: "", finish: "Foil" }).price], [0.05, 0.13]);
  // Even a stale stored name must not pull a plain number over to the showcase card.
  assert.equal(matchPrice(products, prices, { number: "006", name: "Lux, Crownguard", finish: "Foil" }).productName, "Oasis Raider");
  assert.equal(matchPrice(products, prices, { number: "SP6", name: "", finish: "Foil" }).price, 21.65);
  assert.equal(matchPrice(products, prices, { number: "SP6/006", name: "", finish: "Normal" }).mismatch, true);
  assert.equal(matchPrice(products, prices, { number: "R06", name: "", finish: "Foil" }).price, 9.51);
});
