/** Allocation idempotency and the deck-sale log line, against isolated Postgres. No Neon, Airtable, or CardTrader. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { allocationStoreWithQuery } from "../src/allocationsdb.ts";
import { allocationSaleLine } from "../src/allocations.ts";
import { saleStoreWithQuery } from "../src/salesdb.ts";

const pg = new PGlite();
const T = "00000000-0000-4000-8000-000000000001";
const REC = "recAAAAAAAAAAAAAA";
const alloc = () => allocationStoreWithQuery(async (sql, params) => (await pg.query<Record<string, unknown>>(sql, params)).rows);
const sales = () => saleStoreWithQuery(async (sql, params) => (await pg.query<Record<string, unknown>>(sql, params)).rows);

before(async () => {
  await pg.exec("create table tenants (id uuid primary key)");
  await pg.query("insert into tenants values ($1)", [T]);
  const salesSql = readFileSync(new URL("../db/migrations/0005_sales.sql", import.meta.url), "utf8").split("-- A short lease")[0]!;
  await pg.exec(salesSql);
  const migration = readFileSync(new URL("../db/migrations/0012_allocations.sql", import.meta.url), "utf8");
  await pg.exec(migration);
  await pg.exec(migration);
});
after(async () => { await pg.close(); });

test("a stored allocation result is returned for the same key and blocks a different request", async () => {
  const store = alloc();
  const body = { ok: true, applied: true, ct_listing_id: 50, ct_qty_before: 4, ct_qty_after: 3 };
  assert.equal(await store.put(T, "key-1", { httpStatus: 200, body, allocationId: "a", deckId: "d", op: "reserve", recordId: REC, qty: 1 }), "stored");
  assert.equal(await store.put(T, "key-1", { httpStatus: 200, body, allocationId: "other", deckId: "d", op: "reserve", recordId: REC, qty: 1 }), "exists");
  const stored = await store.get(T, "key-1");
  assert.equal(stored?.httpStatus, 200);
  assert.equal(stored?.allocationId, "a");
  assert.equal(stored?.body.ct_qty_after, 3);
  assert.equal(await store.get(T, "missing"), null);
});

test("the last reserve price for an allocation is read back for a relist", async () => {
  const store = alloc();
  assert.equal(await store.reservePrice(T, "price-a"), null);
  await store.put(T, "res-p1", { httpStatus: 200, body: { ok: true, applied: true, ct_price_cents: 125 }, allocationId: "price-a", deckId: "d", op: "reserve", recordId: REC, qty: 1 });
  await store.put(T, "rel-p1", { httpStatus: 200, body: { ok: true, applied: true, ct_price_cents: 999 }, allocationId: "price-a", deckId: "d", op: "release", recordId: REC, qty: 1 });
  await store.put(T, "res-p2", { httpStatus: 200, body: { ok: true, applied: true, note: "not_listed" }, allocationId: "price-b", deckId: "d", op: "reserve", recordId: REC, qty: 1 });
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
