import { test } from "node:test";
import assert from "node:assert/strict";
import { finishMatchFormula, matchesPrinting, printingKey, type QueueCard } from "./airtable.ts";
import { buildRow, type Blueprint, type ExportCard } from "./cardtrader.ts";
import { buildCreateFields, buildEditFields, parseDraft } from "./fields.ts";
import { canonicalFinish, finishQueryValues, isFoilFinish, readFinish, sameFinish } from "./sets.ts";
import { buildPullList, tcgplayerCsv } from "./tcgplayer.ts";
import { matchScore, type ReconRow } from "./threeway.ts";
import type { TcgRow } from "./tcgcsv.ts";
import type { SaleRow } from "./sales.ts";

const card = (finish: string): QueueCard => ({
  id: "recAAAAAAAAAAAAAA", name: "Elsa", cardName: "Elsa", resolvedName: null, game: "Lorcana",
  setNumber: "1", setIdentifier: null, setName: "The First Chapter", collectorNumber: "42", finish, condition: "NM",
  qty: 1, status: "Listed", rankScore: null, marketPriceUsd: null, notes: null, priority: null, createdTime: "2026-10-01T00:00:00.000Z",
  autoRank: null, rarity: null, costBasisUsd: null, cardType: null, recommendation: null, rankReason: null, enrichedAt: null, priceSource: null,
});
const draft = { game: "Lorcana", setNumber: "1", collectorNumber: "42", finish: "Normal" };

test("Normal is read as Regular and still written as Normal", () => {
  assert.equal(readFinish("Normal"), "Regular");
  assert.equal(readFinish("regular"), "Regular");
  assert.equal(readFinish("Foil"), "Foil");
  assert.equal(readFinish(""), null);
  assert.equal(sameFinish("Normal", "Regular"), true);
  assert.equal(sameFinish("Normal", "Foil"), false);
  assert.equal(isFoilFinish("Normal"), false);
  assert.equal(isFoilFinish("Regular"), false);
  assert.equal(isFoilFinish("Foil"), true);
  assert.equal(isFoilFinish("Enchanted"), true);
  assert.equal(isFoilFinish("Borderless"), false);
  assert.equal(isFoilFinish("Borderless Foil"), true);
  assert.equal(isFoilFinish(null), false);
  assert.deepEqual(finishQueryValues("Normal"), ["Normal", "Regular"]);
  assert.deepEqual(finishQueryValues("Foil"), ["Foil"]);
  assert.equal(finishMatchFormula("Normal"), "OR({Finish}='Normal',{Finish}='Regular')");
  assert.equal(finishMatchFormula("Foil"), "{Finish}='Foil'");
  assert.equal(matchesPrinting(card("Regular"), draft), true);
  assert.equal(matchesPrinting(card("Normal"), draft), true);
  assert.equal(matchesPrinting(card("Foil"), draft), false);
  assert.equal(printingKey(card("Normal"))[0], printingKey(card("Regular"))[0]);
  assert.notEqual(printingKey(card("Normal"))[0], printingKey(card("Foil"))[0]);

  assert.equal(canonicalFinish("regular"), null);
  assert.equal(canonicalFinish("Regular"), null);
  assert.equal(buildEditFields({ finish: "Regular" }, "Lorcana").ok, false);
  const edited = buildEditFields({ finish: "Normal" }, "Lorcana");
  assert.equal(edited.ok && edited.fields.Finish, "Normal");
  const parsed = parseDraft({ game: "Lorcana", setNumber: "1", collectorNumber: "42", finish: "Normal", condition: "NM", qty: 1 });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(buildCreateFields(parsed.card).Finish, "Normal");
});

test("Regular is non-foil on the TCGplayer condition and the reconcile score, same as Normal", () => {
  const sale = (over: Partial<SaleRow> = {}): SaleRow => ({
    id: 1, platform: "cardtrader", externalOrderId: "1", orderCode: null, lineKey: "1", recordId: "recAAAAAAAAAAAAAA",
    game: "Lorcana", cardName: "Elsa", qty: 1, currency: "USD", grossCents: 100, feeCents: null, netCents: null,
    soldAt: "2026-10-20T10:00:00.000Z", orderState: "paid", cancelledAt: null, decrementOwner: "starfoil", decrementedAt: null,
    oversold: false, needsReview: null, ...over,
  });
  const stock = (finish: string) => ({
    id: "recAAAAAAAAAAAAAA", name: "Elsa", cardName: "Elsa", resolvedName: "Elsa - Spirit of Winter", game: "Lorcana",
    setNumber: "1", setIdentifier: null, setName: "The First Chapter", collectorNumber: "42", finish, condition: "NM", qty: 0,
    status: "Sold", rankScore: null, marketPriceUsd: 12.5, notes: null, priority: null, createdTime: "", autoRank: null,
    rarity: "Legendary", costBasisUsd: null, cardType: null, recommendation: null, rankReason: null, enrichedAt: null,
    priceSource: null, cardTraderListingId: null, tcgplayerSku: "123456",
  });
  const conditionOf = (finish: string) => tcgplayerCsv(buildPullList([sale()], [stock(finish)])).csv.trim().split("\r\n")[1]!.split(",")[7];
  assert.equal(conditionOf("Normal"), "Near Mint");
  assert.equal(conditionOf("Regular"), "Near Mint");
  assert.equal(conditionOf("Foil"), "Near Mint Foil");

  const row = (finish: string): ReconRow => ({
    id: "recAAAAAAAAAAAAAA", name: "Elsa - Spirit of Winter", game: "Lorcana", setName: "The First Chapter", setIdentifier: null,
    setNumber: "1", collectorNumber: "42", finish, condition: "NM", rarity: "Legendary", qty: 2, status: "Listed",
    marketPriceUsd: 12.5, cardTraderListingId: null, tcgplayerSku: null,
  });
  const tcg = (condition: string): TcgRow => ({
    tcgplayerId: "1", productLine: "Lorcana", setName: "The First Chapter", productName: "Elsa - Spirit of Winter",
    number: "42", rarity: "Legendary", condition, totalQty: 1, priceCents: 1250, marketCents: 1250,
  });
  assert.equal(matchScore(row("Regular"), tcg("Near Mint")), matchScore(row("Normal"), tcg("Near Mint")));
  assert.ok(matchScore(row("Regular"), tcg("Near Mint Foil")) < matchScore(row("Regular"), tcg("Near Mint")));
});

test("a Regular finish lists on CardTrader as non-foil, the same as Normal", () => {
  const conditionProp = { name: "condition", possible_values: ["Mint", "Near Mint", "Slightly Played", "Moderately Played", "Played", "Poor"] };
  const blueprint: Blueprint = {
    id: 400552, name: "Oasis Raider", version: null, category_id: 258, expansion_id: 4521,
    fixed_properties: { collector_number: "006" },
    editable_properties: [conditionProp, { name: "riftbound_foil", possible_values: [true, false] }],
  };
  const exportCard = (finish: string): ExportCard => ({
    id: "recAAAAAAAAAAAAAA", game: "Riftbound", setNumber: null, setIdentifier: "VEN", collectorNumber: "006", name: "",
    resolvedName: "Oasis Raider", finish, condition: "NM", qty: 2, status: "Waitlist", marketPriceUsd: 0.05,
    priceSource: "CardTrader market (Near Mint non-foil, 160 offers)", cardTraderListingId: null,
  });
  const regular = buildRow(exportCard("Regular"), blueprint);
  const normal = buildRow(exportCard("Normal"), blueprint);
  assert.equal(regular.ready && regular.product.properties.riftbound_foil, false);
  assert.equal(normal.ready && normal.product.properties.riftbound_foil, false);
});
