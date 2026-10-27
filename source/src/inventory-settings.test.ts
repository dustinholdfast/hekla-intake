import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInventory, stockFlags } from "./inventory.ts";
import {
  READ_INVENTORY_SETTINGS_SQL,
  SAVE_INVENTORY_SETTINGS_SQL,
  isMissingPhase2Settings,
} from "./inventorydb.ts";
import {
  BLOCKED_GRADES,
  buyPercent,
  creditCostCents,
  defaultInventorySettings,
  offerPreview,
  settingsFromRow,
  validateInventorySettings,
  SettingsError,
} from "./inventory-settings.ts";

const NOW = new Date("2026-10-27T16:00:00.000Z");

function withRates(patch: Record<string, unknown>) {
  const base = defaultInventorySettings();
  return validateInventorySettings({ ...base, ...patch, buyRates: { ...base.buyRates, ...(patch.buyRates as object | undefined) } });
}

test("approved defaults: NM and LP rates, blocked grades, blank fees, flag thresholds, face-value credit", () => {
  const settings = validateInventorySettings(defaultInventorySettings());
  assert.deepEqual(settings.buyRates.NM, { cashPercent: 50, creditPercent: 65, blocked: false });
  assert.deepEqual(settings.buyRates.LP, { cashPercent: 40, creditPercent: 55, blocked: false });
  for (const grade of BLOCKED_GRADES) {
    assert.equal(settings.buyRates[grade].blocked, true);
    assert.equal(settings.buyRates[grade].cashPercent, null);
    assert.equal(settings.buyRates[grade].creditPercent, null);
    assert.equal(buyPercent(settings, grade, "cash").ok, false);
    assert.equal(buyPercent(settings, grade, "credit").ok, false);
  }
  assert.deepEqual(settings.paymentFees, { cash: null, card: null, venmo: null, paypal: null, cashapp: null, store_credit: null });
  assert.deepEqual(settings.thresholds, { lowStockOnHand: 0, overstockSkuLimit: 3, tcgplayerLevel: 1, slowMoverDays: 45 });
  assert.equal(settings.creditCostRule, "face_value");
  assert.equal(creditCostCents(650), 650);
  assert.match(offerPreview(settings), /NM cash pays \$5\.00/);
  assert.match(offerPreview(settings), /NM credit pays \$6\.50/);
  assert.match(offerPreview(settings), /cost basis is \$6\.50/);
  assert.match(offerPreview(settings), /LP cash pays \$4\.00/);
  assert.match(offerPreview(settings), /LP credit pays \$5\.50/);
});

test("rates must be whole percents from 0 to 100, and blocked grades stay blocked", () => {
  const base = defaultInventorySettings();
  assert.equal(withRates({ buyRates: { NM: { cashPercent: 0, creditPercent: 100, blocked: false } } }).buyRates.NM.cashPercent, 0);
  assert.throws(() => withRates({ buyRates: { NM: { cashPercent: 101, creditPercent: 65, blocked: false } } }), /NM cash must be a whole percent from 0 to 100/);
  assert.throws(() => withRates({ buyRates: { LP: { cashPercent: -1, creditPercent: 55, blocked: false } } }), /LP cash/);
  assert.throws(() => withRates({ buyRates: { NM: { cashPercent: 50.5, creditPercent: 65, blocked: false } } }), /NM cash/);
  assert.throws(() => withRates({ buyRates: { NM: { cashPercent: 50, creditPercent: 65, blocked: true } } }), /NM is buyable/);
  assert.throws(() => withRates({ buyRates: { MP: { cashPercent: 30, creditPercent: 40, blocked: false } } }), /MP is not buyable/);
  assert.throws(() => withRates({ buyRates: { HP: { cashPercent: null, creditPercent: 10, blocked: true } } }), /HP is not buyable, so it has no cash or credit rate/);
  assert.throws(() => withRates({ buyRates: { DMG: { cashPercent: null, creditPercent: null, blocked: false } } }), /DMG is not buyable/);
  assert.throws(() => validateInventorySettings({ ...base, creditCostRule: "unknown" }), /face value/);
  assert.throws(() => creditCostCents(1.5), SettingsError);
});

test("processor fees stay blank until set, and 0 is an explicit zero rather than a guess", () => {
  const base = defaultInventorySettings();
  const blank = validateInventorySettings(base);
  assert.equal(blank.paymentFees.venmo, null);
  assert.equal(blank.paymentFees.cashapp, null);
  const zero = validateInventorySettings({ ...base, paymentFees: { ...base.paymentFees, cash: 0, venmo: 30 } });
  assert.equal(zero.paymentFees.cash, 0);
  assert.equal(zero.paymentFees.venmo, 30);
  assert.equal(zero.paymentFees.paypal, null);
  assert.throws(() => validateInventorySettings({ ...base, paymentFees: { ...base.paymentFees, card: -1 } }), /Card fee/);
  assert.throws(() => validateInventorySettings({ ...base, paymentFees: { ...base.paymentFees, paypal: 1.5 } }), /PayPal fee/);
  assert.throws(() => validateInventorySettings({ ...base, paymentFees: { ...base.paymentFees, cashapp: "0.30" } }), /CashApp fee/);
  const { cash: _cash, ...rest } = base.paymentFees;
  assert.throws(() => validateInventorySettings({ ...base, paymentFees: rest }), /Cash fee is missing/);
});

test("inventory flags read the settings thresholds", () => {
  const settings = defaultInventorySettings();
  const flags = (over: Parameters<typeof stockFlags>[0]) => stockFlags({ ...over, thresholds: settings.thresholds });
  const age = { dateAcquired: null, firstSeen: null, lastSaleAt: null, now: NOW };
  assert.equal(flags({ onHand: 0, wantQty: 2, ...age }).low, true);
  assert.equal(flags({ onHand: 1, wantQty: 2, ...age }).low, false);
  assert.equal(flags({ onHand: 4, wantQty: null, ...age }).overstock, true);
  const levelTwo = validateInventorySettings({ ...settings, thresholds: { ...settings.thresholds, tcgplayerLevel: 2 } });
  assert.equal(stockFlags({ onHand: 4, wantQty: null, thresholds: levelTwo.thresholds, ...age }).overstock, false);
  assert.equal(stockFlags({ onHand: 4, wantQty: 2, thresholds: levelTwo.thresholds, ...age }).overstock, true);
  assert.equal(buildInventory([], [], settings.thresholds, NOW).thresholdSource, "inventory_settings");
  assert.throws(() => validateInventorySettings({ ...settings, thresholds: { ...settings.thresholds, tcgplayerLevel: 0 } }), /TCGplayer level/);
  assert.throws(() => validateInventorySettings({ ...settings, thresholds: { ...settings.thresholds, slowMoverDays: 0 } }), /Slow mover/);
  assert.throws(() => validateInventorySettings({ ...settings, thresholds: { ...settings.thresholds, lowStockOnHand: -1 } }), /Low stock/);
});

test("a settings row maps back to the same decided values", () => {
  const settings = settingsFromRow({
    nm_cash_percent: 50,
    nm_credit_percent: 65,
    lp_cash_percent: 40,
    lp_credit_percent: 55,
    credit_cost_rule: "face_value",
    payment_fees: { cash: 0, venmo: null },
    low_stock_on_hand: 0,
    overstock_sku_limit: 3,
    tcgplayer_level: 1,
    slow_mover_days: 45,
  });
  assert.equal(settings.buyRates.NM.cashPercent, 50);
  assert.equal(settings.paymentFees.cash, 0);
  assert.equal(settings.paymentFees.venmo, null);
  assert.equal(settings.paymentFees.card, null);
  assert.match(SAVE_INVENTORY_SETTINGS_SQL, /nm_cash_percent/);
  assert.match(SAVE_INVENTORY_SETTINGS_SQL, /low_stock_on_hand/);
  assert.match(SAVE_INVENTORY_SETTINGS_SQL, /payment_fees/);
  assert.match(READ_INVENTORY_SETTINGS_SQL, /slow_mover_days/);
  assert.doesNotMatch(SAVE_INVENTORY_SETTINGS_SQL, /delete from/i);
  assert.equal(isMissingPhase2Settings(new Error('column "nm_cash_percent" of relation "inventory_settings" does not exist')), true);
  assert.equal(isMissingPhase2Settings(new Error("password authentication failed")), false);
});
