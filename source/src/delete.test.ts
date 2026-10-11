import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDeletable } from "./airtable.ts";

test("delete only accepts real record ids on Waitlist rows", () => {
  assert.doesNotThrow(() => assertDeletable("recAAAAAAAAAAAAAA", "Waitlist"));
  assert.throws(() => assertDeletable("recAAAAAAAAAAAAAA", "Listed"), /Only Waitlist/);
  assert.throws(() => assertDeletable("recAAAAAAAAAAAAAA", null), /Only Waitlist/);
  assert.throws(() => assertDeletable("../tblX", "Waitlist"), /not an Airtable row/);
  assert.throws(() => assertDeletable("rec123", "Waitlist"), /not an Airtable row/);
});
