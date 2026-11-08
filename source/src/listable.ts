/**
 * Copies that can be listed or sold online.
 * Airtable Qty stays the on-hand count. Reserved Qty is copies held for a deck and must not be listed again.
 * A blank reservation counts as 0. The result never goes below 0.
 */
export function listableQty(qty: number, reserved: number | null | undefined): number {
  const onHand = typeof qty === "number" && Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 0;
  const held = typeof reserved === "number" && Number.isFinite(reserved) && reserved > 0 ? Math.floor(reserved) : 0;
  return Math.max(0, onHand - held);
}

/** Listing and re-list callers pass Airtable cards through this so the quantity sent to a marketplace is the listable one. */
export function withListableQuantity<T extends { qty: number; reservedQty?: number | null }>(cards: T[]): T[] {
  return cards.map((card) => ({ ...card, qty: listableQty(card.qty, card.reservedQty) }));
}
