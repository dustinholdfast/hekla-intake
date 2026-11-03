import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRow, type Blueprint, type ExportCard } from "./cardtrader.ts";
import { buildEditFields, parseDraft } from "./fields.ts";
import {
  airtableWriteTypecast,
  canonicalMagicFinish,
  chooseMagicFinish,
  magicFinishOptions,
  type FinishBlueprint,
} from "./magic-finish.ts";
import { parseBulk } from "./parse.ts";
import { finishesFor, isFoilFinish } from "./sets.ts";

const condition = { name: "condition", possible_values: ["Near Mint", "Slightly Played", "Moderately Played", "Played", "Poor"] };
const foil = { name: "mtg_foil", possible_values: [false, true] };
const foilOnly = { name: "mtg_foil", possible_values: [true] };

function bp(over: Partial<FinishBlueprint> & Pick<FinishBlueprint, "id" | "name">): FinishBlueprint {
  return {
    version: null,
    category_id: 1,
    fixed_properties: { collector_number: "089" },
    editable_properties: [condition, foil],
    ...over,
  };
}

const regular = bp({ id: 1, name: "Ardyn, the Usurper" });
const borderless = bp({ id: 2, name: "Ardyn, the Usurper", version: "Borderless", fixed_properties: { collector_number: "379" } });
const borderlessArt = bp({ id: 7, name: "Ardyn, the Usurper", version: "Borderless", fixed_properties: { collector_number: "315" } });
const extended = bp({ id: 3, name: "Ardyn, the Usurper", version: "Extended Art", fixed_properties: { collector_number: "444" } });
const etched = bp({
  id: 4, name: "Ardyn, the Usurper", version: "Etched", fixed_properties: { collector_number: "500" },
  editable_properties: [condition, foilOnly],
});
const surge = bp({
  id: 5, name: "Ardyn, the Usurper", version: "Borderless | Surge Foil", fixed_properties: { collector_number: "524" },
  editable_properties: [condition],
});
const other = bp({ id: 6, name: "Other Card", version: "Showcase", fixed_properties: { collector_number: "12" } });
const sealed = bp({ id: 8, name: "Ardyn, the Usurper", version: "Borderless", category_id: 99, fixed_properties: { collector_number: "1" } });

test("a Magic card's finishes are the CardTrader treatments for that printing, plus foil", () => {
  const found = magicFinishOptions([regular, borderless, borderlessArt, extended, etched, surge, other, sealed], 1, "089");
  assert.equal(found.cardName, "Ardyn, the Usurper");
  assert.deepEqual(found.options.map((option) => `${option.finish}#${option.collectorNumber}`), [
    "Normal#089",
    "Foil#089",
    "Borderless#315",
    "Borderless Foil#315",
    "Borderless#379",
    "Borderless Foil#379",
    "Extended Art#444",
    "Extended Art Foil#444",
    "Etched Foil#500",
    "Borderless | Surge Foil#524",
  ]);
  assert.equal(found.options[0]!.blueprintId, 1);
  assert.equal(found.options[0]!.foil, false);
  assert.equal(found.options[1]!.foil, true);
  assert.equal(found.options.find((option) => option.blueprintId === 2)!.label, "Borderless · #379");
  assert.equal(found.options.find((option) => option.blueprintId === 5)!.foil, null);
  assert.equal(found.options.some((option) => option.blueprintId === other.id || option.blueprintId === sealed.id), false);
});

test("basic-land arts are not offered as finishes of a different collector number", () => {
  const islands = ["265", "266", "267"].map((number, index) => bp({ id: index + 1, name: "Island", fixed_properties: { collector_number: number } }));
  const found = magicFinishOptions(islands, 1, "265");
  assert.deepEqual(found.options.map((option) => `${option.finish}#${option.collectorNumber}`), ["Normal#265", "Foil#265"]);
});

test("choosing a treatment selects that blueprint and its collector number", () => {
  const found = magicFinishOptions([regular, borderless, extended, surge], 1, "089");
  const border = chooseMagicFinish(found.options, "089", "borderless");
  assert.equal("finish" in border && border.finish, "Borderless");
  assert.equal("blueprintId" in border && border.blueprintId, 2);
  assert.equal("collectorNumber" in border && border.collectorNumber, "379");

  const foilChoice = chooseMagicFinish(found.options, "379", "Borderless Foil");
  assert.equal("foil" in foilChoice && foilChoice.foil, true);
  assert.equal("blueprintId" in foilChoice && foilChoice.blueprintId, 2);

  const normal = chooseMagicFinish(found.options, "089", "Foil");
  assert.equal("blueprintId" in normal && normal.blueprintId, 1);

  const ambiguous = chooseMagicFinish(magicFinishOptions([regular, borderless, borderlessArt], 1, "089").options, "089", "Borderless");
  assert.equal("reason" in ambiguous && /#315/.test(ambiguous.reason) && /#379/.test(ambiguous.reason), true);
});

test("the chosen Magic finish lists on the matching blueprint with mtg_foil", () => {
  const found = magicFinishOptions([regular, borderless, extended, surge], 1, "089");
  const card = (finish: string, collectorNumber: string): ExportCard => ({
    id: "recAAAAAAAAAAAAAA", game: "Magic: The Gathering", setNumber: null, setIdentifier: "fin", collectorNumber,
    name: "", resolvedName: "Ardyn, the Usurper", finish, condition: "NM", qty: 1, status: "Waitlist",
    marketPriceUsd: 1.2, priceSource: "CardTrader market (Near Mint non-foil, 4 offers)", cardTraderListingId: null,
  });
  const blueprint = (option: { blueprint: FinishBlueprint }): Blueprint => ({ ...option.blueprint, expansion_id: 8 });

  const normal = chooseMagicFinish(found.options, "089", "Normal");
  assert.equal("blueprint" in normal, true);
  if (!("blueprint" in normal)) return;
  const normalRow = buildRow(card("Normal", "089"), blueprint(normal));
  assert.equal(normalRow.ready, true);
  if (!normalRow.ready) return;
  assert.equal(normalRow.product.blueprint_id, 1);
  assert.equal(normalRow.product.properties.mtg_foil, false);

  const borderFoil = chooseMagicFinish(found.options, "089", "Borderless Foil");
  assert.equal("blueprint" in borderFoil, true);
  if (!("blueprint" in borderFoil)) return;
  const borderRow = buildRow(card(borderFoil.finish, borderFoil.collectorNumber), blueprint(borderFoil));
  assert.equal(borderRow.ready, true);
  if (!borderRow.ready) return;
  assert.equal(borderRow.product.blueprint_id, 2);
  assert.equal(borderRow.product.properties.mtg_foil, true);
  assert.equal(borderRow.foil, true);

  const surgeChoice = chooseMagicFinish(found.options, "524", "Borderless | Surge Foil");
  assert.equal("blueprint" in surgeChoice, true);
  if (!("blueprint" in surgeChoice)) return;
  const surgeRow = buildRow(card(surgeChoice.finish, "524"), blueprint(surgeChoice));
  assert.equal(surgeRow.ready, true);
  if (!surgeRow.ready) return;
  assert.equal(surgeRow.product.blueprint_id, 5);
  assert.equal(surgeRow.product.properties.mtg_foil, undefined);
  assert.equal("mtg_foil" in surgeRow.product.properties, false);
});

test("Magic intake accepts CardTrader treatments and Lorcana does not", () => {
  assert.deepEqual([...finishesFor("Magic: The Gathering")], ["Normal", "Foil"]);
  assert.deepEqual([...finishesFor("Lorcana")], ["Normal", "Foil", "Enchanted"]);
  assert.deepEqual([...finishesFor("Riftbound")], ["Normal", "Foil", "Special"]);
  assert.equal(canonicalMagicFinish("  foil "), "Foil");
  assert.equal(canonicalMagicFinish("Enchanted"), null);
  assert.equal(canonicalMagicFinish("Borderless | Surge Foil"), "Borderless | Surge Foil");
  assert.equal(isFoilFinish("Borderless"), false);
  assert.equal(isFoilFinish("Borderless Foil"), true);
  assert.equal(isFoilFinish("Borderless | Surge Foil"), true);
  assert.equal(isFoilFinish("Extended Art"), false);
  assert.equal(isFoilFinish("Etched Foil"), true);
  assert.equal(isFoilFinish("Special"), true);
  assert.equal(isFoilFinish("Enchanted"), true);

  const magic = parseDraft({ game: "Magic: The Gathering", setIdentifier: "fin", collectorNumber: "379", finish: "Borderless", condition: "NM", qty: 1 });
  assert.equal(magic.ok && magic.card.finish, "Borderless");
  assert.equal(parseDraft({ game: "Magic: The Gathering", setIdentifier: "fin", collectorNumber: "089", finish: "Enchanted", condition: "NM", qty: 1 }).ok, false);
  assert.equal(parseDraft({ game: "Lorcana", setNumber: "1", collectorNumber: "1", finish: "Borderless", condition: "NM", qty: 1 }).ok, false);
  assert.equal(parseDraft({ game: "Lorcana", setNumber: "1", collectorNumber: "1", finish: "Enchanted", condition: "NM", qty: 1 }).ok, true);
  assert.equal(buildEditFields({ finish: "Extended Art Foil" }, "Magic: The Gathering").ok, true);
  assert.equal(buildEditFields({ finish: "Borderless" }, "Riftbound").ok, false);
  assert.equal(buildEditFields({ finish: "Special" }, "Riftbound").ok, true);

  const [ok, bad] = parseBulk("FIN,379,Borderless,NM,1,Ardyn\nFIN 12 Enchanted NM 1", "Magic: The Gathering");
  assert.equal(ok?.card?.finish, "Borderless");
  assert.match(bad?.error ?? "", /not a Magic/);
  assert.equal(airtableWriteTypecast({ Finish: "Borderless" }), true);
  assert.equal(airtableWriteTypecast({ Finish: "Normal" }), false);
  assert.equal(airtableWriteTypecast({ Finish: "Enchanted" }), false);
  assert.equal(airtableWriteTypecast({ Finish: "Special" }), false);
  assert.equal(airtableWriteTypecast({ Qty: 1 }), false);
});
