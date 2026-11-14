import { test } from "node:test";
import assert from "node:assert/strict";
import { weightedCost } from "./cleanup.ts";
import { draftIdentityKey } from "./intake-upsert.ts";
import { FIXTURE_TENANT } from "./inventory-fixtures.ts";
import { defaultInventorySettings } from "./inventory-settings.ts";
import { exampleAcceptInput, exampleCatalog, exampleSellRequestRecord, EXAMPLE_RECEIVED_ON, EXAMPLE_SR_ID } from "./purchases-fixtures.ts";
import {
  applyReceiveWrites,
  isWorseCondition,
  nextKnownCost,
  planAcceptance,
  planReceipt,
  planRedemption,
  planWant,
  PurchaseBook,
  payoutKind,
  qtyPatchDecision,
  readSellRequest,
} from "./purchases.ts";
import { applyPurchaseTables, creditMirrorPlan, fieldCreateBody, formatPurchaseSchema, planPurchaseTables, purchaseTablePlan, PURCHASE_FIELDS, CREDIT_MIRROR_FIELDS, PRIMARY_FIELD_TYPES, tableRequestBody, type FieldCreateBody } from "./purchases-schema.ts";

const NOW = "2026-10-27T15:00:00.000Z";

test("payouts: PayPal, Venmo, and Check are cash, and Store Credit is exact", () => {
  assert.equal(payoutKind("PayPal").ok && payoutKind("PayPal").ok, true);
  assert.deepEqual(payoutKind("PayPal"), { ok: true, kind: "cash" });
  assert.deepEqual(payoutKind("Venmo"), { ok: true, kind: "cash" });
  assert.deepEqual(payoutKind("Check"), { ok: true, kind: "cash" });
  assert.deepEqual(payoutKind("Store Credit"), { ok: true, kind: "store_credit" });
  assert.equal(payoutKind("store credit").ok, false);
  assert.equal(payoutKind("CashApp").ok, false);
});

test("a sell request drops name, email, and phone", () => {
  const opened = readSellRequest(exampleSellRequestRecord());
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(opened.request.ref, "SR-EX12");
  assert.equal(opened.request.offerCents, 1800);
  const packed = JSON.stringify(opened.request);
  assert.equal(packed.includes("seller@example.com"), false);
  assert.equal(packed.includes("555-010-0199"), false);
  assert.equal(packed.includes("Example Seller"), false);
  assert.equal(readSellRequest({ id: "not-a-record", fields: {} }).ok, false);
});

test("blocked grades are refused and a missing market ref blocks the split", () => {
  const input = exampleAcceptInput();
  const mp = structuredClone(input);
  mp.lines[0]!.condition = "MP";
  const blocked = planAcceptance(mp);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.error, /not buyable/);

  const missing = structuredClone(input);
  missing.lines[2]!.marketRefCents = null;
  const stopped = planAcceptance(missing);
  assert.equal(stopped.ok, false);
  if (!stopped.ok) assert.match(stopped.error, /no market ref/);
});

test("line shares add up to the offer in exact cents", () => {
  const planned = planAcceptance(exampleAcceptInput());
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const sum = planned.purchase.lines.reduce((total, line) => total + line.offerCents, 0);
  assert.equal(sum, 1800);
  assert.equal(planned.purchase.lines.reduce((total, line) => total + line.cashCents, 0), 0);
  assert.equal(planned.purchase.lines.reduce((total, line) => total + line.creditCents, 0), 1800);
  for (const line of planned.purchase.lines) {
    assert.equal(line.costTotalCents, line.creditCents, "store credit is costed at face value");
    assert.equal(line.costRule, "credit rule v1");
  }
  assert.equal(planned.purchase.lines[0]?.ratePercent, 65);
  assert.equal(planned.purchase.lines[1]?.ratePercent, 55);
  assert.equal(planned.purchase.lines[2]?.buyListId, null, "Moss Knight has no buy-list row");
  assert.equal(planned.purchase.lines[2]?.marketRefSource, "Market Price USD");
  assert.equal(planned.purchase.lines[0]?.marketRefSource, "Buy List Market Ref USD");
});

test("cash cost is the cash paid", () => {
  const input = exampleAcceptInput();
  input.request = { ...input.request, payout: "PayPal" };
  const planned = planAcceptance(input);
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  assert.equal(planned.purchase.paymentType, "cash");
  for (const line of planned.purchase.lines) {
    assert.equal(line.cashCents, line.offerCents);
    assert.equal(line.creditCents, 0);
    assert.equal(line.costTotalCents, line.cashCents);
    assert.equal(line.costRule, "cash paid");
    assert.equal(line.ratePercent, line.condition === "LP" ? 40 : 50);
  }
});

test("double submit keeps one purchase and does not change stock", () => {
  const book = new PurchaseBook();
  const first = book.accept(exampleAcceptInput());
  const second = book.accept(exampleAcceptInput());
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.purchase.id, first.purchase.id);
  assert.equal(book.liability(FIXTURE_TENANT).entries, 0);
  assert.equal(first.purchase.lines.every((line) => line.status === "accepted"), true);
  const edited = exampleAcceptInput();
  edited.request = { ...edited.request, offerCents: 900 };
  const third = book.accept(edited);
  assert.equal(third.ok, true);
  if (!third.ok) return;
  assert.equal(third.purchase.id, first.purchase.id);
  assert.equal(third.purchase.lines.reduce((sum, line) => sum + line.offerCents, 0), 900);
});

test("double receive inserts one movement and one credit row", () => {
  const book = new PurchaseBook();
  const input = exampleAcceptInput();
  input.lines = input.lines.slice(0, 1);
  input.request = { ...input.request, offerCents: input.lines[0]!.marketRefCents! };
  assert.equal(book.accept(input).ok, true);
  const confirms = [{ lineNo: input.lines[0]!.lineNo, condition: "NM" }];
  const first = book.receive({ tenantId: FIXTURE_TENANT, sellRequestId: EXAMPLE_SR_ID, receivedOn: EXAMPLE_RECEIVED_ON, now: NOW, confirms });
  const second = book.receive({ tenantId: FIXTURE_TENANT, sellRequestId: EXAMPLE_SR_ID, receivedOn: EXAMPLE_RECEIVED_ON, now: NOW, confirms });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.movementsInserted, 1);
  assert.equal(first.creditsInserted, 1);
  assert.equal(second.movementsInserted, 0);
  assert.equal(second.creditsInserted, 0);
  assert.equal(second.plan.writes.length, 0);
  assert.equal(book.liability(FIXTURE_TENANT).outstandingCents, first.plan.credits[0]?.amountCents);
  assert.equal(book.entries(FIXTURE_TENANT).length, 1);
  assert.equal(book.entries(FIXTURE_TENANT)[0]?.customerRef, EXAMPLE_SR_ID);
});

test("blank Want Qty is left alone, want never goes below 0, and Active fills at 0", () => {
  assert.deepEqual(planWant({ kind: "Single", wantQty: null, status: "Active", qty: 4 }), { write: false, wantAfter: null, statusAfter: null, overstockQty: 0 });
  assert.deepEqual(planWant({ kind: "Category", wantQty: 9, status: "Active", qty: 4 }), { write: false, wantAfter: null, statusAfter: null, overstockQty: 0 });
  assert.deepEqual(planWant({ kind: "Sealed", wantQty: 2, status: "Active", qty: 1 }), { write: false, wantAfter: null, statusAfter: null, overstockQty: 0 });
  assert.deepEqual(planWant({ kind: "Single", wantQty: 1, status: "Active", qty: 3 }), { write: true, wantAfter: 0, statusAfter: "Filled", overstockQty: 2 });
  assert.deepEqual(planWant({ kind: "Single", wantQty: 2, status: "Active", qty: 2 }), { write: true, wantAfter: 0, statusAfter: "Filled", overstockQty: 0 });
  assert.equal(planWant({ kind: "Single", wantQty: 8, status: "Active", qty: 2 }).wantAfter, 6);
  assert.equal(planWant({ kind: "Single", wantQty: 0, status: "Paused", qty: 1 }).wantAfter, 0);
  assert.equal(planWant({ kind: "Single", wantQty: 0, status: "Paused", qty: 1 }).statusAfter, null);

  const planned = planAcceptance(exampleAcceptInput());
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const book = new PurchaseBook();
  book.accept(exampleAcceptInput());
  const received = book.receive({
    tenantId: FIXTURE_TENANT,
    sellRequestId: EXAMPLE_SR_ID,
    receivedOn: EXAMPLE_RECEIVED_ON,
    now: NOW,
    confirms: planned.purchase.lines.map((line) => ({ lineNo: line.lineNo, condition: line.condition })),
  });
  assert.equal(received.ok, true);
  if (!received.ok) return;
  const moss = received.plan.purchase.lines.find((line) => line.item === "Example Moss Knight");
  assert.equal(moss?.wantWrite, false);
  assert.equal(moss?.wantAfter, null);
  assert.equal(received.plan.writes.some((write) => write.kind === "patch_want" && write.recordId === moss?.buyListId), false);
  const ember = received.plan.purchase.lines.find((line) => line.item === "Example Ember Drake");
  assert.equal(ember?.wantAfter, 1);
  assert.equal(ember?.wantStatusAfter, null);
  const lantern = received.plan.purchase.lines.find((line) => line.item === "Example Lantern Thief");
  assert.equal(lantern?.stockRecordId?.startsWith("recNewStock"), true);
  const create = received.plan.writes.find((write) => write.kind === "create_stock");
  assert.equal(create?.kind === "create_stock" ? create.fields["Date Acquired"] : null, EXAMPLE_RECEIVED_ON);
  assert.equal(create?.kind === "create_stock" ? create.fields.Finish : null, "Normal");
  const emberPatch = received.plan.writes.find((write) => write.kind === "patch_qty" && write.recordId === ember?.stockRecordId);
  assert.equal(emberPatch?.kind === "patch_qty" ? emberPatch.fields["Unknown-Cost Qty"] : null, ember?.onHand);
  assert.equal(emberPatch?.kind === "patch_qty" ? emberPatch.before : null, 4);
});

test("a worse-condition line is rejected with no stock and no Want Qty change", () => {
  assert.equal(isWorseCondition("NM", "LP"), true);
  assert.equal(isWorseCondition("LP", "NM"), false);
  const book = new PurchaseBook();
  book.accept(exampleAcceptInput());
  const catalog = exampleCatalog();
  const received = book.receive({
    tenantId: FIXTURE_TENANT,
    sellRequestId: EXAMPLE_SR_ID,
    receivedOn: EXAMPLE_RECEIVED_ON,
    now: NOW,
    confirms: catalog.lines.map((line) => ({ lineNo: line.lineNo, condition: line.lineNo === catalog.lines[0]?.lineNo ? "LP" : line.condition ?? "NM" })),
  });
  assert.equal(received.ok, true);
  if (!received.ok) return;
  const ember = received.plan.purchase.lines.find((line) => line.item === "Example Ember Drake");
  assert.equal(ember?.status, "rejected");
  assert.equal(received.plan.movements.some((movement) => movement.note?.includes("line 1")), false);
  assert.equal(received.plan.credits.some((entry) => entry.sourceRef.endsWith(":1")), false);
  assert.equal(received.plan.writes.some((write) => write.kind === "patch_qty" && write.recordId === "recFIXTUREEMBER01"), false);
  assert.equal(received.plan.writes.some((write) => write.kind === "patch_want" && write.recordId === "recBUYLISTEMBER01"), false);
  const row = received.plan.writes.find((write) => write.kind === "create_purchase" && write.lineKey.endsWith(":1"));
  assert.equal(row?.kind === "create_purchase" ? row.fields.Status : null, "Rejected");
  assert.equal(JSON.stringify(row).includes("seller@example.com"), false);
});

test("unknown opening cost is not backfilled, and a redemption cannot go below zero", () => {
  const cost = nextKnownCost({ onHand: 4, unknownCostQty: null, costBasisCents: null, addQty: 1, addCostTotalCents: 1300 });
  assert.equal(cost.unknownCostQty, 4);
  assert.equal(cost.costBasisCents, 1300);
  const mixed = nextKnownCost({ onHand: 4, unknownCostQty: 2, costBasisCents: 100, addQty: 2, addCostTotalCents: 300 });
  assert.equal(mixed.unknownCostQty, 2);
  assert.equal(mixed.costBasisCents, 125);

  const book = new PurchaseBook();
  const input = exampleAcceptInput();
  input.lines = [input.lines[0]!];
  input.request = { ...input.request, offerCents: input.lines[0]!.marketRefCents! };
  book.accept(input);
  book.receive({ tenantId: FIXTURE_TENANT, sellRequestId: EXAMPLE_SR_ID, receivedOn: EXAMPLE_RECEIVED_ON, now: NOW, confirms: [{ lineNo: input.lines[0]!.lineNo, condition: "NM" }] });
  const balance = book.balance(FIXTURE_TENANT, EXAMPLE_SR_ID);
  const tooMuch = book.redeem({ tenantId: FIXTURE_TENANT, customerRef: EXAMPLE_SR_ID, amountCents: balance + 1, sourceRef: "redeem-1", balanceCents: balance, now: NOW, occurredOn: EXAMPLE_RECEIVED_ON });
  assert.equal(tooMuch.ok, false);
  const first = book.redeem({ tenantId: FIXTURE_TENANT, customerRef: "seller@example.com", amountCents: 100, sourceRef: "redeem-1", balanceCents: balance, now: NOW, occurredOn: EXAMPLE_RECEIVED_ON });
  assert.equal(first.ok, false);
  const ok = book.redeem({ tenantId: FIXTURE_TENANT, customerRef: EXAMPLE_SR_ID, amountCents: 100, sourceRef: "redeem-1", balanceCents: balance, now: NOW, occurredOn: EXAMPLE_RECEIVED_ON });
  const again = book.redeem({ tenantId: FIXTURE_TENANT, customerRef: EXAMPLE_SR_ID, amountCents: 100, sourceRef: "redeem-1", balanceCents: balance, now: NOW, occurredOn: EXAMPLE_RECEIVED_ON });
  assert.equal(ok.ok && again.ok, true);
  if (!ok.ok || !again.ok) return;
  assert.equal(ok.created, true);
  assert.equal(again.created, false);
  assert.equal(book.liability(FIXTURE_TENANT).outstandingCents, balance - 100);
  assert.equal(book.entries(FIXTURE_TENANT).length, 2);
  assert.equal(JSON.stringify(book.entries(FIXTURE_TENANT)).includes("@"), false);
});

test("receipt writes are creates and patches, and a second purchase row is not posted", async () => {
  const planned = planAcceptance(exampleAcceptInput());
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const receipt = planReceipt({
    purchase: planned.purchase,
    receivedOn: EXAMPLE_RECEIVED_ON,
    now: NOW,
    confirms: planned.purchase.lines.map((line) => ({ lineNo: line.lineNo, condition: line.condition })),
    balanceCents: 0,
    mintRecordId: (lineNo) => `recNewStockLn${String(lineNo).padStart(4, "0")}`,
  });
  assert.equal(receipt.ok, true);
  if (!receipt.ok) return;
  const calls: { method: string; url: string }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(url) });
    if (method === "GET") return new Response(JSON.stringify({ records: [] }), { status: 200 });
    return new Response(JSON.stringify({ records: [{ id: "recCREATEDPURCH01" }] }), { status: 200 });
  };
  const result = await applyReceiveWrites({ token: "patSECRETVALUE", writes: receipt.plan.writes, fetchImpl });
  assert.ok(calls.every((call) => call.method === "GET" || call.method === "POST" || call.method === "PATCH"));
  assert.equal(calls.some((call) => call.method === "DELETE"), false);
  assert.equal(result.created.length > 0, true);
  assert.equal(JSON.stringify(calls).includes("patSECRETVALUE"), false);
  const purchasePosts = calls.filter((call) => call.method === "POST" && call.url.includes("Purchases")).length;
  calls.length = 0;
  const fetchAgain: typeof fetch = async (url, init) => {
    calls.push({ method: init?.method ?? "GET", url: String(url) });
    if ((init?.method ?? "GET") === "GET" && String(url).includes("Purchases")) return new Response(JSON.stringify({ records: [{ id: "recCREATEDPURCH01" }] }), { status: 200 });
    if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ records: [{ id: "recCREATEDSTOCK01" }] }), { status: 200 });
    return new Response(JSON.stringify({ id: "recIGNORED000000" }), { status: 200 });
  };
  await applyReceiveWrites({ token: "patSECRETVALUE", writes: receipt.plan.writes, fetchImpl: fetchAgain });
  assert.equal(calls.filter((call) => call.method === "POST" && call.url.includes("Purchases")).length, 0);
  assert.equal(purchasePosts > 0, true);
  assert.equal(qtyPatchDecision(5, 4, 5), "done");
  assert.equal(qtyPatchDecision(4, 4, 5), "apply");
  assert.equal(qtyPatchDecision(3, 4, 5), "flag");
});

test("purchase schema dry-run lists Purchases and an optional credit mirror, and skips a table that exists", async () => {
  const plan = planPurchaseTables([]);
  assert.deepEqual(plan.create.map((table) => table.name), ["Purchases", "Store Credit Ledger"]);
  assert.equal(plan.create[1]?.optional, true);
  assert.equal(plan.writes, "none");
  const names = PURCHASE_FIELDS.map((field) => field.name);
  for (const name of ["Hekla Purchase Line ID", "Sell Request", "Buy List row", "Stock row", "Condition", "Payment Type", "Market Ref USD at offer", "Condition Multiplier used", "Offer Amount USD", "Cash Paid USD", "Store Credit Issued USD", "Cost Basis USD", "Cost Rule", "Date Received", "Condition Confirmed", "Over Want Qty", "Status"]) {
    assert.equal(names.includes(name), true, name);
  }
  assert.equal(names.some((name) => /email|phone|seller/i.test(name)), false);
  assert.deepEqual(plan.create[0]?.links.map((link) => link.tableId), ["tbltX89tiY4H2cvuu", "tbleeKxJPfpQAAdnC", "tblvHPu7dgDHA91bc"]);
  const text = formatPurchaseSchema(plan);
  assert.match(text, /OPTIONAL CREATE Store Credit Ledger/);
  assert.match(text, /writes: none/);
  assert.match(text, /Airtable was not called/);
  assert.equal(/\bUPDATE\b|\bDELETE\b|\bRENAME\b/.test(text), false);
  assert.equal(CREDIT_MIRROR_FIELDS.some((field) => field.name === "Customer Reference"), true);
  const skipped = planPurchaseTables(["Purchases", "Store Credit Ledger"]);
  assert.equal(skipped.create.length, 0);
  assert.equal(skipped.skip.length, 2);

  let fetches = 0;
  const fetchImpl: typeof fetch = async () => {
    fetches += 1;
    return new Response(JSON.stringify({ id: "tblNew" }), { status: 200 });
  };
  const applied = await applyPurchaseTables({ token: "patSECRETVALUE", existingTables: ["Purchases"], includeCreditMirror: false, fetchImpl });
  assert.deepEqual(applied.created, []);
  assert.equal(fetches, 0);
  const withMirror = await applyPurchaseTables({ token: "patSECRETVALUE", existingTables: [], includeCreditMirror: false, fetchImpl });
  assert.deepEqual(withMirror.created, ["Purchases"]);
  assert.equal(withMirror.requests.every((request) => request.method === "POST"), true);
  assert.equal(fetches, 1);
});

test("Airtable create bodies omit options on singleLineText and pin every other field type", async () => {
  const tables = [purchaseTablePlan(), creditMirrorPlan()];
  const bodies = tables.map((table) => tableRequestBody(table));
  const fields = bodies.flatMap((body) => body.fields);
  const ofType = (type: FieldCreateBody["type"]) => fields.filter((field) => field.type === type);

  for (const table of tables) {
    const first = table.fields[0];
    assert.equal(first?.type, "singleLineText");
    assert.equal(PRIMARY_FIELD_TYPES.includes(first?.type as typeof PRIMARY_FIELD_TYPES[number]), true);
    assert.equal(table.note.length > 0, true);
  }

  for (const field of ofType("singleLineText")) {
    assert.deepEqual(Object.keys(field), ["name", "type", "description"]);
    assert.equal(JSON.stringify(field).includes("\"options\""), false);
    assert.equal(field.description.length > 0, true);
  }
  assert.equal(ofType("singleLineText").length, 11);

  for (const field of ofType("number")) {
    assert.deepEqual(field.options, { precision: 0 });
    assert.deepEqual(Object.keys(field.options ?? {}), ["precision"]);
  }
  assert.deepEqual(ofType("number").map((field) => field.name), ["Qty", "Condition Multiplier used", "Over Want Qty"]);

  for (const field of ofType("currency")) {
    assert.deepEqual(field.options, { precision: 2, symbol: "$" });
    assert.deepEqual(Object.keys(field.options ?? {}), ["precision", "symbol"]);
  }
  assert.equal(ofType("currency").length, 7);

  for (const field of ofType("date")) {
    assert.deepEqual(field.options, { dateFormat: { name: "iso", format: "YYYY-MM-DD" } });
    assert.deepEqual(Object.keys(field.options ?? {}), ["dateFormat"]);
  }
  assert.deepEqual(ofType("date").map((field) => field.name), ["Date Received", "Date"]);

  for (const field of ofType("checkbox")) {
    assert.deepEqual(field.options, { icon: "check", color: "greenBright" });
    assert.deepEqual(Object.keys(field.options ?? {}), ["icon", "color"]);
  }
  assert.deepEqual(ofType("checkbox").map((field) => field.name), ["Condition Confirmed"]);

  const choices: Record<string, string[]> = {
    Condition: ["NM", "LP", "MP", "HP", "DMG"],
    "Payment Type": ["Cash", "Store credit"],
    Status: ["Accepted", "Received", "Rejected", "Cancelled"],
    Entry: ["Issue", "Redemption"],
  };
  for (const field of ofType("singleSelect")) {
    const options = field.options as { choices: { name: string }[] };
    assert.deepEqual(Object.keys(options), ["choices"]);
    for (const choice of options.choices) assert.deepEqual(Object.keys(choice), ["name"]);
    assert.deepEqual(options.choices.map((choice) => choice.name), choices[field.name]);
  }
  assert.equal(ofType("singleSelect").length, 4);

  const links: Record<string, string> = {
    "Purchases.Sell Request": "tbltX89tiY4H2cvuu",
    "Purchases.Buy List row": "tbleeKxJPfpQAAdnC",
    "Purchases.Stock row": "tblvHPu7dgDHA91bc",
    "Store Credit Ledger.Sell Request": "tbltX89tiY4H2cvuu",
  };
  for (const body of bodies) {
    for (const field of body.fields.filter((row) => row.type === "multipleRecordLinks")) {
      const options = field.options as { linkedTableId: string };
      assert.deepEqual(Object.keys(options), ["linkedTableId"]);
      assert.match(options.linkedTableId, /^tbl[A-Za-z0-9]{14}$/);
      assert.equal(options.linkedTableId, links[`${body.name}.${field.name}`]);
    }
  }

  const purchases = bodies[0]!;
  assert.deepEqual(purchases.fields[0], fieldCreateBody(PURCHASE_FIELDS[0]!));
  assert.deepEqual(purchases.fields.find((field) => field.name === "Cost Basis USD")?.options, { precision: 2, symbol: "$" });
  const credit = bodies[1]!;
  assert.equal(Object.hasOwn(credit.fields[0]!, "options"), false);
  assert.deepEqual(credit.fields.find((field) => field.name === "Amount USD")?.options, { precision: 2, symbol: "$" });

  const posted: unknown[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    posted.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "tblNew" }), { status: 200 });
  };
  const applied = await applyPurchaseTables({ token: "patSECRETVALUE", existingTables: [], includeCreditMirror: true, fetchImpl });
  assert.deepEqual(applied.created, ["Purchases", "Store Credit Ledger"]);
  assert.deepEqual(posted, [tableRequestBody(purchaseTablePlan()), tableRequestBody(creditMirrorPlan())]);
  assert.equal(JSON.stringify(posted).includes("\"options\":{}"), false);
  assert.equal(JSON.stringify(posted).includes("patSECRETVALUE"), false);
});

test("the example catalog matches ember and leaves moss untracked", () => {
  const catalog = exampleCatalog();
  assert.equal(catalog.lines.length, 3);
  assert.equal(catalog.lines[0]?.stockRecordId, "recFIXTUREEMBER01");
  assert.equal(catalog.lines[0]?.wantQty, 2);
  assert.equal(catalog.lines[2]?.wantQty, null);
  assert.equal(defaultInventorySettings().creditCostRule, "face_value");
});

test("receive merges a matching stock identity instead of posting a row, and averages an existing cost", () => {
  const planned = planAcceptance(exampleAcceptInput());
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const purchase = structuredClone(planned.purchase);
  const line = purchase.lines.find((item) => item.item === "Example Lantern Thief");
  assert.ok(line);
  assert.equal(line.stockRecordId, null);
  const identityKey = draftIdentityKey({
    game: line.game,
    setNumber: line.game === "Lorcana" ? line.setIdentity : null,
    setIdentifier: line.game === "Lorcana" ? null : line.setIdentity,
    collectorNumber: line.collectorNumber ?? "",
    finish: line.finishStored ?? "",
    condition: line.condition,
    language: line.language,
  });
  assert.ok(identityKey);
  const blocked = planReceipt({
    purchase: structuredClone(purchase),
    receivedOn: EXAMPLE_RECEIVED_ON,
    now: NOW,
    confirms: [{ lineNo: line.lineNo, condition: line.condition }],
    balanceCents: 0,
    mintRecordId: (lineNo) => `recNewStockLn${String(lineNo).padStart(4, "0")}`,
    identityStock: [
      { identityKey, id: "recLANTERNEXIST01", qty: 1, costBasisUsd: 2, unknownCostQty: 0, status: "Listed" },
      { identityKey, id: "recLANTERNEXIST02", qty: 4, costBasisUsd: 2, unknownCostQty: 0, status: "Waitlist" },
    ],
  });
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.deepEqual(blocked.duplicate?.recordIds, ["recLANTERNEXIST01", "recLANTERNEXIST02"]);

  const receipt = planReceipt({
    purchase,
    receivedOn: EXAMPLE_RECEIVED_ON,
    now: NOW,
    confirms: purchase.lines.map((item) => ({ lineNo: item.lineNo, condition: item.condition })),
    balanceCents: 0,
    mintRecordId: (lineNo) => `recNewStockLn${String(lineNo).padStart(4, "0")}`,
    identityStock: [{ identityKey, id: "recLANTERNEXIST01", qty: 1, costBasisUsd: 2, unknownCostQty: 0, status: "Listed" }],
  });
  assert.equal(receipt.ok, true);
  if (!receipt.ok) return;
  assert.equal(receipt.plan.writes.some((write) => write.kind === "create_stock" && write.lineKey.endsWith(`:${line.lineNo}`)), false);
  const patch = receipt.plan.writes.find((write) => write.kind === "patch_qty" && write.recordId === "recLANTERNEXIST01");
  assert.equal(patch?.kind, "patch_qty");
  if (patch?.kind !== "patch_qty") return;
  assert.equal(patch.fields.Qty, 1 + line.qty);
  assert.equal(patch.before, 1);
  const averaged = weightedCost([{ qty: 1, costBasisUsd: 2 }, { qty: line.qty, costBasisUsd: line.unitCostCents / 100 }]);
  assert.equal(patch.fields["Cost Basis USD"], averaged.cost);
  assert.equal(receipt.plan.lots.find((lot) => lot.recordId === "recLANTERNEXIST01")?.qtyIn, line.qty);
  assert.equal(receipt.plan.purchase.lines.find((item) => item.lineNo === line.lineNo)?.stockRecordId, "recLANTERNEXIST01");
});
