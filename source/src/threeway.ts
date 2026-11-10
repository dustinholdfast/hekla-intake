/**
 * Three-way reconcile: what Airtable says you have, what CardTrader lists, what TCGplayer lists.
 * Pure functions only (no I/O), so matching and the quantity math are unit tested.
 */
import type { CtListing } from "./cardtrader.ts";
import { listableQty } from "./listable.ts";
import { csvRow } from "./sales.ts";
import { effectiveGame, isFoilFinish, type Game } from "./sets.ts";
import { parseTcgCondition, type TcgRow } from "./tcgcsv.ts";
import { TCGPLAYER_HEADER } from "./tcgplayer.ts";

export type ReconRow = {
  id: string; name: string; game: string | null; setName: string | null; setIdentifier: string | null; setNumber: string | null;
  collectorNumber: string | null; finish: string | null; condition: string | null; rarity: string | null; qty: number; status: string | null;
  /** Manual holds. Blank means 0. */
  reservedQty?: number | null;
  /** Deck holds. Blank means 0. */
  deckReservedQty?: number | null;
  /** Set when the Free Qty formula returned a number. Null means compute Qty minus both holds. */
  freeQty?: number | null;
  marketPriceUsd: number | null; cardTraderListingId: string | null; tcgplayerSku: string | null;
};
export type MatchSource = "sku" | "confirmed" | "suggested";
export type TcgMatch = { tcgplayerId: string; source: MatchSource; confidence: number; row: TcgRow | null };
export type ViewRow = {
  recordId: string; name: string; game: string | null; set: string | null; number: string | null; condition: string | null; finish: string | null;
  status: string | null; airtableQty: number; reservedQty: number; deckReservedQty: number; freeQty: number | null; expectedQty: number;
  ct: { qty: number; listingIds: number[]; storedListingId: number | null } | null;
  tcg: { qty: number; tcgplayerId: string; source: MatchSource; confidence: number; productName: string | null; setName: string | null; condition: string | null; priceCents: number | null } | null;
  ctMismatch: boolean; tcgMismatch: boolean;
  /** Set when this row went into a downloaded TCGplayer import that has not shown up in an export yet. */
  tcgPending: { at: string; delta: number } | null;
};
export type View = {
  rows: ViewRow[];
  unmatchedCardTrader: CtListing[];
  unmatchedTcgplayer: TcgRow[];
  counts: ReturnType<typeof viewCounts> & { unmatchedCardTrader: number; unmatchedTcgplayer: number };
  ctAt: string | null; tcgAt: string | null;
};

/* ---------- normalising ---------- */

export function normName(s: string | null | undefined): string {
  return (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}
/** "014/204" → "14", "SP6" → "sp6", "R06" → "r06" (letters keep their digits as written). */
export function normNumber(s: string | null | undefined): string | null {
  const head = (s ?? "").trim().split("/")[0]!.trim().toLowerCase();
  if (!head) return null;
  return /^\d+$/.test(head) ? String(Number(head)) : head.replace(/\s+/g, "");
}
function tokens(s: string): Set<string> { return new Set(s.split(" ").filter(Boolean)); }
/** Dice coefficient over word tokens: 1 = same words. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = tokens(a), y = tokens(b);
  let both = 0; for (const t of x) if (y.has(t)) both++;
  return (2 * both) / (x.size + y.size);
}

/** TCGplayer "Product Line" → Hekla game. Matched loosely; the exact strings vary ("Lorcana TCG", "Magic"). */
export function gameOfProductLine(line: string | null): Game | null {
  const l = (line ?? "").toLowerCase();
  if (l.includes("lorcana")) return "Lorcana";
  if (l.includes("riftbound")) return "Riftbound";
  if (l.includes("magic")) return "Magic: The Gathering";
  if (l.includes("pokemon") || l.includes("pokémon")) return "Pokémon";
  if (l.includes("yugioh") || l.includes("yu-gi-oh")) return "Yu-Gi-Oh!";
  return null;
}

/** What each platform should list: a Listed row's free quantity. Every other status lists 0. */
export const expectedQty = (r: Pick<ReconRow, "qty" | "status" | "reservedQty" | "deckReservedQty" | "freeQty">) => (r.status === "Listed" ? listableQty(r) : 0);

const reservedCopies = (reserved: number | null | undefined): number => (typeof reserved === "number" && Number.isFinite(reserved) && reserved > 0 ? Math.floor(reserved) : 0);
const freeReading = (free: number | null | undefined): number | null => (typeof free === "number" && Number.isFinite(free) ? free : null);

/* ---------- fuzzy TCGplayer matching ---------- */

/** 0..1 confidence that a TCGplayer row is this Waitlist row. Game and collector number must agree. */
export function matchScore(row: ReconRow, tcg: TcgRow): number {
  const game = effectiveGame(row.game);
  if (!game || gameOfProductLine(tcg.productLine) !== game) return 0;
  const a = normNumber(row.collectorNumber), b = normNumber(tcg.number);
  if (a && b && a !== b) return 0;
  const name = Math.max(similarity(normName(row.name), normName(tcg.productName)), similarity(normName(row.name.split(" - ")[0]), normName(tcg.productName)) * 0.8);
  const setA = normName(row.setName ?? row.setIdentifier), setB = normName(tcg.setName);
  const set = setA && setB ? Math.max(similarity(setA, setB), setB.includes(setA) || setA.includes(setB) ? 0.9 : 0) : 0.5;
  const cond = parseTcgCondition(tcg.condition);
  const condition = !row.condition || !cond.condition ? 0.5 : row.condition === cond.condition ? 1 : 0;
  const rowFoil = isFoilFinish(row.finish);
  const finish = row.finish === "Enchanted" ? ((tcg.rarity ?? "").toLowerCase().includes("enchanted") || /enchanted/i.test(tcg.productName) ? 1 : 0.3) : rowFoil === cond.foil ? 1 : 0;
  const number = a && b ? 1 : 0.4;
  const score = 0.4 * name + 0.25 * number + 0.15 * set + 0.12 * condition + 0.08 * finish;
  return Math.round(score * 100) / 100;
}
export const MIN_SUGGEST = 0.6;
export const confidenceLabel = (c: number) => (c >= 0.9 ? "high" : c >= 0.75 ? "medium" : "low");

/**
 * One TCGplayer row per Waitlist row: the Airtable SKU first, then confirmed matches, then the best remaining
 * fuzzy pairs (greedy by score). A SKU on the Waitlist with no stocked TCGplayer row means 0 on TCGplayer.
 */
export function matchTcgplayer(rows: ReconRow[], tcgRows: TcgRow[], confirmed: Map<string, string>): Map<string, TcgMatch> {
  const byId = new Map(tcgRows.map((t) => [t.tcgplayerId, t]));
  const out = new Map<string, TcgMatch>();
  const taken = new Set<string>();
  for (const r of rows) {
    const sku = r.tcgplayerSku?.trim();
    if (sku && /^\d+$/.test(sku) && !taken.has(sku)) { out.set(r.id, { tcgplayerId: sku, source: "sku", confidence: 1, row: byId.get(sku) ?? null }); taken.add(sku); }
  }
  for (const r of rows) {
    const id = confirmed.get(r.id);
    if (!out.has(r.id) && id && !taken.has(id)) { out.set(r.id, { tcgplayerId: id, source: "confirmed", confidence: 1, row: byId.get(id) ?? null }); taken.add(id); }
  }
  const index = new Map<string, TcgRow[]>();
  for (const t of tcgRows) {
    if (taken.has(t.tcgplayerId)) continue;
    const k = `${gameOfProductLine(t.productLine)}|${normNumber(t.number) ?? ""}`;
    index.set(k, [...(index.get(k) ?? []), t]);
  }
  const pairs: { r: ReconRow; t: TcgRow; s: number }[] = [];
  for (const r of rows) {
    if (out.has(r.id)) continue;
    const game = effectiveGame(r.game);
    const n = normNumber(r.collectorNumber);
    const pool = n ? index.get(`${game}|${n}`) ?? [] : [...index.entries()].filter(([k]) => k.startsWith(`${game}|`)).flatMap(([, v]) => v);
    for (const t of pool) {
      const s = matchScore(r, t) + (r.status === "Listed" ? 0.001 : 0);
      if (s >= MIN_SUGGEST) pairs.push({ r, t, s });
    }
  }
  pairs.sort((a, b) => b.s - a.s);
  for (const { r, t, s } of pairs) {
    if (out.has(r.id) || taken.has(t.tcgplayerId)) continue;
    out.set(r.id, { tcgplayerId: t.tcgplayerId, source: "suggested", confidence: Math.min(1, Math.round(s * 100) / 100), row: t });
    taken.add(t.tcgplayerId);
  }
  return out;
}

/* ---------- the table ---------- */

export function buildView(rows: ReconRow[], listings: CtListing[] | null, tcgRows: TcgRow[] | null, confirmed: Map<string, string>, at: { ct: string | null; tcg: string | null }): View {
  const byListing = new Map((listings ?? []).map((l) => [l.id, l]));
  const byRecord = new Map<string, CtListing[]>();
  for (const l of listings ?? []) if (l.recordId) byRecord.set(l.recordId, [...(byRecord.get(l.recordId) ?? []), l]);
  const usedListings = new Set<number>();
  const matches = tcgRows ? matchTcgplayer(rows, tcgRows, confirmed) : new Map<string, TcgMatch>();
  const out: ViewRow[] = [];
  for (const r of rows) {
    const expected = expectedQty(r);
    let ct: ViewRow["ct"] = null;
    if (listings) {
      const mine = new Map<number, CtListing>();
      const stored = Number(r.cardTraderListingId);
      if (Number.isInteger(stored) && byListing.has(stored)) mine.set(stored, byListing.get(stored)!);
      for (const l of byRecord.get(r.id) ?? []) mine.set(l.id, l);
      for (const id of mine.keys()) usedListings.add(id);
      ct = { qty: [...mine.values()].reduce((n, l) => n + l.quantity, 0), listingIds: [...mine.keys()], storedListingId: Number.isInteger(stored) ? stored : null };
    }
    const m = matches.get(r.id);
    const tcg: ViewRow["tcg"] = m ? { qty: m.row?.totalQty ?? 0, tcgplayerId: m.tcgplayerId, source: m.source, confidence: m.confidence, productName: m.row?.productName ?? null, setName: m.row?.setName ?? null, condition: m.row?.condition ?? null, priceCents: m.row?.priceCents ?? null } : null;
    const ctMismatch = ct != null && ct.qty !== expected;
    const tcgMismatch = tcgRows != null && (tcg?.qty ?? 0) !== expected;
    // Rows that are not Listed and show nothing anywhere are history, not reconcile work.
    if (r.status !== "Listed" && !(ct?.qty) && !(tcg?.qty) && !m) continue;
    out.push({ recordId: r.id, name: r.name, game: effectiveGame(r.game) ?? r.game, set: r.setName ?? r.setIdentifier ?? r.setNumber, number: r.collectorNumber, condition: r.condition, finish: r.finish, status: r.status, airtableQty: r.qty, reservedQty: reservedCopies(r.reservedQty), deckReservedQty: reservedCopies(r.deckReservedQty), freeQty: freeReading(r.freeQty), expectedQty: expected, ct, tcg, ctMismatch, tcgMismatch, tcgPending: null });
  }
  const matchedTcg = new Set([...matches.values()].map((m) => m.tcgplayerId));
  const unmatchedCardTrader = (listings ?? []).filter((l) => !usedListings.has(l.id));
  const unmatchedTcgplayer = (tcgRows ?? []).filter((t) => !matchedTcg.has(t.tcgplayerId));
  return {
    rows: out, unmatchedCardTrader, unmatchedTcgplayer, ctAt: at.ct, tcgAt: at.tcg,
    counts: { ...viewCounts(out), unmatchedCardTrader: unmatchedCardTrader.length, unmatchedTcgplayer: unmatchedTcgplayer.length },
  };
}

/* ---------- reconciled rows and pending TCGplayer uploads ---------- */

export type PendingTcg = Record<string, { at: string; tcgplayerId: string; delta: number }>;
export const PENDING_TTL_MS = 24 * 3600_000;

/**
 * A row in a downloaded TCGplayer import counts as pending until a newer export is uploaded (that export then
 * decides) or 24 hours pass. Returns the entries still in force.
 */
export function livePending(pending: PendingTcg | null, snapshotAt: string | null, now: number): PendingTcg {
  const out: PendingTcg = {};
  const snap = snapshotAt ? Date.parse(snapshotAt) : 0;
  for (const [id, p] of Object.entries(pending ?? {})) {
    const at = Date.parse(p.at);
    if (Number.isFinite(at) && now - at < PENDING_TTL_MS && snap <= at) out[id] = p;
  }
  return out;
}
export function applyPending(rows: ViewRow[], pending: PendingTcg): void {
  for (const r of rows) {
    const p = pending[r.recordId];
    r.tcgPending = p && r.tcg?.tcgplayerId === p.tcgplayerId ? { at: p.at, delta: p.delta } : null;
  }
}
/** A TCGplayer mismatch that still needs work (not waiting on an uploaded import). */
export const tcgOpen = (r: ViewRow) => r.tcgMismatch && !r.tcgPending;
/** Reconciled = nothing left to do: both platforms agree (or an import is pending) and no match waits for confirmation. */
export const reconciled = (r: ViewRow) => !r.ctMismatch && !tcgOpen(r) && r.tcg?.source !== "suggested";
export function viewCounts(rows: ViewRow[]) {
  return {
    rows: rows.length, ctMismatch: rows.filter((r) => r.ctMismatch).length, tcgMismatch: rows.filter(tcgOpen).length,
    pendingUpload: rows.filter((r) => r.tcgMismatch && r.tcgPending).length, suggested: rows.filter((r) => r.tcg?.source === "suggested").length,
    open: rows.filter((r) => !reconciled(r)).length,
  };
}

/** `mismatch` picks which open mismatches to list; `showReconciled` adds back everything else (game filter still applies). */
export type ViewFilter = { mismatch: "any" | "cardtrader" | "tcgplayer"; game: string | null; showReconciled: boolean };
export function filterView(rows: ViewRow[], f: ViewFilter): ViewRow[] {
  return rows.filter((r) =>
    (!f.game || r.game === f.game) &&
    (f.showReconciled || (f.mismatch === "any" ? !reconciled(r) : f.mismatch === "cardtrader" ? r.ctMismatch : tcgOpen(r) || r.tcg?.source === "suggested")));
}

export const VIEW_CSV_HEADER = ["Card", "Game", "Set", "Number", "Condition", "Finish", "Status", "Airtable Qty", "Expected listed", "CardTrader qty", "CardTrader listings", "TCGplayer qty", "TCGplayer SKU", "TCGplayer match", "Match confidence", "CardTrader mismatch", "TCGplayer mismatch", "TCGplayer import pending since", "Waitlist record"];
export function viewCsv(rows: ViewRow[]): string {
  const lines = [csvRow(VIEW_CSV_HEADER)];
  for (const r of rows) lines.push(csvRow([r.name, r.game, r.set, r.number, r.condition, r.finish, r.status, r.airtableQty, r.expectedQty, r.ct?.qty, r.ct?.listingIds.join(" "), r.tcg?.qty, r.tcg?.tcgplayerId, r.tcg?.source, r.tcg ? r.tcg.confidence : null, r.ctMismatch ? "yes" : "", r.tcgMismatch ? "yes" : "", r.tcgPending?.at, r.recordId]));
  return lines.join("\r\n") + "\r\n";
}

/* ---------- actions ---------- */

/**
 * How to bring CardTrader to `target` copies across a row's listings. Lowering takes from the largest listing
 * first (a listing that reaches 0 is deleted by CardTrader); raising adds to the row's stored listing, else
 * the largest. With no listing at all, nothing can be raised here (list it from the Export screen).
 */
export function planCardTraderSet(listings: CtListing[], storedListingId: number | null, target: number): { ok: true; changes: { listingId: number; delta: number }[]; before: number } | { ok: false; error: string } {
  if (!Number.isInteger(target) || target < 0) return { ok: false, error: "Target must be a whole number of 0 or more." };
  const before = listings.reduce((n, l) => n + l.quantity, 0);
  let delta = target - before;
  if (delta === 0) return { ok: true, changes: [], before };
  if (delta > 0) {
    if (!listings.length) return { ok: false, error: "This card has no CardTrader listing to raise. List it from the Export screen." };
    const into = listings.find((l) => l.id === storedListingId) ?? [...listings].sort((a, b) => b.quantity - a.quantity)[0]!;
    return { ok: true, changes: [{ listingId: into.id, delta }], before };
  }
  const changes: { listingId: number; delta: number }[] = [];
  for (const l of [...listings].sort((a, b) => b.quantity - a.quantity)) {
    if (delta >= 0) break;
    const take = Math.min(l.quantity, -delta);
    if (take > 0) { changes.push({ listingId: l.id, delta: -take }); delta += take; }
  }
  return { ok: true, changes, before };
}

/**
 * TCGplayer import CSV that brings each selected row to its Airtable quantity: Add to Quantity = expected − TCGplayer.
 * TCG Marketplace Price is required by the import and SETS the price, so it is your current TCGplayer price from
 * the snapshot; only when the SKU is not stocked on TCGplayer at all does it fall back to Hekla's market price.
 */
export function tcgplayerAdjustCsv(rows: ViewRow[], fallbackPrice: Map<string, number | null>): { csv: string; included: { recordId: string; tcgplayerId: string; delta: number; priceSource: string }[]; skipped: { recordId: string; reason: string }[] } {
  const lines = [csvRow([...TCGPLAYER_HEADER])];
  const included: { recordId: string; tcgplayerId: string; delta: number; priceSource: string }[] = []; const skipped: { recordId: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.tcg) { skipped.push({ recordId: r.recordId, reason: "no TCGplayer match" }); continue; }
    if (r.tcg.source === "suggested") { skipped.push({ recordId: r.recordId, reason: "match not confirmed" }); continue; }
    if (seen.has(r.tcg.tcgplayerId)) { skipped.push({ recordId: r.recordId, reason: "duplicate SKU" }); continue; }
    const delta = r.expectedQty - r.tcg.qty;
    if (delta === 0) { skipped.push({ recordId: r.recordId, reason: "already matches" }); continue; }
    const fallback = fallbackPrice.get(r.recordId);
    const price = r.tcg.priceCents != null ? r.tcg.priceCents / 100 : fallback ?? null;
    if (price == null || !(price >= 0.01)) { skipped.push({ recordId: r.recordId, reason: "no price for the import" }); continue; }
    seen.add(r.tcg.tcgplayerId);
    included.push({ recordId: r.recordId, tcgplayerId: r.tcg.tcgplayerId, delta, priceSource: r.tcg.priceCents != null ? "your TCGplayer price" : "Hekla market price" });
    lines.push(csvRow([r.tcg.tcgplayerId, "", r.tcg.setName ?? r.set ?? "", r.tcg.productName ?? r.name, "", r.number ?? "", "", r.tcg.condition ?? "", "", "", "", "", r.tcg.qty, delta, price.toFixed(2), ""]));
  }
  return { csv: lines.join("\r\n") + "\r\n", included, skipped };
}

/**
 * The cached CardTrader listings after a Set CardTrader action. CardTrader's export can lag a write by a few
 * seconds, so the cache is patched with what was applied instead of re-exported. A listing at 0 is gone.
 */
export function applyCtChanges(listings: CtListing[], changes: { listingId: number; delta: number }[]): CtListing[] {
  const delta = new Map<number, number>();
  for (const c of changes) delta.set(c.listingId, (delta.get(c.listingId) ?? 0) + c.delta);
  return listings.map((l) => (delta.has(l.id) ? { ...l, quantity: l.quantity + delta.get(l.id)! } : l)).filter((l) => l.quantity > 0);
}

/* ---------- Reconcile All (Airtable is the source of truth; never changes Airtable) ---------- */

export const RECONCILE_BATCH = 25;
export function chunk<T>(items: T[], size = RECONCILE_BATCH): T[][] {
  if (!(size >= 1)) throw new Error("chunk size must be at least 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type CtItem = { recordId: string; name: string; before: number; target: number; changes: { listingId: number; delta: number }[]; deletes: number[] };
export type AllPlan = {
  cardtrader: CtItem[];
  cardtraderBlocked: { recordId: string; name: string; reason: string }[];
  tcgplayer: { recordIds: string[]; suggested: number; skipped: { recordId: string; reason: string }[] };
  summary: { ctRows: number; ctUp: number; ctDown: number; ctListingsChanged: number; ctDeletes: number; ctToZeroRows: number; tcgRows: number; tcgSuggested: number; tcgSkipped: number };
};

/**
 * What Reconcile All would do with these (visible) rows: CardTrader to the Airtable quantity for every CardTrader
 * mismatch, and a TCGplayer import for every open TCGplayer mismatch with a SKU or confirmed match. Unconfirmed
 * suggestions are counted, never included. `deletes` are listings that reach 0 (CardTrader deletes them).
 */
export function planReconcileAll(rows: ViewRow[], listings: CtListing[], prices: Map<string, number | null>, platforms: { cardtrader: boolean; tcgplayer: boolean }): AllPlan {
  const byId = new Map(listings.map((l) => [l.id, l]));
  const cardtrader: CtItem[] = []; const cardtraderBlocked: AllPlan["cardtraderBlocked"] = [];
  if (platforms.cardtrader) {
    for (const r of rows) {
      if (!r.ctMismatch || !r.ct) continue;
      const mine = r.ct.listingIds.map((id) => byId.get(id)).filter((l): l is CtListing => !!l);
      const plan = planCardTraderSet(mine, r.ct.storedListingId, r.expectedQty);
      if (!plan.ok) { cardtraderBlocked.push({ recordId: r.recordId, name: r.name, reason: plan.error }); continue; }
      if (!plan.changes.length) continue;
      const deletes = plan.changes.filter((c) => (byId.get(c.listingId)?.quantity ?? 0) + c.delta <= 0).map((c) => c.listingId);
      cardtrader.push({ recordId: r.recordId, name: r.name, before: plan.before, target: r.expectedQty, changes: plan.changes, deletes });
    }
  }
  let tcgRecordIds: string[] = []; let suggested = 0; let skipped: { recordId: string; reason: string }[] = [];
  if (platforms.tcgplayer) {
    const open = rows.filter(tcgOpen);
    suggested = open.filter((r) => r.tcg?.source === "suggested").length;
    const built = tcgplayerAdjustCsv(open.filter((r) => r.tcg?.source !== "suggested"), prices);
    tcgRecordIds = built.included.map((i) => i.recordId);
    skipped = built.skipped;
  }
  return {
    cardtrader, cardtraderBlocked, tcgplayer: { recordIds: tcgRecordIds, suggested, skipped },
    summary: {
      ctRows: cardtrader.length, ctUp: cardtrader.filter((i) => i.target > i.before).length, ctDown: cardtrader.filter((i) => i.target < i.before).length,
      ctListingsChanged: cardtrader.reduce((n, i) => n + i.changes.length, 0), ctDeletes: cardtrader.reduce((n, i) => n + i.deletes.length, 0),
      ctToZeroRows: cardtrader.filter((i) => i.target === 0).length, tcgRows: tcgRecordIds.length, tcgSuggested: suggested, tcgSkipped: skipped.length,
    },
  };
}

export type BatchItem = { recordId: string; expectedTarget: number; expectedCurrent: number };
export type BatchResult = { recordId: string; status: "succeeded" | "skipped" | "failed"; reason?: string; before?: number; target?: number; applied: { listingId: number; delta: number }[] };
type BatchCard = { id: string; qty: number; status: string | null; cardTraderListingId: string | null; reservedQty?: number | null; deckReservedQty?: number | null; freeQty?: number | null };

/**
 * One Reconcile All batch, sequential. Each row is re-checked against a fresh Airtable read and a fresh CardTrader
 * export; a row whose numbers moved since the plan is skipped, not changed. A failure stops that row only.
 */
export async function runCtBatch(items: BatchItem[], cards: Map<string, BatchCard>, startListings: CtListing[],
  apply: (listingId: number, delta: number) => Promise<void>, log: (item: BatchItem, result: BatchResult) => Promise<void>,
  /** Renews this row's allocation lease before each write; false stops the row. */
  renew: (recordId: string) => Promise<boolean> = async () => true): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  let listings = startListings;
  for (const item of items) {
    let result: BatchResult;
    const card = cards.get(item.recordId);
    if (!card) result = { recordId: item.recordId, status: "skipped", reason: "Waitlist row not found", applied: [] };
    else {
      const stored = Number(card.cardTraderListingId);
      const mine = listings.filter((l) => l.recordId === card.id || l.id === stored);
      const target = expectedQty(card);
      const plan = planCardTraderSet(mine, Number.isInteger(stored) ? stored : null, target);
      if (target !== item.expectedTarget) result = { recordId: item.recordId, status: "skipped", reason: `Airtable changed (now expects ${target})`, target, applied: [] };
      else if (!plan.ok) result = { recordId: item.recordId, status: "skipped", reason: plan.error, target, applied: [] };
      else if (plan.before !== item.expectedCurrent) result = { recordId: item.recordId, status: "skipped", reason: `CardTrader changed (now ${plan.before})`, before: plan.before, target, applied: [] };
      else if (!plan.changes.length) result = { recordId: item.recordId, status: "skipped", reason: "already matches", before: plan.before, target, applied: [] };
      else {
        const applied: { listingId: number; delta: number }[] = [];
        try {
          for (const ch of plan.changes) {
            if (!(await renew(item.recordId))) throw new Error("row lease lost to an allocation");
            await apply(ch.listingId, ch.delta); applied.push(ch);
          }
          result = { recordId: item.recordId, status: "succeeded", before: plan.before, target, applied };
        } catch (error) {
          result = { recordId: item.recordId, status: "failed", reason: error instanceof Error ? error.message : String(error), before: plan.before, target, applied };
        }
      }
    }
    if (result.applied.length) listings = applyCtChanges(listings, result.applied);
    await log(item, result);
    results.push(result);
  }
  return results;
}
