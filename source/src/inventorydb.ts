/** Neon reads and appends for the inventory ledger. Inserts are idempotent. There is no update. */
import {
  DEFAULT_THRESHOLDS,
  validateMovement,
  type MovementDraft,
  type Thresholds,
} from "./inventory.ts";
import { defaultInventorySettings, settingsFromRow, type InventorySettings } from "./inventory-settings.ts";
import { db } from "./tenants.ts";

export const INSERT_MOVEMENTS_SQL = `insert into stock_movements (
  tenant_id, record_id, delta, qty_before, qty_after, reason, source_kind, source_ref,
  applied_by, unit_cost_cents, note, needs_review, snapshot, created_at
)
select tenant_id, record_id, delta, qty_before, qty_after, reason, source_kind, source_ref,
       applied_by, unit_cost_cents, note, needs_review, snapshot, created_at
from jsonb_to_recordset($1::jsonb) as x(
  tenant_id uuid, record_id text, delta integer, qty_before integer, qty_after integer,
  reason text, source_kind text, source_ref text, applied_by text, unit_cost_cents integer,
  note text, needs_review text, snapshot jsonb, created_at timestamptz
)
on conflict (tenant_id, source_kind, source_ref, reason) do nothing
returning id`;

const MOVEMENT_COLUMNS = `id, tenant_id, record_id, delta, qty_before, qty_after, reason, source_kind, source_ref,
  applied_by, unit_cost_cents, note, needs_review, snapshot, created_at`;

export function isMissingLedger(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /stock_movements|inventory_settings/.test(message) && /does not exist|undefined_table|42P01/i.test(message);
}

/** 0008 is applied and 0009 is not. The threshold columns still exist. */
export function isMissingPhase2Settings(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /nm_cash_percent|lp_cash_percent|credit_cost_rule|payment_fees/.test(message) && /does not exist|undefined_column|42703/i.test(message);
}

export const READ_INVENTORY_SETTINGS_SQL = `select low_stock_on_hand, overstock_sku_limit, tcgplayer_level, slow_mover_days,
  nm_cash_percent, nm_credit_percent, lp_cash_percent, lp_credit_percent, credit_cost_rule, payment_fees
  from inventory_settings where tenant_id = $1`;

export const SAVE_INVENTORY_SETTINGS_SQL = `insert into inventory_settings (
  tenant_id, low_stock_on_hand, overstock_sku_limit, tcgplayer_level, slow_mover_days,
  nm_cash_percent, nm_credit_percent, lp_cash_percent, lp_credit_percent,
  credit_cost_rule, payment_fees, updated_at
) values (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now()
)
on conflict (tenant_id) do update set
  low_stock_on_hand = excluded.low_stock_on_hand,
  overstock_sku_limit = excluded.overstock_sku_limit,
  tcgplayer_level = excluded.tcgplayer_level,
  slow_mover_days = excluded.slow_mover_days,
  nm_cash_percent = excluded.nm_cash_percent,
  nm_credit_percent = excluded.nm_credit_percent,
  lp_cash_percent = excluded.lp_cash_percent,
  lp_credit_percent = excluded.lp_credit_percent,
  credit_cost_rule = excluded.credit_cost_rule,
  payment_fees = excluded.payment_fees,
  updated_at = now()`;

function iso(value: unknown): string {
  return value == null ? new Date(0).toISOString() : new Date(value as string).toISOString();
}

function toMovement(row: Record<string, unknown>): MovementDraft {
  const snapshot = row.snapshot && typeof row.snapshot === "object" ? row.snapshot as MovementDraft["snapshot"] : null;
  return {
    tenantId: String(row.tenant_id),
    recordId: String(row.record_id),
    delta: Number(row.delta),
    qtyBefore: Number(row.qty_before),
    qtyAfter: Number(row.qty_after),
    reason: row.reason as MovementDraft["reason"],
    sourceKind: String(row.source_kind),
    sourceRef: String(row.source_ref),
    appliedBy: String(row.applied_by),
    unitCostCents: row.unit_cost_cents == null ? null : Number(row.unit_cost_cents),
    note: row.note == null ? null : String(row.note),
    needsReview: row.needs_review == null ? null : String(row.needs_review),
    snapshot,
    createdAt: iso(row.created_at),
  };
}

export async function listMovements(env: Env, tenantId: string): Promise<MovementDraft[]> {
  const rows = await db(env).query(
    `select ${MOVEMENT_COLUMNS} from stock_movements where tenant_id = $1 order by created_at, id limit 20000`,
    [tenantId],
  );
  return rows.map(toMovement);
}

export async function readThresholds(env: Env, tenantId: string): Promise<Thresholds> {
  const rows = await db(env).query(
    `select low_stock_on_hand, overstock_sku_limit, tcgplayer_level, slow_mover_days from inventory_settings where tenant_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return { ...DEFAULT_THRESHOLDS };
  return {
    lowStockOnHand: Number(row.low_stock_on_hand),
    overstockSkuLimit: Number(row.overstock_sku_limit),
    tcgplayerLevel: Number(row.tcgplayer_level),
    slowMoverDays: Number(row.slow_mover_days),
  };
}

function settingsParams(tenantId: string, settings: InventorySettings): unknown[] {
  return [
    tenantId,
    settings.thresholds.lowStockOnHand,
    settings.thresholds.overstockSkuLimit,
    settings.thresholds.tcgplayerLevel,
    settings.thresholds.slowMoverDays,
    settings.buyRates.NM.cashPercent,
    settings.buyRates.NM.creditPercent,
    settings.buyRates.LP.cashPercent,
    settings.buyRates.LP.creditPercent,
    settings.creditCostRule,
    JSON.stringify(settings.paymentFees),
  ];
}

/**
 * Full settings. When 0009 is not applied yet, thresholds still come from 0008 (or the approved defaults)
 * and the new fields stay at the approved defaults with phase2 false. Nothing is written in that case.
 */
export async function readInventorySettings(env: Env, tenantId: string): Promise<{ settings: InventorySettings; stored: boolean; phase2: boolean }> {
  try {
    const rows = await db(env).query(READ_INVENTORY_SETTINGS_SQL, [tenantId]);
    const row = rows[0];
    if (!row) return { settings: defaultInventorySettings(), stored: false, phase2: true };
    return { settings: settingsFromRow(row), stored: true, phase2: true };
  } catch (error) {
    if (!isMissingPhase2Settings(error)) throw error;
    const settings = defaultInventorySettings();
    settings.thresholds = await readThresholds(env, tenantId);
    return { settings, stored: false, phase2: false };
  }
}

/** Upsert. The same threshold columns drive /inventory flags. */
export async function saveInventorySettings(env: Env, tenantId: string, settings: InventorySettings): Promise<InventorySettings> {
  await db(env).query(SAVE_INVENTORY_SETTINGS_SQL, settingsParams(tenantId, settings));
  return settings;
}

/** Append movements. A repeated source event inserts nothing and leaves the first row unchanged. */
export async function insertMovements(env: Env, movements: readonly MovementDraft[]): Promise<{ inserted: number }> {
  for (const movement of movements) validateMovement(movement);
  let inserted = 0;
  for (let index = 0; index < movements.length; index += 100) {
    const chunk = movements.slice(index, index + 100).map((movement) => ({
      tenant_id: movement.tenantId,
      record_id: movement.recordId,
      delta: movement.delta,
      qty_before: movement.qtyBefore,
      qty_after: movement.qtyAfter,
      reason: movement.reason,
      source_kind: movement.sourceKind,
      source_ref: movement.sourceRef,
      applied_by: movement.appliedBy,
      unit_cost_cents: movement.unitCostCents,
      note: movement.note,
      needs_review: movement.needsReview,
      snapshot: movement.snapshot ?? {},
      created_at: movement.createdAt,
    }));
    const rows = await db(env).query(INSERT_MOVEMENTS_SQL, [JSON.stringify(chunk)]);
    inserted += rows.length;
  }
  return { inserted };
}
