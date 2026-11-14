/** Isolated PostgreSQL tests: no connection to Neon or Airtable. Migration 0014 is applied only here. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { duplicateAlertStore } from "../src/duplicate-alerts.ts";
import { INSERT_INTAKE_LOT_SQL, insertIntakeLot, type Sql } from "../src/intake-upsert.ts";
import { INSERT_MOVEMENTS_SQL } from "../src/inventorydb.ts";

const pg = new PGlite();
const T = "00000000-0000-4000-8000-000000000001";
const REC = "recAAAAAAAAAAAAAA";
const sql: Sql = async (text, params) => (await pg.query<Record<string, unknown>>(text, params)).rows;
const migration = (name: string) => readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8");

before(async () => {
  await pg.exec("create table tenants (id uuid primary key)");
  await pg.query("insert into tenants values ($1)", [T]);
  await pg.exec(migration("0008_inventory.sql"));
  await pg.exec(migration("0010_purchases.sql"));
  await pg.exec(migration("0014_duplicate_alerts.sql"));
});
after(async () => { await pg.close(); });

test("an override records one open alert, a repeat adds rows, and ack clears it", async () => {
  const store = duplicateAlertStore(sql);
  const first = await store.record(T, { identityKey: "Riftbound|ogn|12|Foil|NM|english", recordIds: [REC, "recBBBBBBBBBBBBBB"], source: "override", note: "Add anyway" });
  assert.equal(first.created, true);
  const again = await store.record(T, { identityKey: "Riftbound|ogn|12|Foil|NM|english", recordIds: ["recCCCCCCCCCCCCCC"], source: "observed", note: "Seen again" });
  assert.equal(again.created, false);
  assert.equal(again.alert.source, "override");
  assert.deepEqual(again.alert.recordIds.sort(), [REC, "recBBBBBBBBBBBBBB", "recCCCCCCCCCCCCCC"].sort());
  assert.equal((await store.open(T)).length, 1);
  assert.equal(await store.ack(T, first.alert.identityKey, "user"), true);
  assert.equal((await store.open(T)).length, 0);
  const after = await store.record(T, { identityKey: first.alert.identityKey, recordIds: [REC, "recDDDDDDDDDDDDDD"], source: "observed", note: "Back" });
  assert.equal(after.created, true);
  assert.equal((await store.open(T)).length, 1);
});

test("a priced intake writes a cost lot and an intake movement without inventing a second lot", async () => {
  await insertIntakeLot(sql, { tenantId: T, recordId: REC, qty: 3, costBasisUsd: 4, acquiredAt: "2026-11-14T15:00:00.000Z" });
  const lots = await sql("select qty_in, qty_left, unit_cost_cents, cost_total_cents from stock_lots where tenant_id = $1 and record_id = $2", [T, REC]);
  assert.equal(lots.length, 1);
  assert.equal(Number(lots[0]?.qty_in), 3);
  assert.equal(Number(lots[0]?.unit_cost_cents), 400);
  assert.equal(Number(lots[0]?.cost_total_cents), 1200);
  const movement = {
    tenant_id: T, record_id: REC, delta: 3, qty_before: 1, qty_after: 4, reason: "intake", source_kind: "intake",
    source_ref: "intake:evt-1", applied_by: "user", unit_cost_cents: 400, note: "Intake merge.", needs_review: null,
    snapshot: {}, created_at: "2026-11-14T15:00:00.000Z",
  };
  const inserted = await sql(INSERT_MOVEMENTS_SQL, [JSON.stringify([movement])]);
  const replay = await sql(INSERT_MOVEMENTS_SQL, [JSON.stringify([movement])]);
  assert.equal(inserted.length, 1);
  assert.equal(replay.length, 0);
  assert.match(INSERT_INTAKE_LOT_SQL, /insert into stock_lots/i);
});
