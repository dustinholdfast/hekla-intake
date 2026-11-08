/**
 * Copies that can be listed or sold online.
 * Qty stays the on-hand count. Reserved Qty is a manual hold. Deck Reserved Qty is a deck hold.
 * A blank of either counts as 0. The result never goes below 0.
 * When Airtable's Free Qty formula returned a number, that number is used. A missing or blank formula is computed here.
 */

export const DEFAULT_RESERVED_QTY_FIELD = "Reserved Qty";
export const DEFAULT_DECK_RESERVED_QTY_FIELD = "Deck Reserved Qty";
export const DEFAULT_FREE_QTY_FIELD = "Free Qty";

export type HoldFieldNames = { reservedQty: string; deckReservedQty: string; freeQty: string };
export type HoldFieldEnv = { RESERVED_QTY_FIELD?: string; DECK_RESERVED_QTY_FIELD?: string; FREE_QTY_FIELD?: string };

const configuredName = (value: string | undefined, fallback: string): string => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
};

/** Airtable column names for holds. Each falls back to its default when unset or blank. */
export function holdFieldNames(env: HoldFieldEnv = {}): HoldFieldNames {
  return {
    reservedQty: configuredName(env.RESERVED_QTY_FIELD, DEFAULT_RESERVED_QTY_FIELD),
    deckReservedQty: configuredName(env.DECK_RESERVED_QTY_FIELD, DEFAULT_DECK_RESERVED_QTY_FIELD),
    freeQty: configuredName(env.FREE_QTY_FIELD, DEFAULT_FREE_QTY_FIELD),
  };
}

export type ListableStock = {
  qty: number;
  reservedQty?: number | null;
  deckReservedQty?: number | null;
  /** A number only when the Free Qty formula returned one. Null or omitted means compute Qty − both holds. */
  freeQty?: number | null;
};

const whole = (value: number | null | undefined): number =>
  (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

export function listableQty(stock: ListableStock): number {
  if (typeof stock.freeQty === "number" && Number.isFinite(stock.freeQty)) return Math.max(0, Math.floor(stock.freeQty));
  return Math.max(0, whole(stock.qty) - whole(stock.reservedQty) - whole(stock.deckReservedQty));
}

/** Listing and re-list callers pass Airtable cards through this so the quantity sent to a marketplace is the listable one. */
export function withListableQuantity<T extends ListableStock>(cards: T[]): T[] {
  return cards.map((card) => ({ ...card, qty: listableQty(card) }));
}
