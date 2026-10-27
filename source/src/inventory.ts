/**
 * Phase 1 inventory ledger: opening balances, idempotency, and Florin's flag rules.
 * Airtable is never written from here. On-hand is the sum of movement deltas.
 * Order sources are labels. TCGplayer stays unavailable until Starfoil has its own seller account.
 */
import { collectorVariants, setIdentityOf } from "./fields.ts";
import { canonicalCondition, effectiveGame, setName, SETS, canonicalSet } from "./sets.ts";

export const MOVEMENT_REASONS = [
  "opening_balance",
  "intake",
  "buylist_purchase",
  "sale_cardtrader",
  "sale_starfoil",
  "sale_tcgplayer",
  "sale_in_person",
  "cancel_restock",
  "adjustment",
  "reserve",
  "release",
] as const;
export type MovementReason = (typeof MOVEMENT_REASONS)[number];

/** Open label. A new marketplace registers in ORDER_SOURCES; the ledger columns do not change. */
export const SOURCE_KIND_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;

export const ORDER_SOURCES = [
  { kind: "snapshot", label: "Opening snapshot", available: true, note: "One opening balance per Waitlist row." },
  { kind: "cardtrader_order", label: "CardTrader order", available: false, note: "Can be logged later on the same idempotency key." },
  { kind: "starfoil_order", label: "starfoil.store order", available: false, note: "Can be logged later on the same idempotency key." },
  { kind: "tcgplayer_order", label: "TCGplayer order", available: false, note: "Parked until Starfoil has its own seller account. No other account is read." },
  { kind: "sell_request", label: "Sell request", available: false, note: "Buy-list purchases are a later phase." },
  { kind: "event_sale", label: "In-person sale", available: false, note: "Event sales are a later phase." },
  { kind: "manual", label: "Manual adjustment", available: false, note: "Adjustments are a later phase." },
] as const;

export const WAITLIST_BASE_ID = "app4Tjz72sZtVMQyp";
export const WAITLIST_TABLE_ID = "tblvHPu7dgDHA91bc";
export const BUY_LIST_TABLE_ID = "tbleeKxJPfpQAAdnC";

/** Approved defaults. Editable later per tenant; never read from a seller account. */
export const DEFAULT_THRESHOLDS = {
  lowStockOnHand: 0,
  overstockSkuLimit: 3,
  tcgplayerLevel: 1,
  slowMoverDays: 45,
} as const;
export type Thresholds = { lowStockOnHand: number; overstockSkuLimit: number; tcgplayerLevel: number; slowMoverDays: number };

export type StockSnapshot = {
  cardName: string | null;
  game: string | null;
  setNumber: string | null;
  setIdentifier: string | null;
  setIdentity: string;
  setLabel: string | null;
  collectorNumber: string | null;
  finishRaw: string | null;
  finish: string | null;
  rarityNote: string | null;
  condition: string | null;
  language: string;
  status: string | null;
  marketPriceUsd: number | null;
  dateAcquired: null;
  firstSeen: string | null;
  cardTraderListingId: string | null;
  identityKey: string | null;
};

export type MovementDraft = {
  tenantId: string;
  recordId: string;
  delta: number;
  qtyBefore: number;
  qtyAfter: number;
  reason: MovementReason;
  sourceKind: string;
  sourceRef: string;
  appliedBy: string;
  unitCostCents: number | null;
  note: string | null;
  needsReview: string | null;
  snapshot: StockSnapshot | null;
  createdAt: string;
};

export type WaitlistInput = { id: string; createdTime?: string | null; fields: Record<string, unknown> };
export type BuyListInput = { id: string; fields: Record<string, unknown> };

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

export function idempotencyKey(m: Pick<MovementDraft, "tenantId" | "sourceKind" | "sourceRef" | "reason">): string {
  return `${m.tenantId}\0${m.sourceKind}\0${m.sourceRef}\0${m.reason}`;
}

export function validateMovement(m: MovementDraft): void {
  if (!m.tenantId.trim()) throw new Error("A movement needs a tenant.");
  if (!/^rec[A-Za-z0-9]{14}$/.test(m.recordId)) throw new Error("A movement needs an Airtable record id.");
  if (!Number.isInteger(m.delta) || !Number.isInteger(m.qtyBefore) || !Number.isInteger(m.qtyAfter)) {
    throw new Error("Quantities must be whole numbers.");
  }
  if (m.qtyBefore < 0 || m.qtyAfter < 0) throw new Error("On-hand quantity cannot go below zero.");
  if (m.qtyAfter !== m.qtyBefore + m.delta) throw new Error("qty_after must equal qty_before plus delta.");
  if (!(MOVEMENT_REASONS as readonly string[]).includes(m.reason)) throw new Error("Unknown movement reason.");
  if (!SOURCE_KIND_PATTERN.test(m.sourceKind)) throw new Error("source_kind must be a short lowercase label.");
  if (!m.sourceRef.trim()) throw new Error("source_ref is the idempotency key and cannot be blank.");
  if (!m.appliedBy.trim()) throw new Error("applied_by is required.");
  if (m.unitCostCents != null && (!Number.isInteger(m.unitCostCents) || m.unitCostCents < 0)) {
    throw new Error("Unit cost must be whole cents, or null when unknown.");
  }
  if (m.reason === "opening_balance") {
    if (m.snapshot?.dateAcquired !== null) throw new Error("Opening rows keep Date Acquired blank.");
    if (m.unitCostCents != null) throw new Error("Opening rows keep cost unknown.");
  }
}

/** In-memory stand-in for the unique key. Inserts only; a repeat of the same source event is a no-op. */
export class AppendOnlyLedger {
  private readonly rows: MovementDraft[] = [];
  private readonly keys = new Set<string>();

  append(movement: MovementDraft): { inserted: boolean } {
    validateMovement(movement);
    const key = idempotencyKey(movement);
    if (this.keys.has(key)) return { inserted: false };
    this.keys.add(key);
    this.rows.push(structuredClone(movement));
    return { inserted: true };
  }

  all(): readonly MovementDraft[] {
    return this.rows;
  }
}

export function applyMovements(ledger: AppendOnlyLedger, movements: readonly MovementDraft[]): { inserted: number; already: number } {
  let inserted = 0;
  let already = 0;
  for (const movement of movements) {
    if (ledger.append(movement).inserted) inserted += 1;
    else already += 1;
  }
  return { inserted, already };
}

export function onHand(movements: readonly Pick<MovementDraft, "delta">[]): number {
  return movements.reduce((sum, movement) => sum + movement.delta, 0);
}

/** 42, 042 and 042/204 collapse the way Hekla already matches collector numbers. */
export function canonicalCollector(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const variants = collectorVariants(trimmed);
  const numeric = variants.find((value) => /^[1-9]\d*(\/\d+)?$/.test(value) || value === "0" || /^0(\/\d+)?$/.test(value));
  return (numeric ?? trimmed).toLowerCase();
}

export type FinishMap = { finish: string | null; review: string | null; rarityNote: string | null };

/** Normal is Regular. Enchanted is a rarity stored as Holofoil. Special is not guessed. */
export function canonicalStockFinish(raw: string | null | undefined): FinishMap {
  const textValue = (raw ?? "").trim();
  const lower = textValue.toLowerCase();
  if (!lower) return { finish: null, review: "Finish is blank.", rarityNote: null };
  if (lower === "normal" || lower === "regular") return { finish: "Regular", review: null, rarityNote: null };
  if (lower === "foil") return { finish: "Foil", review: null, rarityNote: null };
  if (lower === "holofoil" || lower === "holo") return { finish: "Holofoil", review: null, rarityNote: null };
  if (lower === "cold foil" || lower === "coldfoil") return { finish: "Cold Foil", review: null, rarityNote: null };
  if (lower === "enchanted") return { finish: "Holofoil", review: null, rarityNote: "Enchanted" };
  if (lower === "special") return { finish: null, review: "Special finish needs a printing. Not guessed.", rarityNote: null };
  if (lower === "any") return { finish: null, review: null, rarityNote: null };
  return { finish: null, review: `Finish “${textValue}” is not a known printing.`, rarityNote: null };
}

/** English only for now. Any other language stays on its own row and is flagged. */
export function normalizeLanguage(raw: string | null | undefined): { language: string; review: string | null } {
  const value = (raw ?? "").trim();
  if (!value || value.toLowerCase() === "english" || value.toLowerCase() === "en") return { language: "English", review: null };
  return { language: value, review: "Non-English copy. It keeps its own stock row and is flagged for Florin." };
}

export function stockIdentityKey(parts: { game: string; setIdentity: string; collectorNumber: string; finish: string; condition: string; language: string }): string {
  return [parts.game, parts.setIdentity, canonicalCollector(parts.collectorNumber), parts.finish, parts.condition, parts.language.toLowerCase()].join("|");
}

/** Category and Sealed buy-list rows are never decremented and never treated as a card want. */
export function wantDecrementAllowed(kind: string | null | undefined): boolean {
  const value = (kind ?? "").trim().toLowerCase();
  return value !== "category" && value !== "sealed";
}

export function buyListSetIdentity(game: string | null, setText: string | null): string | null {
  const raw = (setText ?? "").trim();
  if (!raw) return null;
  if (effectiveGame(game) === "Lorcana" || !game?.trim()) {
    const byId = canonicalSet(raw);
    if (byId) return byId;
    const byName = SETS.find((set) => set.name.toLowerCase() === raw.toLowerCase());
    return byName?.id ?? null;
  }
  return raw.toLowerCase();
}

function openingQty(value: unknown): { qty: number; review: string | null } {
  if (value == null || value === "") return { qty: 0, review: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100_000) {
    return { qty: 0, review: "Qty is not a whole number from 0 up. Opening balance recorded as 0 until reviewed." };
  }
  return { qty: value, review: null };
}

function joinReview(parts: (string | null | undefined)[]): string | null {
  const textParts = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return textParts.length ? textParts.join(" ") : null;
}

function mapOne(row: WaitlistInput, tenantId: string, nowIso: string): MovementDraft {
  const fields = row.fields ?? {};
  const gameRaw = text(fields.Game);
  const game = effectiveGame(gameRaw) ?? gameRaw;
  const setNumber = text(fields["Set #"]);
  const setIdentifier = text(fields["Set Identifier"]);
  const knownGame = effectiveGame(gameRaw);
  const setIdentity = knownGame ? setIdentityOf({ game: knownGame, setNumber, setIdentifier }) : (setIdentifier ?? setNumber ?? "").trim().toLowerCase();
  const setLabel = knownGame === "Lorcana" || !knownGame ? (setName(setNumber) ?? (setNumber ? `Set ${setNumber}` : null)) : setIdentifier;
  const collectorNumber = text(fields["Collector Number"]);
  const finishRaw = text(fields.Finish);
  const finish = canonicalStockFinish(finishRaw);
  const conditionRaw = text(fields.Condition);
  const condition = conditionRaw ? canonicalCondition(conditionRaw) : null;
  const language = normalizeLanguage(text(fields.Language));
  const qty = openingQty(fields.Qty);
  const name = text(fields["Card Name"]) ?? text(fields["Resolved Name"]);
  const market = typeof fields["Market Price USD"] === "number" && Number.isFinite(fields["Market Price USD"]) ? fields["Market Price USD"] : null;
  const reviews = [
    finish.review,
    language.review,
    qty.review,
    conditionRaw && !condition ? `Condition “${conditionRaw}” is not NM, LP, MP, HP, or DMG.` : null,
    !conditionRaw ? "Condition is blank." : null,
    gameRaw && !knownGame ? "Game is not a known choice." : null,
    !setIdentity ? "Set is blank, so this row cannot share a printing key." : null,
    !collectorNumber ? "Collector number is blank." : null,
  ];
  const identityKey = game && setIdentity && collectorNumber && finish.finish && condition
    ? stockIdentityKey({ game, setIdentity, collectorNumber, finish: finish.finish, condition, language: language.language })
    : null;
  const notes = ["Opening balance. Cost unknown. Date acquired left blank."];
  if (finishRaw?.toLowerCase() === "normal") notes.push("Finish Normal is stored as Regular. Airtable was not changed.");
  if (finish.rarityNote === "Enchanted") notes.push("Enchanted stays on the card as rarity. Finish is Holofoil. Airtable was not changed.");
  const snapshot: StockSnapshot = {
    cardName: name,
    game,
    setNumber,
    setIdentifier,
    setIdentity,
    setLabel,
    collectorNumber,
    finishRaw,
    finish: finish.finish,
    rarityNote: finish.rarityNote,
    condition,
    language: language.language,
    status: text(fields.Status),
    marketPriceUsd: market,
    dateAcquired: null,
    firstSeen: row.createdTime ?? null,
    cardTraderListingId: text(fields["CardTrader Listing ID"]),
    identityKey,
  };
  return {
    tenantId,
    recordId: row.id,
    delta: qty.qty,
    qtyBefore: 0,
    qtyAfter: qty.qty,
    reason: "opening_balance",
    sourceKind: "snapshot",
    sourceRef: row.id,
    appliedBy: "hekla",
    unitCostCents: null,
    note: notes.join(" "),
    needsReview: joinReview(reviews),
    snapshot,
    createdAt: nowIso,
  };
}

/**
 * One opening movement per Waitlist row. Re-running builds the same idempotency keys.
 * Duplicate printing + condition + language is flagged, not merged, and Airtable is not changed.
 * Date Acquired is always blank. Cost is always unknown, even when Cost Basis USD has a number.
 */
export function planOpeningEntries(rows: readonly WaitlistInput[], tenantId: string, now = new Date()): MovementDraft[] {
  const nowIso = now.toISOString();
  const movements = rows.map((row) => mapOne(row, tenantId, nowIso));
  const groups = new Map<string, MovementDraft[]>();
  for (const movement of movements) {
    const snap = movement.snapshot;
    if (!snap) continue;
    const key = snap.identityKey ?? rawGroupKey(snap);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(movement);
    groups.set(key, list);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const note = `Duplicate stock identity (${group.length} Waitlist rows share printing, condition, and language). Not merged.`;
    for (const movement of group) movement.needsReview = joinReview([movement.needsReview, note]);
  }
  return movements;
}

function rawGroupKey(snap: StockSnapshot): string | null {
  if (!snap.game || !snap.setIdentity || !snap.collectorNumber || !snap.condition || !snap.finishRaw) return null;
  return ["raw", snap.game, snap.setIdentity, canonicalCollector(snap.collectorNumber), snap.condition, snap.language.toLowerCase(), snap.finishRaw.toLowerCase()].join("|");
}

export function matchWantQty(
  stock: { game: string | null; setIdentity: string; collectorNumber: string | null; finish: string | null },
  rows: readonly BuyListInput[],
): { wantQty: number | null; review: string | null } {
  const hits: { want: number }[] = [];
  for (const row of rows) {
    if (!wantDecrementAllowed(text(row.fields.Kind))) continue;
    const wantRaw = row.fields["Want Qty"];
    if (typeof wantRaw !== "number" || !Number.isFinite(wantRaw)) continue;
    const finishRaw = text(row.fields.Finish);
    const anyFinish = (finishRaw ?? "").trim().toLowerCase() === "any";
    const mapped = canonicalStockFinish(finishRaw);
    if (!anyFinish && mapped.finish == null) continue;
    if (!anyFinish && mapped.finish !== stock.finish) continue;
    const game = effectiveGame(text(row.fields.Game) ?? undefined) ?? text(row.fields.Game);
    if ((game ?? "") !== (stock.game ?? "")) continue;
    const setIdentity = buyListSetIdentity(game, text(row.fields.Set));
    if (setIdentity == null || setIdentity !== stock.setIdentity) continue;
    const collector = text(row.fields["Collector #"]);
    if (!collector || !stock.collectorNumber) continue;
    if (canonicalCollector(collector) !== canonicalCollector(stock.collectorNumber)) continue;
    hits.push({ want: wantRaw });
  }
  if (hits.length > 1) return { wantQty: null, review: "More than one buy-list row matches. Want Qty was not guessed." };
  if (hits.length === 0) return { wantQty: null, review: null };
  return { wantQty: hits[0]!.want, review: null };
}

const DAY_MS = 86_400_000;

export function ageDays(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  return Math.floor((now.getTime() - time) / DAY_MS);
}

export type StockFlagResult = {
  low: boolean;
  overstock: boolean;
  overstockBy: number | null;
  slow: boolean;
  daysWithoutSale: number | null;
  ageSource: "acquired" | "first_seen" | null;
};

/**
 * Low: Want Qty is set and on hand is at the low-stock setting (default 0).
 * Overstock: on hand is above Want Qty, or more than the SKU limit while the level setting is 1.
 * Slow: that many days in stock with no sale. Blank Date Acquired uses first-seen (row created) as an estimate.
 */
export function stockFlags(input: {
  onHand: number;
  wantQty: number | null;
  thresholds: Thresholds;
  dateAcquired: string | null;
  firstSeen: string | null;
  lastSaleAt: string | null;
  now: Date;
}): StockFlagResult {
  const { onHand: qty, wantQty, thresholds, now } = input;
  const low = wantQty != null && wantQty > 0 && qty <= thresholds.lowStockOnHand;
  const aboveWant = wantQty != null && qty > wantQty;
  const aboveSku = thresholds.tcgplayerLevel === 1 && qty > thresholds.overstockSkuLimit;
  const overstock = aboveWant || aboveSku;
  const overstockBy = aboveWant ? qty - (wantQty as number) : aboveSku ? qty - thresholds.overstockSkuLimit : null;
  const acquiredAge = ageDays(input.dateAcquired, now);
  const seenAge = ageDays(input.firstSeen, now);
  const ageSource = input.dateAcquired ? "acquired" as const : input.firstSeen ? "first_seen" as const : null;
  const inStockDays = acquiredAge ?? seenAge;
  const sinceSale = input.lastSaleAt ? ageDays(input.lastSaleAt, now) : inStockDays;
  const slow = qty > 0 && inStockDays != null && sinceSale != null && inStockDays >= thresholds.slowMoverDays && sinceSale >= thresholds.slowMoverDays;
  return { low, overstock, overstockBy, slow, daysWithoutSale: sinceSale, ageSource: slow || inStockDays != null ? ageSource : null };
}

export type InventoryFilter = {
  game?: string;
  condition?: string;
  finish?: string;
  q?: string;
  flag?: "low" | "overstock" | "slow" | "review";
  cost?: "known" | "unknown";
};

export type InventoryRow = {
  recordId: string;
  name: string;
  game: string | null;
  setLabel: string | null;
  collectorNumber: string | null;
  finish: string | null;
  finishRaw: string | null;
  rarityNote: string | null;
  condition: string | null;
  language: string;
  onHand: number;
  unitCostCents: number | null;
  marketPriceUsd: number | null;
  daysInStock: number | null;
  state: "In hand" | "Sold";
  wantQty: number | null;
  dateAcquired: null;
  firstSeen: string | null;
  cardTraderListingId: string | null;
  flags: StockFlagResult & { needsReview: string | null };
};

export type InventoryPayload = {
  phase: 1;
  readOnly: true;
  onHandSource: "ledger";
  rows: InventoryRow[];
  totals: { units: number; rows: number; unknownCostUnits: number; knownCostUnits: number; flags: number; low: number; overstock: number; slow: number; needsReview: number };
  facets: { games: string[]; conditions: string[]; finishes: string[] };
  thresholds: Thresholds;
  wantQtyState: "matched" | "unread";
  orderSources: typeof ORDER_SOURCES;
  placeholders: {
    tcgplayerLevel: string;
    storeCredit: string;
    purchases: string;
    eventSale: string;
  };
  generatedAt: string;
};

const PLACEHOLDERS = {
  tcgplayerLevel: "Not connected. Starfoil does not have its own TCGplayer seller account, and this page does not read any other account.",
  storeCredit: "Store credit liability ships with purchases. Nothing is issued or redeemed here.",
  purchases: "Logging a buy-list purchase is a later phase. This page does not write to Airtable.",
  eventSale: "In-person sales are a later phase.",
} as const;

function snapshotOf(movements: readonly MovementDraft[]): StockSnapshot | null {
  let found: StockSnapshot | null = null;
  for (const movement of movements) if (movement.snapshot?.language) found = movement.snapshot;
  return found;
}

function lastSaleAt(movements: readonly MovementDraft[]): string | null {
  let latest: string | null = null;
  for (const movement of movements) {
    if (!movement.reason.startsWith("sale_") || movement.delta >= 0) continue;
    if (!latest || movement.createdAt > latest) latest = movement.createdAt;
  }
  return latest;
}

function rowFrom(recordId: string, movements: readonly MovementDraft[], buyList: readonly BuyListInput[], thresholds: Thresholds, now: Date): InventoryRow {
  const ordered = [...movements].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sourceRef.localeCompare(b.sourceRef));
  const snap = snapshotOf(ordered);
  const qty = onHand(ordered);
  const want = snap
    ? matchWantQty({ game: snap.game, setIdentity: snap.setIdentity, collectorNumber: snap.collectorNumber, finish: snap.finish }, buyList)
    : { wantQty: null, review: null };
  const knownCost = ordered.some((movement) => movement.unitCostCents != null);
  const flags = stockFlags({
    onHand: qty,
    wantQty: want.wantQty,
    thresholds,
    dateAcquired: null,
    firstSeen: snap?.firstSeen ?? null,
    lastSaleAt: lastSaleAt(ordered),
    now,
  });
  const needsReview = joinReview([...ordered.map((movement) => movement.needsReview), want.review]);
  return {
    recordId,
    name: snap?.cardName || "Untitled",
    game: snap?.game ?? null,
    setLabel: snap?.setLabel ?? null,
    collectorNumber: snap?.collectorNumber ?? null,
    finish: snap?.finish ?? null,
    finishRaw: snap?.finishRaw ?? null,
    rarityNote: snap?.rarityNote ?? null,
    condition: snap?.condition ?? null,
    language: snap?.language ?? "English",
    onHand: qty,
    unitCostCents: knownCost ? ordered.find((movement) => movement.unitCostCents != null)?.unitCostCents ?? null : null,
    marketPriceUsd: snap?.marketPriceUsd ?? null,
    daysInStock: null,
    state: qty === 0 ? "Sold" : "In hand",
    wantQty: want.wantQty,
    dateAcquired: null,
    firstSeen: snap?.firstSeen ?? null,
    cardTraderListingId: snap?.cardTraderListingId ?? null,
    flags: { ...flags, needsReview },
  };
}

function matchesFilter(row: InventoryRow, filter: InventoryFilter): boolean {
  if (filter.game && row.game !== filter.game) return false;
  if (filter.condition && row.condition !== filter.condition) return false;
  if (filter.finish && row.finish !== filter.finish && row.finishRaw !== filter.finish) return false;
  if (filter.flag === "low" && !row.flags.low) return false;
  if (filter.flag === "overstock" && !row.flags.overstock) return false;
  if (filter.flag === "slow" && !row.flags.slow) return false;
  if (filter.flag === "review" && !row.flags.needsReview) return false;
  if (filter.cost === "known" && row.unitCostCents == null) return false;
  if (filter.cost === "unknown" && row.unitCostCents != null) return false;
  if (filter.q) {
    const haystack = [row.name, row.collectorNumber, row.setLabel, row.recordId, row.game, row.finish, row.finishRaw].join(" ").toLowerCase();
    if (!haystack.includes(filter.q.trim().toLowerCase())) return false;
  }
  return true;
}

export function buildInventory(
  movements: readonly MovementDraft[],
  buyList: readonly BuyListInput[],
  thresholds: Thresholds,
  now: Date,
  filter: InventoryFilter = {},
  wantQtyState: "matched" | "unread" = buyList.length ? "matched" : "unread",
): InventoryPayload {
  const byRecord = new Map<string, MovementDraft[]>();
  for (const movement of movements) {
    const list = byRecord.get(movement.recordId) ?? [];
    list.push(movement);
    byRecord.set(movement.recordId, list);
  }
  const all = [...byRecord.entries()]
    .map(([recordId, rows]) => rowFrom(recordId, rows, buyList, thresholds, now))
    .sort((a, b) => a.name.localeCompare(b.name) || a.recordId.localeCompare(b.recordId));
  const rows = all.filter((row) => matchesFilter(row, filter));
  const flagged = (row: InventoryRow) => row.flags.low || row.flags.overstock || row.flags.slow || Boolean(row.flags.needsReview);
  const totals = {
    units: all.reduce((sum, row) => sum + row.onHand, 0),
    rows: all.length,
    unknownCostUnits: all.filter((row) => row.unitCostCents == null).reduce((sum, row) => sum + row.onHand, 0),
    knownCostUnits: all.filter((row) => row.unitCostCents != null).reduce((sum, row) => sum + row.onHand, 0),
    flags: all.filter(flagged).length,
    low: all.filter((row) => row.flags.low).length,
    overstock: all.filter((row) => row.flags.overstock).length,
    slow: all.filter((row) => row.flags.slow).length,
    needsReview: all.filter((row) => row.flags.needsReview).length,
  };
  const uniq = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b));
  return {
    phase: 1,
    readOnly: true,
    onHandSource: "ledger",
    rows,
    totals,
    facets: { games: uniq(all.map((row) => row.game)), conditions: uniq(all.map((row) => row.condition)), finishes: uniq(all.map((row) => row.finish)) },
    thresholds,
    wantQtyState,
    orderSources: ORDER_SOURCES,
    placeholders: PLACEHOLDERS,
    generatedAt: now.toISOString(),
  };
}

export function movementsFor(movements: readonly MovementDraft[], recordId: string): MovementDraft[] {
  return movements.filter((movement) => movement.recordId === recordId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sourceRef.localeCompare(b.sourceRef));
}

export type HistoryLine = {
  createdAt: string;
  delta: number;
  qtyBefore: number;
  qtyAfter: number;
  reason: MovementReason;
  sourceKind: string;
  sourceRef: string;
  appliedBy: string;
  note: string | null;
  needsReview: string | null;
  unitCostCents: number | null;
};

export function buildDetail(
  movements: readonly MovementDraft[],
  buyList: readonly BuyListInput[],
  thresholds: Thresholds,
  now: Date,
  recordId: string,
): { row: InventoryRow; movements: HistoryLine[] } | null {
  const mine = movementsFor(movements, recordId);
  if (mine.length === 0) return null;
  const row = buildInventory(mine, buyList, thresholds, now).rows[0];
  if (!row) return null;
  return {
    row,
    movements: mine.map((movement) => ({
      createdAt: movement.createdAt,
      delta: movement.delta,
      qtyBefore: movement.qtyBefore,
      qtyAfter: movement.qtyAfter,
      reason: movement.reason,
      sourceKind: movement.sourceKind,
      sourceRef: movement.sourceRef,
      appliedBy: movement.appliedBy,
      note: movement.note,
      needsReview: movement.needsReview,
      unitCostCents: movement.unitCostCents,
    })),
  };
}
