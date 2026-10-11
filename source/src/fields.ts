import {
  canonicalCondition,
  canonicalFinish,
  canonicalGame,
  canonicalRarity,
  canonicalSet,
  CONDITIONS,
  effectiveGame,
  finishesFor,
  GAMES,
  type Condition,
  type Finish,
  type Game,
  type Rarity,
  type SetNumber,
} from "./sets.ts";

/** Fields intake is allowed to send on create. Status is always Waitlist. */
export const CREATE_FIELDS = [
  "Game",
  "Set #",
  "Set Identifier",
  "Collector Number",
  "Finish",
  "Condition",
  "Qty",
  "Status",
  "Card Name",
  "Rarity",
  "Cost Basis USD",
  "Priority",
  "Notes",
] as const;

export const SET_IDENTIFIER_MAX = 80;

/** Hekla-owned or legacy. Intake must never write these. */
export const FORBIDDEN_FIELDS = [
  "Resolved Name",
  "Market Price USD",
  "Rank Score",
  "Set Name",
  "Set Name (legacy)",
] as const;

const ALLOWED = new Set<string>(CREATE_FIELDS);

type DraftExtras = {
  collectorNumber: string;
  finish: Finish;
  condition: Condition;
  qty: number;
  cardName?: string;
  rarity?: Rarity;
  costBasisUsd?: number;
  priority?: number;
  notes?: string;
};

export type DraftCard = DraftExtras & (
  | { game: "Lorcana"; setNumber: SetNumber }
  | { game: Exclude<Game, "Lorcana">; setIdentifier: string }
);

export type PrintingRef = {
  game: string | null;
  setNumber?: string | null;
  setIdentifier?: string | null;
  collectorNumber: string;
  finish: string;
};

export type FieldMap = Record<string, string | number>;

export function collectorVariants(raw: string): string[] {
  const trimmed = raw.trim();
  const out = new Set<string>([trimmed]);
  const match = /^0*(\d+)(\/\d+)?$/.exec(trimmed);
  if (match?.[1]) {
    const numeric = String(Number(match[1]));
    const suffix = match[2] ?? "";
    out.add(numeric + suffix);
    out.add(numeric.padStart(3, "0") + suffix);
  }
  return [...out];
}

/** Set half of the dedupe key. Lorcana uses Set #; other games use Set Identifier, case-insensitive. */
export function setIdentityOf(card: Pick<PrintingRef, "game" | "setNumber" | "setIdentifier">): string {
  if (effectiveGame(card.game) === "Lorcana") return (card.setNumber ?? "").trim();
  return (card.setIdentifier ?? "").trim().toLowerCase();
}

export function dedupeKey(game: string, setIdentity: string, collectorNumber: string, finish: string): string {
  return `${game}|${setIdentity}|${collectorNumber.trim().toLowerCase()}|${finish}`;
}

export function buildCreateFields(card: DraftCard): FieldMap {
  const fields: FieldMap = {
    Game: card.game,
    "Collector Number": card.collectorNumber.trim(),
    Finish: card.finish,
    Condition: card.condition,
    Qty: card.qty,
    Status: "Waitlist",
  };
  if (card.game === "Lorcana") {
    fields["Set #"] = card.setNumber;
  } else {
    fields["Set Identifier"] = card.setIdentifier.trim();
  }
  if (card.cardName?.trim()) fields["Card Name"] = card.cardName.trim();
  if (card.rarity) fields.Rarity = card.rarity;
  if (card.costBasisUsd !== undefined) fields["Cost Basis USD"] = card.costBasisUsd;
  if (card.priority !== undefined) fields.Priority = card.priority;
  if (card.notes?.trim()) fields.Notes = card.notes.trim();
  assertCreateFields(fields);
  return fields;
}

export function buildMergeFields(qty: number): FieldMap {
  if (!Number.isInteger(qty) || qty < 1 || qty > 999) {
    throw new Error("Merged quantity must be a whole number from 1 to 999.");
  }
  const fields: FieldMap = { Qty: qty };
  const keys = Object.keys(fields);
  if (keys.length !== 1 || keys[0] !== "Qty") {
    throw new Error("Merge can only update Qty.");
  }
  return fields;
}

export function assertCreateFields(fields: FieldMap): void {
  for (const key of Object.keys(fields)) {
    if (!ALLOWED.has(key) || (FORBIDDEN_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`Refusing to write “${key}”.`);
    }
  }
  if (fields.Status !== "Waitlist") {
    throw new Error("Intake only creates rows with Status Waitlist.");
  }
  if (typeof fields.Game !== "string" || !(GAMES as readonly string[]).includes(fields.Game)) {
    throw new Error("Game must be one of the Waitlist choices.");
  }
  const lorcana = fields.Game === "Lorcana";
  if (lorcana && !fields["Set #"]) throw new Error("Lorcana rows need a Set #.");
  if (lorcana && fields["Set Identifier"]) throw new Error("Lorcana rows do not use Set Identifier.");
  if (!lorcana && !fields["Set Identifier"]) throw new Error("Set identifier is required.");
  if (!lorcana && fields["Set #"]) throw new Error("Only Lorcana rows use Set #.");
}

export type IntakeBody = {
  game?: string;
  setNumber?: string;
  setIdentifier?: string;
  collectorNumber: string;
  finish: string;
  condition?: string;
  qty?: number;
  cardName?: string;
  rarity?: string;
  costBasisUsd?: number | null;
  priority?: number | null;
  notes?: string;
  onDuplicate?: "ask" | "merge" | "add";
  mergeRecordId?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function optionalText(value: unknown, label: string, max: number): string | undefined | { error: string } {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return { error: `${label} must be text.` };
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) return { error: `${label} is too long.` };
  return trimmed;
}

export function parseDraft(input: IntakeBody): { ok: true; card: DraftCard } | { ok: false; error: string } {
  const game = canonicalGame(input.game?.trim() ? input.game : "Lorcana");
  if (!game) {
    return { ok: false, error: "Game must be Lorcana, Magic: The Gathering, Riftbound, Pokémon, or Yu-Gi-Oh!." };
  }

  const collectorNumber = (input.collectorNumber ?? "").trim();
  if (!collectorNumber) return { ok: false, error: "Collector number is required." };
  if (collectorNumber.length > 40 || /[\r\n]/.test(collectorNumber)) {
    return { ok: false, error: "Collector number looks wrong." };
  }

  const finish = canonicalFinish(input.finish ?? "");
  if (!finish || !finishesFor(game).includes(finish)) return { ok: false, error: `Finish must be ${finishesFor(game).join(", ")}.` };

  const condition = canonicalCondition(input.condition?.trim() ? input.condition : "NM");
  if (!condition) return { ok: false, error: "Condition must be NM, LP, MP, HP, or DMG." };

  const qtyValue = input.qty === undefined ? 1 : input.qty;
  if (typeof qtyValue !== "number" || !Number.isInteger(qtyValue) || qtyValue < 1 || qtyValue > 250) {
    return { ok: false, error: "Quantity must be a whole number from 1 to 250." };
  }

  let card: DraftCard;
  if (game === "Lorcana") {
    const setNumber = canonicalSet(input.setNumber ?? "");
    if (!setNumber) return { ok: false, error: "Pick a real Lorcana set number." };
    card = { game, setNumber, collectorNumber, finish, condition, qty: qtyValue };
  } else {
    const setIdentifier = (input.setIdentifier ?? "").trim();
    if (!setIdentifier) return { ok: false, error: "Set identifier is required." };
    if (setIdentifier.length > SET_IDENTIFIER_MAX || /[\r\n]/.test(setIdentifier)) {
      return { ok: false, error: "Set identifier looks wrong." };
    }
    card = { game, setIdentifier, collectorNumber, finish, condition, qty: qtyValue };
  }

  const name = optionalText(input.cardName, "Card name", 180);
  if (name && typeof name === "object") return { ok: false, error: name.error };
  if (typeof name === "string") card.cardName = name;

  if (input.rarity !== undefined && input.rarity !== null && input.rarity !== "") {
    const rarity = canonicalRarity(input.rarity);
    if (!rarity) return { ok: false, error: "That rarity is not in the Waitlist choices." };
    card.rarity = rarity;
  }

  if (input.costBasisUsd !== undefined && input.costBasisUsd !== null && input.costBasisUsd !== ("" as unknown)) {
    const cost = input.costBasisUsd;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || cost > 100_000) {
      return { ok: false, error: "Cost basis must be a USD amount from 0 to 100000." };
    }
    card.costBasisUsd = Math.round(cost * 100) / 100;
  }

  if (input.priority !== undefined && input.priority !== null) {
    const priority = input.priority;
    if (typeof priority !== "number" || !Number.isInteger(priority) || priority < -9999 || priority > 9999) {
      return { ok: false, error: "Priority must be a whole number. Lower is sooner." };
    }
    card.priority = priority;
  }

  const notes = optionalText(input.notes, "Notes", 2000);
  if (notes && typeof notes === "object") return { ok: false, error: notes.error };
  if (typeof notes === "string") card.notes = notes;

  return { ok: true, card };
}

export function parseIntakeBody(value: unknown): { ok: true; body: IntakeBody } | { ok: false; error: string } {
  const record = asRecord(value);
  if (!record) return { ok: false, error: "Expected a card object." };

  const onDuplicate = record.onDuplicate;
  if (
    onDuplicate !== undefined &&
    onDuplicate !== "ask" &&
    onDuplicate !== "merge" &&
    onDuplicate !== "add"
  ) {
    return { ok: false, error: "Duplicate choice must be ask, merge, or add." };
  }

  const body: IntakeBody = {
    game: typeof record.game === "string" ? record.game : "",
    setNumber: typeof record.setNumber === "string" ? record.setNumber : "",
    setIdentifier: typeof record.setIdentifier === "string" ? record.setIdentifier : "",
    collectorNumber: typeof record.collectorNumber === "string" ? record.collectorNumber : "",
    finish: typeof record.finish === "string" ? record.finish : "",
    onDuplicate: onDuplicate ?? "ask",
  };

  if (typeof record.condition === "string") body.condition = record.condition;
  if (typeof record.cardName === "string") body.cardName = record.cardName;
  if (typeof record.rarity === "string") body.rarity = record.rarity;
  if (typeof record.notes === "string") body.notes = record.notes;
  if (typeof record.mergeRecordId === "string" && record.mergeRecordId.trim()) {
    body.mergeRecordId = record.mergeRecordId.trim();
  }

  if (record.qty !== undefined && record.qty !== null && record.qty !== "") {
    const qty = typeof record.qty === "number" ? record.qty : Number(record.qty);
    body.qty = qty;
  }
  if (record.costBasisUsd !== undefined && record.costBasisUsd !== null && record.costBasisUsd !== "") {
    const cost = typeof record.costBasisUsd === "number" ? record.costBasisUsd : Number(record.costBasisUsd);
    body.costBasisUsd = cost;
  }
  if (record.priority !== undefined && record.priority !== null && record.priority !== "") {
    const priority = typeof record.priority === "number" ? record.priority : Number(record.priority);
    body.priority = priority;
  }

  return { ok: true, body };
}

export type EditInput = { finish?: unknown; condition?: unknown; qty?: unknown };
export const EDITABLE_FIELDS = ["Finish", "Condition", "Qty"] as const;

/** Inline queue edits: only Finish, Condition, Qty — validated against the game's option lists. */
export function buildEditFields(input: EditInput, game: Game): { ok: true; fields: FieldMap } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Send finish, condition, or qty." };
  const extra = Object.keys(input).filter((key) => !["finish", "condition", "qty"].includes(key));
  if (extra.length) return { ok: false, error: `Only finish, condition, and qty can be edited (got ${extra.join(", ")}).` };
  const fields: FieldMap = {};
  if (input.finish !== undefined) {
    const finish = typeof input.finish === "string" ? canonicalFinish(input.finish) : null;
    if (!finish || !finishesFor(game).includes(finish)) return { ok: false, error: `Finish must be ${finishesFor(game).join(", ")}.` };
    fields.Finish = finish;
  }
  if (input.condition !== undefined) {
    const condition = typeof input.condition === "string" ? canonicalCondition(input.condition) : null;
    if (!condition) return { ok: false, error: `Condition must be ${CONDITIONS.join(", ")}.` };
    fields.Condition = condition;
  }
  if (input.qty !== undefined) {
    const qty = typeof input.qty === "number" ? input.qty : typeof input.qty === "string" && /^\d+$/.test(input.qty.trim()) ? Number(input.qty) : NaN;
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) return { ok: false, error: "Qty must be a whole number from 1 to 999." };
    fields.Qty = qty;
  }
  if (Object.keys(fields).length === 0) return { ok: false, error: "Nothing to change." };
  if (Object.keys(fields).some((key) => !(EDITABLE_FIELDS as readonly string[]).includes(key))) return { ok: false, error: "Only Finish, Condition, and Qty can be edited." };
  return { ok: true, fields };
}
