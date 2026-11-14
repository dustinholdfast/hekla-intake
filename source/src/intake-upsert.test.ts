import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { weightedCost } from "./cleanup.ts";
import { duplicateAlertEmailOn, duplicateAlertText, emailDuplicateAlert } from "./duplicate-alerts.ts";
import { parseDraft } from "./fields.ts";
import {
  bulkDuplicateChoice,
  draftIdentityKey,
  intakeIdentityKey,
  intakeLotCents,
  intakeMovement,
  matchesStock,
  mergeEffect,
  planIntakeUpsert,
  type UpsertMatch,
} from "./intake-upsert.ts";
import { parseBulk } from "./parse.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const REC = "recAAAAAAAAAAAAAA";
const NOW = "2026-11-14T15:00:00.000Z";

function card(over: { qty?: number; condition?: string; cost?: number | null; finish?: string; collector?: string } = {}) {
  const parsed = parseDraft({
    game: "Riftbound",
    setIdentifier: "OGN",
    collectorNumber: over.collector ?? "12",
    finish: over.finish ?? "Foil",
    condition: over.condition ?? "NM",
    qty: over.qty ?? 3,
    costBasisUsd: over.cost === undefined ? 4 : over.cost,
    cardName: "Listed Scout",
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.card;
}

function match(over: Partial<UpsertMatch> = {}): UpsertMatch {
  return { id: REC, qty: 1, status: "Listed", costBasisUsd: 2, unknownCostQty: 0, reservedQty: 1, deckReservedQty: 1, ...over };
}

const row = (condition: string, language: string | null, finish = "Foil") => ({
  game: "Riftbound", setIdentifier: "OGN", collectorNumber: "12", finish, condition, language, status: "Listed" as const,
});

test("a merge increments qty, keeps holds, and adds a weighted cost lot", () => {
  const incoming = card();
  const target = match();
  const plan = planIntakeUpsert({ card: incoming, matches: [target], choice: "merge" });
  assert.equal(plan.action, "merge");
  if (plan.action !== "merge") return;
  assert.equal(plan.effect.qty, 4);
  assert.equal(plan.effect.fields.Qty, 4);
  assert.equal(plan.effect.fields["Reserved Qty"], undefined);
  assert.equal(plan.effect.fields["Deck Reserved Qty"], undefined);
  const held = mergeEffect(match({ qty: 4, costBasisUsd: null, unknownCostQty: null }), 3, null);
  assert.equal(held.holds.reservedQty, 1);
  assert.equal(held.holds.deckReservedQty, 1);
  assert.equal(held.holds.listableBefore, 2);
  assert.equal(held.holds.listableAfter, 5);
  assert.equal(held.fields["Cost Basis USD"], undefined);
  assert.equal(held.lot, null);
  const averaged = weightedCost([{ qty: 1, costBasisUsd: 2 }, { qty: 3, costBasisUsd: 4 }]);
  assert.equal(plan.effect.fields["Cost Basis USD"], averaged.cost);
  assert.equal(averaged.cost, 3.5);
  assert.deepEqual(plan.effect.lot, { qty: 3, costBasisUsd: 4 });
  assert.equal(plan.observedDuplicate, false);

  const movement = intakeMovement({
    tenantId: TENANT, recordId: REC, qtyBefore: 1, addQty: 3, unitCostCents: intakeLotCents(4, 3).unitCostCents,
    appliedBy: "user", now: NOW, eventId: "evt-1", snapshot: null, note: "Intake merge.",
  });
  assert.equal(movement.reason, "intake");
  assert.equal(movement.delta, 3);
  assert.equal(movement.qtyAfter, 4);
  assert.equal(movement.unitCostCents, 400);
  assert.equal(intakeLotCents(4, 3).costTotalCents, 1200);
  assert.equal(mergeEffect(target, 3, null).lot, null);
  assert.equal(mergeEffect(target, 3, null).fields["Cost Basis USD"], undefined);
  assert.equal(mergeEffect({ ...target, costBasisUsd: null, unknownCostQty: null }, 3, 4).writeUnknown, true);
});

test("condition and language keep separate stock rows, and a blank language is English", () => {
  const draft = card({ condition: "NM" });
  assert.equal(matchesStock(row("NM", null), draft), true);
  assert.equal(matchesStock(row("NM", ""), draft), true);
  assert.equal(matchesStock(row("NM", "EN"), draft), true);
  assert.equal(matchesStock(row("NM", "English"), draft), true);
  assert.equal(matchesStock(row("LP", null), draft), false);
  assert.equal(matchesStock(row("NM", "Japanese"), draft), false);
  assert.equal(matchesStock({ ...row("NM", null), status: "Sold" }, draft), false);
  assert.equal(matchesStock(row("NM", null, "Regular"), { ...draft, finish: "Normal" }), true);
  assert.equal(intakeIdentityKey(row("NM", "")), draftIdentityKey(draft));
  assert.notEqual(draftIdentityKey(draft), draftIdentityKey({ ...draft, condition: "LP" }));
  assert.notEqual(draftIdentityKey(draft), intakeIdentityKey(row("NM", "Japanese")));
  const blankCondition = intakeIdentityKey({ ...row("NM", null), condition: "" });
  assert.equal(blankCondition, null);

  const lp = planIntakeUpsert({ card: card({ condition: "LP" }), matches: [match()], choice: "merge" });
  assert.equal(lp.action, "merge");
  const separated = planIntakeUpsert({ card: card({ condition: "LP" }), matches: [], choice: "merge" });
  assert.equal(separated.action, "create");
});

test("bulk paste defaults to merge and never falls back to add", () => {
  assert.deepEqual(bulkDuplicateChoice(undefined, false), { ok: true, choice: "merge" });
  assert.deepEqual(bulkDuplicateChoice("", false), { ok: true, choice: "merge" });
  assert.deepEqual(bulkDuplicateChoice(null, false), { ok: true, choice: "merge" });
  assert.deepEqual(bulkDuplicateChoice("merge", false), { ok: true, choice: "merge" });
  assert.deepEqual(bulkDuplicateChoice("skip", false), { ok: true, choice: "skip" });
  assert.equal(bulkDuplicateChoice("add", false).ok, false);
  assert.deepEqual(bulkDuplicateChoice("add", true), { ok: true, choice: "add" });
  assert.equal(bulkDuplicateChoice("whatever", true).ok, false);

  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(html, /name="onDuplicate" value="merge" checked/);
  assert.match(js, /const onDuplicate = selected \? selected\.value : "merge"/);
  assert.doesNotMatch(js, /selected \? selected\.value : "add"/);
  assert.match(js, /confirmOverride: onDuplicate === "add"/);
  assert.match(js, /confirmOverride: true/);
  assert.match(js, /window\.confirm\(/);

  const withCost = parseBulk("OGN 12 Foil NM 2 1.25 Scout", "Riftbound");
  assert.equal(withCost[0]?.card?.qty, 2);
  assert.equal(withCost[0]?.card?.costBasisUsd, 1.25);
  assert.equal(withCost[0]?.card?.cardName, "Scout");
  const blank = parseBulk("OGN,12,Foil,NM,2,Scout", "Riftbound");
  assert.equal(blank[0]?.card?.costBasisUsd, undefined);
  assert.equal(blank[0]?.card?.cardName, "Scout");
  const noQty = parseBulk("OGN 12 Foil NM 2.50", "Riftbound");
  assert.equal(noQty[0]?.card?.qty, 1);
  assert.equal(noQty[0]?.card?.costBasisUsd, 2.5);
});

test("add anyway is refused until it is confirmed, and a confirmed override is recorded", () => {
  const incoming = card({ cost: null });
  const matches = [match({ costBasisUsd: null }), match({ id: "recBBBBBBBBBBBBBB", costBasisUsd: null })];
  const refused = planIntakeUpsert({ card: incoming, matches, choice: "add", confirmOverride: false });
  assert.equal(refused.action, "reject");
  const asked = planIntakeUpsert({ card: incoming, matches, choice: "ask" });
  assert.equal(asked.action, "ask");
  if (asked.action === "ask") assert.equal(asked.observedDuplicate, true);
  const skipped = planIntakeUpsert({ card: incoming, matches: [match()], choice: "skip" });
  assert.equal(skipped.action, "skip");
  const override = planIntakeUpsert({ card: incoming, matches, choice: "add", confirmOverride: true });
  assert.equal(override.action, "create");
  if (override.action !== "create") return;
  assert.equal(override.recordOverride, true);
  assert.deepEqual(override.matchedIds, [REC, "recBBBBBBBBBBBBBB"]);
  const fresh = planIntakeUpsert({ card: incoming, matches: [], choice: "add" });
  assert.equal(fresh.action, "create");
  if (fresh.action === "create") assert.equal(fresh.recordOverride, false);
});

test("duplicate alert email stays off unless DUPLICATE_ALERT_EMAIL is on", async () => {
  assert.equal(duplicateAlertEmailOn({}), false);
  assert.equal(duplicateAlertEmailOn({ DUPLICATE_ALERT_EMAIL: "off" }), false);
  assert.equal(duplicateAlertEmailOn({ DUPLICATE_ALERT_EMAIL: "On" }), true);
  const alert = {
    id: "1", tenantId: TENANT, identityKey: "Riftbound|ogn|12|Foil|NM|english", recordIds: [REC, "recBBBBBBBBBBBBBB"],
    source: "override" as const, note: "Add anyway", createdAt: NOW, emailSentAt: null,
  };
  const text = duplicateAlertText(alert);
  assert.match(text.subject, /Duplicate stock/);
  assert.match(text.text, /recAAAAAAAAAAAAAA/);
  let calls = 0;
  const send = async () => { calls += 1; return "not_configured" as const; };
  assert.equal(await emailDuplicateAlert({} as Env, alert, send), "off");
  assert.equal(calls, 0);
  assert.equal(await emailDuplicateAlert({ DUPLICATE_ALERT_EMAIL: "1" } as Env, alert, send), "not_configured");
  assert.equal(calls, 1);
  assert.equal(await emailDuplicateAlert({ DUPLICATE_ALERT_EMAIL: "on" } as Env, { ...alert, emailSentAt: NOW }, async () => "sent"), "skipped");
});
