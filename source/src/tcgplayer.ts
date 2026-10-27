/**
 * Daily "pull from TCGplayer" list. There is no TCGplayer API access, so Hekla cannot delist there.
 * Instead it lists the cards that sold on CardTrader or starfoil.store in the last day, and builds a CSV in
 * TCGplayer's Seller Portal pricing format (Pricing tab → Import to Staged) that subtracts those copies.
 *
 * The 16 columns, their order and the Add to Quantity rules follow TCGplayer's help article
 * "Importing and Exporting CSVs to Mass Update Prices and Quantities". TCGplayer matches rows on
 * "TCGplayer Id", which is the SKU (not the product id), and requires "TCG Marketplace Price" — the import
 * also SETS your price to that value. Rows without a SKU cannot be imported and are listed separately.
 */
import type { StockCard } from "./airtable.ts";
import { csvRow, type SaleRow } from "./sales.ts";
import { isFoilFinish } from "./sets.ts";

export const TCGPLAYER_HEADER = [
  "TCGplayer Id", "Product Line", "Set Name", "Product Name", "Title", "Number", "Rarity", "Condition",
  "TCG Market Price", "TCG Direct Low", "TCG Low Price With Shipping", "TCG Low Price", "Total Quantity",
  "Add to Quantity", "TCG Marketplace Price", "Photo URL",
] as const;

/** Best-known TCGplayer product line names. Informational only: the import matches on the SKU. */
const PRODUCT_LINE: Record<string, string> = {
  Lorcana: "Lorcana TCG",
  Riftbound: "Riftbound: League of Legends Trading Card Game",
  "Magic: The Gathering": "Magic",
  "Pokémon": "Pokemon",
  "Yu-Gi-Oh!": "YuGiOh",
};
const CONDITION: Record<string, string> = { NM: "Near Mint", LP: "Lightly Played", MP: "Moderately Played", HP: "Heavily Played", DMG: "Damaged" };

export type PullItem = {
  recordId: string | null; name: string; game: string | null; set: string | null; number: string | null; rarity: string | null;
  condition: string | null; finish: string | null; qtySold: number; platforms: string[]; lastSoldAt: string;
  sharedQty: number | null; soldOut: boolean; tcgplayerSku: string | null; priceUsd: number | null;
};

/** Groups the window's sales by Waitlist row (or by name when a sale had no row) and joins the row's details. */
export function buildPullList(sales: SaleRow[], cards: StockCard[]): PullItem[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const groups = new Map<string, PullItem>();
  for (const s of sales) {
    const key = s.recordId ?? `name:${s.platform}:${s.cardName ?? s.lineKey}`;
    const card = s.recordId ? byId.get(s.recordId) : undefined;
    const g = groups.get(key) ?? {
      recordId: s.recordId, name: card?.resolvedName || card?.name || s.cardName || "(unnamed)", game: card?.game ?? s.game,
      set: card ? card.setName ?? card.setIdentifier ?? card.setNumber : null, number: card?.collectorNumber ?? null, rarity: card?.rarity ?? null,
      condition: card?.condition ?? null, finish: card?.finish ?? null, qtySold: 0, platforms: [], lastSoldAt: s.soldAt,
      sharedQty: card ? (card.status === "Sold" ? 0 : card.qty) : null, soldOut: card ? card.status === "Sold" || card.qty <= 0 : false,
      tcgplayerSku: card?.tcgplayerSku ?? null, priceUsd: card?.marketPriceUsd ?? null,
    };
    g.qtySold += s.qty;
    if (!g.platforms.includes(s.platform)) g.platforms.push(s.platform);
    if (s.soldAt > g.lastSoldAt) g.lastSoldAt = s.soldAt;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.lastSoldAt.localeCompare(a.lastSoldAt));
}

const conditionName = (item: PullItem) => {
  const base = CONDITION[item.condition ?? ""] ?? "";
  return base && isFoilFinish(item.finish) ? `${base} Foil` : base;
};

/** The importable CSV: only rows with a TCGplayer SKU and a price. Add to Quantity subtracts what sold. */
export function tcgplayerCsv(items: PullItem[]): { csv: string; included: number; skipped: PullItem[] } {
  const lines = [csvRow([...TCGPLAYER_HEADER])];
  const skipped: PullItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const sku = item.tcgplayerSku?.trim();
    if (!sku || !/^\d+$/.test(sku) || item.priceUsd == null || !(item.priceUsd >= 0.01) || seen.has(sku)) { skipped.push(item); continue; }
    seen.add(sku); // TCGplayer refuses duplicate ids in one file
    lines.push(csvRow([
      sku, PRODUCT_LINE[item.game ?? ""] ?? item.game ?? "", item.set ?? "", item.name, "", item.number ?? "", item.rarity ?? "", conditionName(item),
      "", "", "", "", "", -item.qtySold, item.priceUsd.toFixed(2), "",
    ]));
  }
  return { csv: lines.join("\r\n") + "\r\n", included: lines.length - 1, skipped };
}

/** A plain checklist of everything in the window, SKU or not, for pulling by hand. */
export function checklistCsv(items: PullItem[]): string {
  const lines = [csvRow(["Card", "Game", "Set", "Number", "Condition", "Finish", "Qty sold", "Sold on", "Last sold (UTC)", "Shared Qty now", "Sold out", "TCGplayer SKU", "Waitlist record"])];
  for (const i of items) lines.push(csvRow([i.name, i.game, i.set, i.number, i.condition, i.finish, i.qtySold, i.platforms.join(" + "), i.lastSoldAt, i.sharedQty, i.soldOut ? "yes" : "", i.tcgplayerSku, i.recordId]));
  return lines.join("\r\n") + "\r\n";
}

export function pullEmailText(items: PullItem[], hours: number): string {
  if (items.length === 0) return `Nothing sold on CardTrader or starfoil.store in the last ${hours} hours. Nothing to pull from TCGplayer.`;
  return [
    `Pull these from TCGplayer (sold elsewhere in the last ${hours} hours):`,
    "",
    ...items.map((i) => `  -${i.qtySold}  ${i.name}${i.set ? ` · ${i.set}` : ""}${i.number ? ` #${i.number}` : ""} · ${i.condition ?? ""} ${i.finish ?? ""} · sold on ${i.platforms.join(" + ")}${i.soldOut ? " · SOLD OUT" : ""}${i.tcgplayerSku ? "" : " · no TCGplayer SKU"}`),
    "",
    "The import CSV is on the Sales page in Hekla Intake.",
  ].join("\n");
}
