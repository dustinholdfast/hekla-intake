/** Allocation idempotency and the deck-sale log line, against isolated Postgres. No Neon, Airtable, or CardTrader. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { allocationAlertsWithQuery, allocationStoreWithQuery } from "../src/allocationsdb.ts";
import { allocationSaleLine } from "../src/allocations.ts";
import { saleStoreWithQuery } from "../src/salesdb.ts";

const pg = new PGlite();
const T = "00000000-0000-4000-8000-000000000001";
const REC = "recAAAAAAAAAAAAAA";
const alloc = () => allocationStoreWithQuery(async (sql, params) => (await pg.query<Record<string, unknown>>(sql, params)).rows);
const alerts = () => allocationAlertsWithQuery(async (sql, params) => (await pg.query<Record<string, unknown>>(sql, params)).rows);
const sales = () => saleStoreWithQuery(async (sql, params) => (await pg.query<Record<string, unknown>>(sql, params)).rows);

before(async () => {
  await pg.exec("create table tenants (id uuid primary key)");
  await pg.query("insert into tenants values ($1)", [T]);
  const salesSql = readFileSync(new URL("../db/migrations/0005_sales.sql", import.meta.url), "utf8").split("-- A short lease")[0]!;
  await pg.exec(salesSql);
  // sync_state (0005, after the stock lock part) holds the alert "checked" marks.
  await pg.exec(readFileSync(new URL("../db/migrations/0005_sales.sql", import.meta.url), "utf8").split("create table if not exists sync_state")[1]!.split(";")[0]!.replace(/^/, "create table if not exists sync_state") + ";");
  const migration = readFileSync(new URL("../db/migrations/0012_allocations.sql", import.meta.url), "utf8");
  await pg.exec(migration);
  await pg.exec(migration);
  const claims = readFileSync(new URL("../db/migrations/0013_allocation_claims.sql", import.meta.url), "utf8");
  await pg.exec(claims);
  await pg.exec(claims);
});
after(async () => { await pg.close(); });

const req = (over: Partial<{ allocationId: string; qty: number; lineKey: string | null }> = {}) => ({
  allocationId: "a", deckId: "d", op: "reserve", recordId: REC, qty: 1, orderId: null, lineKey: null, ...over,
});

test("a key is claimed once, a duplicate is busy, and the finished answer is replayed", async () => {
  const store = alloc();
  const [one, two] = await Promise.all([store.claim(T, "key-1", req(), "tok-1", 60), store.claim(T, "key-1", req(), "tok-2", 60)]);
  assert.deepEqual([one.kind, two.kind].sort(), ["busy", "claimed"]);
  const owner = one.kind === "claimed" ? "tok-1" : "tok-2";
  assert.equal((await store.claim(T, "key-1", req({ qty: 2 }), "tok-3", 60)).kind, "mismatch");
  await store.finish(T, "key-1", owner, 200, { ok: true, applied: true, ct_listing_id: 50, ct_qty_before: 4, ct_qty_after: 3 });
  const again = await store.claim(T, "key-1", req(), "tok-4", 60);
  assert.equal(again.kind, "done");
  if (again.kind === "done") {
    assert.equal(again.stored.httpStatus, 200);
    assert.equal(again.stored.body.ct_qty_after, 3);
  }
  assert.equal((await store.claim(T, "key-1", req({ lineKey: "x" }), "tok-5", 60)).kind, "mismatch", "line_key is part of the request");
});

test("an abandoned claim keeps its plan for the next try, and an expired lease can be taken over", async () => {
  const store = alloc();
  assert.equal((await store.claim(T, "key-p", req(), "tok-a", 60)).kind, "claimed");
  const plan = { steps: [{ kind: "set" as const, listingId: 50, from: 4, to: 3 }], status: 200, body: { ok: true } };
  await store.savePlan(T, "key-p", "tok-a", plan);
  await assert.rejects(store.savePlan(T, "key-p", "tok-other", plan), /claim was lost/);
  await store.abandon(T, "key-p", "tok-a");
  const next = await store.claim(T, "key-p", req(), "tok-b", 60);
  assert.equal(next.kind, "claimed");
  if (next.kind === "claimed") assert.deepEqual(next.plan, plan);
  assert.equal(await store.finish(T, "key-p", "tok-a", 500, { ok: false }), false, "a stale token's finish reports it was not saved");
  assert.equal((await store.claim(T, "key-p", req(), "tok-c", 60)).kind, "busy", "a stale token cannot finish");

  assert.equal((await store.claim(T, "key-lease", req(), "tok-d", 0)).kind, "claimed");
  assert.equal((await store.claim(T, "key-lease", req(), "tok-e", 60)).kind, "claimed", "a zero-second lease has run out");
});

test("one request at a time holds a Waitlist row", async () => {
  const store = alloc();
  const [x, y] = await Promise.all([store.lockRow(T, REC, "h1", 60), store.lockRow(T, REC, "h2", 60)]);
  assert.deepEqual([x, y].sort(), [false, true]);
  const holder = x ? "h1" : "h2";
  await store.unlockRow(T, REC, holder === "h1" ? "h2" : "h1");
  assert.equal(await store.lockRow(T, REC, "h3", 60), false, "only the holder can unlock");
  await store.unlockRow(T, REC, holder);
  assert.equal(await store.lockRow(T, REC, "h3", 0), true);
  assert.equal(await store.lockRow(T, REC, "h4", 60), true, "an expired lease is taken over");
});

test("leases are renewed only by their holder and only while they are live", async () => {
  const store = alloc();
  assert.equal((await store.claim(T, "key-r", req(), "tok-r", 60)).kind, "claimed");
  assert.equal(await store.renew(T, "key-r", "tok-r", 60), true);
  assert.equal(await store.renew(T, "key-r", "tok-x", 60), false);
  assert.equal((await store.claim(T, "key-r0", req(), "tok-r0", 0)).kind, "claimed");
  assert.equal(await store.renew(T, "key-r0", "tok-r0", 60), false, "an expired claim is not revived");
  assert.equal(await store.finish(T, "key-r", "tok-r", 200, { ok: true }), true);
  assert.equal(await store.renew(T, "key-r", "tok-r", 60), false, "a finished key has no lease");

  const row = "recRENEWAAAAAAAAA";
  assert.equal(await store.lockRow(T, row, "h1", 60), true);
  assert.equal(await store.renewRow(T, row, "h1", 60), true);
  assert.equal(await store.renewRow(T, row, "h2", 60), false);
  await store.unlockRow(T, row, "h1");
  assert.equal(await store.renewRow(T, row, "h1", 60), false, "a released lease is not re-created");
  assert.equal(await store.lockRow(T, row, "h3", 0), true);
  assert.equal(await store.renewRow(T, row, "h3", 60), false, "an expired lease is not revived");
});

test("a pending key with a sent-but-unanswered step marks its row unresolved", async () => {
  const store = alloc();
  const row = "recUNRESAAAAAAAAA";
  assert.equal((await store.claim(T, "key-u", req({ allocationId: "u" }), "tok-u", 60)).kind, "claimed");
  const step = { kind: "set" as const, listingId: 50, from: 4, to: 3 };
  await pg.query("update allocation_results set waitlist_record_id = $1 where idempotency_key = 'key-u'", [row]);
  await store.savePlan(T, "key-u", "tok-u", { steps: [step], status: 200, body: { ok: true } });
  assert.equal(await store.rowUnresolved(T, row, ""), false, "a planned step not yet sent");
  await store.savePlan(T, "key-u", "tok-u", { steps: [{ ...step, attemptedAt: "2026-11-09T12:00:00.000Z" }], status: 200, body: { ok: true } });
  assert.equal(await store.rowUnresolved(T, row, ""), true);
  assert.equal(await store.rowUnresolved(T, row, "key-u"), false, "its own retry is not blocked");
  await store.savePlan(T, "key-u", "tok-u", { steps: [{ ...step, attemptedAt: "2026-11-09T12:00:00.000Z", done: { quantity: 3 } }], status: 200, body: { ok: true } });
  assert.equal(await store.rowUnresolved(T, row, ""), false);
});

test("stale settlement: unanswered keys on a row are listed with their lease, and only an expired one is taken over", async () => {
  const store = alloc();
  const row = "recSTALEAAAAAAAAA";
  const step = { kind: "set" as const, listingId: 60, from: 2, to: 1, attemptedAt: "2026-11-09T12:00:00.000Z" };
  assert.equal((await store.claim(T, "key-s", { ...req({ allocationId: "s", lineKey: "ln" }), recordId: row, orderId: "o-1" }, "tok-s", 60)).kind, "claimed");
  await store.savePlan(T, "key-s", "tok-s", { steps: [step], status: 200, body: { ok: true } });
  let list = await store.unresolvedOnRow(T, row, "");
  assert.equal(list.length, 1);
  assert.equal(list[0]!.key, "key-s");
  assert.equal(list[0]!.leaseLive, true);
  assert.deepEqual(list[0]!.plan.steps, [step]);
  assert.deepEqual(await store.unresolvedOnRow(T, row, "key-s"), []);
  assert.equal(await store.takeOver(T, "key-s", "tok-admin", 60), null, "a live claim is not taken");

  await store.abandon(T, "key-s", "tok-s");
  list = await store.unresolvedOnRow(T, row, "");
  assert.equal(list[0]!.leaseLive, false);
  const taken = await store.takeOver(T, "key-s", "tok-admin", 60);
  assert.ok(taken);
  assert.deepEqual(taken.row, { allocationId: "s", deckId: "d", op: "reserve", recordId: row, qty: 1, orderId: "o-1", lineKey: "ln" });
  assert.deepEqual(taken.plan?.steps, [step]);
  assert.equal(await store.takeOver(T, "key-s", "tok-other", 60), null, "the new holder now has it");
  assert.equal(await store.finish(T, "key-s", "tok-admin", 409, { ok: false, error: "ct_retry_unverifiable" }), true);
  assert.deepEqual(await store.unresolvedOnRow(T, row, ""), []);
  assert.equal(await store.takeOver(T, "key-s", "tok-late", 60), null, "a finished key is never taken over");
});

test("a sale in the sales log since a time counts as retry evidence; an allocation line does not", async () => {
  const store = alloc();
  const row = "recEVIDAAAAAAAAAA";
  const insert = (platform: string, order: string, soldAt: string) => pg.query(
    `insert into sales (tenant_id, platform, external_order_id, line_key, record_id, qty, currency, gross_cents, sold_at, raw)
     values ($1, $2, $3, 'l', $4, 1, 'USD', 100, $5, '{}')`, [T, platform, order, row, soldAt]);
  await insert("allocation", "deck-1", "2030-01-01T00:00:00Z");
  assert.equal(await store.saleLogged(T, row, "2029-01-01T00:00:00Z"), false);
  await insert("cardtrader", "ct-1", "2030-01-01T00:00:00Z");
  assert.equal(await store.saleLogged(T, row, "2029-01-01T00:00:00Z"), true);
  assert.equal(await store.saleLogged(T, row, "2031-01-01T00:00:00Z"), false);
  await pg.query("delete from sales where record_id = $1", [row]);
});

test("the last reserve price for an allocation is read back for a relist", async () => {
  const store = alloc();
  assert.equal(await store.reservePrice(T, "price-a"), null);
  const finished = async (key: string, op: string, allocationId: string, body: Record<string, unknown>) => {
    await store.claim(T, key, { ...req({ allocationId }), op }, `t-${key}`, 60);
    await store.finish(T, key, `t-${key}`, 200, body as never);
  };
  await finished("res-p1", "reserve", "price-a", { ok: true, applied: true, ct_price_cents: 125 });
  await finished("rel-p1", "release", "price-a", { ok: true, applied: true, ct_price_cents: 999 });
  await finished("res-p2", "reserve", "price-b", { ok: true, applied: true, note: "not_listed" });
  assert.equal(await store.reservePrice(T, "price-a"), 125, "only reserve rows count");
  assert.equal(await store.reservePrice(T, "price-b"), null);
});

test("a deck sale is logged once and is not a Hekla Qty decrement", async () => {
  const store = sales();
  const line = allocationSaleLine({
    op: "finalize_sold", idempotency_key: "sold-1", allocation_id: "alloc-1", deck_id: "deck-1",
    waitlist_record_id: REC, qty: 2, game: "riftbound", order_id: "deck-1", line_key: "sold-1",
  }, { name: "Oasis Raider", resolvedName: null, marketPriceUsd: 0.5 }, "2026-11-08T00:00:00.000Z");
  assert.equal(await store.insertLines(T, [line]), 1);
  assert.equal(await store.insertLines(T, [line]), 0);
  assert.equal(await store.insertLines(T, [{ ...line, raw: { retry: true } }]), 0, "the same order_id and line_key is one sale");
  assert.deepEqual(await store.pendingDecrements(T, 10), []);
  const rows = (await pg.query<Record<string, unknown>>("select platform, line_key, decrement_owner, gross_cents from sales")).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.platform, "allocation");
  assert.equal(rows[0]!.line_key, "sold-1");
  assert.equal(rows[0]!.decrement_owner, "none");
  assert.equal(Number(rows[0]!.gross_cents), 100);

  await store.insertLines(T, [{ ...line, platform: "cardtrader", externalOrderId: "ct-1", lineKey: "ct-line", decrementOwner: "hekla" }]);
  const pending = await store.pendingDecrements(T, 10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.platform, "cardtrader");
  await assert.rejects(store.insertLines(T, [{ ...line, platform: "ebay" as "allocation", externalOrderId: "nope", lineKey: "nope" }]));
});

const T2 = "00000000-0000-4000-8000-000000000002";

test("sweep: stale rows are pending keys no request holds with an unanswered write at or before the cutoff, oldest first, capped", async () => {
  await pg.query("insert into tenants values ($1) on conflict do nothing", [T2]);
  const store = alloc();
  const at = (iso: string, done = false) => ({ steps: [{ kind: "set" as const, listingId: 70, from: 2, to: 1, attemptedAt: iso, ...(done ? { done: { quantity: 1 } } : {}) }], status: 200, body: { ok: true } });
  const put = async (key: string, row: string, plan: ReturnType<typeof at> | null, release = true) => {
    assert.equal((await store.claim(T2, key, { ...req({ allocationId: key }), recordId: row }, `tok-${key}`, 60)).kind, "claimed");
    if (plan) await store.savePlan(T2, key, `tok-${key}`, plan);
    if (release) await store.abandon(T2, key, `tok-${key}`);
  };
  await put("sw-old", "recSWEEPAAAAAAAA1", at("2026-11-09T10:00:00.000Z"));
  await put("sw-older", "recSWEEPAAAAAAAA2", at("2026-11-09T09:00:00.000Z"));
  await put("sw-recent", "recSWEEPAAAAAAAA3", at("2026-11-09T12:59:00.000Z"));
  await put("sw-held", "recSWEEPAAAAAAAA4", at("2026-11-09T08:00:00.000Z"), false);
  await put("sw-done-step", "recSWEEPAAAAAAAA5", at("2026-11-09T08:00:00.000Z", true));
  await put("sw-unsent", "recSWEEPAAAAAAAA6", { steps: [{ kind: "set", listingId: 70, from: 2, to: 1 }], status: 200, body: { ok: true } } as never);
  await put("sw-noplan", "recSWEEPAAAAAAAA7", null);
  const cutoff = "2026-11-09T12:45:00.000Z";
  assert.deepEqual(await store.staleRows(T2, cutoff, 10), ["recSWEEPAAAAAAAA2", "recSWEEPAAAAAAAA1"]);
  assert.deepEqual(await store.staleRows(T2, cutoff, 1), ["recSWEEPAAAAAAAA2"]);
  assert.deepEqual(await store.staleRows(T, cutoff, 10), [], "per tenant");
  // A finished key is not stale.
  const taken = await store.takeOver(T2, "sw-older", "tok-sweep", 60);
  assert.ok(taken);
  assert.equal(await store.finish(T2, "sw-older", "tok-sweep", 409, { ok: false, error: "ct_retry_unverifiable", note: "n", unverified: { listing_id: 70, from: 2, expected: 1, observed: 2, attempted_at: "2026-11-09T09:00:00.000Z" } }), true);
  assert.deepEqual(await store.staleRows(T2, cutoff, 10), ["recSWEEPAAAAAAAA1"]);
});

test("alerts: every stored ct_retry_unverifiable is listed with row, listing, quantities and direction until it is marked checked", async () => {
  const store = alloc();
  const list = alerts();
  // From the previous test: sw-older (reserve) was stored as ct_retry_unverifiable.
  assert.equal((await store.claim(T2, "al-rel", { ...req({ allocationId: "al-rel" }), op: "release", recordId: "recALERTAAAAAAAAA" }, "tok-r", 60)).kind, "claimed");
  assert.equal(await store.finish(T2, "al-rel", "tok-r", 409, { ok: false, error: "ct_retry_unverifiable", note: "relist", unverified: { listing_id: null, from: 0, expected: 2, observed: null, attempted_at: null } }), true);
  assert.equal((await store.claim(T2, "al-ok", { ...req({ allocationId: "al-ok" }), recordId: "recALERTAAAAAAAAA" }, "tok-o", 60)).kind, "claimed");
  assert.equal(await store.finish(T2, "al-ok", "tok-o", 409, { ok: false, error: "ct_changed_during_retry" }), true);

  const open = await list.open(T2);
  assert.deepEqual(open.map((a) => [a.key, a.recordId, a.direction, a.listingId, a.from, a.expected, a.observed]).sort(), [
    ["al-rel", "recALERTAAAAAAAAA", "release", null, 0, 2, null],
    ["sw-older", "recSWEEPAAAAAAAA2", "reserve", 70, 2, 1, 2],
  ]);
  // Per tenant; an answer stored before `unverified` existed (key-s, earlier test) is listed with unknown quantities.
  assert.deepEqual((await list.open(T)).map((a) => [a.key, a.direction, a.listingId, a.expected, a.observed]), [["key-s", "reserve", null, null, null]]);

  assert.equal(await list.ack(T2, "al-rel", "user_admin"), true);
  assert.equal(await list.ack(T2, "al-rel", "user_admin"), true, "idempotent");
  assert.equal(await list.ack(T2, "al-ok", "user_admin"), false, "only unverified writes are alerts");
  assert.equal(await list.ack(T2, "nope", "user_admin"), false);
  assert.deepEqual((await list.open(T2)).map((a) => a.key), ["sw-older"]);
});

test("alerts: email_sent_at lives in sync_state; a claim blocks a second send, a release lets the sweep resend, sent is final", async () => {
  const list = alerts();
  // Open on T2 now: sw-older (reserve 2 -> 1, observed 2) only.
  let open = await list.open(T2);
  assert.deepEqual(open.map((a) => [a.key, a.risk, a.emailSentAt]), [["sw-older", "high", null]]);
  assert.deepEqual((await list.unsent(T2, 5)).map((a) => [a.key, a.direction, a.from, a.expected, a.observed, a.known, a.source]), [["sw-older", "reserve", 2, 1, 2, true, "resend"]]);

  assert.equal(await list.claimEmail(T2, "sw-older"), true);
  assert.equal(await list.claimEmail(T2, "sw-older"), false, "another send holds it");
  await list.releaseEmail(T2, "sw-older");
  assert.equal((await list.unsent(T2, 5)).length, 1, "released: still unsent");
  assert.equal(await list.claimEmail(T2, "sw-older"), true);
  await list.markEmailSent(T2, "sw-older");
  assert.equal(await list.claimEmail(T2, "sw-older"), false, "sent is final");
  await list.releaseEmail(T2, "sw-older");
  assert.deepEqual(await list.unsent(T2, 5), []);
  open = await list.open(T2);
  assert.ok(open[0]!.emailSentAt, "email_sent_at shown on the admin list");

  // An expired claim (a send that died mid-way) can be taken again.
  await pg.query("insert into sync_state (tenant_id, key, value) values ($1, 'alloc_alert_email:key-s', jsonb_build_object('claimed_until', now() - interval '1 minute'))", [T]);
  assert.equal(await list.claimEmail(T, "key-s"), true);
  // A legacy answer with no recorded quantities is "high".
  assert.deepEqual((await list.open(T)).map((a) => [a.key, a.risk, a.known]), [["key-s", "high", false]]);
  // Checked alerts are not resent.
  await list.releaseEmail(T, "key-s");
  assert.equal((await list.unsent(T, 5)).length, 1);
  assert.equal(await list.ack(T, "key-s", "user_admin"), true);
  assert.deepEqual(await list.unsent(T, 5), []);
});
