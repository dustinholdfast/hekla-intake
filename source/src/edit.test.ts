import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEditFields } from "./fields.ts";
import { collectorCore, previewCacheKey } from "./preview.ts";

test("edit allows only finish/condition/qty", () => {
  const r = buildEditFields({ finish: "foil", condition: "lp", qty: "3" }, "Lorcana");
  assert.deepEqual(r, { ok: true, fields: { Finish: "Foil", Condition: "LP", Qty: 3 } });
});
test("edit rejects other fields", () => {
  const r = buildEditFields({ qty: 2, status: "Listed" } as never, "Lorcana");
  assert.equal(r.ok, false);
});
test("edit rejects bad qty and empty body", () => {
  assert.equal(buildEditFields({ qty: 0 }, "Lorcana").ok, false);
  assert.equal(buildEditFields({ qty: 1.5 }, "Lorcana").ok, false);
  assert.equal(buildEditFields({}, "Lorcana").ok, false);
  assert.equal(buildEditFields({ condition: "Mint" }, "Lorcana").ok, false);
});
test("preview helpers", () => {
  assert.equal(collectorCore("42/204"), "42");
  assert.equal(previewCacheKey({ game: "Lorcana", set: "1", number: "42/204", name: "" }), previewCacheKey({ game: "Lorcana", set: "1", number: "42", name: "" }));
});
