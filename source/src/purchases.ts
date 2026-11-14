/**
 * Buy-list purchases. Accepting saves a draft and changes no stock and no Want Qty.
 * Receive & confirm is the only step that adds a movement, a lot, a credit issue, and the Airtable writes.
 * A customer is a Sell Request record id. Names, emails, and phones are not stored.
 */
import { buildCreateFields, setIdentityOf, type DraftCard } from "./fields.ts";
import { draftIdentityKey, mergeCostUpdate } from "./intake-upsert.ts";
import {
  buyListSetIdentity,
  canonicalCollector,
  canonicalStockFinish,
  normalizeLanguage,
  stockIdentityKey,
  wantDecrementAllowed,
  type BuyListInput,
  type MovementDraft,
  type StockSnapshot,
  type WaitlistInput,
} from "./inventory.ts";
import { buyPercent, creditCostCents, type InventorySettings } from "./inventory-settings.ts";
import { parseBulk } from "./parse.ts";
import { allocate } from "./sales.ts";
import { airtableWriteTypecast, canonicalMagicFinish } from "./magic-finish.ts";
import { canonicalFinish, effectiveGame, SETS, setName, type Condition, type Game, type SetNumber } from "./sets.ts";

export const SELL_REQUEST_TABLE_ID = "tbltX89tiY4H2cvuu";
export const SELL_REQUEST_BASE_ID = "app4Tjz72sZtVMQyp";
export const RECORD_ID = /^rec[A-Za-z0-9]{14}$/;
export const CREDIT_COST_RULE_TEXT = "credit rule v1";
export const CASH_COST_RULE_TEXT = "cash paid";

const CONDITION_RANK: Record<string, number> = { NM: 0, LP: 1, MP: 2, HP: 3, DMG: 4 };
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(?:\+?\d{1,2}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}/;
const CONTACT_KEY = /email|e-mail|phone|mobile|address|paypal|venmo|cashapp|cash app|seller|buyer|contact/i;

export class PurchaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseError";
  }
}

export type PayoutKind = "cash" | "store_credit";

/** PayPal, Venmo, and Check are cash. Store credit is the exact payout value "Store Credit". */
export function payoutKind(payout: string): { ok: true; kind: PayoutKind } | { ok: false; error: string } {
  const value = payout.trim();
  if (value === "PayPal" || value === "Venmo" || value === "Check") return { ok: true, kind: "cash" };
  if (value === "Store Credit") return { ok: true, kind: "store_credit" };
  return { ok: false, error: `Payout “${value}” is not PayPal, Venmo, Check, or Store Credit.` };
}

export function isWorseCondition(offered: string, received: string): boolean {
  const left = CONDITION_RANK[offered];
  const right = CONDITION_RANK[received];
  if (left == null || right == null) return false;
  return right > left;
}

export function movementSourceRef(ref: string, sellRequestId: string, lineNo: number): string {
  return `${ref}:${sellRequestId}:${lineNo}`;
}

export function purchaseLineKey(sellRequestId: string, lineNo: number): string {
  return `${sellRequestId}:${lineNo}`;
}

/** Blank Want Qty is left alone. Otherwise the new want is never below 0, and 0 fills an Active row. */
export function planWant(input: {
  kind: string | null;
  wantQty: number | null;
  status: string | null;
  qty: number;
}): { write: boolean; wantAfter: number | null; statusAfter: "Filled" | null; overstockQty: number } {
  if (!wantDecrementAllowed(input.kind)) return { write: false, wantAfter: null, statusAfter: null, overstockQty: 0 };
  if (input.wantQty == null) return { write: false, wantAfter: null, statusAfter: null, overstockQty: 0 };
  const wantAfter = Math.max(0, input.wantQty - input.qty);
  const overstockQty = Math.max(0, input.qty - input.wantQty);
  const statusAfter = wantAfter === 0 && (input.status ?? "").trim().toLowerCase() === "active" ? "Filled" as const : null;
  return { write: true, wantAfter, statusAfter, overstockQty };
}

/**
 * Known-cost units keep a weighted average. Units that were unknown stay unknown.
 * A blank cost basis means every unit already on hand is unknown, even if a decorative number sits on the row.
 */
export function nextKnownCost(input: {
  onHand: number;
  unknownCostQty: number | null;
  costBasisCents: number | null;
  addQty: number;
  addCostTotalCents: number | null;
}): { unknownCostQty: number; costBasisCents: number | null; costBasisUsd: number | null } {
  const unknownBefore = input.costBasisCents == null ? input.onHand : Math.max(0, input.unknownCostQty ?? 0);
  const knownBefore = Math.max(0, input.onHand - unknownBefore);
  if (input.addCostTotalCents == null) {
    return { unknownCostQty: unknownBefore + input.addQty, costBasisCents: input.costBasisCents, costBasisUsd: input.costBasisCents == null ? null : input.costBasisCents / 100 };
  }
  const knownTotal = knownBefore * (input.costBasisCents ?? 0) + input.addCostTotalCents;
  const knownAfter = knownBefore + input.addQty;
  const costBasisCents = knownAfter === 0 ? null : Math.round(knownTotal / knownAfter);
  return { unknownCostQty: unknownBefore, costBasisCents, costBasisUsd: costBasisCents == null ? null : costBasisCents / 100 };
}

/** Crash retry for a Qty patch. Same before/target idea as the sales lease. */
export function qtyPatchDecision(current: number, before: number, after: number): "apply" | "done" | "flag" {
  if (current === after) return "done";
  if (current === before) return "apply";
  return "flag";
}

export type SellRequestView = {
  id: string;
  ref: string;
  status: string;
  payout: string;
  offerCents: number;
  game: string | null;
  cardsText: string;
};

const REF_FIELDS = ["Ref", "Reference", "SR", "Sell Request"];
const CARD_FIELDS = ["Cards", "Card List", "Cards Text"];

function dollarsToCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstText(fields: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = text(fields[name]);
    if (value) return value;
  }
  return null;
}

/** Copies only the sell-request fields the purchase flow needs. Contact fields are dropped. */
export function readSellRequest(record: { id: string; fields?: Record<string, unknown> }): { ok: true; request: SellRequestView } | { ok: false; error: string } {
  if (!RECORD_ID.test(record.id)) return { ok: false, error: "That sell request id is not an Airtable record id." };
  const fields = record.fields ?? {};
  for (const key of Object.keys(fields)) {
    if (CONTACT_KEY.test(key)) continue;
  }
  const name = text(fields.Name);
  const ref = firstText(fields, REF_FIELDS) ?? (name && /^SR-[A-Za-z0-9-]+$/.test(name) ? name : null);
  const cardsText = firstText(fields, CARD_FIELDS) ?? "";
  const status = text(fields.Status);
  const payout = text(fields.Payout);
  const offer = dollarsToCents(fields["Offer USD"] ?? fields.Offer);
  const game = text(fields.Game);
  if (!ref) return { ok: false, error: "The sell request has no SR ref." };
  if (!status) return { ok: false, error: "The sell request has no status." };
  if (!payout) return { ok: false, error: "The sell request has no payout." };
  if (offer == null) return { ok: false, error: "The sell request has no offer." };
  if (EMAIL.test(cardsText) || PHONE.test(cardsText)) return { ok: false, error: "The card list looks like contact details. It was not opened." };
  const request: SellRequestView = { id: record.id, ref, status, payout, offerCents: offer, game, cardsText };
  const packed = JSON.stringify(request);
  for (const key of Object.keys(fields)) {
    if (!CONTACT_KEY.test(key)) continue;
    const dropped = text(fields[key]);
    if (dropped && packed.includes(dropped)) return { ok: false, error: "Contact details were not copied off the sell request." };
  }
  return { ok: true, request };
}

export type CatalogLine = {
  lineNo: number;
  raw: string;
  item: string;
  game: string | null;
  setName: string | null;
  setIdentity: string | null;
  collectorNumber: string | null;
  finish: string | null;
  finishStored: string | null;
  language: string;
  condition: string | null;
  qty: number;
  parseError: string | null;
  buyListId: string | null;
  buyListLabel: string | null;
  wantQty: number | null;
  buyListStatus: string | null;
  buyListKind: string | null;
  marketRefCents: number | null;
  marketRefSource: string | null;
  stockRecordId: string | null;
  onHand: number | null;
  unknownCostQty: number | null;
  costBasisCents: number | null;
  stockStatus: string | null;
  review: string | null;
};

function lineFromCard(lineNo: number, raw: string, card: DraftCard): CatalogLine {
  const finish = canonicalStockFinish(card.finish);
  const language = normalizeLanguage(null);
  const setIdentity = setIdentityOf(card);
  return {
    lineNo,
    raw,
    item: card.cardName?.trim() || raw,
    game: card.game,
    setName: card.game === "Lorcana" ? setName(card.setNumber) : card.setIdentifier,
    setIdentity,
    collectorNumber: card.collectorNumber,
    finish: finish.finish,
    finishStored: card.game === "Magic: The Gathering" ? canonicalMagicFinish(card.finish) : canonicalFinish(card.finish),
    language: language.language,
    condition: card.condition,
    qty: card.qty,
    parseError: null,
    buyListId: null,
    buyListLabel: null,
    wantQty: null,
    buyListStatus: null,
    buyListKind: null,
    marketRefCents: null,
    marketRefSource: null,
    stockRecordId: null,
    onHand: null,
    unknownCostQty: null,
    costBasisCents: null,
    stockStatus: null,
    review: finish.review,
  };
}

export function splitCardList(text: string, game: Game = "Lorcana"): CatalogLine[] {
  const parsed = parseBulk(text, game);
  if (parsed.length === 0) return [];
  return parsed.map((row) => {
    if (!row.card || row.error) {
      return {
        lineNo: row.line,
        raw: row.raw,
        item: row.raw,
        game: null,
        setName: null,
        setIdentity: null,
        collectorNumber: null,
        finish: null,
        finishStored: null,
        language: "English",
        condition: null,
        qty: 0,
        parseError: row.error ?? "This line could not be read.",
        buyListId: null,
        buyListLabel: null,
        wantQty: null,
        buyListStatus: null,
        buyListKind: null,
        marketRefCents: null,
        marketRefSource: null,
        stockRecordId: null,
        onHand: null,
        unknownCostQty: null,
        costBasisCents: null,
        stockStatus: null,
        review: row.error ?? null,
      };
    }
    return lineFromCard(row.line, row.raw, row.card);
  });
}

function samePrinting(line: CatalogLine, game: string | null, setIdentity: string | null, collector: string | null, finish: string | null, anyFinish: boolean): boolean {
  if (!line.game || !line.setIdentity || !line.collectorNumber || !line.finish) return false;
  if ((game ?? "") !== line.game) return false;
  if (setIdentity == null || setIdentity !== line.setIdentity) return false;
  if (!collector || canonicalCollector(collector) !== canonicalCollector(line.collectorNumber)) return false;
  if (anyFinish) return true;
  return finish === line.finish;
}

function stockCost(fields: Record<string, unknown>, onHand: number, ledgerKnown: boolean): { unknownCostQty: number | null; costBasisCents: number | null } {
  if (!ledgerKnown) return { unknownCostQty: onHand, costBasisCents: null };
  const basis = dollarsToCents(fields["Cost Basis USD"]);
  const unknown = fields["Unknown-Cost Qty"];
  if (basis == null) return { unknownCostQty: onHand, costBasisCents: null };
  if (typeof unknown === "number" && Number.isFinite(unknown)) return { unknownCostQty: Math.max(0, Math.round(unknown)), costBasisCents: basis };
  return { unknownCostQty: 0, costBasisCents: basis };
}

/** Match each parsed line to the Buy List and to one stock row. A missing market ref stays null. */
export function matchLines(
  lines: readonly CatalogLine[],
  buyList: readonly BuyListInput[],
  stock: readonly WaitlistInput[],
  onHandByRecord: ReadonlyMap<string, number>,
  ledgerKnown: ReadonlySet<string> = new Set(),
): CatalogLine[] {
  return lines.map((line) => {
    const next: CatalogLine = { ...line };
    if (line.parseError || !line.finish) return next;
    const buyHits: BuyListInput[] = [];
    for (const row of buyList) {
      if (!wantDecrementAllowed(text(row.fields.Kind))) continue;
      const finishRaw = text(row.fields.Finish);
      const anyFinish = (finishRaw ?? "").toLowerCase() === "any";
      const mapped = canonicalStockFinish(finishRaw);
      if (!anyFinish && mapped.finish == null) continue;
      const game = effectiveGame(text(row.fields.Game) ?? undefined) ?? text(row.fields.Game);
      const setIdentity = buyListSetIdentity(game, text(row.fields.Set));
      if (!samePrinting(next, game, setIdentity, text(row.fields["Collector #"]), mapped.finish, anyFinish)) continue;
      buyHits.push(row);
    }
    if (buyHits.length > 1) next.review = "More than one buy-list row matches. The row was not guessed.";
    if (buyHits.length === 1) {
      const row = buyHits[0]!;
      next.buyListId = row.id;
      next.buyListLabel = text(row.fields.Item);
      next.buyListKind = text(row.fields.Kind);
      next.buyListStatus = text(row.fields.Status);
      const want = row.fields["Want Qty"];
      next.wantQty = typeof want === "number" && Number.isFinite(want) ? want : null;
      const market = dollarsToCents(row.fields["Market Ref USD"]);
      if (market != null) {
        next.marketRefCents = market;
        next.marketRefSource = "Buy List Market Ref USD";
      }
    }
    const stockHits: WaitlistInput[] = [];
    for (const row of stock) {
      const fields = row.fields ?? {};
      const game = effectiveGame(text(fields.Game) ?? undefined) ?? text(fields.Game);
      const setIdentity = fields["Set #"] || fields["Set Identifier"]
        ? setIdentityOf({
          game: game ?? "Lorcana",
          setNumber: text(fields["Set #"]),
          setIdentifier: text(fields["Set Identifier"]),
        })
        : null;
      const finish = canonicalStockFinish(text(fields.Finish));
      const condition = text(fields.Condition);
      const language = normalizeLanguage(text(fields.Language)).language;
      if (!samePrinting(next, game, setIdentity, text(fields["Collector Number"]), finish.finish, false)) continue;
      if (condition !== next.condition) continue;
      if (language.toLowerCase() !== next.language.toLowerCase()) continue;
      stockHits.push(row);
    }
    if (stockHits.length > 1) next.review = "More than one stock row matches. The row was not guessed.";
    if (stockHits.length === 1) {
      const row = stockHits[0]!;
      const onHand = onHandByRecord.get(row.id) ?? (typeof row.fields.Qty === "number" ? row.fields.Qty : 0);
      const cost = stockCost(row.fields, onHand, ledgerKnown.has(row.id));
      next.stockRecordId = row.id;
      next.onHand = onHand;
      next.unknownCostQty = cost.unknownCostQty;
      next.costBasisCents = cost.costBasisCents;
      next.stockStatus = text(row.fields.Status);
      if (next.marketRefCents == null) {
        const market = dollarsToCents(row.fields["Market Price USD"]);
        if (market != null) {
          next.marketRefCents = market;
          next.marketRefSource = "Market Price USD";
        }
      }
    }
    return next;
  });
}

export type PurchaseLine = {
  lineNo: number;
  raw: string;
  item: string;
  game: string | null;
  setName: string | null;
  setIdentity: string | null;
  collectorNumber: string | null;
  finish: string | null;
  finishStored: string | null;
  language: string;
  condition: string;
  qty: number;
  marketRefCents: number;
  marketRefSource: string;
  ratePercent: number;
  offerCents: number;
  cashCents: number;
  creditCents: number;
  costTotalCents: number;
  unitCostCents: number;
  costRule: string;
  buyListId: string | null;
  buyListLabel: string | null;
  wantQty: number | null;
  buyListStatus: string | null;
  buyListKind: string | null;
  stockRecordId: string | null;
  onHand: number | null;
  unknownCostQty: number | null;
  costBasisCents: number | null;
  stockStatus: string | null;
  status: "accepted" | "received" | "rejected";
  receivedCondition: string | null;
  wantAfter: number | null;
  wantWrite: boolean;
  wantStatusAfter: "Filled" | null;
  overstockQty: number | null;
  movementSourceRef: string | null;
  review: string | null;
};

export type PurchaseDraft = {
  id: string;
  tenantId: string;
  sellRequestId: string;
  sellRequestRef: string;
  payout: string;
  paymentType: PayoutKind;
  offerCents: number;
  status: "accepted" | "received" | "partial" | "cancelled";
  lines: PurchaseLine[];
};

function applyOverride(line: CatalogLine, overrides: readonly { lineNo: number; marketRefCents: number }[]): CatalogLine {
  if (line.marketRefCents != null) return line;
  const hit = overrides.find((row) => row.lineNo === line.lineNo);
  if (!hit) return line;
  if (!Number.isInteger(hit.marketRefCents) || hit.marketRefCents < 0) return line;
  return { ...line, marketRefCents: hit.marketRefCents, marketRefSource: "entered" };
}

/** Split the accepted offer in exact cents. A missing market ref, a blocked grade, or a bad payout stops the save. */
export function planAcceptance(input: {
  tenantId: string;
  request: SellRequestView;
  lines: readonly CatalogLine[];
  settings: InventorySettings;
  overrides?: readonly { lineNo: number; marketRefCents: number }[];
}): { ok: true; purchase: PurchaseDraft } | { ok: false; error: string } {
  if (!input.tenantId.trim()) return { ok: false, error: "A purchase needs a tenant." };
  if (input.request.status !== "Accepted") return { ok: false, error: "Only an accepted sell request can be saved." };
  const payout = payoutKind(input.request.payout);
  if (!payout.ok) return { ok: false, error: payout.error };
  if (!Number.isInteger(input.request.offerCents) || input.request.offerCents < 0) return { ok: false, error: "The offer must be whole cents." };
  if (input.lines.length === 0) return { ok: false, error: "The sell request has no card lines." };
  const tender = payout.kind === "cash" ? "cash" : "credit";
  const prepared = input.lines.map((line) => applyOverride(line, input.overrides ?? []));
  for (const line of prepared) {
    if (line.parseError) return { ok: false, error: `Line ${line.lineNo}: ${line.parseError}` };
    if (!line.condition) return { ok: false, error: `Line ${line.lineNo} needs a condition.` };
    const rate = buyPercent(input.settings, line.condition, tender);
    if (!rate.ok) return { ok: false, error: rate.error };
    if (line.marketRefCents == null) return { ok: false, error: `Line ${line.lineNo} has no market ref, so the offer cannot be split.` };
    if (line.review && /not guessed/i.test(line.review)) return { ok: false, error: `Line ${line.lineNo}: ${line.review}` };
    if (!Number.isInteger(line.qty) || line.qty < 1) return { ok: false, error: `Line ${line.lineNo} needs a quantity.` };
  }
  const weights = prepared.map((line) => (line.marketRefCents ?? 0) * line.qty);
  if (weights.reduce((sum, weight) => sum + weight, 0) <= 0) return { ok: false, error: "The market refs are zero, so the offer cannot be split." };
  const shares = allocate(input.request.offerCents, weights);
  if (shares.some((share) => share == null)) return { ok: false, error: "The offer could not be split." };
  const lines: PurchaseLine[] = prepared.map((line, index) => {
    const offerCents = shares[index] ?? 0;
    const rate = buyPercent(input.settings, line.condition ?? "", tender);
    const percent = rate.ok ? rate.percent : 0;
    const cashCents = payout.kind === "cash" ? offerCents : 0;
    const creditCents = payout.kind === "store_credit" ? offerCents : 0;
    const costTotalCents = payout.kind === "store_credit" ? creditCostCents(creditCents) : cashCents;
    return {
      lineNo: line.lineNo,
      raw: line.raw,
      item: line.item,
      game: line.game,
      setName: line.setName,
      setIdentity: line.setIdentity,
      collectorNumber: line.collectorNumber,
      finish: line.finish,
      finishStored: line.finishStored,
      language: line.language,
      condition: line.condition ?? "",
      qty: line.qty,
      marketRefCents: line.marketRefCents ?? 0,
      marketRefSource: line.marketRefSource ?? "entered",
      ratePercent: percent,
      offerCents,
      cashCents,
      creditCents,
      costTotalCents,
      unitCostCents: Math.round(costTotalCents / line.qty),
      costRule: payout.kind === "store_credit" ? CREDIT_COST_RULE_TEXT : CASH_COST_RULE_TEXT,
      buyListId: line.buyListId,
      buyListLabel: line.buyListLabel,
      wantQty: line.wantQty,
      buyListStatus: line.buyListStatus,
      buyListKind: line.buyListKind,
      stockRecordId: line.stockRecordId,
      onHand: line.onHand,
      unknownCostQty: line.unknownCostQty,
      costBasisCents: line.costBasisCents,
      stockStatus: line.stockStatus,
      status: "accepted",
      receivedCondition: null,
      wantAfter: null,
      wantWrite: false,
      wantStatusAfter: null,
      overstockQty: null,
      movementSourceRef: null,
      review: line.review,
    };
  });
  const sum = lines.reduce((total, line) => total + line.offerCents, 0);
  if (sum !== input.request.offerCents) return { ok: false, error: "The line shares do not add up to the offer." };
  return {
    ok: true,
    purchase: {
      id: `purchase:${input.request.id}`,
      tenantId: input.tenantId,
      sellRequestId: input.request.id,
      sellRequestRef: input.request.ref,
      payout: input.request.payout.trim(),
      paymentType: payout.kind,
      offerCents: input.request.offerCents,
      status: "accepted",
      lines,
    },
  };
}

export type LotDraft = {
  id: string;
  tenantId: string;
  recordId: string;
  qtyIn: number;
  qtyLeft: number;
  unitCostCents: number;
  costTotalCents: number;
  acquiredAt: string;
  purchaseLineKey: string;
};

export type CreditEntry = {
  id: string;
  tenantId: string;
  customerRef: string;
  amountCents: number;
  entryKind: "issue" | "redemption";
  sourceKind: string;
  sourceRef: string;
  occurredOn: string;
  balanceAfterCents: number;
  createdAt: string;
};

export type ReceiveWrite =
  | { kind: "patch_qty"; recordId: string; before: number; after: number; fields: Record<string, string | number> }
  | { kind: "create_stock"; lineKey: string; note: string; fields: Record<string, string | number> }
  | { kind: "patch_want"; recordId: string; fields: Record<string, string | number> }
  | { kind: "create_purchase"; lineKey: string; fields: Record<string, unknown> };

export type ReceiptPlan = {
  purchase: PurchaseDraft;
  movements: MovementDraft[];
  lots: LotDraft[];
  credits: CreditEntry[];
  writes: ReceiveWrite[];
};

function assertNoCustomerContact(fields: Record<string, unknown>, where: string): void {
  for (const [key, value] of Object.entries(fields)) {
    if (CONTACT_KEY.test(key)) throw new PurchaseError(`${where} cannot store ${key}.`);
    if (typeof value === "string" && (EMAIL.test(value) || PHONE.test(value))) throw new PurchaseError(`${where} cannot store contact details.`);
  }
}

function purchaseAirtableFields(purchase: PurchaseDraft, line: PurchaseLine, receivedOn: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    "Hekla Purchase Line ID": purchaseLineKey(purchase.sellRequestId, line.lineNo),
    Item: line.item,
    Language: line.language,
    Condition: line.receivedCondition ?? line.condition,
    Qty: line.qty,
    "Payment Type": purchase.paymentType === "cash" ? "Cash" : "Store credit",
    "Market Ref USD at offer": line.marketRefCents / 100,
    "Condition Multiplier used": line.ratePercent,
    "Offer Amount USD": line.offerCents / 100,
    "Cash Paid USD": line.cashCents / 100,
    "Store Credit Issued USD": line.creditCents / 100,
    "Cost Basis USD": line.unitCostCents / 100,
    "Cost Rule": line.costRule,
    "Date Received": receivedOn,
    "Condition Confirmed": true,
    "Over Want Qty": line.overstockQty ?? 0,
    Status: line.status === "received" ? "Received" : "Rejected",
    "Sell Request": [purchase.sellRequestId],
  };
  if (line.game) fields.Game = line.game;
  if (line.setName) fields.Set = line.setName;
  if (line.collectorNumber) fields["Collector #"] = line.collectorNumber;
  if (line.finish) fields.Finish = line.finish;
  if (line.buyListId) fields["Buy List row"] = [line.buyListId];
  if (line.status === "received" && line.stockRecordId) fields["Stock row"] = [line.stockRecordId];
  assertNoCustomerContact(fields, "Purchases");
  return fields;
}

function draftForLine(line: PurchaseLine): DraftCard {
  if (!line.game || !line.collectorNumber || !line.finishStored || !line.setIdentity) throw new PurchaseError(`Line ${line.lineNo} cannot create a stock row.`);
  const condition: Condition = line.receivedCondition === "NM" || line.receivedCondition === "LP" || line.receivedCondition === "MP" || line.receivedCondition === "HP" || line.receivedCondition === "DMG"
    ? line.receivedCondition
    : "NM";
  const finish = line.game === "Magic: The Gathering" ? canonicalMagicFinish(line.finishStored ?? "") : canonicalFinish(line.finishStored ?? "");
  if (!finish) throw new PurchaseError(`Line ${line.lineNo} has no Airtable finish.`);
  const shared = { collectorNumber: line.collectorNumber, finish, condition, qty: line.qty, cardName: line.item, costBasisUsd: line.unitCostCents / 100 };
  if (line.game === "Lorcana") {
    const setNumber = SETS.find((set) => set.id === line.setIdentity)?.id;
    if (!setNumber) throw new PurchaseError(`Line ${line.lineNo} has no Lorcana set.`);
    return { game: "Lorcana", setNumber: setNumber as SetNumber, ...shared };
  }
  return { game: line.game as Exclude<Game, "Lorcana">, setIdentifier: line.setIdentity, ...shared };
}

function stockCreateFields(line: PurchaseLine, receivedOn: string, lineKey: string): Record<string, string | number> {
  const fields = buildCreateFields(draftForLine(line));
  fields.Language = line.language || "English";
  fields["Date Acquired"] = receivedOn;
  fields["Unknown-Cost Qty"] = 0;
  fields.Notes = `Hekla purchase ${lineKey}`;
  return fields;
}

function snapshotFor(line: PurchaseLine, condition: string): StockSnapshot {
  const lorcana = line.game === "Lorcana" || !line.game;
  const identity = line.game && line.setIdentity && line.collectorNumber && line.finish
    ? stockIdentityKey({ game: line.game, setIdentity: line.setIdentity, collectorNumber: line.collectorNumber, finish: line.finish, condition, language: line.language })
    : null;
  return {
    cardName: line.item,
    game: line.game,
    setNumber: lorcana ? line.setIdentity : null,
    setIdentifier: lorcana ? null : line.setIdentity,
    setIdentity: line.setIdentity ?? "",
    setLabel: line.setName,
    collectorNumber: line.collectorNumber,
    finishRaw: line.finishStored,
    finish: line.finish,
    rarityNote: line.finishStored === "Enchanted" ? "Enchanted" : null,
    condition,
    language: line.language,
    status: "Waitlist",
    marketPriceUsd: line.marketRefCents / 100,
    dateAcquired: null,
    firstSeen: null,
    cardTraderListingId: null,
    identityKey: identity,
  };
}

export type IdentityStockRow = {
  identityKey: string;
  id: string;
  qty: number;
  costBasisUsd: number | null;
  unknownCostQty: number | null;
  status: string | null;
};

export function planReceipt(input: {
  purchase: PurchaseDraft;
  receivedOn: string;
  now: string;
  confirms: readonly { lineNo: number; condition: string }[];
  balanceCents: number;
  mintRecordId: (lineNo: number) => string;
  /** Open rows keyed like intake. One match is merged. Several matches stop the receive before any write. */
  identityStock?: readonly IdentityStockRow[];
}): { ok: true; plan: ReceiptPlan } | { ok: false; error: string; duplicate?: { identityKey: string; recordIds: string[] } } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.receivedOn)) return { ok: false, error: "Date received must be YYYY-MM-DD." };
  const purchase: PurchaseDraft = { ...input.purchase, lines: input.purchase.lines.map((line) => ({ ...line })) };
  const movements: MovementDraft[] = [];
  const lots: LotDraft[] = [];
  const credits: CreditEntry[] = [];
  const writes: ReceiveWrite[] = [];
  let balance = input.balanceCents;
  for (const line of purchase.lines) {
    if (line.status === "received" || line.status === "rejected") continue;
    const confirm = input.confirms.find((row) => row.lineNo === line.lineNo);
    const received = confirm?.condition ?? line.condition;
    if (!(received in CONDITION_RANK)) return { ok: false, error: `Line ${line.lineNo} needs a condition of NM, LP, MP, HP, or DMG.` };
    line.receivedCondition = received;
    if (isWorseCondition(line.condition, received)) {
      line.status = "rejected";
      line.wantWrite = false;
      line.wantAfter = null;
      line.overstockQty = 0;
      line.movementSourceRef = null;
      writes.push({ kind: "create_purchase", lineKey: purchaseLineKey(purchase.sellRequestId, line.lineNo), fields: purchaseAirtableFields(purchase, line, input.receivedOn) });
      continue;
    }
    if (received !== line.condition) {
      line.stockRecordId = null;
      line.onHand = null;
      line.unknownCostQty = null;
      line.costBasisCents = null;
      line.stockStatus = null;
    }
    if (!line.stockRecordId && input.identityStock) {
      const identityKey = draftIdentityKey({
        game: line.game,
        setNumber: line.game === "Lorcana" ? line.setIdentity : null,
        setIdentifier: line.game === "Lorcana" ? null : line.setIdentity,
        collectorNumber: line.collectorNumber ?? "",
        finish: line.finishStored ?? line.finish ?? "",
        condition: received,
        language: line.language,
      });
      const hits = identityKey
        ? input.identityStock.filter((row) => row.identityKey === identityKey && (row.status === "Waitlist" || row.status === "Listed"))
        : [];
      if (hits.length > 1) {
        return {
          ok: false,
          error: `Line ${line.lineNo} matches ${hits.length} stock rows (${hits.map((hit) => hit.id).join(", ")}). Nothing was received.`,
          duplicate: { identityKey: identityKey ?? "", recordIds: hits.map((hit) => hit.id) },
        };
      }
      const hit = hits[0];
      if (hit) {
        line.stockRecordId = hit.id;
        line.onHand = hit.qty;
        line.unknownCostQty = hit.unknownCostQty;
        line.costBasisCents = hit.costBasisUsd == null ? null : Math.round(hit.costBasisUsd * 100);
        line.stockStatus = hit.status;
      }
    }
    const creating = !line.stockRecordId;
    const recordId = line.stockRecordId ?? input.mintRecordId(line.lineNo);
    if (!RECORD_ID.test(recordId)) return { ok: false, error: "A new stock row needs an Airtable record id." };
    const before = creating ? 0 : (line.onHand ?? 0);
    const after = before + line.qty;
    const sourceRef = movementSourceRef(purchase.sellRequestRef, purchase.sellRequestId, line.lineNo);
    const want = planWant({ kind: line.buyListKind, wantQty: line.wantQty, status: line.buyListStatus, qty: line.qty });
    line.stockRecordId = recordId;
    line.status = "received";
    line.wantWrite = want.write;
    line.wantAfter = want.wantAfter;
    line.wantStatusAfter = want.statusAfter;
    line.overstockQty = want.overstockQty;
    line.movementSourceRef = sourceRef;
    const known = nextKnownCost({
      onHand: before,
      unknownCostQty: line.unknownCostQty,
      costBasisCents: before === 0 ? null : line.costBasisCents,
      addQty: line.qty,
      addCostTotalCents: line.costTotalCents,
    });
    const averaged = !creating && line.costBasisCents != null
      ? mergeCostUpdate(
        { qty: before, costBasisUsd: line.costBasisCents / 100, unknownCostQty: line.unknownCostQty },
        { qty: line.qty, costBasisUsd: line.unitCostCents / 100 },
      )
      : null;
    const cost = averaged?.writeCost && averaged.costBasisUsd != null
      ? { ...known, costBasisUsd: averaged.costBasisUsd, unknownCostQty: averaged.unknownCostQty }
      : known;
    if (creating) {
      const note = `Hekla purchase ${purchaseLineKey(purchase.sellRequestId, line.lineNo)}`;
      writes.push({ kind: "create_stock", lineKey: purchaseLineKey(purchase.sellRequestId, line.lineNo), note, fields: stockCreateFields(line, input.receivedOn, purchaseLineKey(purchase.sellRequestId, line.lineNo)) });
    } else {
      const fields: Record<string, string | number> = {
        Qty: after,
        "Unknown-Cost Qty": cost.unknownCostQty,
      };
      if (cost.costBasisUsd != null) fields["Cost Basis USD"] = cost.costBasisUsd;
      if ((line.stockStatus ?? "").toLowerCase() === "sold" && after > 0) fields.Status = "Listed";
      writes.push({ kind: "patch_qty", recordId, before, after, fields });
    }
    if (want.write && line.buyListId && want.wantAfter != null) {
      const fields: Record<string, string | number> = { "Want Qty": want.wantAfter };
      if (want.statusAfter) fields.Status = want.statusAfter;
      writes.push({ kind: "patch_want", recordId: line.buyListId, fields });
    }
    writes.push({ kind: "create_purchase", lineKey: purchaseLineKey(purchase.sellRequestId, line.lineNo), fields: purchaseAirtableFields(purchase, line, input.receivedOn) });
    movements.push({
      tenantId: purchase.tenantId,
      recordId,
      delta: line.qty,
      qtyBefore: before,
      qtyAfter: after,
      reason: "buylist_purchase",
      sourceKind: "sell_request",
      sourceRef,
      appliedBy: "hekla",
      unitCostCents: line.unitCostCents,
      note: `${purchase.sellRequestRef} line ${line.lineNo}. ${line.costRule}.`,
      needsReview: line.overstockQty ? `${line.overstockQty} over Want Qty.` : null,
      snapshot: snapshotFor(line, received),
      createdAt: input.now,
    });
    lots.push({
      id: `lot:${sourceRef}`,
      tenantId: purchase.tenantId,
      recordId,
      qtyIn: line.qty,
      qtyLeft: line.qty,
      unitCostCents: line.unitCostCents,
      costTotalCents: line.costTotalCents,
      acquiredAt: `${input.receivedOn}T12:00:00.000Z`,
      purchaseLineKey: purchaseLineKey(purchase.sellRequestId, line.lineNo),
    });
    if (purchase.paymentType === "store_credit" && line.creditCents > 0) {
      balance += line.creditCents;
      credits.push({
        id: `credit:${purchase.sellRequestId}:${line.lineNo}`,
        tenantId: purchase.tenantId,
        customerRef: purchase.sellRequestId,
        amountCents: line.creditCents,
        entryKind: "issue",
        sourceKind: "sell_request",
        sourceRef: purchaseLineKey(purchase.sellRequestId, line.lineNo),
        occurredOn: input.receivedOn,
        balanceAfterCents: balance,
        createdAt: input.now,
      });
    }
  }
  const open = purchase.lines.some((line) => line.status === "accepted");
  const received = purchase.lines.some((line) => line.status === "received");
  const rejected = purchase.lines.some((line) => line.status === "rejected");
  if (!open && received && !rejected) purchase.status = "received";
  else if (!open && rejected && !received) purchase.status = "cancelled";
  else if (!open) purchase.status = "partial";
  return { ok: true, plan: { purchase, movements, lots, credits, writes } };
}

type RedemptionInput = {
  tenantId: string;
  customerRef: string;
  amountCents: number;
  sourceRef: string;
  now: string;
  occurredOn: string;
};

/** Validate a request only. The database authorizes spending and supplies the actual balance. */
export function draftRedemption(input: RedemptionInput): { ok: true; entry: CreditEntry } | { ok: false; error: string } {
  if (!RECORD_ID.test(input.customerRef)) return { ok: false, error: "Store credit is kept against a sell request id, not a name or email." };
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > 2147483647) return { ok: false, error: "A redemption is a positive amount of cents within the supported range." };
  if (!input.sourceRef.trim()) return { ok: false, error: "A redemption needs a source id." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn) || !Number.isFinite(Date.parse(input.occurredOn)) || new Date(input.occurredOn).toISOString().slice(0,10) !== input.occurredOn) return { ok: false, error: 'A redemption needs a valid calendar date.' };
  return {
    ok: true,
    entry: {
      id: `redeem:${input.customerRef}:${input.sourceRef}`,
      tenantId: input.tenantId,
      customerRef: input.customerRef,
      amountCents: -input.amountCents,
      entryKind: "redemption",
      sourceKind: "redemption",
      sourceRef: input.sourceRef.trim(),
      occurredOn: input.occurredOn,
      balanceAfterCents: 0,
      createdAt: input.now,
    },
  };
}

/** Preview helper; production spending is authorized atomically in Postgres. */
export function planRedemption(input: RedemptionInput & { balanceCents: number }): ReturnType<typeof draftRedemption> {
  const draft = draftRedemption(input);
  if (!draft.ok) return draft;
  if (input.amountCents > input.balanceCents) return { ok: false, error: `The unspent balance is ${(input.balanceCents / 100).toFixed(2)}. A redemption cannot go below 0.` };
  return { ok: true, entry: { ...draft.entry, balanceAfterCents: input.balanceCents-input.amountCents } };
}

export function outstandingCents(entries: readonly Pick<CreditEntry, "amountCents">[]): number {
  return entries.reduce((sum, entry) => sum + entry.amountCents, 0);
}

type Stored = { purchase: PurchaseDraft; insertedMovement: Set<string>; insertedCredit: Set<string> };

/** In-memory stand-in for the unique keys. A second save edits the draft. A second receive inserts nothing. */
export class PurchaseBook {
  private readonly purchases = new Map<string, Stored>();
  private readonly credits: CreditEntry[] = [];

  private key(tenantId: string, sellRequestId: string): string {
    return `${tenantId}\0${sellRequestId}`;
  }

  get(tenantId: string, sellRequestId: string): PurchaseDraft | null {
    const hit = this.purchases.get(this.key(tenantId, sellRequestId));
    return hit ? structuredClone(hit.purchase) : null;
  }

  accept(input: Parameters<typeof planAcceptance>[0]): { ok: true; purchase: PurchaseDraft; created: boolean } | { ok: false; error: string } {
    const planned = planAcceptance(input);
    if (!planned.ok) return planned;
    const key = this.key(input.tenantId, input.request.id);
    const existing = this.purchases.get(key);
    if (!existing) {
      this.purchases.set(key, { purchase: planned.purchase, insertedMovement: new Set(), insertedCredit: new Set() });
      return { ok: true, purchase: structuredClone(planned.purchase), created: true };
    }
    if (existing.purchase.lines.some((line) => line.status !== "accepted")) {
      return { ok: true, purchase: structuredClone(existing.purchase), created: false };
    }
    planned.purchase.id = existing.purchase.id;
    existing.purchase = planned.purchase;
    return { ok: true, purchase: structuredClone(planned.purchase), created: false };
  }

  balance(tenantId: string, customerRef: string): number {
    return outstandingCents(this.credits.filter((entry) => entry.tenantId === tenantId && entry.customerRef === customerRef));
  }

  receive(input: {
    tenantId: string;
    sellRequestId: string;
    receivedOn: string;
    now: string;
    confirms: readonly { lineNo: number; condition: string }[];
    mintRecordId?: (lineNo: number) => string;
  }): { ok: true; plan: ReceiptPlan; movementsInserted: number; creditsInserted: number } | { ok: false; error: string } {
    const key = this.key(input.tenantId, input.sellRequestId);
    const existing = this.purchases.get(key);
    if (!existing) return { ok: false, error: "Save the sell request before receiving it." };
    const planned = planReceipt({
      purchase: existing.purchase,
      receivedOn: input.receivedOn,
      now: input.now,
      confirms: input.confirms,
      balanceCents: this.balance(input.tenantId, input.sellRequestId),
      mintRecordId: input.mintRecordId ?? ((lineNo) => `recNewStockLn${String(lineNo).padStart(4, "0")}`),
    });
    if (!planned.ok) return planned;
    let movementsInserted = 0;
    const movements = planned.plan.movements.filter((movement) => {
      const id = `${movement.tenantId}\0${movement.sourceKind}\0${movement.sourceRef}\0${movement.reason}`;
      if (existing.insertedMovement.has(id)) return false;
      existing.insertedMovement.add(id);
      movementsInserted += 1;
      return true;
    });
    let creditsInserted = 0;
    const credits = planned.plan.credits.filter((entry) => {
      const id = `${entry.tenantId}\0${entry.sourceKind}\0${entry.sourceRef}\0${entry.entryKind}`;
      if (existing.insertedCredit.has(id)) return false;
      existing.insertedCredit.add(id);
      this.credits.push(entry);
      creditsInserted += 1;
      return true;
    });
    existing.purchase = planned.plan.purchase;
    const fresh = movementsInserted > 0 || creditsInserted > 0 || planned.plan.writes.some((write) => write.kind === "create_purchase" && movements.length === 0 && credits.length === 0 && planned.plan.movements.length === 0);
    return {
      ok: true,
      plan: { ...planned.plan, movements, credits, writes: planned.plan.movements.length === 0 && planned.plan.credits.length === 0 && planned.plan.writes.length === 0 ? [] : (fresh || planned.plan.writes.length > 0 ? planned.plan.writes : []) },
      movementsInserted,
      creditsInserted,
    };
  }

  redeem(input: Parameters<typeof planRedemption>[0]): { ok: true; entry: CreditEntry; created: boolean } | { ok: false; error: string } {
    const id = `${input.tenantId}\0redemption\0${input.sourceRef}\0redemption`;
    if (this.credits.some((entry) => `${entry.tenantId}\0${entry.sourceKind}\0${entry.sourceRef}\0${entry.entryKind}` === id)) {
      const entry = this.credits.find((row) => `${row.tenantId}\0${row.sourceKind}\0${row.sourceRef}\0${row.entryKind}` === id)!;
      return { ok: true, entry: structuredClone(entry), created: false };
    }
    const planned = planRedemption({ ...input, balanceCents: this.balance(input.tenantId, input.customerRef) });
    if (!planned.ok) return planned;
    this.credits.push(planned.entry);
    return { ok: true, entry: structuredClone(planned.entry), created: true };
  }

  entries(tenantId: string): CreditEntry[] {
    return this.credits.filter((entry) => entry.tenantId === tenantId).map((entry) => structuredClone(entry));
  }

  liability(tenantId: string): { outstandingCents: number; customers: number; entries: number } {
    const mine = this.entries(tenantId);
    const customers = new Set(mine.map((entry) => entry.customerRef));
    return { outstandingCents: outstandingCents(mine), customers: customers.size, entries: mine.length };
  }
}

export function assertWritesStayOffContact(writes: readonly ReceiveWrite[]): void {
  for (const write of writes) {
    if (write.kind === "create_purchase") assertNoCustomerContact(write.fields, "Purchases");
  }
}

const PURCHASE_TABLE = "Purchases";

function redact(message: string, token: string): string {
  return token ? message.split(token).join("[redacted]") : message;
}

async function airtableCall(url: string, token: string, method: "GET" | "POST" | "PATCH", fetchImpl: typeof fetch, body?: unknown): Promise<{ records?: { id: string }[]; id?: string }> {
  if (method !== "GET" && method !== "POST" && method !== "PATCH") throw new PurchaseError("Purchase writes are creates and patches only.");
  const response = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json() as { error?: { message?: string } | string };
      detail = typeof payload.error === "string" ? payload.error : payload.error?.message ?? "";
    } catch { /* ignore */ }
    throw new PurchaseError(redact(`Airtable ${method} failed (${response.status})${detail ? `: ${detail}` : "."}`, token));
  }
  return await response.json() as { records?: { id: string }[]; id?: string };
}

/**
 * Applies the planned Airtable writes. Callers in tests pass a mock fetch.
 * A purchase row is created only when its Hekla Purchase Line ID is not already there.
 */
/** One Sell Request record. GET only. Contact fields are dropped by readSellRequest. */
export async function fetchSellRequest(token: string, recordId: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; request: SellRequestView } | { ok: false; error: string }> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, error: "Set AIRTABLE_API_KEY or AIRTABLE_PAT. The value is never printed." };
  if (!RECORD_ID.test(recordId)) return { ok: false, error: "That sell request id is not an Airtable record id." };
  const url = `https://api.airtable.com/v0/${SELL_REQUEST_BASE_ID}/${SELL_REQUEST_TABLE_ID}/${recordId}`;
  const response = await fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${trimmed}`, accept: "application/json" } });
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json() as { error?: { message?: string } | string };
      detail = typeof payload.error === "string" ? payload.error : payload.error?.message ?? "";
    } catch { /* ignore */ }
    return { ok: false, error: redact(detail ? `Airtable read failed (${response.status}): ${detail}` : `Airtable read failed (${response.status}).`, trimmed) };
  }
  const body = await response.json() as { id?: string; fields?: Record<string, unknown> };
  return readSellRequest({ id: body.id ?? recordId, fields: body.fields ?? {} });
}

export async function applyReceiveWrites(args: { token: string; writes: readonly ReceiveWrite[]; fetchImpl?: typeof fetch }): Promise<{ created: string[]; patched: string[]; stock: { lineKey: string; recordId: string }[] }> {
  const token = args.token.trim();
  if (!token) throw new PurchaseError("Set AIRTABLE_API_KEY or AIRTABLE_PAT. The value is never printed.");
  const fetchImpl = args.fetchImpl ?? fetch;
  const base = `https://api.airtable.com/v0/${SELL_REQUEST_BASE_ID}`;
  const created: string[] = [];
  const patched: string[] = [];
  const stock: { lineKey: string; recordId: string }[] = [];
  for (const write of args.writes) {
    if (write.kind === "create_purchase") {
      const lineKey = String(write.fields["Hekla Purchase Line ID"] ?? "");
      const formula = encodeURIComponent(`{Hekla Purchase Line ID}="${lineKey.replaceAll('"', "")}"`);
      const found = await airtableCall(`${base}/${encodeURIComponent(PURCHASE_TABLE)}?filterByFormula=${formula}&maxRecords=1`, token, "GET", fetchImpl);
      if ((found.records ?? []).length > 0) continue;
      await airtableCall(`${base}/${encodeURIComponent(PURCHASE_TABLE)}`, token, "POST", fetchImpl, { records: [{ fields: write.fields }], typecast: false });
      created.push(lineKey);
      continue;
    }
    if (write.kind === "create_stock") {
      const formula = encodeURIComponent(`{Notes}="${write.note.replaceAll('"', "")}"`);
      const found = await airtableCall(`${base}/tblvHPu7dgDHA91bc?filterByFormula=${formula}&maxRecords=1`, token, "GET", fetchImpl);
      const existingId = found.records?.[0]?.id;
      if (existingId) {
        stock.push({ lineKey: write.lineKey, recordId: existingId });
        continue;
      }
      const made = await airtableCall(`${base}/tblvHPu7dgDHA91bc`, token, "POST", fetchImpl, { records: [{ fields: write.fields }], typecast: airtableWriteTypecast(write.fields) });
      const recordId = made.records?.[0]?.id ?? made.id ?? "";
      if (recordId) stock.push({ lineKey: write.lineKey, recordId });
      created.push(write.lineKey);
      continue;
    }
    if (write.kind === "patch_qty") {
      const table = "tblvHPu7dgDHA91bc";
      await airtableCall(`${base}/${table}/${write.recordId}`, token, "PATCH", fetchImpl, { fields: write.fields, typecast: false });
      patched.push(write.recordId);
      continue;
    }
    await airtableCall(`${base}/tbleeKxJPfpQAAdnC/${write.recordId}`, token, "PATCH", fetchImpl, { fields: write.fields, typecast: false });
    patched.push(write.recordId);
  }
  return { created, patched, stock };
}
