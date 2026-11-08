/**
 * Sales log and the shared-Qty decrement.
 *
 * Every sold line from CardTrader or starfoil.store becomes one `sales` row, keyed on
 * (tenant, platform, order, line) so webhooks, polls and retries can all deliver the same sale safely.
 *
 * The Airtable Waitlist row's Qty is the one shared inventory record. Exactly one system lowers it for
 * each sale, recorded per row in `decrement_owner`:
 *   - starfoil.store sales: always starfoil-lgs (it lowers CardTrader and Airtable at checkout).
 *   - CardTrader sales: starfoil-lgs until the hand-over time, Hekla from then on (CT_DECREMENT_FROM).
 * Hekla never cancels an order and never raises a Qty on its own.
 */
import { CARDTRADER_GAMES } from "./cardtrader.ts";
import type { Game } from "./sets.ts";

export type Platform = "cardtrader" | "starfoil" | "allocation";
export const PLATFORMS: readonly Platform[] = ["cardtrader", "starfoil", "allocation"];
export type DecrementOwner = "starfoil" | "hekla" | "none";

export type SaleLine = {
  platform: Platform;
  externalOrderId: string;
  orderCode: string | null;
  lineKey: string;
  recordId: string | null;
  game: string | null;
  cardName: string | null;
  qty: number;
  currency: string;
  grossCents: number;
  feeCents: number | null;
  netCents: number | null;
  soldAt: string;
  orderState: string | null;
  decrementOwner: DecrementOwner;
  raw: unknown;
};

type J = Record<string, any>;
const RECORD_ID = /^rec[A-Za-z0-9]{14}$/;
export const isRecordId = (value: unknown): value is string => typeof value === "string" && RECORD_ID.test(value);

/* ---------- money ---------- */

/**
 * Splits an order-level amount (a fee) across lines in proportion to their weight (gross), so the parts
 * add up to exactly the total. Largest-remainder rounding; ties go to the earlier line.
 */
export function allocate(total: number | null | undefined, weights: number[]): (number | null)[] {
  if (total == null || !Number.isFinite(total)) return weights.map(() => null);
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (weights.length === 0) return [];
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? Math.round(total) : 0));
  const whole = Math.round(total);
  const exact = weights.map((w) => (Math.max(0, w) / sum) * whole);
  const parts = exact.map((x) => Math.floor(x));
  let left = whole - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) parts[order[k]!.i]! += 1;
  return parts;
}

const cents = (money: unknown): number | null => {
  const value = (money as J | null)?.cents;
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
};

/* ---------- CardTrader orders ---------- */

/** Order states in which the cards have been bought (same list starfoil-lgs uses). */
export const CT_SOLD_STATES = new Set(["paid", "sent", "arrived", "done", "hub_pending", "closed", "lost"]);
export const CT_CANCELLED_STATES = new Set(["canceled", "cancelled"]);

const GAME_BY_CT_ID = new Map<number, Game>(Object.entries(CARDTRADER_GAMES).map(([game, cfg]) => [cfg.gameId, game as Game]));

/** When a CardTrader sale counts as sold: paid_at, else created_at. starfoil-lgs uses the same rule for the hand-over. */
export function cardTraderSoldAt(order: J, now = new Date()): string {
  for (const key of ["paid_at", "created_at"]) {
    const v = order?.[key];
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  }
  return now.toISOString();
}

/**
 * Who lowers the shared Qty for a CardTrader sale. Before the hand-over (or with no hand-over set) it is
 * starfoil-lgs; from CT_DECREMENT_FROM on, it is Hekla. starfoil-lgs is configured with the same instant as
 * CT_DECREMENT_UNTIL, so every order belongs to exactly one of them.
 */
export function cardTraderOwner(soldAt: string, decrementFrom: string | null): DecrementOwner {
  if (!decrementFrom) return "starfoil";
  const from = Date.parse(decrementFrom);
  if (Number.isNaN(from)) return "starfoil";
  return Date.parse(soldAt) >= from ? "hekla" : "starfoil";
}

/** The sold lines of one CardTrader order, or [] when it is not a sale (yet). */
export function cardTraderLines(order: J, decrementFrom: string | null, now = new Date()): SaleLine[] {
  if (!order || typeof order !== "object" || order.order_as !== "seller") return [];
  const state = typeof order.state === "string" ? order.state : null;
  if (!state || !CT_SOLD_STATES.has(state)) return [];
  const items: J[] = Array.isArray(order.order_items) ? order.order_items.filter((i: J) => Number(i?.quantity) > 0) : [];
  if (items.length === 0) return [];
  const gross = items.map((i) => (cents(i.seller_price) ?? 0) * Math.round(Number(i.quantity)));
  const fees = allocate(cents(order.seller_fee_amount), gross);
  const soldAt = cardTraderSoldAt(order, now);
  const owner = cardTraderOwner(soldAt, decrementFrom);
  return items.map((item, i) => {
    const fee = fees[i] ?? null;
    return {
      platform: "cardtrader" as const,
      externalOrderId: String(order.id),
      orderCode: typeof order.code === "string" ? order.code : null,
      lineKey: String(item.id ?? `${item.product_id}:${i}`),
      recordId: isRecordId(item.user_data_field) ? item.user_data_field : null,
      game: GAME_BY_CT_ID.get(Number(item.game_id)) ?? null,
      cardName: typeof item.name === "string" ? item.name.slice(0, 200) : null,
      qty: Math.round(Number(item.quantity)),
      currency: String(item.seller_price?.currency ?? order.seller_subtotal?.currency ?? "USD"),
      grossCents: gross[i]!,
      feeCents: fee,
      netCents: fee == null ? null : gross[i]! - fee,
      soldAt,
      orderState: state,
      // A line with no Airtable record has nothing to lower.
      decrementOwner: isRecordId(item.user_data_field) ? owner : "none",
      raw: { order: { id: order.id, code: order.code, state, paid_at: order.paid_at, seller_subtotal: order.seller_subtotal, seller_fee_amount: order.seller_fee_amount, seller_total: order.seller_total, fee_percentage: order.fee_percentage }, item },
    };
  });
}

/* ---------- starfoil.store sales ---------- */

export type StarfoilEvent = {
  orderId: string;
  paidAt: string;
  currency?: string;
  subtotalCents?: number;
  shippingCents?: number;
  taxCents?: number;
  totalCents?: number;
  /** The Stripe fee for the whole order, when starfoil could read it. */
  feeCents?: number | null;
  items: { lineKey: string; recordId?: string | null; game?: string | null; name: string; qty: number; unitCents: number; stockResult?: string | null }[];
};

/** Validates a starfoil.store sale event. starfoil-lgs has already lowered CardTrader and Airtable for it. */
export function starfoilLines(input: unknown): { ok: true; lines: SaleLine[] } | { ok: false; error: string } {
  const e = input as J;
  if (!e || typeof e !== "object") return { ok: false, error: "Expected a sale object." };
  if (typeof e.orderId !== "string" || !/^[A-Za-z0-9_-]{4,80}$/.test(e.orderId)) return { ok: false, error: "orderId is missing." };
  if (typeof e.paidAt !== "string" || Number.isNaN(Date.parse(e.paidAt))) return { ok: false, error: "paidAt is missing." };
  if (!Array.isArray(e.items) || e.items.length === 0 || e.items.length > 200) return { ok: false, error: "items must list 1 to 200 lines." };
  const keys = new Set<string>();
  for (const item of e.items as J[]) {
    if (typeof item?.lineKey !== "string" || !item.lineKey || item.lineKey.length > 300) return { ok: false, error: "Every item needs a lineKey." };
    if (keys.has(item.lineKey)) return { ok: false, error: `Duplicate lineKey ${item.lineKey}.` };
    keys.add(item.lineKey);
    if (!Number.isInteger(item.qty) || item.qty < 1) return { ok: false, error: "qty must be a whole number of at least 1." };
    if (!Number.isInteger(item.unitCents) || item.unitCents < 0) return { ok: false, error: "unitCents must be whole cents." };
  }
  const items = e.items as StarfoilEvent["items"];
  const gross = items.map((i) => i.unitCents * i.qty);
  const fee = typeof e.feeCents === "number" && Number.isFinite(e.feeCents) && e.feeCents >= 0 ? e.feeCents : null;
  const fees = allocate(fee, gross);
  const soldAt = new Date(e.paidAt).toISOString();
  return {
    ok: true,
    lines: items.map((item, i) => ({
      platform: "starfoil" as const,
      externalOrderId: e.orderId,
      orderCode: e.orderId.slice(0, 8).toUpperCase(),
      lineKey: item.lineKey,
      recordId: isRecordId(item.recordId) ? item.recordId : null,
      game: typeof item.game === "string" ? item.game.slice(0, 60) : null,
      cardName: String(item.name ?? "").slice(0, 200) || null,
      qty: item.qty,
      currency: typeof e.currency === "string" ? e.currency.toUpperCase().slice(0, 3) : "USD",
      grossCents: gross[i]!,
      feeCents: fees[i] ?? null,
      netCents: fees[i] == null ? null : gross[i]! - fees[i]!,
      soldAt,
      orderState: "paid",
      decrementOwner: "starfoil" as const,
      raw: { order: { id: e.orderId, paidAt: e.paidAt, subtotalCents: e.subtotalCents, shippingCents: e.shippingCents, taxCents: e.taxCents, totalCents: e.totalCents, feeCents: fee }, item },
    })),
  };
}

/* ---------- the decrement ---------- */

export type DecrementPlan = { before: number; target: number; oversold: boolean; shortBy: number; soldOut: boolean };

/** What the shared Qty becomes after selling `qty` copies. It never goes below 0; going below is an oversell. */
export function planDecrement(current: number, qty: number): DecrementPlan {
  const before = Math.max(0, Math.round(current));
  const next = before - qty;
  return { before, target: Math.max(0, next), oversold: next < 0, shortBy: Math.max(0, -next), soldOut: next <= 0 };
}

/**
 * A decrement that was started but not confirmed (the Worker stopped between writing Airtable and the log).
 * If Airtable already shows the target, it happened; if it still shows the old Qty, do it again;
 * anything else means someone else changed the row, and a person decides.
 */
export function resolveRetry(before: number, target: number, current: number): "done" | "redo" | "conflict" {
  if (current === target) return "done";
  if (current === before) return "redo";
  return "conflict";
}

export type PendingDecrement = {
  id: number; recordId: string; qty: number; platform: Platform; externalOrderId: string; orderCode: string | null;
  cardName: string | null; qtyBefore: number | null; qtyTarget: number | null; started: boolean;
};
export type DecrementScope = { tenantId: string; recordId: string; holder: string };

export interface SaleStore {
  /** Inserts new lines and ignores ones already logged. Returns how many were new. */
  insertLines(tenantId: string, lines: SaleLine[]): Promise<number>;
  /** Marks an order's lines cancelled. Returns Hekla updates already started or finished, for review. */
  markCancelled(tenantId: string, platform: Platform, externalOrderId: string, at: string, state: string): Promise<{ id: number; recordId: string | null; qty: number; cardName: string | null }[]>;
  pendingDecrements(tenantId: string, limit: number): Promise<PendingDecrement[]>;
  pendingDecrement(scope: DecrementScope, id: number): Promise<PendingDecrement | null>;
  startDecrement(scope: DecrementScope, id: number, before: number, target: number): Promise<boolean>;
  finishDecrement(scope: DecrementScope, id: number, oversold: boolean, review: string | null): Promise<boolean>;
  flag(scope: DecrementScope, id: number, review: string): Promise<boolean>;
  acquireLock(tenantId: string, recordId: string, holder: string, seconds: number): Promise<boolean>;
  releaseLock(tenantId: string, recordId: string, holder: string): Promise<void>;
}

/** The shared inventory record. write() also sets Status = Sold when the Qty reaches 0. */
export interface StockRecord {
  read(recordId: string): Promise<number | null>;
  write(recordId: string, qty: number): Promise<void>;
}

export type Alert = { subject: string; text: string; key: string };
export type DecrementResult = { applied: number; oversold: number; skipped: number; flagged: number; alerts: Alert[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Lowers the shared Qty for every Hekla-owned sale not yet applied, one row at a time under a lease.
 * Discovery rows are only candidates: reload after locking and after the external read. Every database
 * transition checks the live lease and pending state. Unknown writes and expired in-flight leases require review.
 */
export async function applyPendingDecrements(store: SaleStore, stock: StockRecord, tenantId: string, opts: { limit?: number; holder?: string; lockWaitMs?: number } = {}): Promise<DecrementResult> {
  const result: DecrementResult = { applied: 0, oversold: 0, skipped: 0, flagged: 0, alerts: [] };
  const holder = opts.holder ?? crypto.randomUUID();
  const pending = await store.pendingDecrements(tenantId, opts.limit ?? 50);
  for (const candidate of pending) {
    const scope = { tenantId, recordId: candidate.recordId, holder };
    let locked = false;
    for (let attempt = 0; attempt < 3 && !locked; attempt++) {
      locked = await store.acquireLock(tenantId, candidate.recordId, holder, 60);
      if (!locked && attempt < 2) await sleep(opts.lockWaitMs ?? 300);
    }
    if (!locked) { result.skipped++; continue; } // another run holds it; the next run picks this row up
    let releaseSafe = true;
    try {
      let row = await store.pendingDecrement(scope, candidate.id);
      if (!row) { result.skipped++; continue; }
      const current = await stock.read(row.recordId);
      // Cancellation, completion, review state or lease ownership may have changed during the read.
      row = await store.pendingDecrement(scope, candidate.id);
      if (!row) { result.skipped++; continue; }
      if (current == null) {
        if (!await store.flag(scope, row.id, "The Airtable row is gone, so its Qty could not be lowered.")) { result.skipped++; continue; }
        result.flagged++;
        result.alerts.push(alertFor(row, `The Waitlist row ${row.recordId} for this sale no longer exists. Nothing was changed.`, `missing:${row.id}`));
        continue;
      }
      if (row.started && (row.qtyBefore == null || row.qtyTarget == null)) {
        if (await store.flag(scope, row.id, "The saved stock update is incomplete. Check the sale and stock before retrying.")) result.flagged++;
        else result.skipped++;
        continue;
      }
      if (row.started && row.qtyBefore != null && row.qtyTarget != null) {
        const retry = resolveRetry(row.qtyBefore, row.qtyTarget, current);
        if (retry === "done") {
          const oversold = row.qtyBefore < row.qty;
          if (await store.finishDecrement(scope, row.id, oversold, oversold ? `Oversold by ${row.qty - row.qtyBefore}: Qty was ${row.qtyBefore}, this sale took ${row.qty}.` : null)) {
            result.applied++;
            if (oversold) {
              result.oversold++;
              result.alerts.push(alertFor(row, `This sale took ${row.qty} but Qty was ${row.qtyBefore}. Its completed stock update has been recovered; check fulfilment. Nothing was cancelled.`, `oversold:${row.id}`, true));
            }
          } else result.skipped++;
          continue;
        }
        if (retry === "conflict") {
          if (!await store.flag(scope, row.id, `Qty was ${row.qtyBefore}, Hekla meant to set ${row.qtyTarget}, Airtable now shows ${current}. Check by hand.`)) { result.skipped++; continue; }
          result.flagged++;
          result.alerts.push(alertFor(row, `Hekla was lowering Qty for this sale when the row changed underneath it (was ${row.qtyBefore}, meant ${row.qtyTarget}, now ${current}). Nothing more was changed; please check the row.`, `conflict:${row.id}`));
          continue;
        }
      }
      const plan = planDecrement(current, row.qty);
      if (!await store.startDecrement(scope, row.id, plan.before, plan.target)) { result.skipped++; continue; }
      releaseSafe = false;
      try { await stock.write(row.recordId, plan.target); }
      catch {
        const message = "The stock write outcome is unknown. Check Airtable and this sale before clearing review; Hekla will not retry it automatically.";
        if (await store.flag(scope, row.id, message)) {
          releaseSafe = true;
          result.flagged++;
          result.alerts.push(alertFor(row, message, `unknown-write:${row.id}`));
        } else result.skipped++;
        continue;
      }
      releaseSafe = true;
      const review = plan.oversold ? `Oversold by ${plan.shortBy}: Qty was ${plan.before}, this sale took ${row.qty}.` : null;
      if (!await store.finishDecrement(scope, row.id, plan.oversold, review)) { result.skipped++; continue; }
      result.applied++;
      if (plan.oversold) {
        result.oversold++;
        result.alerts.push(alertFor(row, `This sale took ${row.qty} but the shared Qty was only ${plan.before}, so ${plan.shortBy} cop${plan.shortBy === 1 ? "y was" : "ies were"} sold that you may not have. Qty is now 0. Nothing was cancelled; decide whether to cancel or fulfil.`, `oversold:${row.id}`, true));
      }
    } finally {
      // If recording an unknown outcome also failed, leave the lease: expired in-flight work cannot be stolen.
      if (releaseSafe) await store.releaseLock(tenantId, candidate.recordId, holder).catch(() => undefined);
    }
  }
  return result;
}

function alertFor(row: PendingDecrement, what: string, key: string, oversold = false): Alert {
  const where = row.platform === "cardtrader" ? "CardTrader" : row.platform === "allocation" ? "Deck sale" : "starfoil.store";
  return {
    key,
    subject: `${oversold ? "OVERSOLD: " : "Check: "}${row.cardName ?? row.recordId} · ${where} order ${row.orderCode ?? row.externalOrderId}`,
    text: [
      what,
      "",
      `Card: ${row.cardName ?? "—"}`,
      `Waitlist row: ${row.recordId}`,
      `Platform: ${where}, order ${row.orderCode ?? row.externalOrderId}`,
      `Quantity sold: ${row.qty}`,
    ].join("\n"),
  };
}

/* ---------- CSV ---------- */

/** One CSV cell. Text that a spreadsheet would run as a formula is prefixed with an apostrophe. */
export function csvCell(value: unknown): string {
  if (value == null) return "";
  let s = typeof value === "number" ? String(value) : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvRow = (cells: unknown[]): string => cells.map(csvCell).join(",");

/* ---------- filters for the sales page ---------- */

export type SalesFilter = { platform: Platform | null; from: string | null; to: string | null; game: string | null; q: string | null; includeCancelled: boolean };

const day = (v: string | undefined): string | null => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);

/** Reads the page's query string. Dates are whole days in America/New_York, inclusive. */
export function readSalesFilter(q: Record<string, string | undefined>): SalesFilter {
  const platform = PLATFORMS.includes(q.platform as Platform) ? (q.platform as Platform) : null;
  const text = (v: string | undefined, max: number) => (v?.trim() ? v.trim().slice(0, max) : null);
  return { platform, from: day(q.from), to: day(q.to), game: text(q.game, 60), q: text(q.q, 120), includeCancelled: q.cancelled === "1" };
}

export const SALES_CSV_HEADER = ["Sold at (UTC)", "Platform", "Order", "Order code", "Line", "Waitlist record", "Game", "Card", "Qty", "Currency", "Gross", "Fees", "Net payout", "State", "Cancelled at", "Lowered by", "Oversold", "Needs review"];

export type SaleRow = {
  id: number; platform: Platform; externalOrderId: string; orderCode: string | null; lineKey: string; recordId: string | null;
  game: string | null; cardName: string | null; qty: number; currency: string; grossCents: number; feeCents: number | null; netCents: number | null;
  soldAt: string; orderState: string | null; cancelledAt: string | null; decrementOwner: DecrementOwner; decrementedAt: string | null; oversold: boolean; needsReview: string | null;
};

const money = (c: number | null) => (c == null ? null : (c / 100).toFixed(2));
export function salesCsv(rows: SaleRow[]): string {
  const lines = [csvRow(SALES_CSV_HEADER)];
  for (const r of rows) {
    lines.push(csvRow([r.soldAt, r.platform, r.externalOrderId, r.orderCode, r.lineKey, r.recordId, r.game, r.cardName, r.qty, r.currency, money(r.grossCents), money(r.feeCents), money(r.netCents), r.orderState, r.cancelledAt, r.decrementOwner, r.oversold ? "yes" : "", r.needsReview]));
  }
  return lines.join("\r\n") + "\r\n";
}

export type PlatformTotals = { platform: Platform; currency: string; orders: number; lines: number; qty: number; grossCents: number; feeCents: number; netCents: number; unknownFeeLines: number };

/** Totals per platform and currency over non-cancelled lines. Lines with an unknown fee count toward gross only. */
export function totalsByPlatform(rows: SaleRow[]): PlatformTotals[] {
  const map = new Map<string, PlatformTotals & { orderIds: Set<string> }>();
  for (const r of rows) {
    if (r.cancelledAt) continue;
    const key = `${r.platform}|${r.currency}`;
    const t = map.get(key) ?? { platform: r.platform, currency: r.currency, orders: 0, lines: 0, qty: 0, grossCents: 0, feeCents: 0, netCents: 0, unknownFeeLines: 0, orderIds: new Set<string>() };
    t.orderIds.add(r.externalOrderId);
    t.lines++; t.qty += r.qty; t.grossCents += r.grossCents;
    if (r.feeCents == null) { t.unknownFeeLines++; t.netCents += r.grossCents; } else { t.feeCents += r.feeCents; t.netCents += r.netCents ?? r.grossCents - r.feeCents; }
    map.set(key, t);
  }
  return [...map.values()].map(({ orderIds, ...t }) => ({ ...t, orders: orderIds.size })).sort((a, b) => a.platform.localeCompare(b.platform) || a.currency.localeCompare(b.currency));
}
