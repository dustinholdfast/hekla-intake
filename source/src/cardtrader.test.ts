import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRow, companionCodes, createProduct, expansionCode, marketPrice, matchBlueprint, type Blueprint, type ExportCard, type Offer } from "./cardtrader.ts";

const conditionProp = { name: "condition", possible_values: ["Mint", "Near Mint", "Slightly Played", "Moderately Played", "Played", "Poor"] };
const blueprints: Blueprint[] = [
  { id: 400552, name: "Oasis Raider", version: null, category_id: 258, expansion_id: 4521, fixed_properties: { collector_number: "006" }, editable_properties: [conditionProp, { name: "riftbound_foil", possible_values: [true, false] }] },
  { id: 400001, name: "Lux - Crownguard", version: null, category_id: 258, expansion_id: 4521, fixed_properties: { collector_number: "SP6" }, editable_properties: [conditionProp] },
  { id: 400534, name: "Order Rune", version: "VEN", category_id: 258, expansion_id: 4521, fixed_properties: { collector_number: "R06" }, editable_properties: [conditionProp, { name: "riftbound_foil", possible_values: [true, false] }] },
  { id: 499999, name: "Vendetta Booster Box", category_id: 259, expansion_id: 4521, fixed_properties: {}, editable_properties: [] },
];
const card = (over: Partial<ExportCard>): ExportCard => ({ id: "recAAAAAAAAAAAAAA", game: "Riftbound", setNumber: null, setIdentifier: "VEN", collectorNumber: "006", name: "", resolvedName: "Oasis Raider", finish: "Normal", condition: "NM", qty: 2, status: "Waitlist", marketPriceUsd: 0.05, priceSource: "CardTrader market (Near Mint non-foil, 160 offers)", cardTraderListingId: null, ...over });
const match = (number: string) => { const m = matchBlueprint(blueprints, 258, number); return "blueprint" in m ? m.blueprint.name : m.reason; };

test("sets map to CardTrader expansion codes", () => {
  assert.equal(expansionCode("Riftbound", { setNumber: null, setIdentifier: " VEN " }), "ven");
  assert.equal(expansionCode("Lorcana", { setNumber: "1", setIdentifier: null }), "ch1");
  assert.equal(expansionCode("Lorcana", { setNumber: "13", setIdentifier: null }), "lor13");
  assert.equal(expansionCode("Lorcana", { setNumber: "Q2", setIdentifier: null }), "quest2");
  assert.equal(expansionCode("Lorcana", { setNumber: "P", setIdentifier: null }), null);
  assert.equal(expansionCode("Pokémon", { setNumber: null, setIdentifier: "SV08" }), "sv08");
  assert.equal(expansionCode("Magic: The Gathering", { setNumber: null, setIdentifier: "" }), null);
});
test("a plain number matches the main-set card, never the showcase card or the rune", () => {
  assert.equal(match("006"), "Oasis Raider");
  assert.equal(match("6/166"), "Oasis Raider");
  assert.equal(match("SP6"), "Lux - Crownguard");
  assert.equal(match("R06"), "Order Rune");
  assert.match(match("777"), /no card numbered 777/);
  assert.deepEqual(matchBlueprint(blueprints, 258, null), { reason: "No collector number." });
  assert.match(match("499"), /no card numbered 499/); // the booster box is not a single card
});
test("a ready row carries the stored market price unchanged and the mapped condition and finish", () => {
  const row = buildRow(card({ finish: "Foil", condition: "LP", marketPriceUsd: 0.13 }), blueprints[0]!);
  assert.equal(row.ready, true);
  if (!row.ready) return;
  assert.deepEqual(row.product, { blueprint_id: 400552, price: 0.13, quantity: 2, error_mode: "strict", user_data_field: "recAAAAAAAAAAAAAA", properties: { condition: "Slightly Played", riftbound_foil: true } });
  const normal = buildRow(card({}), blueprints[0]!);
  assert.equal(normal.ready && normal.product.properties.riftbound_foil, false);
});
test("rows that should not be listed are held back with a reason", () => {
  const reason = (over: Partial<ExportCard>, bp = blueprints[0]!) => { const r = buildRow(card(over), bp); return r.ready ? "ready" : r.reason; };
  assert.match(reason({ marketPriceUsd: null }), /No market price/);
  assert.match(reason({ marketPriceUsd: 0 }), /No market price/);
  assert.match(reason({ priceSource: "Lorcast usd" }), /not from CardTrader yet/);
  assert.match(reason({ priceSource: "CardTrader: no Near Mint foil offers in English right now; kept existing price" }), /not from CardTrader yet/);
  assert.match(reason({ condition: "XX" }), /condition XX/);
  assert.match(reason({ resolvedName: "Lux, Crownguard" }), /not "Lux, Crownguard"/);
  assert.match(reason({ collectorNumber: "SP6", resolvedName: "Lux, Crownguard", finish: "Normal" }, blueprints[1]), /single finish/);
  assert.equal(reason({ collectorNumber: "SP6", resolvedName: "Lux, Crownguard", finish: "Special", marketPriceUsd: 21.65 }, blueprints[1]), "ready");
  assert.equal(reason({ resolvedName: null }), "ready");
});
test("creating a product sends exactly the approved product and reports what CardTrader stored", async () => {
  const row = buildRow(card({}), blueprints[0]!);
  assert.equal(row.ready, true);
  if (!row.ready) return;
  const calls: { url: string; method?: string; body?: string; auth: string }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: init.method, body: String(init.body), auth: (init.headers as Record<string, string>).authorization ?? "" });
    return new Response(JSON.stringify({ result: "ok", resource: { id: 19799784, price: { cents: 5, currency: "USD" } } }), { status: 200 });
  }) as never;
  assert.deepEqual(await createProduct("tok", row.product, fetcher), { productId: 19799784, currency: "USD", cents: 5 });
  assert.deepEqual(calls, [{ url: "https://api.cardtrader.com/api/v2/products", method: "POST", body: JSON.stringify(row.product), auth: "Bearer tok" }]);
  await assert.rejects(createProduct("tok", row.product, (async () => new Response(JSON.stringify({ error: "price too low" }), { status: 422 })) as never), /CardTrader said: price too low/);
});

import { cardTraderListingFields } from "./airtable.ts";
test("a confirmed listing writes the listing id and Status = Listed, and nothing else", () => {
  assert.deepEqual(cardTraderListingFields(19799784), { "CardTrader Listing ID": "19799784", Status: "Listed" });
});

const offer = (cents: number, condition: string, foil: boolean | undefined, language = "en", currency = "USD"): Offer => ({ price: { cents, currency }, properties_hash: { condition, riftbound_language: language, ...(foil === undefined ? {} : { riftbound_foil: foil }) } });
test("market price is the median of the five cheapest matching offers", () => {
  const offers = [offer(2, "Near Mint", false), offer(14, "Near Mint", false), offer(14, "Near Mint", false), offer(15, "Near Mint", false), offer(16, "Near Mint", false), offer(25, "Near Mint", false), offer(329, "Near Mint", false),
    offer(1, "Near Mint", true), offer(1, "Slightly Played", false), offer(1, "Near Mint", false, "fr")];
  assert.deepEqual(marketPrice(offers, { condition: "Near Mint", foil: false }), { price: 0.14, offers: 7, currency: "USD" }); // one $0.02 lowball does not set the price
  assert.equal(marketPrice(offers, { condition: "Near Mint", foil: true })?.price, 0.01);
  assert.equal(marketPrice(offers, { condition: "Slightly Played", foil: false })?.offers, 1);
  assert.equal(marketPrice(offers, { condition: "Poor", foil: false }), null);
  assert.equal(marketPrice([], { condition: "Near Mint", foil: false }), null);
});
test("a single-finish card is priced whatever finish the row says", () => {
  const offers = [offer(2000, "Near Mint", undefined), offer(2165, "Near Mint", undefined), offer(2300, "Near Mint", undefined)];
  assert.equal(marketPrice(offers, { condition: "Near Mint", foil: null })?.price, 21.65);
  assert.equal(marketPrice(offers, { condition: "Near Mint", foil: true })?.price, 21.65);
});

import { namesMatch } from "./cardtrader.ts";
test("namesMatch accepts prefixes/versions and punctuation, rejects different cards", () => {
  assert.ok(namesMatch("Curator of the Sands", "Nasus - Curator of the Sands"));
  assert.ok(namesMatch("Nasus", "Nasus - Curator of the Sands"));
  assert.ok(namesMatch("nasus – curator of the sands", "Nasus - Curator of the Sands"));
  assert.ok(namesMatch("Mickey Mouse - Brave Little Tailor", "Mickey Mouse, Brave Little Tailor"));
  assert.ok(namesMatch("Mickey Mouse", "Mickey Mouse - Brave Little Tailor"));
  assert.ok(namesMatch("Ol' Poro", "Ol Poro"));
  assert.ok(namesMatch("  Black   Lotus ", "black lotus"));
  assert.ok(!namesMatch("Curator of the Sands", "Nasus - Guardian of the Sands"));
  assert.ok(!namesMatch("Punching Poro", "Affectionate Poro"));
  assert.ok(!namesMatch("Poro", "Punching Poro"));
  assert.ok(!namesMatch("Mickey Mouse", "Minnie Mouse - Beloved Princess"));
  assert.ok(!namesMatch("", "Nasus"));
});

test("companionCodes: Magic numbers past the main set are looked up in the Collectors expansion", () => {
  assert.deepEqual(companionCodes("Magic: The Gathering", "tdm"), ["ctdm"]);
  assert.deepEqual(companionCodes("Riftbound", "ven"), []);
  assert.deepEqual(companionCodes("Lorcana", "lor9"), []);
});

import { ctRateGate, ctRetry, CT_SECOND_MAX, isChallengePage, resetCtRateGate } from "./cardtrader.ts";
test("CardTrader turning a request away (429 or site protection) is retried, then reported", async () => {
  const realWait = ctRetry.wait; const waits: number[] = [];
  ctRetry.wait = async (ms) => { waits.push(ms); };
  resetCtRateGate();
  try {
    const row = buildRow(card({}), blueprints[0]!);
    assert.equal(row.ready, true);
    if (!row.ready) return;
    const ok = () => new Response(JSON.stringify({ result: "ok", resource: { id: 7, price: { cents: 5, currency: "USD" } } }), { status: 200 });
    const tooMany = () => new Response(JSON.stringify({ error: "Too many requests: max 10 requests per second" }), { status: 429 });
    const challenge = () => new Response("<!DOCTYPE html><html lang=\"en-US\"><head><title>Just a moment...</title></head></html>", { status: 403 });
    let n = 0;
    const flaky = (async () => (++n === 1 ? tooMany() : ok())) as never;
    assert.equal((await createProduct("tok", row.product, flaky)).productId, 7);
    assert.equal(n, 2);
    n = 0;
    const blocked = (async () => (++n <= 2 ? challenge() : ok())) as never;
    assert.equal((await createProduct("tok", row.product, blocked)).productId, 7);
    assert.equal(n, 3);
    await assert.rejects(createProduct("tok", row.product, (async () => tooMany()) as never), /Too many requests/);
    await assert.rejects(createProduct("tok", row.product, (async () => challenge()) as never), /site protection blocked/);
    assert.ok(waits.length >= 6 && waits.every((ms) => ms > 0 && ms <= 10_000));
    assert.equal(isChallengePage(200, "<title>Just a moment...</title>"), false);
  } finally { ctRetry.wait = realWait; resetCtRateGate(); }
});
test("the rate gate keeps calls under CardTrader's per-second limit", async () => {
  resetCtRateGate();
  let clock = 0; const waits: number[] = [];
  const now = () => clock; const wait = async (ms: number) => { waits.push(ms); clock += ms; };
  for (let i = 0; i < CT_SECOND_MAX * 3; i++) await ctRateGate(now, wait);
  assert.ok(CT_SECOND_MAX < 10);
  assert.ok(clock >= 2000, "24 calls at 8 per second take at least two seconds");
  resetCtRateGate();
});
