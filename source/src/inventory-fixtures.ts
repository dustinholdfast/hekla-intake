/** Example rows for the local inventory preview. Not live stock, and not written to Airtable. */
import { planOpeningEntries, type BuyListInput, type MovementDraft, type WaitlistInput } from "./inventory.ts";

export const FIXTURE_TENANT = "00000000-0000-4000-8000-000000000001";

const ago = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

export function fixtureRows(now: Date): WaitlistInput[] {
  const row = (id: string, days: number, fields: Record<string, unknown>): WaitlistInput => ({ id, createdTime: ago(now, days), fields });
  return [
    row("recFIXTUREEMBER01", 9, { "Card Name": "Example Ember Drake", Game: "Lorcana", "Set #": "1", "Collector Number": "042/204", Finish: "Enchanted", Condition: "NM", Qty: 4, Status: "Listed", Rarity: "Enchanted", "Market Price USD": 7.8, "Cost Basis USD": 2.98 }),
    row("recFIXTURETIDE001", 3, { "Card Name": "Example Tide Oracle", Game: "Lorcana", "Set #": "2", "Collector Number": "117/204", Finish: "Foil", Condition: "NM", Qty: 2, Status: "Listed", "Market Price USD": 24 }),
    row("recFIXTURETIDE002", 3, { "Card Name": "Example Tide Oracle", Game: "Lorcana", "Set #": "2", "Collector Number": "117/204", Finish: "Foil", Condition: "NM", Qty: 1, Status: "Listed", "Market Price USD": 24 }),
    row("recFIXTUREGOLEM01", 71, { "Card Name": "Example Vault Golem", Game: "Magic: The Gathering", "Set Identifier": "MH3", "Collector Number": "301", Finish: "Normal", Condition: "LP", Qty: 9, Status: "Listed", "Market Price USD": 0.85 }),
    row("recFIXTURESCOUT01", 20, { "Card Name": "Example Rift Scout", Game: "Riftbound", "Set Identifier": "SAMPLE", "Collector Number": "088", Finish: "Foil", Condition: "NM", Qty: 0, Status: "Listed", "Market Price USD": 15.4 }),
    row("recFIXTURETHIEF01", 22, { "Card Name": "Example Lantern Thief", Game: "Lorcana", "Set #": "3", "Collector Number": "009/204", Finish: "Normal", Condition: "MP", Qty: 14, Status: "Listed", "Market Price USD": 0.95 }),
    row("recFIXTURESPRITE1", 40, { "Card Name": "Example Harbor Sprite", Game: "Lorcana", "Set #": "2", "Collector Number": "051/204", Finish: "Foil", Condition: "NM", Qty: 0, Status: "Sold", "Market Price USD": 2.3 }),
    row("recFIXTURESPECIAL", 10, { "Card Name": "Example Prism Fox", Game: "Lorcana", "Set #": "1", "Collector Number": "001/204", Finish: "Special", Condition: "NM", Qty: 1, Status: "Listed", "Market Price USD": 12 }),
    row("recFIXTUREJAPAN01", 12, { "Card Name": "Example Sakura Knight", Game: "Lorcana", "Set #": "4", "Collector Number": "012/204", Finish: "Foil", Condition: "NM", Qty: 2, Status: "Listed", Language: "Japanese", "Market Price USD": 4 }),
    row("recFIXTUREMOSS001", 50, { "Card Name": "Example Moss Knight", Game: "Lorcana", "Set #": "5", "Collector Number": "015/204", Finish: "Regular", Condition: "NM", Qty: 3, Status: "Listed", "Market Price USD": 1.1 }),
    row("recFIXTUREYOUNG01", 10, { "Card Name": "Example Young Drake", Game: "Lorcana", "Set #": "6", "Collector Number": "020/204", Finish: "Foil", Condition: "NM", Qty: 6, Status: "Listed", "Market Price USD": 3.25 }),
    row("recFIXTUREANY0001", 5, { "Card Name": "Example Any-Finish Wisp", Game: "Lorcana", "Set #": "7", "Collector Number": "033/204", Finish: "Foil", Condition: "LP", Qty: 5, Status: "Listed", "Market Price USD": 0.4 }),
  ];
}

export function fixtureBuyList(): BuyListInput[] {
  const row = (id: string, fields: Record<string, unknown>): BuyListInput => ({ id, fields });
  return [
    row("recBUYLISTEMBER01", { Item: "Example Ember Drake", Game: "Lorcana", Kind: "Single", Set: "The First Chapter", Finish: "Enchanted", "Want Qty": 2, "Collector #": "42/204", Status: "Active" }),
    row("recBUYLISTCAT0001", { Item: "Example Ember Drake", Game: "Lorcana", Kind: "Category", Set: "The First Chapter", Finish: "Any", "Want Qty": 99, "Collector #": "42/204", Status: "Active" }),
    row("recBUYLISTSEAL001", { Item: "Example Ember Drake", Game: "Lorcana", Kind: "Sealed", Set: "1", Finish: "Enchanted", "Want Qty": 4, "Collector #": "042/204", Status: "Active" }),
    row("recBUYLISTSCOUT01", { Item: "Example Rift Scout", Game: "Riftbound", Kind: "Single", Set: "SAMPLE", Finish: "Foil", "Want Qty": 2, "Collector #": "88", Status: "Active" }),
    row("recBUYLISTTHIEF01", { Item: "Example Lantern Thief", Game: "Lorcana", Kind: "Single", Set: "Into the Inklands", Finish: "Regular", "Want Qty": 8, "Collector #": "9/204", Status: "Active" }),
    row("recBUYLISTSPRIT01", { Item: "Example Harbor Sprite", Game: "Lorcana", Kind: "Single", Set: "2", Finish: "Foil", "Want Qty": null, "Collector #": "51/204", Status: "Active" }),
    row("recBUYLISTANY0001", { Item: "Example Any-Finish Wisp", Game: "Lorcana", Kind: "Single", Set: "7", Finish: "Any", "Want Qty": 1, "Collector #": "033/204", Status: "Active" }),
  ];
}

export function fixtureMovements(now = new Date()): MovementDraft[] {
  return planOpeningEntries(fixtureRows(now), FIXTURE_TENANT, now);
}
