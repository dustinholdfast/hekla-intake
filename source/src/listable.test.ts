import { test } from "node:test";
import assert from "node:assert/strict";
import { CARDTRADER_FIELD, TCGPLAYER_SKU_FIELD, unknownAirtableField, withoutUnknownField } from "./airtable.ts";
import { DEFAULT_DECK_RESERVED_QTY_FIELD, DEFAULT_FREE_QTY_FIELD, DEFAULT_RESERVED_QTY_FIELD, holdFieldNames, listableQty, withListableQuantity } from "./listable.ts";

test("listable quantity subtracts manual and deck holds, blanks are 0, and it floors at 0", () => {
  assert.equal(listableQty({ qty: 5, reservedQty: 1, deckReservedQty: 2 }), 2);
  assert.equal(listableQty({ qty: 4, reservedQty: 1 }), 3);
  assert.equal(listableQty({ qty: 4, reservedQty: 0, deckReservedQty: 0 }), 4);
  assert.equal(listableQty({ qty: 4, reservedQty: null, deckReservedQty: null }), 4);
  assert.equal(listableQty({ qty: 4 }), 4);
  assert.equal(listableQty({ qty: 1, reservedQty: 3, deckReservedQty: 1 }), 0);
  assert.equal(listableQty({ qty: 2, reservedQty: -1, deckReservedQty: -4 }), 2);
  assert.equal(listableQty({ qty: 2.9, reservedQty: 1.2 }), 1);
});

test("a Free Qty number is used, and a blank formula falls back to Qty minus both holds", () => {
  assert.equal(listableQty({ qty: 5, reservedQty: 1, deckReservedQty: 1, freeQty: 2 }), 2);
  assert.equal(listableQty({ qty: 4, freeQty: 0 }), 0);
  assert.equal(listableQty({ qty: 4, reservedQty: 1, freeQty: null }), 3);
  assert.equal(listableQty({ qty: 3, freeQty: -2 }), 0);
});

test("new listings and re-lists pass the listable quantity, not the on-hand Qty", () => {
  const [card] = withListableQuantity([{ id: "recAAAAAAAAAAAAAA", qty: 5, reservedQty: 1, deckReservedQty: 1 }]);
  assert.equal(card!.qty, 3);
  assert.equal(withListableQuantity([{ qty: 4, freeQty: 1 }])[0]!.qty, 1);
  assert.equal(withListableQuantity([{ qty: 2 }])[0]!.qty, 2);
});

test("hold field names default and can be overridden", () => {
  assert.deepEqual(holdFieldNames(), { reservedQty: DEFAULT_RESERVED_QTY_FIELD, deckReservedQty: DEFAULT_DECK_RESERVED_QTY_FIELD, freeQty: DEFAULT_FREE_QTY_FIELD });
  assert.deepEqual(holdFieldNames({}), { reservedQty: "Reserved Qty", deckReservedQty: "Deck Reserved Qty", freeQty: "Free Qty" });
  assert.equal(holdFieldNames({ RESERVED_QTY_FIELD: " Manual Hold ", DECK_RESERVED_QTY_FIELD: "", FREE_QTY_FIELD: "Available" }).reservedQty, "Manual Hold");
  assert.equal(holdFieldNames({ DECK_RESERVED_QTY_FIELD: "   ", FREE_QTY_FIELD: "Available" }).deckReservedQty, "Deck Reserved Qty");
  assert.equal(holdFieldNames({ FREE_QTY_FIELD: "Available" }).freeQty, "Available");
});

test("an unknown optional column is dropped without dropping the hold fields that exist", () => {
  const required = ["Qty", CARDTRADER_FIELD];
  const fields = [...required, TCGPLAYER_SKU_FIELD, "Reserved Qty", "Deck Reserved Qty", "Free Qty"];
  assert.equal(unknownAirtableField('Airtable: Unknown field name: "TCGplayer SKU"'), "TCGplayer SKU");
  assert.deepEqual(withoutUnknownField(fields, required, 'Unknown field name: "TCGplayer SKU"'), [...required, "Reserved Qty", "Deck Reserved Qty", "Free Qty"]);
  assert.deepEqual(withoutUnknownField(fields, required, "Unknown field"), [...required, TCGPLAYER_SKU_FIELD, "Reserved Qty", "Deck Reserved Qty"]);
  assert.equal(withoutUnknownField(required, required, 'Unknown field name: "Qty"'), null);
});
