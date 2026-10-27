import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AppendOnlyLedger,
  DEFAULT_THRESHOLDS,
  applyMovements,
  buildInventory,
  canonicalStockFinish,
  matchWantQty,
  normalizeLanguage,
  onHand,
  planOpeningEntries,
  stockFlags,
  stockIdentityKey,
  wantDecrementAllowed,
  type MovementDraft,
  type WaitlistInput,
} from "./inventory.ts";
import { INSERT_MOVEMENTS_SQL } from "./inventorydb.ts";
import { fixtureBuyList, fixtureMovements, fixtureRows } from "./inventory-fixtures.ts";
import { BUY_LIST_READ_FIELDS, WAITLIST_READ_FIELDS, airtableListUrl, loadWaitlist } from "./opening.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-27T15:00:00.000Z");
const DAYS = 86_400_000;
const REC = "recFIXTUREEMBER01";

function row(id: string, fields: Record<string, unknown>, createdTime: string | null = NOW.toISOString()): WaitlistInput {
  return { id, createdTime, fields };
}

function baseFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { "Card Name": "Example Card", Game: "Lorcana", "Set #": "1", "Collector Number": "42/204", Finish: "Foil", Condition: "NM", Qty: 2, Status: "Listed", ...over };
}

test("the migration is append-only and keyed once per source event", () => {
  const sql = readFileSync(new URL("../db/migrations/0008_inventory.sql", import.meta.url), "utf8");
  assert.match(sql, /unique \(tenant_id, source_kind, source_ref, reason\)/);
  assert.match(sql, /stock_movements is append-only/);
  assert.match(sql, /before update or delete on stock_movements/);
  assert.match(sql, /source_kind ~ '\^\[a-z\]\[a-z0-9_\]\{0,40\}\$'/);
  assert.doesNotMatch(sql, /source_kind in \(/i);
  assert.doesNotMatch(sql, /drop table/i);
  assert.doesNotMatch(sql, /delete from/i);
  assert.match(INSERT_MOVEMENTS_SQL, /on conflict \(tenant_id, source_kind, source_ref, reason\) do nothing/);
  assert.doesNotMatch(INSERT_MOVEMENTS_SQL, /do update/i);
});

test("the same source event is recorded once and on-hand does not double", () => {
  const ledger = new AppendOnlyLedger();
  const [opening] = planOpeningEntries([row(REC, baseFields({ Qty: 4 }))], TENANT, NOW);
  assert.ok(opening);
  assert.equal(ledger.append(opening).inserted, true);
  assert.equal(ledger.append(opening).inserted, false);
  assert.equal(ledger.all().length, 1);
  assert.equal(onHand(ledger.all()), 4);

  const sale: MovementDraft = {
    ...opening,
    delta: -1,
    qtyBefore: 4,
    qtyAfter: 3,
    reason: "sale_starfoil",
    sourceKind: "starfoil_order",
    sourceRef: "order-1:line-1",
    appliedBy: "starfoil-lgs",
    createdAt: new Date(NOW.getTime() + 1000).toISOString(),
  };
  assert.equal(ledger.append(sale).inserted, true);
  assert.equal(ledger.append({ ...sale }).inserted, false);
  assert.equal(onHand(ledger.all()), 3);

  const otherTenant = ledger.append({ ...opening, tenantId: "00000000-0000-4000-8000-000000000002" });
  assert.equal(otherTenant.inserted, true);
  const otherReason = ledger.append({ ...sale, reason: "cancel_restock", delta: 1, qtyBefore: 3, qtyAfter: 4, sourceKind: "manual", sourceRef: "order-1:line-1" });
  assert.equal(otherReason.inserted, true, "a different reason is a different event");
});

test("re-running opening entries inserts nothing the second time", () => {
  const rows = [row(REC, baseFields({ Qty: 4 })), row("recFIXTURETIDE001", baseFields({ Qty: 1, "Collector Number": "7" }))];
  const first = planOpeningEntries(rows, TENANT, NOW);
  const second = planOpeningEntries(rows, TENANT, new Date(NOW.getTime() + DAYS));
  assert.deepEqual(first.map((movement) => [movement.sourceKind, movement.sourceRef, movement.reason]), second.map((movement) => [movement.sourceKind, movement.sourceRef, movement.reason]));
  const ledger = new AppendOnlyLedger();
  assert.deepEqual(applyMovements(ledger, first), { inserted: 2, already: 0 });
  assert.deepEqual(applyMovements(ledger, second), { inserted: 0, already: 2 });
  assert.equal(onHand(ledger.all()), 5);
  assert.ok(ledger.all().every((movement) => movement.delta >= 0 && movement.reason === "opening_balance"));
});

test("opening mapping follows the finish, language, cost and date rules", () => {
  const [normal] = planOpeningEntries([row(REC, baseFields({ Finish: "Normal", "Cost Basis USD": 12.5, "Date Acquired": "2020-01-01", Qty: 3 }))], TENANT, NOW);
  assert.equal(normal?.snapshot?.finish, "Regular");
  assert.equal(normal?.snapshot?.finishRaw, "Normal");
  assert.equal(normal?.snapshot?.dateAcquired, null);
  assert.equal(normal?.unitCostCents, null);
  assert.match(normal?.note ?? "", /Airtable was not changed/);
  assert.equal(normal?.sourceKind, "snapshot");
  assert.equal(normal?.sourceRef, REC);

  const [enchanted] = planOpeningEntries([row(REC, baseFields({ Finish: "Enchanted", Rarity: "Enchanted" }))], TENANT, NOW);
  assert.equal(enchanted?.snapshot?.finish, "Holofoil");
  assert.equal(enchanted?.snapshot?.rarityNote, "Enchanted");
  assert.equal(enchanted?.needsReview, null);

  const [special] = planOpeningEntries([row(REC, baseFields({ Finish: "Special" }))], TENANT, NOW);
  assert.equal(special?.snapshot?.finish, null);
  assert.match(special?.needsReview ?? "", /Not guessed/);
  assert.equal(canonicalStockFinish("Special").finish, null);

  const [english] = planOpeningEntries([row(REC, baseFields())], TENANT, NOW);
  assert.equal(english?.snapshot?.language, "English");
  assert.equal(normalizeLanguage("EN").language, "English");

  const [japanese] = planOpeningEntries([row("recFIXTUREJAPAN01", baseFields({ Language: "Japanese", "Collector Number": "12" }))], TENANT, NOW);
  assert.equal(japanese?.snapshot?.language, "Japanese");
  assert.match(japanese?.needsReview ?? "", /Non-English/);
  assert.notEqual(japanese?.snapshot?.identityKey, english?.snapshot?.identityKey);

  const twins = planOpeningEntries([
    row(REC, baseFields({ Finish: "Normal", "Collector Number": "042" })),
    row("recFIXTURETIDE001", baseFields({ Finish: "Regular", "Collector Number": "42" })),
  ], TENANT, NOW);
  assert.equal(twins.length, 2);
  assert.ok(twins.every((movement) => movement.needsReview?.includes("Not merged")));
  assert.equal(twins[0]?.snapshot?.identityKey, twins[1]?.snapshot?.identityKey);
  assert.equal(stockIdentityKey({ game: "Lorcana", setIdentity: "1", collectorNumber: "042", finish: "Regular", condition: "NM", language: "English" }), twins[0]?.snapshot?.identityKey);

  const [badQty] = planOpeningEntries([row(REC, baseFields({ Qty: 1.5 }))], TENANT, NOW);
  assert.equal(badQty?.delta, 0);
  assert.match(badQty?.needsReview ?? "", /whole number/);
  assert.equal(planOpeningEntries([row(REC, baseFields({ Qty: 4 })), row("recFIXTURETIDE001", baseFields({ Qty: 1 }))], TENANT, NOW).reduce((sum, movement) => sum + movement.delta, 0), 5);
});

test("category and sealed rows are never decremented and never supply Want Qty", () => {
  assert.equal(wantDecrementAllowed("Category"), false);
  assert.equal(wantDecrementAllowed("Sealed"), false);
  assert.equal(wantDecrementAllowed(" sealed "), false);
  assert.equal(wantDecrementAllowed("Single"), true);
  assert.equal(wantDecrementAllowed(null), true);
  const stock = { game: "Lorcana", setIdentity: "1", collectorNumber: "42/204", finish: "Holofoil" };
  const blocked = matchWantQty(stock, [
    { id: "recBUYLISTCAT0001", fields: { Kind: "Category", Game: "Lorcana", Set: "1", Finish: "Any", "Want Qty": 99, "Collector #": "42/204" } },
    { id: "recBUYLISTSEAL001", fields: { Kind: "Sealed", Game: "Lorcana", Set: "The First Chapter", Finish: "Enchanted", "Want Qty": 4, "Collector #": "042" } },
  ]);
  assert.equal(blocked.wantQty, null);
  const single = matchWantQty(stock, [
    { id: "recBUYLISTCAT0001", fields: { Kind: "Category", Game: "Lorcana", Set: "1", Finish: "Any", "Want Qty": 99, "Collector #": "42/204" } },
    { id: "recBUYLISTEMBER01", fields: { Kind: "Single", Game: "Lorcana", Set: "The First Chapter", Finish: "Enchanted", "Want Qty": 2, "Collector #": "42/204" } },
  ]);
  assert.equal(single.wantQty, 2);
  const anyFinish = matchWantQty(
    { game: "Lorcana", setIdentity: "7", collectorNumber: "033/204", finish: "Foil" },
    [{ id: "recBUYLISTANY0001", fields: { Kind: "Single", Game: "Lorcana", Set: "7", Finish: "Any", "Want Qty": 1, "Collector #": "33/204" } }],
  );
  assert.equal(anyFinish.wantQty, 1);
  const blankWant = matchWantQty(stock, [{ id: "recBUYLISTSPRIT01", fields: { Kind: "Single", Game: "Lorcana", Set: "1", Finish: "Holofoil", "Collector #": "42/204" } }]);
  assert.equal(blankWant.wantQty, null);
  const ambiguous = matchWantQty(stock, [
    { id: "recBUYLISTEMBER01", fields: { Kind: "Single", Game: "Lorcana", Set: "1", Finish: "Holofoil", "Want Qty": 2, "Collector #": "42/204" } },
    { id: "recBUYLISTTIDE001", fields: { Kind: "Single", Game: "Lorcana", Set: "1", Finish: "Holofoil", "Want Qty": 5, "Collector #": "042/204" } },
  ]);
  assert.equal(ambiguous.wantQty, null);
  assert.match(ambiguous.review ?? "", /not guessed/i);
});

test("threshold flags use the approved defaults", () => {
  const flags = (over: Partial<Parameters<typeof stockFlags>[0]>) => stockFlags({
    onHand: 1, wantQty: null, thresholds: { ...DEFAULT_THRESHOLDS }, dateAcquired: null, firstSeen: null, lastSaleAt: null, now: NOW, ...over,
  });
  assert.equal(flags({ onHand: 0, wantQty: 2 }).low, true);
  assert.equal(flags({ onHand: 0, wantQty: null }).low, false, "blank Want Qty is not tracked");
  assert.equal(flags({ onHand: 1, wantQty: 2 }).low, false);
  assert.equal(flags({ onHand: 0, wantQty: 0 }).low, false);

  assert.equal(flags({ onHand: 14, wantQty: 8 }).overstock, true);
  assert.equal(flags({ onHand: 14, wantQty: 8 }).overstockBy, 6);
  assert.equal(flags({ onHand: 9, wantQty: null }).overstock, true);
  assert.equal(flags({ onHand: 9, wantQty: null }).overstockBy, 6);
  assert.equal(flags({ onHand: 3, wantQty: null }).overstock, false, "more than 3, so 3 is not overstock");
  assert.equal(flags({ onHand: 4, wantQty: null }).overstock, true);
  assert.equal(flags({ onHand: 9, wantQty: null, thresholds: { ...DEFAULT_THRESHOLDS, tcgplayerLevel: 2 } }).overstock, false);
  assert.equal(flags({ onHand: 4, wantQty: 2, thresholds: { ...DEFAULT_THRESHOLDS, tcgplayerLevel: 4 } }).overstock, true);
  assert.equal(flags({ onHand: 4, wantQty: 2, thresholds: { ...DEFAULT_THRESHOLDS, tcgplayerLevel: 4 } }).overstockBy, 2);

  const old = new Date(NOW.getTime() - 45 * DAYS).toISOString();
  const almost = new Date(NOW.getTime() - 44 * DAYS).toISOString();
  const veryOld = new Date(NOW.getTime() - 80 * DAYS).toISOString();
  const recentSale = new Date(NOW.getTime() - 10 * DAYS).toISOString();
  assert.equal(flags({ onHand: 1, firstSeen: old }).slow, true);
  assert.equal(flags({ onHand: 1, firstSeen: old }).ageSource, "first_seen");
  assert.equal(flags({ onHand: 1, firstSeen: almost }).slow, false);
  assert.equal(flags({ onHand: 1, firstSeen: veryOld, lastSaleAt: recentSale }).slow, false);
  assert.equal(flags({ onHand: 0, firstSeen: veryOld, wantQty: 2 }).slow, false);
  assert.equal(flags({ onHand: 1, dateAcquired: recentSale, firstSeen: veryOld }).slow, false, "a known Date Acquired wins over first seen");
  assert.equal(flags({ onHand: 1 }).slow, false, "blank dates are not a slow mover");
  assert.equal(DEFAULT_THRESHOLDS.slowMoverDays, 45);
  assert.equal(DEFAULT_THRESHOLDS.lowStockOnHand, 0);
  assert.equal(DEFAULT_THRESHOLDS.overstockSkuLimit, 3);
  assert.equal(DEFAULT_THRESHOLDS.tcgplayerLevel, 1);
});

test("fixture stock shows each approved flag and keeps later phases inert", () => {
  const view = buildInventory(fixtureMovements(NOW), fixtureBuyList(), { ...DEFAULT_THRESHOLDS }, NOW, {}, "matched");
  const byName = (name: string) => view.rows.filter((row) => row.name === name);
  const ember = byName("Example Ember Drake")[0];
  assert.equal(ember?.finish, "Holofoil");
  assert.equal(ember?.rarityNote, "Enchanted");
  assert.equal(ember?.unitCostCents, null);
  assert.equal(ember?.dateAcquired, null);
  assert.equal(ember?.daysInStock, null);
  assert.equal(ember?.wantQty, 2, "category and sealed wants are ignored");
  assert.equal(ember?.flags.overstock, true);
  assert.equal(ember?.flags.low, false);
  assert.equal(ember?.flags.slow, false);

  assert.equal(byName("Example Rift Scout")[0]?.flags.low, true);
  assert.equal(byName("Example Harbor Sprite")[0]?.flags.low, false);
  assert.equal(byName("Example Harbor Sprite")[0]?.state, "Sold");
  assert.equal(byName("Example Vault Golem")[0]?.finish, "Regular");
  assert.equal(byName("Example Vault Golem")[0]?.flags.slow, true);
  assert.equal(byName("Example Vault Golem")[0]?.flags.overstock, true);
  assert.equal(byName("Example Lantern Thief")[0]?.flags.overstockBy, 6);
  assert.equal(byName("Example Moss Knight")[0]?.flags.slow, true);
  assert.equal(byName("Example Moss Knight")[0]?.flags.overstock, false);
  assert.equal(byName("Example Young Drake")[0]?.flags.overstock, true);
  assert.equal(byName("Example Any-Finish Wisp")[0]?.wantQty, 1);
  assert.match(byName("Example Prism Fox")[0]?.flags.needsReview ?? "", /Not guessed/);
  assert.match(byName("Example Sakura Knight")[0]?.flags.needsReview ?? "", /Non-English/);
  assert.equal(byName("Example Tide Oracle").length, 2);
  assert.ok(byName("Example Tide Oracle").every((row) => row.flags.needsReview?.includes("Not merged")));
  assert.equal(view.placeholders.tcgplayerLevel.includes("does not read any other account"), true);
  assert.equal(view.orderSources.find((source) => source.kind === "tcgplayer_order")?.available, false);
  assert.equal(view.onHandSource, "ledger");
  assert.equal(view.readOnly, true);
  const filtered = buildInventory(fixtureMovements(NOW), fixtureBuyList(), { ...DEFAULT_THRESHOLDS }, NOW, { flag: "low" }, "matched");
  assert.deepEqual(filtered.rows.map((row) => row.name), ["Example Rift Scout"]);
  assert.equal(filtered.totals.units, view.totals.units);
});

test("Airtable access for opening entries is a GET of Waitlist or Buy List only", async () => {
  assert.equal(WAITLIST_READ_FIELDS.includes("Language"), false);
  assert.deepEqual([...BUY_LIST_READ_FIELDS], ["Item", "Game", "Kind", "Set", "Finish", "Want Qty", "Collector #", "Status"]);
  assert.throws(() => airtableListUrl("appXXXXXXXXXXXXXX", "tblvHPu7dgDHA91bc", WAITLIST_READ_FIELDS), /Refusing to read a base/);
  assert.throws(() => airtableListUrl("app4Tjz72sZtVMQyp", "tblsIZ5hfhKBhkYbB", WAITLIST_READ_FIELDS), /Refusing to read a table/);
  const calls: { method: string; body: boolean }[] = [];
  const token = "super-secret-token";
  await assert.rejects(
    () => loadWaitlist(token, async (_url, init) => {
      calls.push({ method: init?.method ?? "GET", body: init?.body != null });
      return new Response(JSON.stringify({ error: { message: `nope ${token}` } }), { status: 403 });
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).message.includes(token), false);
      assert.match((error as Error).message, /\[redacted\]/);
      return true;
    },
  );
  assert.deepEqual(calls, [{ method: "GET", body: false }]);
  const ok = await loadWaitlist(token, async () => new Response(JSON.stringify({ records: [{ id: REC, createdTime: NOW.toISOString(), fields: baseFields() }] }), { status: 200 }));
  assert.equal(ok.length, 1);
  assert.equal(ok[0]?.fields.Finish, "Foil");
});
