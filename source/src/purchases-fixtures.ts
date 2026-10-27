/** One accepted sell request for tests and the local preview. Not a live Airtable row. */
import { fixtureBuyList, fixtureRows, FIXTURE_TENANT } from "./inventory-fixtures.ts";
import { onHand, type MovementDraft } from "./inventory.ts";
import { defaultInventorySettings } from "./inventory-settings.ts";
import { matchLines, readSellRequest, splitCardList, type CatalogLine, type SellRequestView } from "./purchases.ts";

export const EXAMPLE_SR_ID = "recSRPhase3Ex0012";
export const EXAMPLE_RECEIVED_ON = "2026-10-27";

const CARDS = [
  "1\t042/204\tEnchanted\tNM\t1\tExample Ember Drake",
  "3\t009/204\tNormal\tLP\t2\tExample Lantern Thief",
  "5\t015/204\tNormal\tNM\t1\tExample Moss Knight",
].join("\n");

export function exampleSellRequestRecord(): { id: string; fields: Record<string, unknown> } {
  return {
    id: EXAMPLE_SR_ID,
    fields: {
      Name: "SR-EX12",
      Ref: "SR-EX12",
      Status: "Accepted",
      Payout: "Store Credit",
      "Offer USD": 18,
      Game: "Lorcana",
      Cards: CARDS,
      Email: "seller@example.com",
      Phone: "555-010-0199",
      "Seller Name": "Example Seller",
    },
  };
}

export function exampleCatalog(movements: readonly MovementDraft[] = []): { request: SellRequestView; lines: CatalogLine[] } {
  const opened = readSellRequest(exampleSellRequestRecord());
  if (!opened.ok) throw new Error(opened.error);
  const buyList = fixtureBuyList().map((row) => ({ id: row.id, fields: { ...row.fields } }));
  const ember = buyList.find((row) => row.id === "recBUYLISTEMBER01");
  const lantern = buyList.find((row) => row.id === "recBUYLISTTHIEF01");
  if (ember) ember.fields["Market Ref USD"] = 7.8;
  if (lantern) lantern.fields["Market Ref USD"] = 0.95;
  const stock = fixtureRows(new Date("2026-10-27T15:00:00.000Z"));
  const onHandByRecord = new Map<string, number>();
  for (const row of stock) {
    const mine = movements.filter((movement) => movement.recordId === row.id);
    onHandByRecord.set(row.id, mine.length ? onHand(mine) : (typeof row.fields.Qty === "number" ? row.fields.Qty : 0));
  }
  const lines = matchLines(splitCardList(opened.request.cardsText, "Lorcana"), buyList, stock, onHandByRecord);
  return { request: opened.request, lines };
}

export function exampleAcceptInput(tenantId = FIXTURE_TENANT) {
  const catalog = exampleCatalog();
  return { tenantId, request: catalog.request, lines: catalog.lines, settings: defaultInventorySettings() };
}
