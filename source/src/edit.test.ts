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

import { parseDraft } from "./fields.ts";
import { parseBulk } from "./parse.ts";
import { finishesFor } from "./sets.ts";
test("riftbound offers Normal, Foil, Special; Lorcana keeps Enchanted; Magic does not", () => {
  assert.deepEqual([...finishesFor("Riftbound")], ["Normal", "Foil", "Special"]);
  assert.deepEqual([...finishesFor("Lorcana")], ["Normal", "Foil", "Enchanted"]);
  assert.deepEqual([...finishesFor("Magic: The Gathering")], ["Normal", "Foil"]);
  assert.deepEqual([...finishesFor("Pokémon")], ["Normal", "Foil", "Enchanted"]);
  const rift = (finish: string) => parseDraft({ game: "Riftbound", setIdentifier: "VEN", collectorNumber: "SP6", finish, condition: "NM", qty: 1 } as never);
  const special = rift("Special");
  assert.equal(special.ok && special.card.finish, "Special");
  assert.equal(rift("Enchanted").ok, false);
  assert.equal(parseDraft({ game: "Lorcana", setNumber: "1", collectorNumber: "1", finish: "Special", condition: "NM", qty: 1 } as never).ok, false);
  assert.equal(buildEditFields({ finish: "special" }, "Riftbound").ok, true);
  assert.equal(buildEditFields({ finish: "Enchanted" }, "Riftbound").ok, false);
  assert.equal(buildEditFields({ finish: "Special" }, "Lorcana").ok, false);
  const [ok, bad] = parseBulk("VEN SP6 Special NM 1\nVEN 12 Enchanted NM 1", "Riftbound");
  assert.equal(ok?.card?.finish, "Special");
  assert.match(bad?.error ?? "", /not a Riftbound finish/);
});
