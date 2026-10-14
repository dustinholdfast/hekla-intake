import { test } from "node:test";
import assert from "node:assert/strict";
import { assertEnrichFields, baseRank, combine, enrichOne, extractCatalog, listedRulesDecision, LISTED_LABELS, lookupCatalog, mapRarity, priceMove, rulesDecision, validateGemini } from "./enrich.ts";
import { pageWindow, pricedByCardTrader, rescanSlotOffset, RESCAN_BATCH } from "./airtable.ts";
import { riftboundNumberKey } from "./preview.ts";

const env = (over: Record<string, unknown> = {}) => over as unknown as Env;
const noPrice = async () => ({ price: null, source: "CardTrader: no Near Mint non-foil offers in English right now" });
const priced = (price: number) => async () => ({ price, source: "CardTrader market (Near Mint foil, 12 offers)" });

test("rarity maps onto Airtable choices only", () => {
  assert.equal(mapRarity("Enchanted"), "Enchanted");
  assert.equal(mapRarity("mythic"), "Legendary");
  assert.equal(mapRarity("Super_rare"), "Super Rare");
  assert.equal(mapRarity("Ultra Rare"), "Special");
  assert.equal(mapRarity("common"), "Common");
  assert.equal(mapRarity(""), null);
});

test("catalogs supply name, type and rarity but never a price", () => {
  const mtg = extractCatalog("Magic: The Gathering", { name: "X", type_line: "Creature", rarity: "rare", prices: { usd: "1.50", usd_foil: "4.00" } });
  assert.deepEqual([mtg.found, mtg.name, mtg.cardType, mtg.sourceRarity, mtg.price], [true, "X", "Creature", "rare", null]);
  const lor = extractCatalog("Lorcana", { name: "Elsa", version: "Spirit of Winter", type: ["Character"], rarity: "Enchanted", prices: { usd_foil: "952.84" } });
  assert.deepEqual([lor.name, lor.price], ["Elsa - Spirit of Winter", null]);
  assert.equal(extractCatalog("Pokémon", { name: "P", supertype: "Pokémon", subtypes: ["Basic"] }).cardType, "Pokémon Basic");
  assert.equal(extractCatalog("Yu-Gi-Oh!", { name: "Y", card_prices: [{ any_price: "0.16" }] }).price, null);
  assert.equal(extractCatalog("Riftbound", { name: "R", classification: { type: "Unit", rarity: "Rare" } }).sourceRarity, "Rare");
  assert.deepEqual(extractCatalog("Lorcana", undefined), { found: false, price: null, priceSource: "" });
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

test("Gemini adjusts base by at most ±20, and no listing cap holds a card back", () => {
  assert.equal(combine(40, { rankScore: 95, recommendation: "List", reason: "r" }).rankScore, 60);
  assert.equal(combine(40, { rankScore: 0, recommendation: "Skip", reason: "r" }).rankScore, 20);
  assert.equal(combine(60, { rankScore: 70, recommendation: "List", reason: "r" }).recommendation, "List");
  assert.equal(rulesDecision(70, 20).recommendation, "List");
  assert.equal(rulesDecision(40, 5).recommendation, "Hold");
  assert.equal(rulesDecision(70, null).recommendation, "Hold");
  assert.equal(rulesDecision(10, 0.5).recommendation, "Skip");
});

test("enrichment never writes Status", () => {
  assert.throws(() => assertEnrichFields({ Status: "Listed" }));
  assert.throws(() => assertEnrichFields({ Recommendation: "Sell" }));
  assertEnrichFields({ "Auto Rank": 50, Recommendation: "Hold", Rarity: "Rare" });
});

test("enrichOne end-to-end: catalog facts, CardTrader price, Gemini adjustment", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("scryfall")) return new Response(JSON.stringify({ object: "card", name: "Ancestral Katana", type_line: "Artifact — Equipment", rarity: "common", prices: { usd: "0.10", usd_foil: "0.40" } }));
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const gem = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ rankScore: 5, recommendation: "Skip", reason: "Bulk common." }) }] } }] }))) as unknown as typeof fetch;
  try {
    const r = await enrichOne({ id: "recAAAAAAAAAAAAAA", game: "Magic: The Gathering", setNumber: null, setIdentifier: "NEO", collectorNumber: "1", name: "", finish: "Foil", condition: "NM", qty: 1, costBasisUsd: null, rarity: null, resolvedName: null },
      env({ GEMINI_API_KEY: "test" }), { fetcher: gem, price: priced(0.55), now: () => new Date("2026-10-10T14:00:00Z") });
    assert.equal(r.fields["Market Price USD"], 0.55); // CardTrader's price, not the catalog's 0.40
    assert.match(String(r.fields["Price Source"]), /^CardTrader market/);
    assert.equal(r.fields.Recommendation, "Skip");
    assert.equal(r.fields.Rarity, "Common");
    assert.equal(r.fields["Resolved Name"], "Ancestral Katana");
    assert.equal(r.decision.via, "gemini");
    assert.ok(!("Status" in r.fields));
    assert.ok(!("Rank Score" in r.fields));
  } finally { globalThis.fetch = realFetch; }
});

test("no CardTrader price keeps the existing price and says so", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ items: [{ name: "Ol' Poro", riftbound_id: "ven-029-166", collector_number: 29, classification: { type: "Unit", rarity: "Common" }, metadata: {} }], pages: 1 }))) as typeof fetch;
  try {
    const r = await enrichOne({ id: "recBBBBBBBBBBBBBB", game: "Riftbound", setNumber: null, setIdentifier: "VEN", collectorNumber: "029", name: "Ol' Poro", finish: "Normal", condition: "NM", qty: 1, costBasisUsd: null, rarity: "Common", resolvedName: "Ol' Poro", marketPriceUsd: 0.06 }, env(), { price: noPrice });
    assert.ok(!("Market Price USD" in r.fields));
    assert.match(String(r.fields["Price Source"]), /^CardTrader: .*kept existing price$/);
    assert.equal(r.decision.via, "rules");
  } finally { globalThis.fetch = realFetch; }
});

test("without a connected CardTrader account there is no price, only a reason", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ name: "Rafiki", version: "Mysterious Sage", type: ["Character"], rarity: "Uncommon", prices: { usd: "0.08" } }))) as typeof fetch;
  try {
    const catalog = await lookupCatalog({ id: "recDDDDDDDDDDDDDD", game: "Lorcana", setNumber: "1", setIdentifier: null, collectorNumber: "54", name: "Rafiki", finish: "Normal", condition: "NM", qty: 1, costBasisUsd: null, rarity: null, resolvedName: null }, env());
    assert.equal(catalog.price, null);
    assert.match(catalog.priceSource, /^CardTrader: not connected/);
    assert.equal(catalog.name, "Rafiki - Mysterious Sage");
  } finally { globalThis.fetch = realFetch; }
});

test("listed mode: keep/watch/pull rules", () => {
  assert.equal(listedRulesDecision(50, 3).recommendation, "List");
  assert.equal(listedRulesDecision(20, 0.1).recommendation, "Skip");
  assert.equal(listedRulesDecision(30, null).recommendation, "Hold");
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
  globalThis.fetch = (async () => new Response(JSON.stringify({ name: "Rafiki", version: "Mysterious Sage", type: ["Character"], rarity: "Uncommon" }))) as typeof fetch;
  try {
    const r = await enrichOne({ id: "recCCCCCCCCCCCCCC", game: "Lorcana", setNumber: "1", setIdentifier: null, collectorNumber: "54", name: "Rafiki", finish: "Normal", condition: "NM", qty: 1, costBasisUsd: null, rarity: "Uncommon", resolvedName: "Rafiki - Mysterious Sage" }, env(), { mode: "listed", price: priced(0.08) });
    assert.equal(r.fields.Recommendation, "Skip");
    assert.match(String(r.fields["Rank Reason"]), /^Pull:/);
    assert.ok(!("Status" in r.fields) && !("Rank Score" in r.fields));
  } finally { globalThis.fetch = realFetch; }
});

test("price move: only a real, different price counts as a change", () => {
  assert.deepEqual(priceMove(1.2, 1.45), { changed: true, from: 1.2, to: 1.45 });
  assert.deepEqual(priceMove(null, 0.5), { changed: true, from: null, to: 0.5 });
  assert.equal(priceMove(1.2, 1.2).changed, false);
  assert.equal(priceMove(0.1 + 0.2, 0.3).changed, false);
  assert.deepEqual(priceMove(4.25, null), { changed: false, from: 4.25, to: 4.25 });
  assert.deepEqual(priceMove(undefined, null), { changed: false, from: null, to: null });
});
test("a row priced from any other source is re-assessed on the next scan", () => {
  assert.equal(pricedByCardTrader("CardTrader market (Near Mint non-foil, 160 offers)"), true);
  assert.equal(pricedByCardTrader("CardTrader: no Near Mint foil offers in English right now"), true);
  for (const old of ["Lorcast usd", "price unavailable (no catalog match)", "", null, undefined]) assert.equal(pricedByCardTrader(old), false);
});
test("cron re-scan visits every page in turn and wraps", () => {
  const slot = 600_000; const seen = new Set<number>();
  for (let run = 0; run < 8; run++) seen.add(rescanSlotOffset(157, run * slot));
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 20, 40, 60, 80, 100, 120, 140]);
  assert.equal(rescanSlotOffset(157, 8 * slot), 0);
  assert.equal(rescanSlotOffset(RESCAN_BATCH, 5 * slot), 0);
  assert.equal(rescanSlotOffset(0, 5 * slot), 0);
});
test("enrichOne re-ranks from a supplied catalog without any lookup, and still never writes Status", async () => {
  const card = { id: "rec1", game: "Lorcana", setNumber: "1", setIdentifier: null, collectorNumber: "1", name: "Test", finish: "Normal", condition: "NM", qty: 1, costBasisUsd: null, rarity: "Rare", resolvedName: "Test", marketPriceUsd: 1 };
  const boom = (() => { throw new Error("no lookups in a re-rank"); }) as never;
  const r = await enrichOne(card, env(), { mode: "listed", catalog: { found: true, name: "Test", price: 9.5, priceSource: "CardTrader market (Near Mint non-foil, 3 offers)" }, fetcher: boom, price: boom, now: () => new Date("2026-10-11T00:00:00Z") });
  assert.equal(r.fields["Market Price USD"], 9.5);
  assert.equal(r.fields.Status, undefined);
  assert.match(String(r.fields["Rank Reason"]), /^(Keep|Watch|Pull):/);
  assertEnrichFields(r.fields);
});

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

import { catalogHealth } from "./preview.ts";
test("a dead catalog does not stop pricing: CardTrader names the card instead", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }) as typeof fetch;
  catalogHealth.clear();
  try {
    const card = { id: "recEEEEEEEEEEEEEE", game: "Riftbound", setNumber: null, setIdentifier: "VEN", collectorNumber: "006", name: "", finish: "Normal", condition: "NM", qty: 1, costBasisUsd: null, rarity: null, resolvedName: null };
    const viaCardTrader = async () => ({ price: 0.14, source: "CardTrader market (Near Mint non-foil, 160 offers)", card: { name: "Oasis Raider", rarity: "Common" } });
    const r = await enrichOne(card, env(), { price: viaCardTrader });
    assert.equal(r.fields["Market Price USD"], 0.14);
    assert.equal(r.fields["Resolved Name"], "Oasis Raider");
    assert.equal(r.fields.Rarity, "Common");
    assert.notEqual(r.fields.Recommendation, undefined);
    const before = calls;
    await enrichOne({ ...card, id: "recFFFFFFFFFFFFFF" }, env(), { price: viaCardTrader });
    assert.equal(calls, before, "the dead catalog is skipped, not waited on again");
    // When neither source knows the card, the row fails so it is retried later.
    await assert.rejects(enrichOne({ ...card, id: "recGGGGGGGGGGGGGG" }, env(), { price: noPrice }), /not responding|did not answer/);
  } finally { globalThis.fetch = realFetch; catalogHealth.clear(); }
});
