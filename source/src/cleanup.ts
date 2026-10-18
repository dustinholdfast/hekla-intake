/**
 * CardTrader cleanup → Airtable. Dustin consolidated duplicate CardTrader listings (merged several listings of one
 * printing into one surviving listing and deleted the rest). This plans the matching Airtable cleanup: the row
 * that owns the surviving listing gets CardTrader's consolidated quantity (and a quantity-weighted cost), the
 * duplicate rows whose listings are gone are removed (snapshotted to Neon first, reason "cardtrader-cleanup").
 * Pure functions only. It never treats an error, a missing response or an unmatched row as "0".
 */
import type { CtListing } from "./cardtrader.ts";
import { effectiveGame } from "./sets.ts";

export type CleanupRow = {
  id: string; name: string; game: string | null; setNumber: string | null; setIdentifier: string | null;
  collectorNumber: string | null; finish: string | null; condition: string | null; qty: number; status: string | null;
  costBasisUsd: number | null; cardTraderListingId: string | null;
};
export type Survivor = { row: CleanupRow; listing: CtListing };
export type CleanupGroup = {
  key: string; name: string;
  survivor: CleanupRow; listingId: number;
  /** CardTrader's consolidated quantity: the new Airtable Qty for the survivor. */
  ctQty: number;
  removed: CleanupRow[];
  /** Survivor + removed Airtable quantities. */
  airtableQtySum: number;
  qtyMismatch: boolean;
  cost: { before: number | null; after: number | null; changed: boolean; mixed: boolean };
  update: { qty: boolean; cost: boolean; listingId: boolean };
};
export type CleanupPlan = {
  groups: CleanupGroup[];
  /** Survivors that need an Airtable write (qty, cost or listing id). */
  toUpdate: CleanupGroup[];
  /** Rows to remove, each with the survivor it merges into. */
  toRemove: { row: CleanupRow; intoRecordId: string; intoName: string; listingId: number }[];
  /** Listed rows whose CardTrader listing is gone with no surviving listing for that printing. */
  goneNoSurvivor: CleanupRow[];
  /** CardTrader listings with no Airtable row (tag points nowhere and no row stores the id). */
  listingsNoRow: CtListing[];
  /** Groups whose Airtable total differs from CardTrader's consolidated quantity. */
  qtyMismatches: CleanupGroup[];
  /** Printings with more than one live listing: not merged on CardTrader, left alone (listed for review). */
  ambiguous: { key: string; recordIds: string[]; listingIds: number[] }[];
  skippedSold: number;
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
/** "0249" → "249", "42/204" → "42", "SP6" → "sp6". */
export function normCollector(s: string | null | undefined): string {
  const head = norm(s).split("/")[0]!.trim();
  return /^\d+$/.test(head) ? String(Number(head)) : head.replace(/\s+/g, "");
}
/** One printing in one condition: game, set, collector number, finish, condition. */
export function printingKey(r: CleanupRow): string | null {
  const game = effectiveGame(r.game) ?? r.game ?? "";
  const set = game === "Lorcana" ? norm(r.setNumber) : norm(r.setIdentifier);
  const num = normCollector(r.collectorNumber);
  if (!set || !num) return null;
  return [norm(game), set, num, norm(r.finish), norm(r.condition)].join("|");
}
const listingIdOf = (r: CleanupRow) => { const n = Number(r.cardTraderListingId); return Number.isInteger(n) && n > 0 ? n : null; };
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Quantity-weighted average of the known costs (rows without a cost are left out of the average). */
export function weightedCost(rows: { qty: number; costBasisUsd: number | null }[]): { cost: number | null; mixed: boolean } {
  const known = rows.filter((r) => r.costBasisUsd != null && Number.isFinite(r.costBasisUsd));
  if (!known.length) return { cost: null, mixed: false };
  const distinct = new Set(known.map((r) => r.costBasisUsd));
  if (distinct.size === 1) return { cost: known[0]!.costBasisUsd, mixed: known.length !== rows.length };
  const w = known.reduce((n, r) => n + Math.max(1, r.qty), 0);
  return { cost: round2(known.reduce((n, r) => n + r.costBasisUsd! * Math.max(1, r.qty), 0) / w), mixed: true };
}

/**
 * `listings` must come from a successful CardTrader products export (the caller refuses to plan otherwise).
 * Only Listed rows take part; Sold rows are sales history and are never touched.
 */
export function planCleanup(rows: CleanupRow[], listings: CtListing[]): CleanupPlan {
  const live = new Map(listings.map((l) => [l.id, l]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const listed = rows.filter((r) => r.status === "Listed");
  const skippedSold = rows.filter((r) => r.status === "Sold" && listingIdOf(r) != null).length;

  // Which row owns each live listing: the row CardTrader's tag points at, else the row that stores the id.
  const owner = new Map<number, CleanupRow>();
  for (const l of listings) {
    const tagged = l.recordId ? byId.get(l.recordId) : undefined;
    if (tagged && tagged.status === "Listed") owner.set(l.id, tagged);
  }
  for (const r of listed) { const id = listingIdOf(r); if (id != null && live.has(id) && !owner.has(id)) owner.set(id, r); }
  const owners = new Set([...owner.values()].map((r) => r.id));

  // Live listings per printing (through their owning row).
  const liveByKey = new Map<string, Survivor[]>();
  for (const [id, row] of owner) {
    const k = printingKey(row); if (!k) continue;
    liveByKey.set(k, [...(liveByKey.get(k) ?? []), { row, listing: live.get(id)! }]);
  }
  // Rows whose stored listing is gone (or that share a live listing with its owner) are duplicates candidates.
  const gone = listed.filter((r) => !owners.has(r.id) && listingIdOf(r) != null);

  const groups = new Map<string, CleanupGroup>();
  const goneNoSurvivor: CleanupRow[] = [];
  const ambiguous: CleanupPlan["ambiguous"] = [];
  const ambiguousKeys = new Set<string>();
  for (const [k, s] of liveByKey) {
    if (s.length > 1) { ambiguousKeys.add(k); ambiguous.push({ key: k, recordIds: s.map((x) => x.row.id), listingIds: s.map((x) => x.listing.id) }); continue; }
    const { row, listing } = s[0]!;
    groups.set(k, {
      key: k, name: row.name, survivor: row, listingId: listing.id, ctQty: listing.quantity, removed: [], airtableQtySum: row.qty, qtyMismatch: false,
      cost: { before: row.costBasisUsd, after: row.costBasisUsd, changed: false, mixed: false },
      update: { qty: false, cost: false, listingId: listingIdOf(row) !== listing.id },
    });
  }
  for (const r of gone) {
    const k = printingKey(r);
    const g = k ? groups.get(k) : undefined;
    if (g) { g.removed.push(r); g.airtableQtySum += r.qty; }
    else if (!(k && ambiguousKeys.has(k))) goneNoSurvivor.push(r);
  }
  for (const g of groups.values()) {
    const members = [g.survivor, ...g.removed];
    const c = weightedCost(members);
    g.cost = { before: g.survivor.costBasisUsd, after: c.cost, changed: c.cost !== g.survivor.costBasisUsd, mixed: c.mixed };
    g.qtyMismatch = g.removed.length > 0 && g.airtableQtySum !== g.ctQty;
    g.update = { qty: g.survivor.qty !== g.ctQty, cost: g.cost.changed, listingId: g.update.listingId };
  }
  const all = [...groups.values()];
  const ownedIds = new Set(owner.keys());
  return {
    groups: all,
    toUpdate: all.filter((g) => g.update.qty || g.update.cost || g.update.listingId),
    toRemove: all.flatMap((g) => g.removed.map((row) => ({ row, intoRecordId: g.survivor.id, intoName: g.survivor.name, listingId: g.listingId }))),
    goneNoSurvivor,
    listingsNoRow: listings.filter((l) => !ownedIds.has(l.id)),
    qtyMismatches: all.filter((g) => g.qtyMismatch),
    ambiguous,
    skippedSold,
  };
}

/* ---------- apply (one batch, sequential, each group re-checked against a fresh plan) ---------- */

export const CLEANUP_REASON = "cardtrader-cleanup";
export const CLEANUP_BATCH = 10;
export type RemoveMode = "delete" | "archive";
/** Archive instead of delete: the Waitlist has no Archived field, so Status Skip + Qty 0 (Hekla never creates fields). */
export const ARCHIVE_FIELDS = { Status: "Skip", Qty: 0 } as const;
export type ApplyGroup = { key: string; survivorId: string; listingId: number; ctQty: number; removeIds: string[]; mode: "keep" | "skip" };
export type ApplyResult = { key: string; name: string; status: "succeeded" | "skipped" | "failed"; reason?: string; updated: Record<string, unknown> | null; removed: string[]; snapshotIds: number[] };
export type CleanupIO = {
  snapshot(recordId: string, action: "update" | RemoveMode, detail: Record<string, unknown>): Promise<number>;
  applied(snapshotId: number): Promise<void>;
  update(recordId: string, fields: Record<string, unknown>): Promise<void>;
  remove(recordId: string): Promise<void>;
  archive(recordId: string): Promise<void>;
};

/** The Airtable fields the survivor needs, or null when it already matches. */
export function survivorPatch(g: CleanupGroup): Record<string, unknown> | null {
  const f: Record<string, unknown> = {};
  if (g.update.qty) f.Qty = g.ctQty;
  if (g.update.cost && g.cost.after != null) f["Cost Basis USD"] = g.cost.after;
  if (g.update.listingId) f["CardTrader Listing ID"] = String(g.listingId);
  return Object.keys(f).length ? f : null;
}
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export async function runCleanupBatch(inputs: ApplyGroup[], fresh: CleanupPlan, io: CleanupIO, mode: RemoveMode = "delete"): Promise<ApplyResult[]> {
  const byKey = new Map(fresh.groups.map((g) => [g.key, g]));
  const out: ApplyResult[] = [];
  for (const i of inputs) {
    const g = byKey.get(i.key);
    const base = { key: i.key, name: g?.name ?? i.key, updated: null, removed: [] as string[], snapshotIds: [] as number[] };
    if (i.mode === "skip") { out.push({ ...base, status: "skipped", reason: "skipped by you" }); continue; }
    if (!g) { out.push({ ...base, status: "skipped", reason: "no longer a cleanup group (CardTrader or Airtable changed)" }); continue; }
    if (g.survivor.id !== i.survivorId || g.listingId !== i.listingId) { out.push({ ...base, status: "skipped", reason: "the surviving row or listing changed since the preview" }); continue; }
    if (g.ctQty !== i.ctQty) { out.push({ ...base, status: "skipped", reason: `CardTrader now shows ${g.ctQty} (preview said ${i.ctQty})` }); continue; }
    const removeIds = g.removed.map((r) => r.id);
    if (!sameSet(removeIds, i.removeIds)) { out.push({ ...base, status: "skipped", reason: "the rows to remove changed since the preview" }); continue; }
    const patch = survivorPatch(g);
    if (!patch && !removeIds.length) { out.push({ ...base, status: "skipped", reason: "already matches" }); continue; }
    const result: ApplyResult = { ...base, status: "succeeded" };
    const detail = { survivor: g.survivor.id, listingId: g.listingId, ctQty: g.ctQty, airtableQtySum: g.airtableQtySum, qtyMismatch: g.qtyMismatch, cost: g.cost, removing: removeIds };
    try {
      if (patch) {
        const id = await io.snapshot(g.survivor.id, "update", { ...detail, patch });
        result.snapshotIds.push(id);
        await io.update(g.survivor.id, patch);
        await io.applied(id);
        result.updated = patch;
      }
      for (const r of g.removed) {
        const id = await io.snapshot(r.id, mode, { ...detail, into: g.survivor.id, qty: r.qty });
        result.snapshotIds.push(id);
        await (mode === "archive" ? io.archive(r.id) : io.remove(r.id));
        await io.applied(id);
        result.removed.push(r.id);
      }
    } catch (error) {
      result.status = "failed"; result.reason = error instanceof Error ? error.message : String(error);
    }
    out.push(result);
  }
  return out;
}

/** The preview the page shows: plan groups as plain JSON. */
export function previewJson(p: CleanupPlan) {
  const r = (x: CleanupRow) => ({ recordId: x.id, name: x.name, game: x.game, set: x.setIdentifier ?? x.setNumber, number: x.collectorNumber, finish: x.finish, condition: x.condition, qty: x.qty, cost: x.costBasisUsd, listingId: x.cardTraderListingId });
  const g = (x: CleanupGroup) => ({ key: x.key, name: x.name, survivor: r(x.survivor), listingId: x.listingId, ctQty: x.ctQty, airtableQtySum: x.airtableQtySum, qtyMismatch: x.qtyMismatch, cost: x.cost, update: x.update, patch: survivorPatch(x), removed: x.removed.map(r) });
  const merges = p.groups.filter((x) => x.removed.length).map(g);
  const syncs = p.groups.filter((x) => !x.removed.length && survivorPatch(x)).map(g);
  return {
    merges, syncs,
    deletes: p.toRemove.map((x) => ({ ...r(x.row), intoRecordId: x.intoRecordId, intoName: x.intoName, listingId: x.listingId })),
    noMatch: { goneNoSurvivor: p.goneNoSurvivor.map(r), listingsNoRow: p.listingsNoRow },
    qtyMismatches: p.qtyMismatches.map((x) => x.key),
    ambiguous: p.ambiguous, skippedSold: p.skippedSold,
    counts: { merges: merges.length, deletes: p.toRemove.length, syncs: syncs.length, goneNoSurvivor: p.goneNoSurvivor.length, listingsNoRow: p.listingsNoRow.length, qtyMismatches: p.qtyMismatches.length, ambiguous: p.ambiguous.length },
  };
}
