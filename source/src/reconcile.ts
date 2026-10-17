/**
 * Every 15 minutes: compare the shared Qty (Airtable Waitlist) with what CardTrader has listed.
 * starfoil.store needs no check of its own: its singles stock is copied from the CardTrader listings.
 *
 * Report mode only reports. Push mode also lowers a CardTrader listing that shows more copies than the
 * shared Qty, but only after the same excess has been seen on two runs in a row, so a sale still being
 * processed is never "fixed" twice. Hekla never raises a CardTrader quantity.
 */
import type { CtListing } from "./cardtrader.ts";

export type DriftKind = "over_listed" | "under_listed" | "missing_on_cardtrader" | "unknown_record";
export type Drift = { kind: DriftKind; recordId: string | null; name: string | null; airtableQty: number | null; cardTraderQty: number; listingIds: number[] };
export type ReconcileReport = { at: string; checkedRows: number; listings: number; drift: Drift[]; pushed: { recordId: string; listingId: number; delta: number }[]; errors: string[] };

type Row = { id: string; name: string; qty: number; status: string | null; cardTraderListingId: string | null };

export function diffStock(rows: Row[], listings: CtListing[]): Drift[] {
  const byRecord = new Map<string, CtListing[]>();
  const byListing = new Map<number, CtListing>();
  for (const l of listings) {
    byListing.set(l.id, l);
    if (l.recordId) byRecord.set(l.recordId, [...(byRecord.get(l.recordId) ?? []), l]);
  }
  const known = new Set(rows.map((r) => r.id));
  const drift: Drift[] = [];
  for (const row of rows) {
    const mine = [...(byRecord.get(row.id) ?? [])];
    const stored = Number(row.cardTraderListingId);
    if (Number.isInteger(stored) && byListing.has(stored) && !mine.some((l) => l.id === stored)) mine.push(byListing.get(stored)!);
    const ct = mine.reduce((n, l) => n + l.quantity, 0);
    const air = row.status === "Sold" ? 0 : Math.max(0, row.qty);
    const base = { recordId: row.id, name: row.name || null, airtableQty: air, cardTraderQty: ct, listingIds: mine.map((l) => l.id) };
    if (ct > air) drift.push({ kind: "over_listed", ...base });
    else if (ct === 0 && air > 0 && row.status === "Listed") drift.push({ kind: "missing_on_cardtrader", ...base });
    else if (ct < air && row.status === "Listed") drift.push({ kind: "under_listed", ...base });
  }
  for (const l of listings) {
    if (l.recordId && !known.has(l.recordId)) drift.push({ kind: "unknown_record", recordId: l.recordId, name: null, airtableQty: null, cardTraderQty: l.quantity, listingIds: [l.id] });
  }
  return drift;
}

/**
 * Which CardTrader listings to lower, and by how much, given this run's drift and the previous run's.
 * Only over-listed rows with the same excess on both runs qualify. Largest listings are lowered first.
 */
export function planPushes(current: Drift[], previous: Drift[] | null, listings: CtListing[], max = 40): { recordId: string; listingId: number; delta: number }[] {
  if (!previous) return [];
  const before = new Map(previous.filter((d) => d.kind === "over_listed" && d.recordId).map((d) => [d.recordId!, d.cardTraderQty - (d.airtableQty ?? 0)]));
  const qtyOf = new Map(listings.map((l) => [l.id, l.quantity]));
  const out: { recordId: string; listingId: number; delta: number }[] = [];
  for (const d of current) {
    if (d.kind !== "over_listed" || !d.recordId) continue;
    let excess = d.cardTraderQty - (d.airtableQty ?? 0);
    if (excess <= 0 || before.get(d.recordId) !== excess) continue;
    const ids = [...d.listingIds].sort((a, b) => (qtyOf.get(b) ?? 0) - (qtyOf.get(a) ?? 0));
    for (const id of ids) {
      if (excess <= 0 || out.length >= max) break;
      const take = Math.min(excess, qtyOf.get(id) ?? 0);
      if (take > 0) { out.push({ recordId: d.recordId, listingId: id, delta: -take }); excess -= take; }
    }
  }
  return out;
}

export function reconcileSummary(report: ReconcileReport): string {
  const count = (k: DriftKind) => report.drift.filter((d) => d.kind === k).length;
  return `over-listed ${count("over_listed")}, under-listed ${count("under_listed")}, missing on CardTrader ${count("missing_on_cardtrader")}, listings with an unknown row ${count("unknown_record")}, lowered ${report.pushed.length}`;
}
