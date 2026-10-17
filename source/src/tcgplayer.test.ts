import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPullList, checklistCsv, TCGPLAYER_HEADER, tcgplayerCsv } from "./tcgplayer.ts";
import type { StockCard } from "./airtable.ts";
import type { SaleRow } from "./sales.ts";

const A = "recAAAAAAAAAAAAAA", B = "recBBBBBBBBBBBBBB";
const sale = (over: Partial<SaleRow>): SaleRow => ({ id: 1, platform: "cardtrader", externalOrderId: "1", orderCode: null, lineKey: "1", recordId: A, game: "Lorcana", cardName: "Elsa", qty: 1, currency: "USD", grossCents: 100, feeCents: null, netCents: null, soldAt: "2026-10-20T10:00:00.000Z", orderState: "paid", cancelledAt: null, decrementOwner: "starfoil", decrementedAt: null, oversold: false, needsReview: null, ...over });
const card = (over: Partial<StockCard>): StockCard => ({ id: A, name: "Elsa", cardName: "Elsa", resolvedName: "Elsa - Spirit of Winter", game: "Lorcana", setNumber: "1", setIdentifier: null, setName: "The First Chapter", collectorNumber: "42", finish: "Normal", condition: "NM", qty: 0, status: "Sold", rankScore: null, marketPriceUsd: 12.5, notes: null, priority: null, createdTime: "", autoRank: null, rarity: "Legendary", costBasisUsd: null, cardType: null, recommendation: null, rankReason: null, enrichedAt: null, priceSource: null, cardTraderListingId: null, tcgplayerSku: "123456", ...over });

test("pull list groups by row across platforms", () => {
  const items = buildPullList([sale({}), sale({ id: 2, platform: "starfoil", qty: 2, soldAt: "2026-10-20T12:00:00.000Z" }), sale({ id: 3, recordId: B, cardName: "Jinx" })], [card({}), card({ id: B, tcgplayerSku: null, status: "Listed", qty: 2, finish: "Foil" })]);
  assert.equal(items.length, 2);
  const elsa = items.find((i) => i.recordId === A)!;
  assert.equal(elsa.qtySold, 3); assert.deepEqual(elsa.platforms.sort(), ["cardtrader", "starfoil"]); assert.equal(elsa.soldOut, true);
  assert.equal(elsa.name, "Elsa - Spirit of Winter");
});

test("TCGplayer CSV: 16 columns, negative Add to Quantity, only rows with a SKU and price", () => {
  const items = buildPullList([sale({ qty: 2 }), sale({ id: 3, recordId: B })], [card({}), card({ id: B, tcgplayerSku: null })]);
  const { csv, included, skipped } = tcgplayerCsv(items);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines[0], TCGPLAYER_HEADER.join(","));
  assert.equal(TCGPLAYER_HEADER.length, 16);
  assert.equal(included, 1); assert.equal(skipped.length, 1);
  const cells = lines[1]!.split(",");
  assert.equal(cells.length, 16);
  assert.equal(cells[0], "123456"); assert.equal(cells[1], "Lorcana TCG"); assert.equal(cells[7], "Near Mint");
  assert.equal(cells[13], "-2"); assert.equal(cells[14], "12.50");
});

test("duplicate SKUs are not repeated in one file", () => {
  const items = buildPullList([sale({}), sale({ id: 2, recordId: B })], [card({}), card({ id: B })]);
  assert.equal(tcgplayerCsv(items).included, 1);
});

test("checklist includes everything", () => {
  const csv = checklistCsv(buildPullList([sale({ recordId: null, cardName: "Loose card" })], []));
  assert.match(csv, /Loose card/);
});
