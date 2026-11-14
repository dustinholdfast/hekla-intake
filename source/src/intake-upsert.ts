/**
 * One stock upsert for Quick Add, bulk paste, and purchase receive.
 * A match is stockIdentityKey: game, set, collector number, finish, condition, and language.
 * Blank language is English. Normal and Regular are the same finish. A blank condition on a
 * stored row is not NM; a blank condition on a draft is NM, which is what the intake form sends.
 * On a match the existing row's Qty goes up, its holds stay (so the new copies are listable),
 * and a known incoming cost adds a lot and a weighted Cost Basis USD. A blank cost never blocks intake.
 */
import { weightedCost } from "./cleanup.ts";
import { buildStockMergeFields, setIdentityOf, type DraftCard, type FieldMap, type PrintingRef } from "./fields.ts";
import { canonicalCollector, normalizeLanguage, stockIdentityKey, type MovementDraft, type StockSnapshot } from "./inventory.ts";
import { listableQty } from "./listable.ts";
import { canonicalCondition, effectiveGame, readFinish, setName } from "./sets.ts";

export type IdentityCard = {
  game: string | null;
  setNumber?: string | null;
  setIdentifier?: string | null;
  collectorNumber: string | null;
  finish: string | null;
  condition?: string | null;
  language?: string | null;
  status?: string | null;
};

export type UpsertMatch = {
  id: string;
  qty: number;
  status: string | null;
  costBasisUsd: number | null;
  unknownCostQty?: number | null;
  reservedQty?: number | null;
  deckReservedQty?: number | null;
};

export type UpsertChoice = "ask" | "merge" | "skip" | "add";

/** Missing, blank, or unrecognized input is merge. "add" is returned only when the caller confirmed it. */
export function bulkDuplicateChoice(value: unknown, confirmOverride: boolean): { ok: true; choice: "merge" | "skip" | "add" } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, choice: "merge" };
  if (value === "merge" || value === "skip") return { ok: true, choice: value };
  if (value === "add") {
    if (!confirmOverride) return { ok: false, error: "Add anyway creates a second row for the same card. Confirm that override explicitly." };
    return { ok: true, choice: "add" };
  }
  return { ok: false, error: "Choose skip, merge, or add for duplicates." };
}

function finishPart(raw: string | null | undefined): string | null {
  const read = readFinish(raw);
  if (read) return read;
  const text = (raw ?? "").trim();
  return text || null;
}

function conditionPart(raw: string | null | undefined, blankIsNm: boolean): string | null {
  const text = (raw ?? "").trim();
  if (!text) return blankIsNm ? "NM" : null;
  return canonicalCondition(text);
}

/** Ledger key for one open row. A blank condition does not match NM. A blank language is English. */
export function intakeIdentityKey(card: IdentityCard | PrintingRef): string | null {
  return identityKey(card, false);
}

/** Key for a card being added. A blank condition is NM. A blank language is English. */
export function draftIdentityKey(card: IdentityCard | PrintingRef): string | null {
  return identityKey(card, true);
}

function identityKey(card: IdentityCard | PrintingRef, blankConditionIsNm: boolean): string | null {
  const game = effectiveGame(card.game) ?? (card.game ?? "").trim();
  if (!game) return null;
  const setIdentity = setIdentityOf({ game: effectiveGame(card.game) ?? card.game, setNumber: card.setNumber, setIdentifier: card.setIdentifier });
  const collector = (card.collectorNumber ?? "").trim();
  const finish = finishPart(card.finish);
  const condition = conditionPart(card.condition, blankConditionIsNm);
  if (!setIdentity || !collector || !finish || !condition) return null;
  const language = normalizeLanguage(card.language).language;
  return stockIdentityKey({ game, setIdentity, collectorNumber: canonicalCollector(collector), finish, condition, language });
}

export function matchesStock(card: IdentityCard, draft: PrintingRef): boolean {
  if (card.status !== "Waitlist" && card.status !== "Listed") return false;
  const left = intakeIdentityKey(card);
  const right = draftIdentityKey(draft);
  return left != null && left === right;
}

export type MergeEffect = {
  qty: number;
  fields: FieldMap;
  costBasisUsd: number | null;
  writeCost: boolean;
  unknownCostQty: number;
  writeUnknown: boolean;
  lot: { qty: number; costBasisUsd: number } | null;
  holds: { reservedQty: number; deckReservedQty: number; listableBefore: number; listableAfter: number };
};

/**
 * Weighted average of the known units, via weightedCost. Unknown units stay unknown.
 * A blank incoming cost does not change Cost Basis USD and does not create a lot.
 */
export function mergeCostUpdate(
  existing: { qty: number; costBasisUsd: number | null; unknownCostQty?: number | null },
  added: { qty: number; costBasisUsd: number | null },
): Omit<MergeEffect, "fields" | "holds"> {
  const qty = existing.qty + added.qty;
  const unknownBefore = existing.costBasisUsd == null
    ? existing.qty
    : Math.max(0, Math.min(existing.qty, existing.unknownCostQty ?? 0));
  const knownBefore = Math.max(0, existing.qty - unknownBefore);
  if (added.costBasisUsd == null) {
    return { qty, costBasisUsd: existing.costBasisUsd, writeCost: false, unknownCostQty: unknownBefore + added.qty, writeUnknown: false, lot: null };
  }
  const parts: { qty: number; costBasisUsd: number | null }[] = [];
  if (knownBefore > 0 && existing.costBasisUsd != null) parts.push({ qty: knownBefore, costBasisUsd: existing.costBasisUsd });
  parts.push({ qty: added.qty, costBasisUsd: added.costBasisUsd });
  const averaged = weightedCost(parts);
  return {
    qty,
    costBasisUsd: averaged.cost,
    writeCost: averaged.cost != null,
    unknownCostQty: unknownBefore,
    writeUnknown: unknownBefore > 0,
    lot: { qty: added.qty, costBasisUsd: added.costBasisUsd },
  };
}

export function mergeEffect(existing: UpsertMatch, addQty: number, costBasisUsd: number | null): MergeEffect {
  const cost = mergeCostUpdate(
    { qty: existing.qty, costBasisUsd: existing.costBasisUsd, unknownCostQty: existing.unknownCostQty },
    { qty: addQty, costBasisUsd },
  );
  const reservedQty = existing.reservedQty ?? 0;
  const deckReservedQty = existing.deckReservedQty ?? 0;
  return {
    ...cost,
    fields: buildStockMergeFields({
      qty: cost.qty,
      costBasisUsd: cost.writeCost ? cost.costBasisUsd : undefined,
      unknownCostQty: cost.writeUnknown ? cost.unknownCostQty : undefined,
    }),
    holds: {
      reservedQty,
      deckReservedQty,
      listableBefore: listableQty({ qty: existing.qty, reservedQty, deckReservedQty }),
      listableAfter: listableQty({ qty: cost.qty, reservedQty, deckReservedQty }),
    },
  };
}

export type IntakePlan =
  | { action: "reject"; error: string }
  | { action: "ask"; identityKey: string | null; observedDuplicate: boolean }
  | { action: "skip"; identityKey: string | null; observedDuplicate: boolean }
  | { action: "merge"; target: UpsertMatch; addQty: number; effect: MergeEffect; identityKey: string | null; observedDuplicate: boolean }
  | { action: "create"; identityKey: string | null; recordOverride: boolean; matchedIds: string[] };

export function planIntakeUpsert(input: {
  card: DraftCard;
  matches: readonly UpsertMatch[];
  choice: UpsertChoice;
  confirmOverride?: boolean;
  mergeRecordId?: string;
}): IntakePlan {
  const identityKey = draftIdentityKey(input.card);
  const observedDuplicate = input.matches.length > 1;
  const cost = input.card.costBasisUsd ?? null;
  if (input.choice === "add") {
    if (input.matches.length > 0 && input.confirmOverride !== true) {
      return { action: "reject", error: "Add anyway creates a second row for the same card. Confirm that override explicitly." };
    }
    return { action: "create", identityKey, recordOverride: input.matches.length > 0, matchedIds: input.matches.map((match) => match.id) };
  }
  if (input.matches.length === 0) return { action: "create", identityKey, recordOverride: false, matchedIds: [] };
  if (input.choice === "skip") return { action: "skip", identityKey, observedDuplicate };
  const needsPick = input.choice === "ask" || (input.matches.length > 1 && !input.mergeRecordId);
  if (needsPick) return { action: "ask", identityKey, observedDuplicate };
  const target = input.mergeRecordId ? input.matches.find((match) => match.id === input.mergeRecordId) : input.matches[0];
  if (!target) return { action: "reject", error: "That row is not a matching Waitlist or Listed card." };
  return { action: "merge", target, addQty: input.card.qty, effect: mergeEffect(target, input.card.qty, cost), identityKey, observedDuplicate };
}

export function intakeSnapshot(card: DraftCard, status: string | null, identityKey: string | null): StockSnapshot {
  const lorcana = card.game === "Lorcana";
  const setIdentity = setIdentityOf(card);
  return {
    cardName: card.cardName ?? null,
    game: card.game,
    setNumber: lorcana ? card.setNumber : null,
    setIdentifier: lorcana ? null : card.setIdentifier,
    setIdentity,
    setLabel: lorcana ? (setName(card.setNumber) ?? card.setNumber) : card.setIdentifier,
    collectorNumber: card.collectorNumber,
    finishRaw: card.finish,
    finish: readFinish(card.finish) ?? card.finish,
    rarityNote: card.finish.toLowerCase() === "enchanted" ? "Enchanted" : null,
    condition: card.condition,
    language: normalizeLanguage(undefined).language,
    status,
    marketPriceUsd: null,
    dateAcquired: null,
    firstSeen: null,
    cardTraderListingId: null,
    identityKey,
  };
}

/** The ledger row for one intake add or merge. Cost stays null when the lot has no cost. */
export function intakeMovement(input: {
  tenantId: string;
  recordId: string;
  qtyBefore: number;
  addQty: number;
  unitCostCents: number | null;
  appliedBy: string;
  now: string;
  eventId: string;
  snapshot: StockSnapshot | null;
  note: string;
}): MovementDraft {
  return {
    tenantId: input.tenantId,
    recordId: input.recordId,
    delta: input.addQty,
    qtyBefore: input.qtyBefore,
    qtyAfter: input.qtyBefore + input.addQty,
    reason: "intake",
    sourceKind: "intake",
    sourceRef: `intake:${input.eventId}`,
    appliedBy: input.appliedBy,
    unitCostCents: input.unitCostCents,
    note: input.note,
    needsReview: null,
    snapshot: input.snapshot,
    createdAt: input.now,
  };
}

export function intakeLotCents(costBasisUsd: number, qty: number): { unitCostCents: number; costTotalCents: number } {
  const unitCostCents = Math.round(costBasisUsd * 100);
  return { unitCostCents, costTotalCents: unitCostCents * qty };
}

export const INSERT_INTAKE_LOT_SQL = `insert into stock_lots (
  tenant_id, record_id, qty_in, qty_left, unit_cost_cents, cost_total_cents, acquired_at
) values ($1, $2, $3, $4, $5, $6, $7)`;

export type Sql = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

export async function insertIntakeLot(sql: Sql, lot: {
  tenantId: string;
  recordId: string;
  qty: number;
  costBasisUsd: number;
  acquiredAt: string;
}): Promise<void> {
  const cents = intakeLotCents(lot.costBasisUsd, lot.qty);
  await sql(INSERT_INTAKE_LOT_SQL, [lot.tenantId, lot.recordId, lot.qty, lot.qty, cents.unitCostCents, cents.costTotalCents, lot.acquiredAt]);
}
