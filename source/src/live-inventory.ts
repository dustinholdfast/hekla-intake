/** Current quantities come from the tenant's operational Airtable table. History is evidence,
 * not a complete stock authority until every external writer records movements. No writes here. */
import {
  buildInventory, movementsFor, planOpeningEntries, stockFlags,
  type BuyListInput, type InventoryFilter, type InventoryPayload, type InventoryRow,
  type LiabilitySummary, type MovementDraft, type Thresholds, type WaitlistInput,
} from './inventory.ts';

export type StockAccuracy = {
  status: 'matches' | 'different' | 'unrecorded' | 'missing';
  ledgerQty: number | null;
  difference: number | null;
  identityChanged: boolean;
};
export type LiveInventoryRow = InventoryRow & {
  accuracy: StockAccuracy;
  knownCostQty: number;
  unknownCostQty: number;
  airtableStatus: string | null;
};
export type LiveInventoryPayload = Omit<InventoryPayload, 'rows'> & {
  rows: LiveInventoryRow[];
  accuracy: { different: number; unrecorded: number; missing: number; historyComplete: false };
  stockReadStartedAt: string;
};
export type LiveStock = { rows: readonly WaitlistInput[]; startedAt: string; completedAt: string };

const review = (...notes: (string | null | undefined)[]) => notes.filter(Boolean).join(' ') || null;
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;

export class InventoryReadError extends Error {}

/** Blank Airtable numeric cells are omitted. Malformed quantities must not turn into zero. */
export function currentQty(row: WaitlistInput): number {
  const value = row.fields.Qty;
  if (value == null) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InventoryReadError(`Stock row ${row.id} has an invalid quantity. Current inventory totals are unavailable until it is corrected.`);
  }
  return value;
}

function liveRow(row: WaitlistInput, mapped: InventoryRow, ledger: InventoryRow | undefined, thresholds: Thresholds, now: Date): LiveInventoryRow {
  const qty = currentQty(row);
  const ledgerQty = ledger?.onHand ?? null;
  const identityChanged = ledger != null && ['game', 'setLabel', 'collectorNumber', 'finish', 'condition', 'language'].some(key =>
    mapped[key as keyof InventoryRow] !== ledger[key as keyof InventoryRow]);
  const accuracy: StockAccuracy = {
    status: ledgerQty == null ? 'unrecorded' : qty === ledgerQty && !identityChanged ? 'matches' : 'different',
    ledgerQty,
    difference: ledgerQty == null ? null : qty - ledgerQty,
    identityChanged,
  };
  // Never infer old costs from the first priced movement or from a decorative cost value.
  // The explicit unknown quantity and current cost basis are required to classify known units.
  const basis = row.fields['Cost Basis USD'];
  const unknown = row.fields['Unknown-Cost Qty'];
  const explicitCost = typeof basis === 'number' && Number.isFinite(basis) && basis >= 0
    && typeof unknown === 'number' && Number.isSafeInteger(unknown) && unknown >= 0 && unknown <= qty;
  const knownCostQty = explicitCost ? qty - unknown : 0;
  const status = text(row.fields.Status);
  const notes = review(mapped.flags.needsReview,
    accuracy.status === 'unrecorded' ? 'No recorded movement history. Quantity is from Airtable.' : null,
    accuracy.status === 'different' ? `Recorded movements total ${ledgerQty}; Airtable shows ${qty}. History is incomplete or needs review.` : null,
    identityChanged ? 'The current printing, condition, or language differs from recorded history.' : null,
    (status === 'Sold' || status === 'Skip') && qty > 0 ? `${status} row still has ${qty} units in Airtable. Check its status and quantity.` : null,
    unknown != null && !explicitCost ? 'Cost information is incomplete or inconsistent; these units are shown as cost unknown.' : null);
  const flags = stockFlags({ onHand: qty, wantQty: mapped.wantQty, thresholds,
    dateAcquired: null, firstSeen: mapped.firstSeen, lastSaleAt: null, now });
  // Unlogged sales make "no sale for N days" unknowable, even when the quantities agree.
  // Keep low/overstock rules; don't assert a slow-mover decision from incomplete history.
  return { ...mapped, onHand: qty, state: qty === 0 ? 'Sold' : 'In hand',
    unitCostCents: knownCostQty > 0 && typeof basis === 'number' ? Math.round(basis * 100) : null,
    knownCostQty, unknownCostQty: qty - knownCostQty, accuracy, airtableStatus: status,
    flags: { ...flags, slow: false, daysWithoutSale: null, needsReview: notes } };
}

export function buildLiveInventory(args: {
  tenantId: string; stock: LiveStock; movements: readonly MovementDraft[]; buyList: readonly BuyListInput[];
  thresholds: Thresholds; filter?: InventoryFilter; wantQtyState: 'matched' | 'unread'; liability?: LiabilitySummary | null;
}): LiveInventoryPayload {
  const { stock, movements, buyList, thresholds } = args;
  const now = new Date(stock.completedAt);
  // Reuse identity/finish validation and duplicate detection, without persisting synthetic openings.
  const mapped = buildInventory(planOpeningEntries(stock.rows, args.tenantId, now), buyList, thresholds, now);
  const recorded = buildInventory(movements, buyList, thresholds, now);
  const byId = new Map(recorded.rows.map(row => [row.recordId, row]));
  const rawById = new Map(stock.rows.map(row => [row.id, row]));
  if (rawById.size !== stock.rows.length) throw new InventoryReadError('The stock scan contains duplicate row IDs. Refresh inventory.');
  const all: LiveInventoryRow[] = mapped.rows.map(row => liveRow(rawById.get(row.recordId)!, row, byId.get(row.recordId), thresholds, now));
  for (const row of recorded.rows) {
    if (rawById.has(row.recordId)) continue;
    all.push({ ...row, onHand: 0, unitCostCents: null, marketPriceUsd: null, state: 'Missing',
      knownCostQty: 0, unknownCostQty: 0, airtableStatus: null,
      accuracy: { status: 'missing', ledgerQty: row.onHand, difference: null, identityChanged: false },
      flags: { ...row.flags, low: false, overstock: false, overstockBy: null, slow: false, daysWithoutSale: null,
        needsReview: 'This record is absent from the current Airtable scan. Its recorded history is retained and contributes no current stock.' } });
  }
  all.sort((a, b) => a.name.localeCompare(b.name) || a.recordId.localeCompare(b.recordId));
  const f = args.filter ?? {};
  const rows = all.filter(row => (!f.game || row.game === f.game) && (!f.condition || row.condition === f.condition)
    && (!f.finish || row.finish === f.finish || row.finishRaw === f.finish)
    && (!f.flag || (f.flag === 'review' ? Boolean(row.flags.needsReview) : row.flags[f.flag]))
    && (!f.cost || (f.cost === 'known' ? row.knownCostQty > 0 : row.unknownCostQty > 0))
    && (!f.q || [row.name, row.recordId, row.game, row.setLabel, row.collectorNumber, row.finish, row.finishRaw].join(' ').toLowerCase().includes(f.q.trim().toLowerCase())));
  return { ...mapped, rows, onHandSource: 'airtable', wantQtyState: args.wantQtyState, liability: args.liability ?? null,
    stockReadStartedAt: stock.startedAt,
    totals: { units: all.reduce((n, row) => n + row.onHand, 0), rows: stock.rows.length,
      knownCostUnits: all.reduce((n, row) => n + row.knownCostQty, 0), unknownCostUnits: all.reduce((n, row) => n + row.unknownCostQty, 0),
      flags: all.filter(row => row.flags.low || row.flags.overstock || row.flags.needsReview).length,
      low: all.filter(row => row.flags.low).length, overstock: all.filter(row => row.flags.overstock).length,
      slow: 0, needsReview: all.filter(row => row.flags.needsReview).length },
    accuracy: { different: all.filter(row => row.accuracy.status === 'different').length,
      unrecorded: all.filter(row => row.accuracy.status === 'unrecorded').length,
      missing: all.filter(row => row.accuracy.status === 'missing').length, historyComplete: false } };
}

export function buildLiveDetail(payload: LiveInventoryPayload, movements: readonly MovementDraft[], recordId: string) {
  const row = payload.rows.find(row => row.recordId === recordId);
  if (!row) return null;
  return { row, onHandSource: payload.onHandSource, generatedAt: payload.generatedAt, historyComplete: false,
    movements: movementsFor(movements, recordId).map(({ snapshot: _snapshot, tenantId: _tenant, recordId: _id, ...movement }) => movement) };
}
