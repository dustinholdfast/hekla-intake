/**
 * Glue between the pure sales logic and the outside world: CardTrader orders (webhook + poll), starfoil.store
 * sale events, Hekla's own decrements, the reconcile, and the TCGplayer pull list. Every entry point is
 * per tenant and safe to run twice.
 */
import { readStock, rowsWithListings, stockCardsByIds, writeStock, type StockCard } from "./airtable.ts";
import { deliverAlerts } from "./alerts.ts";
import { exportListings, incrementListing, sellerOrders } from "./cardtrader.ts";
import { connectionSecret } from "./connections.ts";
import { diffStock, planPushes, reconcileSummary, type Drift, type ReconcileReport } from "./reconcile.ts";
import { applyPendingDecrements, cardTraderLines, CT_CANCELLED_STATES, starfoilLines, type Alert, type DecrementResult } from "./sales.ts";
import { getState, neonSaleStore, salesSince, setState } from "./salesdb.ts";
import { buildPullList, pullEmailText, type PullItem } from "./tcgplayer.ts";
import { tenantEnv, type Tenant } from "./tenants.ts";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type SalesMode = "off" | "log" | "decrement";
export type ReconcileMode = "off" | "report" | "push";

/** CT_SALES_MODE: off (default) does nothing; log records CardTrader sales; decrement also lowers the shared Qty. */
export function salesMode(env: Env): SalesMode {
  const v = (env.CT_SALES_MODE ?? "").trim().toLowerCase();
  return v === "log" || v === "decrement" ? v : "off";
}
export function reconcileMode(env: Env): ReconcileMode {
  const v = (env.RECONCILE_MODE ?? "").trim().toLowerCase();
  return v === "report" || v === "push" ? v : "off";
}
/** The hand-over instant. Hekla only lowers Qty in decrement mode AND with a valid instant set. */
export function decrementFrom(env: Env): string | null {
  if (salesMode(env) !== "decrement") return null;
  const v = (env.CT_DECREMENT_FROM ?? "").trim();
  return v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
}
// What a cron tick runs. There is a single "*/5" trigger (one schedule is simpler to reason about); it
// carries enrichment on every 10th minute, the same cadence as the old "*/10".
// Any other cron string (e.g. an old "*/10" event) runs enrichment only.
export function cronJobs(cron: string, at: Date): { enrich: boolean; sales: boolean } {
  if (cron === "*/5 * * * *") return { enrich: at.getUTCMinutes() % 10 === 0, sales: true };
  return { enrich: true, sales: false };
}

export const dailyEmailOn = (env: Env) => (env.TCGPLAYER_DAILY_EMAIL ?? "").trim().toLowerCase() === "on";

/* ---------- CardTrader orders ---------- */

export type IngestResult = { orders: number; newLines: number; cancelled: number };

export async function ingestCardTraderOrders(env: Env, tenantId: string, orders: J[]): Promise<IngestResult> {
  const store = neonSaleStore(env);
  const from = decrementFrom(env);
  const result: IngestResult = { orders: 0, newLines: 0, cancelled: 0 };
  const alerts: Alert[] = [];
  const lines = [];
  for (const order of orders) {
    if (!order || order.order_as !== "seller") continue;
    result.orders++;
    if (CT_CANCELLED_STATES.has(String(order.state))) {
      const undone = await store.markCancelled(tenantId, "cardtrader", String(order.id), new Date().toISOString(), String(order.state));
      result.cancelled++;
      for (const line of undone) {
        alerts.push({
          key: `cancelled:${line.id}`,
          subject: `Cancelled during or after a stock update: ${line.cardName ?? line.recordId} · CardTrader order ${order.code ?? order.id}`,
          text: `CardTrader order ${order.code ?? order.id} was cancelled during or after Hekla's stock update for ${line.qty} copies of ${line.cardName ?? "this card"} (row ${line.recordId}).\nCheck the sale and the actual stock before restocking. Hekla does not add stock back automatically.`,
        });
      }
      continue;
    }
    lines.push(...cardTraderLines(order, from));
  }
  result.newLines = await store.insertLines(tenantId, lines);
  if (alerts.length) await deliverAlerts(env, tenantId, alerts);
  return result;
}

/** A verified CardTrader webhook. Test-mode events are ignored. */
export async function handleCardTraderEvent(env: Env, tenant: Tenant, event: J): Promise<IngestResult | null> {
  if (salesMode(env) === "off" || event?.mode === "test" || event?.object_class !== "Order") return null;
  const order = event.data && typeof event.data === "object" ? { ...event.data } : null;
  if (!order) return null;
  if (event.cause === "order.destroy") order.state = "canceled";
  const result = await ingestCardTraderOrders(env, tenant.id, [order]);
  await runDecrements(env, tenant);
  return result;
}

/** Poll fallback: the newest 50 seller orders. Cheap (one request) and idempotent. */
export async function pollCardTrader(env: Env, tenant: Tenant): Promise<IngestResult | null> {
  if (salesMode(env) === "off") return null;
  const token = await connectionSecret(env, tenant.id, "cardtrader");
  if (!token) return null;
  const orders = await sellerOrders(token, 50);
  const result = await ingestCardTraderOrders(env, tenant.id, orders);
  await setState(env, tenant.id, "cardtrader:last_poll", { at: new Date().toISOString(), ...result });
  return result;
}

/** Lowers the shared Qty for sales Hekla owns. Does nothing unless CT_SALES_MODE=decrement and CT_DECREMENT_FROM is set. */
export async function runDecrements(env: Env, tenant: Tenant): Promise<DecrementResult | null> {
  if (!decrementFrom(env)) return null;
  const scoped = tenantEnv(env, tenant);
  const result = await applyPendingDecrements(neonSaleStore(env), { read: (id) => readStock(scoped, id), write: (id, qty) => writeStock(scoped, id, qty) }, tenant.id);
  if (result.alerts.length) await deliverAlerts(env, tenant.id, result.alerts);
  return result;
}

/* ---------- starfoil.store ---------- */

export async function ingestStarfoil(env: Env, tenantId: string, body: unknown): Promise<{ ok: true; newLines: number } | { ok: false; error: string }> {
  const parsed = starfoilLines(body);
  if (!parsed.ok) return parsed;
  return { ok: true, newLines: await neonSaleStore(env).insertLines(tenantId, parsed.lines) };
}

/* ---------- reconcile ---------- */

export async function runReconcile(env: Env, tenant: Tenant, mode: ReconcileMode = reconcileMode(env)): Promise<ReconcileReport | null> {
  if (mode === "off") return null;
  const report: ReconcileReport = { at: new Date().toISOString(), checkedRows: 0, listings: 0, drift: [], pushed: [], errors: [] };
  const token = await connectionSecret(env, tenant.id, "cardtrader");
  if (!token) { report.errors.push("CardTrader is not connected."); await setState(env, tenant.id, "reconcile:last", report); return report; }
  const [rows, listings] = await Promise.all([rowsWithListings(tenantEnv(env, tenant)), exportListings(token)]);
  report.checkedRows = rows.length; report.listings = listings.length;
  report.drift = diffStock(rows, listings);
  const previous = await getState<ReconcileReport>(env, tenant.id, "reconcile:last");
  if (mode === "push") {
    for (const push of planPushes(report.drift, previous?.drift ?? null, listings)) {
      try { await incrementListing(token, push.listingId, push.delta); report.pushed.push(push); }
      catch (error) { report.errors.push(`Listing ${push.listingId}: ${error instanceof Error ? error.message : "failed"}`); }
    }
  }
  await setState(env, tenant.id, "reconcile:last", report);
  const alerts = report.drift.filter((d) => d.kind === "over_listed").map((d) => overListedAlert(d, mode, report));
  if (alerts.length) await deliverAlerts(env, tenant.id, alerts);
  console.log(JSON.stringify({ level: "info", event: "reconcile", tenantId: tenant.id, summary: reconcileSummary(report) }));
  return report;
}

function overListedAlert(d: Drift, mode: ReconcileMode, report: ReconcileReport): Alert {
  const lowered = report.pushed.filter((p) => p.recordId === d.recordId).reduce((n, p) => n - p.delta, 0);
  return {
    key: `overlisted:${d.recordId}:${d.airtableQty}:${d.cardTraderQty}`,
    subject: `CardTrader shows more than you have: ${d.name ?? d.recordId}`,
    text: [
      `CardTrader lists ${d.cardTraderQty} but the listable quantity is ${d.airtableQty} (Qty minus Reserved Qty). A buyer could buy a copy you do not have.`,
      lowered ? `Hekla lowered the CardTrader listing by ${lowered}.` : mode === "push" ? "Hekla will lower the listing if this is still true on the next check (15 minutes)." : "Reconcile is in report mode, so nothing was changed.",
      "", `Waitlist row: ${d.recordId}`, `CardTrader listings: ${d.listingIds.join(", ")}`,
    ].join("\n"),
  };
}

/* ---------- TCGplayer pull list ---------- */

export async function tcgplayerPull(env: Env, tenant: Tenant, hours = 24): Promise<{ since: string; items: PullItem[] }> {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const sales = await salesSince(env, tenant.id, since);
  const ids = [...new Set(sales.map((s) => s.recordId).filter((x): x is string => Boolean(x)))];
  const cards: StockCard[] = [];
  for (let i = 0; i < ids.length; i += 100) cards.push(...await stockCardsByIds(tenantEnv(env, tenant), ids.slice(i, i + 100)));
  return { since, items: buildPullList(sales, cards) };
}

export async function sendDailyPull(env: Env, tenant: Tenant): Promise<void> {
  if (!dailyEmailOn(env)) return;
  const { items } = await tcgplayerPull(env, tenant, 24);
  if (items.length === 0) return;
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  await deliverAlerts(env, tenant.id, [{ key: `tcgplayer-daily:${day}`, subject: `Pull ${items.reduce((n, i) => n + i.qtySold, 0)} from TCGplayer (${day})`, text: pullEmailText(items, 24) }]);
}
