import { test } from "node:test";
import assert from "node:assert/strict";
import { CARDTRADER_FIELD, RESERVED_QTY_FIELD, STOCK_FIELD_ATTEMPTS, TCGPLAYER_SKU_FIELD } from "./airtable.ts";
import { listableQty, withListableQuantity } from "./listable.ts";

test("listable quantity is Qty minus Reserved Qty, blank is 0, and it floors at 0", () => {
  assert.equal(listableQty(4, 1), 3);
  assert.equal(listableQty(4, 0), 4);
  assert.equal(listableQty(4, null), 4);
  assert.equal(listableQty(4, undefined), 4);
  assert.equal(listableQty(1, 3), 0);
  assert.equal(listableQty(2, -1), 2);
  assert.equal(listableQty(2.9, 1.2), 1);
});

test("new listings and re-lists pass the listable quantity, not the on-hand Qty", () => {
  const [card] = withListableQuantity([{ id: "recAAAAAAAAAAAAAA", qty: 4, reservedQty: 1 }]);
  assert.equal(card!.qty, 3);
  assert.equal(withListableQuantity([{ qty: 2 }])[0]!.qty, 2);
});

test("stock reads keep Reserved Qty when the optional SKU column is absent", () => {
  assert.ok(STOCK_FIELD_ATTEMPTS[0]!.includes(RESERVED_QTY_FIELD));
  assert.ok(STOCK_FIELD_ATTEMPTS[0]!.includes(TCGPLAYER_SKU_FIELD));
  const withoutSku = STOCK_FIELD_ATTEMPTS.find((fields) => fields.includes(RESERVED_QTY_FIELD) && !fields.includes(TCGPLAYER_SKU_FIELD));
  assert.ok(withoutSku);
  assert.ok(withoutSku!.includes(CARDTRADER_FIELD));
  assert.ok(STOCK_FIELD_ATTEMPTS.some((fields) => !fields.includes(RESERVED_QTY_FIELD) && !fields.includes(TCGPLAYER_SKU_FIELD)));
});
