import { test } from "node:test";
import assert from "node:assert/strict";
import { CARDTRADER_GAMES, resolveSetInput, setOptions } from "./cardtrader.ts";

const EXP = [
  { id: 10, game_id: 1, code: "M21", name: "Core Set 2021" },
  { id: 900, game_id: 1, code: "fdn", name: "Foundations" },
  { id: 950, game_id: 22, code: "ogn", name: "Origins" },
  { id: 500, game_id: 1, code: "fdn", name: "Foundations (dupe)" },
  { id: 20, game_id: 1, code: "", name: "No code" },
  { id: 30, game_id: 5, code: "sv8", name: "Surging Sparks" },
];

test("setOptions keeps one game's expansions, newest first, codes lowercased and unique", () => {
  assert.deepEqual(setOptions(EXP, CARDTRADER_GAMES["Magic: The Gathering"].gameId), [{ code: "fdn", name: "Foundations" }, { code: "m21", name: "Core Set 2021" }]);
  assert.deepEqual(setOptions(EXP, CARDTRADER_GAMES.Riftbound.gameId), [{ code: "ogn", name: "Origins" }]);
  assert.deepEqual(setOptions(EXP, CARDTRADER_GAMES["Yu-Gi-Oh!"].gameId), []);
});

test("resolveSetInput accepts the code in any case, 'code — name', or the exact name", () => {
  const opts = setOptions(EXP, 1);
  assert.equal(resolveSetInput("FDN", opts), "fdn");
  assert.equal(resolveSetInput(" fdn — Foundations ", opts), "fdn");
  assert.equal(resolveSetInput("m21 - Core Set 2021", opts), "m21");
  assert.equal(resolveSetInput("core set 2021", opts), "m21");
  assert.equal(resolveSetInput("ogn", opts), null, "another game's set is not valid here");
  assert.equal(resolveSetInput("", opts), null);
});
