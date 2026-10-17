import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocate, applyPendingDecrements, cardTraderLines, cardTraderOwner, csvCell, planDecrement, readSalesFilter, resolveRetry, salesCsv,
  starfoilLines, totalsByPlatform, type PendingDecrement, type Platform, type SaleLine, type SaleRow, type SaleStore, type StockRecord,
} from "./sales.ts";

const REC = "recAAAAAAAAAAAAAA";
const REC2 = "recBBBBBBBBBBBBBB";
const FROM = "2026-10-20T14:00:00.000Z";

const ctOrder = (over: Record<string, unknown> = {}) => ({
  id: 9001, code: "20261020abc", order_as: "seller", state: "paid", paid_at: "2026-10-20T15:00:00Z", created_at: "2026-10-20T14:50:00Z",
  seller_fee_amount: { cents: 100, currency: "USD" },
  order_items: [
    { id: 1, product_id: 11, game_id: 18, name: "Elsa", quantity: 2, user_data_field: REC, seller_price: { cents: 300, currency: "USD" } },
    { id: 2, product_id: 12, game_id: 22, name: "Jinx", quantity: 1, user_data_field: "", seller_price: { cents: 400, currency: "USD" } },
  ],
  ...over,
});

test("allocate splits a total in proportion and always sums exactly", () => {
  assert.deepEqual(allocate(100, [600, 400]), [60, 40]);
  assert.deepEqual(allocate(10, [1, 1, 1]).reduce((a, b) => a! + b!, 0), 10);
  assert.deepEqual(allocate(null, [1, 2]), [null, null]);
  assert.deepEqual(allocate(5, [0, 0]).reduce((a, b) => a! + b!, 0), 5);
});

test("CardTrader order becomes one line per item with gross, allocated fee and net", () => {
  const lines = cardTraderLines(ctOrder(), FROM);
  assert.equal(lines.length, 2);
  const [a, b] = lines;
  assert.equal(a!.grossCents, 600); assert.equal(a!.feeCents, 60); assert.equal(a!.netCents, 540);
  assert.equal(b!.grossCents, 400); assert.equal(b!.feeCents, 40); assert.equal(b!.netCents, 360);
  assert.equal(a!.game, "Lorcana"); assert.equal(b!.game, "Riftbound");
  assert.equal(a!.recordId, REC); assert.equal(b!.recordId, null);
  assert.equal(a!.decrementOwner, "hekla", "paid after the hand-over");
  assert.equal(b!.decrementOwner, "none", "no Airtable row, nothing to lower");
  assert.equal(a!.lineKey, "1"); assert.equal(a!.externalOrderId, "9001");
  assert.equal(a!.soldAt, "2026-10-20T15:00:00.000Z");
});

test("only seller orders in a sold state count", () => {
  assert.equal(cardTraderLines(ctOrder({ order_as: "buyer" }), FROM).length, 0);
  assert.equal(cardTraderLines(ctOrder({ state: "pending" }), FROM).length, 0);
  assert.equal(cardTraderLines(ctOrder({ state: "canceled" }), FROM).length, 0);
  assert.equal(cardTraderLines(ctOrder({ state: "sent" }), FROM).length, 2);
});

test("the hand-over instant gives every order exactly one owner", () => {
  assert.equal(cardTraderOwner("2026-10-20T13:59:59.999Z", FROM), "starfoil");
  assert.equal(cardTraderOwner(FROM, FROM), "hekla");
  assert.equal(cardTraderOwner(FROM, null), "starfoil", "no hand-over set: starfoil keeps decrementing");
  assert.equal(cardTraderOwner(FROM, "nonsense"), "starfoil");
  // paid_at missing: created_at decides, same rule as the starfoil companion
  const [line] = cardTraderLines(ctOrder({ paid_at: null, created_at: "2026-10-20T13:00:00Z" }), FROM);
  assert.equal(line!.decrementOwner, "starfoil");
});

test("starfoil events are validated and always owned by starfoil", () => {
  const ok = starfoilLines({ orderId: "cs_test_1234", paidAt: "2026-10-20T15:00:00Z", feeCents: 59, items: [
    { lineKey: "p1:v1:" + REC, recordId: REC, name: "Elsa", qty: 1, unitCents: 1000 },
    { lineKey: "p2:v2:", name: "Booster", qty: 2, unitCents: 500 },
  ] });
  assert.ok(ok.ok);
  if (!ok.ok) return;
  assert.equal(ok.lines.length, 2);
  assert.ok(ok.lines.every((l) => l.decrementOwner === "starfoil" && l.platform === "starfoil"));
  assert.equal(ok.lines.reduce((n, l) => n + (l.feeCents ?? 0), 0), 59);
  assert.equal(ok.lines[1]!.recordId, null);
  assert.equal(starfoilLines({ orderId: "x", paidAt: "2026-10-20", items: [] }).ok, false);
  assert.equal(starfoilLines({ orderId: "cs_1234", paidAt: "2026-10-20", items: [{ lineKey: "a", name: "a", qty: 1, unitCents: 1 }, { lineKey: "a", name: "a", qty: 1, unitCents: 1 }] }).ok, false);
  assert.equal(starfoilLines({ orderId: "cs_1234", paidAt: "2026-10-20", items: [{ lineKey: "a", name: "a", qty: 1.5, unitCents: 1 }] }).ok, false);
});

test("planDecrement never goes below zero and reports an oversell", () => {
  assert.deepEqual(planDecrement(5, 2), { before: 5, target: 3, oversold: false, shortBy: 0, soldOut: false });
  assert.deepEqual(planDecrement(2, 2), { before: 2, target: 0, oversold: false, shortBy: 0, soldOut: true });
  assert.deepEqual(planDecrement(1, 3), { before: 1, target: 0, oversold: true, shortBy: 2, soldOut: true });
  assert.deepEqual(planDecrement(-4, 1), { before: 0, target: 0, oversold: true, shortBy: 1, soldOut: true });
});

test("resolveRetry: finished, not started, or changed underneath", () => {
  assert.equal(resolveRetry(5, 3, 3), "done");
  assert.equal(resolveRetry(5, 3, 5), "redo");
  assert.equal(resolveRetry(5, 3, 4), "conflict");
});

/* ---------- in-memory store and stock, mirroring the Neon SQL ---------- */

type MemRow = SaleLine & { id: number; tenantId: string; cancelledAt: string | null; startedAt: boolean; qtyBefore: number | null; qtyTarget: number | null; decrementedAt: boolean; oversold: boolean; needsReview: string | null };

class MemStore implements SaleStore {
  rows: MemRow[] = [];
  locks = new Map<string, { holder: string; until: number }>();
  failFinishOnce = false;
  now = () => Date.now();
  async insertLines(tenantId: string, lines: SaleLine[]) {
    let n = 0;
    for (const l of lines) {
      const hit = this.rows.find((r) => r.tenantId === tenantId && r.platform === l.platform && r.externalOrderId === l.externalOrderId && r.lineKey === l.lineKey);
      if (hit) { hit.orderState = l.orderState; continue; }
      this.rows.push({ ...l, id: this.rows.length + 1, tenantId, cancelledAt: null, startedAt: false, qtyBefore: null, qtyTarget: null, decrementedAt: false, oversold: false, needsReview: null });
      n++;
    }
    return n;
  }
  async markCancelled(tenantId: string, platform: Platform, orderId: string, at: string) {
    const out = [];
    for (const r of this.rows) {
      if (r.tenantId !== tenantId || r.platform !== platform || r.externalOrderId !== orderId || r.cancelledAt) continue;
      r.cancelledAt = at;
      if (r.decrementOwner === "hekla" && r.decrementedAt) { r.needsReview = "cancelled after decrement"; out.push({ id: r.id, recordId: r.recordId, qty: r.qty, cardName: r.cardName }); }
    }
    return out;
  }
  async pendingDecrements(tenantId: string, limit: number): Promise<PendingDecrement[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId && r.decrementOwner === "hekla" && !r.decrementedAt && !r.cancelledAt && !r.needsReview && r.recordId)
      .sort((a, b) => a.soldAt.localeCompare(b.soldAt) || a.id - b.id).slice(0, limit)
      .map((r) => ({ id: r.id, recordId: r.recordId!, qty: r.qty, platform: r.platform, externalOrderId: r.externalOrderId, orderCode: r.orderCode, cardName: r.cardName, qtyBefore: r.qtyBefore, qtyTarget: r.qtyTarget, started: r.startedAt }));
  }
  async startDecrement(id: number, before: number, target: number) { const r = this.rows[id - 1]!; r.startedAt = true; r.qtyBefore = before; r.qtyTarget = target; }
  async finishDecrement(id: number, oversold: boolean, review: string | null) {
    if (this.failFinishOnce) { this.failFinishOnce = false; throw new Error("worker stopped"); }
    const r = this.rows[id - 1]!; r.decrementedAt = true; r.oversold = oversold; r.needsReview = review ?? r.needsReview;
  }
  async flag(id: number, review: string) { this.rows[id - 1]!.needsReview = review; }
  async acquireLock(tenantId: string, recordId: string, holder: string, seconds: number) {
    const key = `${tenantId}|${recordId}`; const hit = this.locks.get(key);
    if (hit && hit.until > this.now() && hit.holder !== holder) return false;
    this.locks.set(key, { holder, until: this.now() + seconds * 1000 }); return true;
  }
  async releaseLock(tenantId: string, recordId: string, holder: string) { const key = `${tenantId}|${recordId}`; if (this.locks.get(key)?.holder === holder) this.locks.delete(key); }
}

class MemStock implements StockRecord {
  qty = new Map<string, number>();
  writes: [string, number][] = [];
  constructor(init: Record<string, number>) { for (const [k, v] of Object.entries(init)) this.qty.set(k, v); }
  async read(id: string) { return this.qty.has(id) ? this.qty.get(id)! : null; }
  async write(id: string, q: number) { this.qty.set(id, q); this.writes.push([id, q]); }
}

const T = "00000000-0000-0000-0000-000000000001";
const opts = { lockWaitMs: 1 };

test("a CardTrader sale lowers the shared Qty once, however often it is delivered", async () => {
  const store = new MemStore(); const stock = new MemStock({ [REC]: 5 });
  // webhook, then the poll, then a webhook retry: same order three times
  for (let i = 0; i < 3; i++) await store.insertLines(T, cardTraderLines(ctOrder(), FROM));
  assert.equal(store.rows.length, 2);
  const first = await applyPendingDecrements(store, stock, T, opts);
  const second = await applyPendingDecrements(store, stock, T, opts);
  assert.equal(first.applied, 1); assert.equal(second.applied, 0);
  assert.equal(stock.qty.get(REC), 3);
  assert.deepEqual(stock.writes, [[REC, 3]]);
});

test("sales before the hand-over and starfoil sales are never lowered by Hekla", async () => {
  const store = new MemStore(); const stock = new MemStock({ [REC]: 5 });
  await store.insertLines(T, cardTraderLines(ctOrder({ paid_at: "2026-10-19T00:00:00Z" }), FROM));
  const sf = starfoilLines({ orderId: "cs_test_1234", paidAt: "2026-10-21T00:00:00Z", items: [{ lineKey: "x", recordId: REC, name: "Elsa", qty: 1, unitCents: 100 }] });
  assert.ok(sf.ok); if (sf.ok) await store.insertLines(T, sf.lines);
  const r = await applyPendingDecrements(store, stock, T, opts);
  assert.equal(r.applied, 0); assert.equal(stock.writes.length, 0);
});

test("two sales of the same card in one run are applied one after the other", async () => {
  const store = new MemStore(); const stock = new MemStock({ [REC]: 3 });
  await store.insertLines(T, cardTraderLines(ctOrder(), FROM));
  await store.insertLines(T, cardTraderLines(ctOrder({ id: 9002, order_items: [{ id: 7, game_id: 18, name: "Elsa", quantity: 1, user_data_field: REC, seller_price: { cents: 300 } }] }), FROM));
  const r = await applyPendingDecrements(store, stock, T, opts);
  assert.equal(r.applied, 2); assert.equal(stock.qty.get(REC), 0);
  assert.equal(r.oversold, 0);
});

test("an oversell sets Qty to 0, is flagged and alerts once; no order is cancelled", async () => {
  const store = new MemStore(); const stock = new MemStock({ [REC]: 1 });
  await store.insertLines(T, cardTraderLines(ctOrder(), FROM)); // sells 2
  const r = await applyPendingDecrements(store, stock, T, opts);
  assert.equal(r.oversold, 1); assert.equal(stock.qty.get(REC), 0);
  assert.equal(r.alerts.length, 1); assert.match(r.alerts[0]!.subject, /^OVERSOLD/); assert.match(r.alerts[0]!.text, /Nothing was cancelled/);
  const row = store.rows[0]!; assert.equal(row.oversold, true); assert.match(row.needsReview ?? "", /Oversold by 1/);
  assert.equal((await applyPendingDecrements(store, stock, T, opts)).alerts.length, 0);
});

test("another run holding the row's lease makes this run skip it (picked up next time)", async () => {
  const store = new MemStore(); const stock = new MemStock({ [REC]: 5 });
  await store.insertLines(T, cardTraderLines(ctOrder(), FROM));
  await store.acquireLock(T, REC, "other-run", 30);
  const r = await applyPendingDecrements(store, stock, T, { ...opts, holder: "me" });
  assert.equal(r.skipped, 1); assert.equal(stock.writes.length, 0);
  await store.releaseLock(T, REC, "other-run");
  assert.equal((await applyPendingDecrements(store, stock, T, opts)).applied, 1);
  assert.equal(stock.qty.get(REC), 3);
});

test("an expired lease is taken over", async () => {
  const store = new MemStore(); const stock = new MemStock({ [REC]: 5 });
  await store.insertLines(T, cardTraderLines(ctOrder(), FROM));
  await store.acquireLock(T, REC, "crashed-run", 30);
  const real = store.now; store.now = () => real() + 31_000;
  assert.equal((await applyPendingDecrements(store, stock, T, opts)).applied, 1);
});

test("a run that stopped after writing Airtable is not applied twice", async () => {
  const store = new MemStore(); const stock = new MemStock({ [REC]: 5 });
  await store.insertLines(T, cardTraderLines(ctOrder(), FROM));
  store.failFinishOnce = true;
  await assert.rejects(applyPendingDecrements(store, stock, T, opts));
  assert.equal(stock.qty.get(REC), 3);
  const r = await applyPendingDecrements(store, stock, T, opts);
  assert.equal(r.applied, 1); assert.equal(stock.qty.get(REC), 3, "seen as done, not lowered again");
  assert.equal(stock.writes.length, 1);
});

test("a run that stopped before writing Airtable is redone", async () => {
  const store = new MemStore(); const stock = new MemStock({ [REC]: 5 });
  await store.insertLines(T, cardTraderLines(ctOrder(), FROM));
  await store.startDecrement(1, 5, 3); // recorded the plan, then stopped
  const r = await applyPendingDecrements(store, stock, T, opts);
  assert.equal(r.applied, 1); assert.equal(stock.qty.get(REC), 3);
});

test("a row changed by someone else mid-decrement is flagged for a person, not guessed", async () => {
  const store = new MemStore(); const stock = new MemStock({ [REC]: 4 });
  await store.insertLines(T, cardTraderLines(ctOrder(), FROM));
  await store.startDecrement(1, 5, 3);
  const r = await applyPendingDecrements(store, stock, T, opts);
  assert.equal(r.flagged, 1); assert.equal(stock.writes.length, 0); assert.equal(r.alerts.length, 1);
  assert.equal((await applyPendingDecrements(store, stock, T, opts)).flagged, 0, "flagged rows leave the queue");
});

test("a missing Airtable row is flagged", async () => {
  const store = new MemStore(); const stock = new MemStock({});
  await store.insertLines(T, cardTraderLines(ctOrder(), FROM));
  const r = await applyPendingDecrements(store, stock, T, opts);
  assert.equal(r.flagged, 1); assert.equal(stock.writes.length, 0);
});

test("a cancelled order is not lowered; a cancel after lowering is returned for review", async () => {
  const store = new MemStore(); const stock = new MemStock({ [REC]: 5, [REC2]: 5 });
  await store.insertLines(T, cardTraderLines(ctOrder(), FROM));
  assert.deepEqual(await store.markCancelled(T, "cardtrader", "9001", "2026-10-20T16:00:00Z"), []);
  assert.equal((await applyPendingDecrements(store, stock, T, opts)).applied, 0);
  await store.insertLines(T, cardTraderLines(ctOrder({ id: 9003, order_items: [{ id: 9, game_id: 18, name: "Moana", quantity: 1, user_data_field: REC2, seller_price: { cents: 100 } }] }), FROM));
  await applyPendingDecrements(store, stock, T, opts);
  const undone = await store.markCancelled(T, "cardtrader", "9003", "2026-10-20T17:00:00Z");
  assert.equal(undone.length, 1); assert.equal(stock.qty.get(REC2), 4, "stock is never added back automatically");
});

/* ---------- page helpers ---------- */

const row = (over: Partial<SaleRow>): SaleRow => ({ id: 1, platform: "cardtrader", externalOrderId: "1", orderCode: null, lineKey: "1", recordId: null, game: null, cardName: "A", qty: 1, currency: "USD", grossCents: 1000, feeCents: 100, netCents: 900, soldAt: "2026-10-20T00:00:00.000Z", orderState: "paid", cancelledAt: null, decrementOwner: "starfoil", decrementedAt: null, oversold: false, needsReview: null, ...over });

test("totals by platform skip cancelled lines and count orders once", () => {
  const t = totalsByPlatform([row({}), row({ id: 2, lineKey: "2" }), row({ id: 3, externalOrderId: "2", cancelledAt: "x" }), row({ id: 4, platform: "starfoil", externalOrderId: "s", feeCents: null, netCents: null })]);
  assert.deepEqual(t.map((x) => [x.platform, x.orders, x.lines, x.grossCents, x.feeCents, x.netCents, x.unknownFeeLines]), [["cardtrader", 1, 2, 2000, 200, 1800, 0], ["starfoil", 1, 1, 1000, 0, 1000, 1]]);
});

test("CSV cells escape quotes and neutralise formulas", () => {
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell(-3), "-3");
  assert.match(salesCsv([row({ cardName: "+SUM(A1)" })]), /'\+SUM\(A1\)/);
});

test("sales filter accepts only known values", () => {
  assert.deepEqual(readSalesFilter({ platform: "ebay", from: "2026-13-40", to: "2026-10-20", q: "  elsa ", cancelled: "1" }), { platform: null, from: null, to: "2026-10-20", game: null, q: "elsa", includeCancelled: true });
});
