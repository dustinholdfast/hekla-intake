/**
 * Per-tenant inventory settings. Decided values from Dustin (rates, credit cost) and the approved
 * flag thresholds. MP, HP and DMG are not buyable. Processor fees stay blank until someone sets them.
 * TCGplayer level is a number only. It is not a connected seller account.
 */
import { DEFAULT_THRESHOLDS, type Thresholds } from "./inventory.ts";

export const GRADES = ["NM", "LP", "MP", "HP", "DMG"] as const;
export type Grade = (typeof GRADES)[number];
export const BUYABLE_GRADES = ["NM", "LP"] as const;
export const BLOCKED_GRADES = ["MP", "HP", "DMG"] as const;

export const GRADE_LABELS: Record<Grade, string> = {
  NM: "Near Mint",
  LP: "Lightly Played",
  MP: "Moderately Played",
  HP: "Heavily Played",
  DMG: "Damaged",
};

export const PAYMENT_METHODS = [
  { id: "cash", label: "Cash" },
  { id: "card", label: "Card" },
  { id: "venmo", label: "Venmo" },
  { id: "paypal", label: "PayPal" },
  { id: "cashapp", label: "CashApp" },
  { id: "store_credit", label: "Store credit" },
] as const;
export type PaymentMethodId = (typeof PAYMENT_METHODS)[number]["id"];

export const CREDIT_COST_RULE = "face_value" as const;
export const CREDIT_COST_NOTE = "Credit buys are costed at face value. Cost basis equals the store credit issued.";
export const TCGPLAYER_LEVEL_NOTE = "Level is a setting only. Starfoil has no TCGplayer seller account, and this does not read any other account. It stays inert. The overstock rule uses it when it is 1.";

export type GradeRate = { cashPercent: number | null; creditPercent: number | null; blocked: boolean };

export type InventorySettings = {
  buyRates: Record<Grade, GradeRate>;
  creditCostRule: typeof CREDIT_COST_RULE;
  paymentFees: Record<PaymentMethodId, number | null>;
  thresholds: Thresholds;
};

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

export function defaultInventorySettings(): InventorySettings {
  return {
    buyRates: {
      NM: { cashPercent: 50, creditPercent: 65, blocked: false },
      LP: { cashPercent: 40, creditPercent: 55, blocked: false },
      MP: { cashPercent: null, creditPercent: null, blocked: true },
      HP: { cashPercent: null, creditPercent: null, blocked: true },
      DMG: { cashPercent: null, creditPercent: null, blocked: true },
    },
    creditCostRule: CREDIT_COST_RULE,
    paymentFees: { cash: null, card: null, venmo: null, paypal: null, cashapp: null, store_credit: null },
    thresholds: { ...DEFAULT_THRESHOLDS },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function percent(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new SettingsError(`${label} must be a whole percent from 0 to 100.`);
  }
  return value;
}

function whole(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new SettingsError(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

/** Rejects blocked grades offered as buyable, and any rate outside 0 to 100. Fees are never invented. */
export function validateInventorySettings(input: unknown): InventorySettings {
  if (!isRecord(input)) throw new SettingsError("Settings must be an object.");
  if (!isRecord(input.buyRates)) throw new SettingsError("Buy rates are missing.");
  const rateKeys = Object.keys(input.buyRates);
  const unknownGrade = rateKeys.find((key) => !(GRADES as readonly string[]).includes(key));
  if (unknownGrade) throw new SettingsError(`${unknownGrade} is not a condition grade.`);

  const buyRates = {} as Record<Grade, GradeRate>;
  for (const grade of BUYABLE_GRADES) {
    const row = input.buyRates[grade];
    if (!isRecord(row)) throw new SettingsError(`${grade} rates are missing.`);
    if (row.blocked === true) throw new SettingsError(`${grade} is buyable. It cannot be blocked.`);
    buyRates[grade] = {
      cashPercent: percent(row.cashPercent, `${grade} cash`),
      creditPercent: percent(row.creditPercent, `${grade} credit`),
      blocked: false,
    };
  }
  for (const grade of BLOCKED_GRADES) {
    const row = input.buyRates[grade];
    if (row != null && !isRecord(row)) throw new SettingsError(`${grade} rates are missing.`);
    if (row && row.blocked === false) throw new SettingsError(`${grade} is not buyable.`);
    if (row && (row.cashPercent != null || row.creditPercent != null)) {
      throw new SettingsError(`${grade} is not buyable, so it has no cash or credit rate.`);
    }
    buyRates[grade] = { cashPercent: null, creditPercent: null, blocked: true };
  }

  if (input.creditCostRule !== CREDIT_COST_RULE) {
    throw new SettingsError("Store-credit buys are costed at face value. Cost basis equals the store credit issued.");
  }

  if (!isRecord(input.paymentFees)) throw new SettingsError("Payment fees are missing.");
  const feeKeys = Object.keys(input.paymentFees);
  const unknownFee = feeKeys.find((key) => !PAYMENT_METHODS.some((method) => method.id === key));
  if (unknownFee) throw new SettingsError(`${unknownFee} is not a payment method.`);
  const paymentFees = {} as Record<PaymentMethodId, number | null>;
  for (const method of PAYMENT_METHODS) {
    if (!Object.prototype.hasOwnProperty.call(input.paymentFees, method.id)) {
      throw new SettingsError(`${method.label} fee is missing. Send null when it is unknown.`);
    }
    const fee = input.paymentFees[method.id];
    if (fee == null) {
      paymentFees[method.id] = null;
      continue;
    }
    if (typeof fee !== "number" || !Number.isInteger(fee) || fee < 0 || fee > 1_000_000) {
      throw new SettingsError(`${method.label} fee must be blank, or whole cents, zero or more. It is not guessed.`);
    }
    paymentFees[method.id] = fee;
  }

  if (!isRecord(input.thresholds)) throw new SettingsError("Thresholds are missing.");
  const thresholds: Thresholds = {
    lowStockOnHand: whole(input.thresholds.lowStockOnHand, "Low stock on hand", 0, 100_000),
    overstockSkuLimit: whole(input.thresholds.overstockSkuLimit, "Overstock per SKU", 0, 100_000),
    tcgplayerLevel: whole(input.thresholds.tcgplayerLevel, "TCGplayer level", 1, 4),
    slowMoverDays: whole(input.thresholds.slowMoverDays, "Slow mover days", 1, 3_650),
  };

  return { buyRates, creditCostRule: CREDIT_COST_RULE, paymentFees, thresholds };
}

export function buyPercent(
  settings: InventorySettings,
  grade: string,
  tender: "cash" | "credit",
): { ok: true; percent: number } | { ok: false; error: string } {
  if (!(GRADES as readonly string[]).includes(grade)) return { ok: false, error: "Condition must be NM, LP, MP, HP, or DMG." };
  const rate = settings.buyRates[grade as Grade];
  if (rate.blocked || rate.cashPercent == null || rate.creditPercent == null) {
    return { ok: false, error: `${grade} is not buyable. No offer can be typed for that grade.` };
  }
  return { ok: true, percent: tender === "cash" ? rate.cashPercent : rate.creditPercent };
}

/** Face value. The unit cost of a credit buy is the store credit issued, in cents. */
export function creditCostCents(storeCreditIssuedCents: number): number {
  if (!Number.isInteger(storeCreditIssuedCents) || storeCreditIssuedCents < 0) {
    throw new SettingsError("Store credit issued must be whole cents, zero or more.");
  }
  return storeCreditIssuedCents;
}

function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function offerPreview(settings: InventorySettings, marketCents = 1000): string {
  const pay = (grade: "NM" | "LP", tender: "cash" | "credit") => {
    const quote = buyPercent(settings, grade, tender);
    if (!quote.ok) return "no offer";
    return money(Math.round(marketCents * quote.percent / 100));
  };
  const credit = buyPercent(settings, "NM", "credit");
  const creditCents = credit.ok ? Math.round(marketCents * credit.percent / 100) : 0;
  return `On a ${money(marketCents)} market price, NM cash pays ${pay("NM", "cash")} and NM credit pays ${pay("NM", "credit")}. That credit's cost basis is ${money(creditCents)}, the same amount as the store credit issued. LP cash pays ${pay("LP", "cash")} and LP credit pays ${pay("LP", "credit")}. MP, HP and DMG are not bought.`;
}

export type SettingsGradeView = {
  grade: Grade;
  label: string;
  blocked: boolean;
  cashPercent: number | null;
  creditPercent: number | null;
};

export type SettingsView = {
  settings: InventorySettings;
  grades: SettingsGradeView[];
  paymentMethods: { id: PaymentMethodId; label: string; feeCents: number | null }[];
  creditCostNote: string;
  tcgplayerLevelNote: string;
  offerPreview: string;
};

export function presentSettings(settings: InventorySettings): SettingsView {
  return {
    settings,
    grades: GRADES.map((grade) => ({
      grade,
      label: GRADE_LABELS[grade],
      blocked: settings.buyRates[grade].blocked,
      cashPercent: settings.buyRates[grade].cashPercent,
      creditPercent: settings.buyRates[grade].creditPercent,
    })),
    paymentMethods: PAYMENT_METHODS.map((method) => ({ id: method.id, label: method.label, feeCents: settings.paymentFees[method.id] })),
    creditCostNote: CREDIT_COST_NOTE,
    tcgplayerLevelNote: TCGPLAYER_LEVEL_NOTE,
    offerPreview: offerPreview(settings),
  };
}

/** Map a database row. Missing phase-2 columns are not handled here. */
export function settingsFromRow(row: Record<string, unknown>): InventorySettings {
  const fees = isRecord(row.payment_fees) ? row.payment_fees : {};
  const paymentFees = {} as Record<PaymentMethodId, number | null>;
  for (const method of PAYMENT_METHODS) {
    const fee = fees[method.id];
    paymentFees[method.id] = fee == null ? null : Number(fee);
  }
  return validateInventorySettings({
    buyRates: {
      NM: { cashPercent: Number(row.nm_cash_percent), creditPercent: Number(row.nm_credit_percent), blocked: false },
      LP: { cashPercent: Number(row.lp_cash_percent), creditPercent: Number(row.lp_credit_percent), blocked: false },
      MP: { cashPercent: null, creditPercent: null, blocked: true },
      HP: { cashPercent: null, creditPercent: null, blocked: true },
      DMG: { cashPercent: null, creditPercent: null, blocked: true },
    },
    creditCostRule: row.credit_cost_rule,
    paymentFees,
    thresholds: {
      lowStockOnHand: Number(row.low_stock_on_hand),
      overstockSkuLimit: Number(row.overstock_sku_limit),
      tcgplayerLevel: Number(row.tcgplayer_level),
      slowMoverDays: Number(row.slow_mover_days),
    },
  });
}
