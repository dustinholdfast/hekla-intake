/** Neon persistence for purchases and store credit. Inserts follow the unique keys. Nothing here calls Airtable. */
import { insertMovements } from "./inventorydb.ts";
import { db } from "./tenants.ts";
import type { CreditEntry, PurchaseDraft, PurchaseLine, ReceiptPlan } from "./purchases.ts";

export function isMissingPurchases(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /purchases|purchase_lines|stock_lots|store_credit_entries|lot_id/.test(message) && /does not exist|undefined_table|undefined_column|42P01|42703/i.test(message);
}

export async function readLiability(env: Env, tenantId: string): Promise<{ outstandingCents: number; customers: number; entries: number }> {
  const rows = await db(env).query(
    `select coalesce(sum(amount_cents), 0)::int as outstanding, count(*)::int as entries, count(distinct customer_ref)::int as customers
     from store_credit_entries where tenant_id = $1`,
    [tenantId],
  );
  const row = rows[0] ?? {};
  return {
    outstandingCents: Number(row.outstanding ?? 0),
    customers: Number(row.customers ?? 0),
    entries: Number(row.entries ?? 0),
  };
}

export async function listCredit(env: Env, tenantId: string): Promise<CreditEntry[]> {
  const rows = await db(env).query(
    `select id, tenant_id, customer_ref, amount_cents, entry_kind, source_kind, source_ref, occurred_on, balance_after_cents, created_at
     from store_credit_entries where tenant_id = $1 order by created_at, id`,
    [tenantId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    customerRef: String(row.customer_ref),
    amountCents: Number(row.amount_cents),
    entryKind: row.entry_kind === "redemption" ? "redemption" : "issue",
    sourceKind: String(row.source_kind),
    sourceRef: String(row.source_ref),
    occurredOn: String(row.occurred_on).slice(0, 10),
    balanceAfterCents: Number(row.balance_after_cents),
    createdAt: new Date(row.created_at as string).toISOString(),
  }));
}

function lineToRow(purchaseId: string, line: PurchaseLine, sellRequestId: string, tenantId: string): unknown[] {
  return [
    tenantId, purchaseId, sellRequestId, line.lineNo, line.raw, line.game, line.item, line.setName, line.setIdentity,
    line.collectorNumber, line.finish, line.finishStored, line.language, line.condition, line.qty, line.marketRefCents,
    line.marketRefSource, line.ratePercent, line.offerCents, line.cashCents, line.creditCents, line.costTotalCents,
    line.unitCostCents, line.costRule, line.buyListId, line.buyListKind, line.buyListStatus, line.stockRecordId,
    line.onHand, line.unknownCostQty, line.costBasisCents, line.stockStatus, line.review, line.status, line.wantQty,
  ];
}

const LINE_INSERT = `insert into purchase_lines (
  tenant_id, purchase_id, sell_request_id, line_no, raw_line, game, item, set_name, set_identity,
  collector_number, finish, finish_stored, language, condition, qty, market_ref_cents, market_ref_source,
  rate_percent, offer_cents, cash_cents, credit_cents, cost_total_cents, unit_cost_cents, cost_rule,
  buy_list_id, buy_list_kind, buy_list_status, stock_record_id, on_hand, unknown_cost_qty, cost_basis_cents,
  stock_status, review, status, want_before
) values (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35
)`;

export async function saveAcceptance(env: Env, purchase: PurchaseDraft): Promise<{ id: string; created: boolean }> {
  const sql = db(env);
  const inserted = await sql.query(
    `insert into purchases (tenant_id, sell_request_id, sell_request_ref, payout, payment_type, offer_cents, status)
     values ($1, $2, $3, $4, $5, $6, 'accepted')
     on conflict (tenant_id, sell_request_id) do nothing
     returning id`,
    [purchase.tenantId, purchase.sellRequestId, purchase.sellRequestRef, purchase.payout, purchase.paymentType, purchase.offerCents],
  );
  const existing = inserted[0] ?? (await sql.query(
    `select id, status from purchases where tenant_id = $1 and sell_request_id = $2`,
    [purchase.tenantId, purchase.sellRequestId],
  ))[0];
  if (!existing) throw new Error("The purchase could not be saved.");
  const id = String(existing.id);
  if (!inserted[0]) {
    if (existing.status !== "accepted") return { id, created: false };
    await sql.query(
      `update purchases set sell_request_ref = $3, payout = $4, payment_type = $5, offer_cents = $6, updated_at = now()
       where id = $1 and tenant_id = $2 and status = 'accepted'`,
      [id, purchase.tenantId, purchase.sellRequestRef, purchase.payout, purchase.paymentType, purchase.offerCents],
    );
    await sql.query(`delete from purchase_lines where purchase_id = $1 and status = 'accepted'`, [id]);
  }
  for (const line of purchase.lines) {
    await sql.query(LINE_INSERT, lineToRow(id, line, purchase.sellRequestId, purchase.tenantId));
  }
  return { id, created: Boolean(inserted[0]) };
}

function asLine(row: Record<string, unknown>): PurchaseLine {
  return {
    lineNo: Number(row.line_no),
    raw: String(row.raw_line ?? ""),
    item: String(row.item ?? ""),
    game: row.game == null ? null : String(row.game),
    setName: row.set_name == null ? null : String(row.set_name),
    setIdentity: row.set_identity == null ? null : String(row.set_identity),
    collectorNumber: row.collector_number == null ? null : String(row.collector_number),
    finish: row.finish == null ? null : String(row.finish),
    finishStored: row.finish_stored == null ? null : String(row.finish_stored),
    language: String(row.language ?? "English"),
    condition: String(row.condition),
    qty: Number(row.qty),
    marketRefCents: Number(row.market_ref_cents ?? 0),
    marketRefSource: String(row.market_ref_source ?? ""),
    ratePercent: Number(row.rate_percent ?? 0),
    offerCents: Number(row.offer_cents ?? 0),
    cashCents: Number(row.cash_cents ?? 0),
    creditCents: Number(row.credit_cents ?? 0),
    costTotalCents: Number(row.cost_total_cents ?? 0),
    unitCostCents: Number(row.unit_cost_cents ?? 0),
    costRule: String(row.cost_rule ?? ""),
    buyListId: row.buy_list_id == null ? null : String(row.buy_list_id),
    buyListLabel: null,
    wantQty: row.want_before == null ? null : Number(row.want_before),
    buyListStatus: row.buy_list_status == null ? null : String(row.buy_list_status),
    buyListKind: row.buy_list_kind == null ? null : String(row.buy_list_kind),
    stockRecordId: row.stock_record_id == null ? null : String(row.stock_record_id),
    onHand: row.on_hand == null ? null : Number(row.on_hand),
    unknownCostQty: row.unknown_cost_qty == null ? null : Number(row.unknown_cost_qty),
    costBasisCents: row.cost_basis_cents == null ? null : Number(row.cost_basis_cents),
    stockStatus: row.stock_status == null ? null : String(row.stock_status),
    status: row.status === "received" || row.status === "rejected" ? row.status : "accepted",
    receivedCondition: row.received_condition == null ? null : String(row.received_condition),
    wantAfter: row.want_after == null ? null : Number(row.want_after),
    wantWrite: row.want_decremented_at != null,
    wantStatusAfter: null,
    overstockQty: row.overstock_qty == null ? null : Number(row.overstock_qty),
    movementSourceRef: row.movement_source_ref == null ? null : String(row.movement_source_ref),
    review: row.review == null ? null : String(row.review),
  };
}

export async function loadPurchase(env: Env, tenantId: string, sellRequestId: string): Promise<PurchaseDraft | null> {
  const sql = db(env);
  const rows = await sql.query(`select * from purchases where tenant_id = $1 and sell_request_id = $2`, [tenantId, sellRequestId]);
  const purchase = rows[0];
  if (!purchase) return null;
  const lines = await sql.query(`select * from purchase_lines where purchase_id = $1 order by line_no`, [purchase.id]);
  const status = purchase.status === "received" || purchase.status === "partial" || purchase.status === "cancelled" ? purchase.status : "accepted";
  return {
    id: String(purchase.id),
    tenantId,
    sellRequestId: String(purchase.sell_request_id),
    sellRequestRef: String(purchase.sell_request_ref),
    payout: String(purchase.payout),
    paymentType: purchase.payment_type === "store_credit" ? "store_credit" : "cash",
    offerCents: Number(purchase.offer_cents),
    status,
    lines: lines.map(asLine),
  };
}

export async function saveReceipt(env: Env, plan: ReceiptPlan): Promise<{ movementsInserted: number; creditsInserted: number }> {
  const sql = db(env);
  const purchase = plan.purchase;
  await sql.query(
    `update purchases set status = $3, received_at = coalesce(received_at, now()), updated_at = now() where tenant_id = $1 and sell_request_id = $2`,
    [purchase.tenantId, purchase.sellRequestId, purchase.status],
  );
  const ids = await sql.query(`select id, line_no from purchase_lines where tenant_id = $1 and sell_request_id = $2`, [purchase.tenantId, purchase.sellRequestId]);
  const byLine = new Map(ids.map((row) => [Number(row.line_no), String(row.id)]));
  for (const line of purchase.lines) {
    await sql.query(
      `update purchase_lines set status = $3, received_condition = $4, received_at = case when $3 = 'accepted' then received_at else now() end,
         stock_record_id = $5, want_before = $6, want_after = $7, overstock_qty = $8,
         want_decremented_at = case when $9 then now() else want_decremented_at end, movement_source_ref = $10
       where tenant_id = $1 and sell_request_id = $2 and line_no = $11`,
      [
        purchase.tenantId, purchase.sellRequestId, line.status, line.receivedCondition, line.stockRecordId,
        line.wantQty, line.wantAfter, line.overstockQty, line.wantWrite, line.movementSourceRef, line.lineNo,
      ],
    );
  }
  const movements = await insertMovements(env, plan.movements);
  let creditsInserted = 0;
  for (const entry of plan.credits) {
    const rows = await sql.query(
      `insert into store_credit_entries (tenant_id, customer_ref, amount_cents, entry_kind, source_kind, source_ref, occurred_on, balance_after_cents)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (tenant_id, source_kind, source_ref, entry_kind) do nothing
       returning id`,
      [entry.tenantId, entry.customerRef, entry.amountCents, entry.entryKind, entry.sourceKind, entry.sourceRef, entry.occurredOn, entry.balanceAfterCents],
    );
    creditsInserted += rows.length;
  }
  for (const lot of plan.lots) {
    const lineId = byLine.get(Number(lot.purchaseLineKey.split(":").pop()));
    await sql.query(
      `insert into stock_lots (tenant_id, record_id, qty_in, qty_left, unit_cost_cents, cost_total_cents, acquired_at, purchase_line_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (purchase_line_id) do nothing`,
      [lot.tenantId, lot.recordId, lot.qtyIn, lot.qtyLeft, lot.unitCostCents, lot.costTotalCents, lot.acquiredAt, lineId ?? null],
    );
  }
  return { movementsInserted: movements.inserted, creditsInserted };
}

export async function saveRedemption(env: Env, entry: CreditEntry): Promise<{ created: boolean }> {
  const rows = await db(env).query(
    `insert into store_credit_entries (tenant_id, customer_ref, amount_cents, entry_kind, source_kind, source_ref, occurred_on, balance_after_cents)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (tenant_id, source_kind, source_ref, entry_kind) do nothing
     returning id`,
    [entry.tenantId, entry.customerRef, entry.amountCents, entry.entryKind, entry.sourceKind, entry.sourceRef, entry.occurredOn, entry.balanceAfterCents],
  );
  return { created: rows.length > 0 };
}

export async function customerBalance(env: Env, tenantId: string, customerRef: string): Promise<number> {
  const rows = await db(env).query(
    `select coalesce(sum(amount_cents), 0)::int as balance from store_credit_entries where tenant_id = $1 and customer_ref = $2`,
    [tenantId, customerRef],
  );
  return Number(rows[0]?.balance ?? 0);
}
