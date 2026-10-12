import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRow, createProduct, expansionCode, matchBlueprint, type Blueprint, type ExportCard } from "./cardtrader.ts";

const conditionProp = { name: "condition", possible_values: ["Mint", "Near Mint", "Slightly Played", "Moderately Played", "Played", "Poor"] };
const blueprints: Blueprint[] = [
  { id: 400552, name: "Oasis Raider", version: null, category_id: 258, expansion_id: 4521, fixed_properties: { collector_number: "006" }, editable_properties: [conditionProp, { name: "riftbound_foil", possible_values: [true, false] }] },
  { id: 400001, name: "Lux - Crownguard", version: null, category_id: 258, expansion_id: 4521, fixed_properties: { collector_number: "SP6" }, editable_properties: [conditionProp] },
  { id: 400534, name: "Order Rune", version: "VEN", category_id: 258, expansion_id: 4521, fixed_properties: { collector_number: "R06" }, editable_properties: [conditionProp, { name: "riftbound_foil", possible_values: [true, false] }] },
  { id: 499999, name: "Vendetta Booster Box", category_id: 259, expansion_id: 4521, fixed_properties: {}, editable_properties: [] },
];
const card = (over: Partial<ExportCard>): ExportCard => ({ id: "recAAAAAAAAAAAAAA", game: "Riftbound", setNumber: null, setIdentifier: "VEN", collectorNumber: "006", name: "", resolvedName: "Oasis Raider", finish: "Normal", condition: "NM", qty: 2, status: "Waitlist", marketPriceUsd: 0.05, cardTraderListingId: null, ...over });
const match = (number: string) => { const m = matchBlueprint(blueprints, 258, number); return "blueprint" in m ? m.blueprint.name : m.reason; };

test("sets map to CardTrader expansion codes", () => {
  assert.equal(expansionCode("Riftbound", { setNumber: null, setIdentifier: " VEN " }), "ven");
  assert.equal(expansionCode("Lorcana", { setNumber: "1", setIdentifier: null }), "ch1");
  assert.equal(expansionCode("Lorcana", { setNumber: "13", setIdentifier: null }), "lor13");
  assert.equal(expansionCode("Lorcana", { setNumber: "Q2", setIdentifier: null }), "quest2");
  assert.equal(expansionCode("Lorcana", { setNumber: "P", setIdentifier: null }), null);
  assert.equal(expansionCode("Pokémon", { setNumber: null, setIdentifier: "SV08" }), null);
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
