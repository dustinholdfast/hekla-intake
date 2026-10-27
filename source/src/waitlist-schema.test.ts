import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COST_BASIS_FIELD,
  COST_BASIS_STATUS_FORMULA,
  DAYS_IN_STOCK_FORMULA,
  OMITTED_TCGPLAYER_FIELDS,
  PROTECTED_FIELDS,
  STOCK_STATE_FORMULA,
  WAITLIST_FIELDS,
  applyWaitlistSchema,
  fieldRequestBody,
  formatSchemaPlan,
  parseSchemaArgs,
  planWaitlistSchema,
  runSchemaCli,
} from "./waitlist-schema.ts";

const NAMES = [
  "Language",
  "Reserved Qty",
  "Date Acquired",
  "Unknown-Cost Qty",
  "Stock State",
  "Days in Stock",
  "Cost Basis Status",
] as const;

test("dry-run lists the seven fields, their types, options and formulas, and omits TCGplayer", () => {
  const plan = planWaitlistSchema([]);
  assert.deepEqual(plan.create.map((field) => field.name), [...NAMES]);
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.skip.length, 0);
  const byName = new Map(plan.create.map((field) => [field.name, field]));
  const language = byName.get("Language");
  assert.equal(language?.type, "singleSelect");
  assert.deepEqual(language?.options.choices, [{ name: "English" }]);
  assert.equal(language?.intendedDefault, "English");
  assert.equal(JSON.stringify(fieldRequestBody(language!)).includes("intendedDefault"), false);
  assert.equal(byName.get("Reserved Qty")?.type, "number");
  assert.deepEqual(byName.get("Reserved Qty")?.options, { precision: 0 });
  assert.equal(byName.get("Date Acquired")?.type, "date");
  assert.equal(byName.get("Unknown-Cost Qty")?.type, "number");
  assert.equal(byName.get("Stock State")?.options.formula, STOCK_STATE_FORMULA);
  assert.equal(byName.get("Days in Stock")?.options.formula, DAYS_IN_STOCK_FORMULA);
  assert.equal(byName.get("Cost Basis Status")?.options.formula, COST_BASIS_STATUS_FORMULA);
  for (const formula of [STOCK_STATE_FORMULA, DAYS_IN_STOCK_FORMULA, COST_BASIS_STATUS_FORMULA]) {
    assert.equal(/tcgplayer/i.test(formula), false);
  }
  assert.match(STOCK_STATE_FORMULA, /Sold/);
  assert.match(STOCK_STATE_FORMULA, /Reserved/);
  assert.match(STOCK_STATE_FORMULA, /In hand/);
  assert.equal(STOCK_STATE_FORMULA.includes("Listed on TCGplayer"), false);
  assert.match(COST_BASIS_STATUS_FORMULA, /Cost Basis USD/);
  assert.deepEqual(plan.omitted.map((field) => field.name), [...OMITTED_TCGPLAYER_FIELDS]);
  assert.deepEqual(plan.protected.map((field) => field.name), [...PROTECTED_FIELDS]);
  assert.equal(plan.reused[0]?.name, COST_BASIS_FIELD);
  assert.equal(plan.create.some((field) => field.name === COST_BASIS_FIELD || field.name === "Qty" || field.name === "Finish" || field.name === "Status"), false);
  const text = formatSchemaPlan(plan);
  assert.match(text, /mode: dry-run/);
  assert.match(text, /writes: none/);
  assert.match(text, /Airtable was not called/);
  assert.equal(/\bUPDATE\b|\bDELETE\b|\bRENAME\b/.test(text), false);
  for (const name of NAMES) assert.match(text, new RegExp(`CREATE ${name}`));
  for (const name of OMITTED_TCGPLAYER_FIELDS) assert.match(text, new RegExp(`OMIT ${name}`));
});

test("existing fields are skipped and never updated, including a second plan of the same names", () => {
  const existing = ["Language", "language", "Qty", "Status", "Finish", COST_BASIS_FIELD, "Stock State"];
  const plan = planWaitlistSchema(existing);
  assert.deepEqual(plan.skip.map((field) => field.name), ["Language", "Stock State"]);
  assert.deepEqual(plan.create.map((field) => field.name), ["Reserved Qty", "Date Acquired", "Unknown-Cost Qty", "Days in Stock", "Cost Basis Status"]);
  assert.equal(plan.create.some((field) => /qty|status|finish|cost basis/i.test(field.name) && field.name !== "Reserved Qty" && field.name !== "Unknown-Cost Qty" && field.name !== "Cost Basis Status"), false);
  const again = planWaitlistSchema([...existing, ...plan.create.map((field) => field.name)]);
  assert.equal(again.create.length, 0);
  assert.equal(again.skip.length, WAITLIST_FIELDS.length);
  const text = formatSchemaPlan(plan, existing);
  assert.match(text, /SKIP Language/);
  assert.doesNotMatch(text, /CREATE Language/);
  assert.doesNotMatch(text, /CREATE Qty/);
  assert.doesNotMatch(text, /CREATE Finish/);
  assert.equal(/\bUPDATE\b|\bDELETE\b|\bRENAME\b/.test(text), false);
});

test("apply posts only missing fields and a dry-run calls nothing", async () => {
  const calls: { method: string; url: string; body: { name: string } }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { name: string };
    calls.push({ method: init?.method ?? "", url: String(url), body });
    return new Response(JSON.stringify({ id: "fldNew", name: body.name }), { status: 200 });
  };
  const result = await applyWaitlistSchema({ token: "patTEST", existingNames: ["Language", "Qty", "Status", "Finish"], fetchImpl });
  assert.deepEqual(result.skipped, ["Language"]);
  assert.equal(result.created.includes("Language"), false);
  assert.equal(calls.length, 6);
  assert.ok(calls.every((call) => call.method === "POST"));
  assert.ok(calls.every((call) => call.url.endsWith("/tblvHPu7dgDHA91bc/fields")));
  assert.equal(calls.some((call) => call.body.name === "Qty" || call.body.name === "Finish" || call.body.name === "Status" || call.body.name === "Language"), false);
  assert.match(String(calls[0]?.body && JSON.stringify(calls)), /Reserved Qty/);

  const all = await applyWaitlistSchema({ token: "patTEST", existingNames: [...NAMES], fetchImpl });
  assert.equal(all.created.length, 0);
  assert.equal(calls.length, 6);

  let fetches = 0;
  const lines: string[] = [];
  const code = await runSchemaCli(["--existing", "Language"], async () => {
    fetches += 1;
    return new Response("no");
  }, (line) => lines.push(line));
  assert.equal(code, 0);
  assert.equal(fetches, 0);
  assert.match(lines.join("\n"), /SKIP Language/);
  assert.match(lines.join("\n"), /writes: none/);
  assert.equal(parseSchemaArgs([]).apply, false);

  const key = process.env.AIRTABLE_API_KEY;
  const pat = process.env.AIRTABLE_PAT;
  delete process.env.AIRTABLE_API_KEY;
  delete process.env.AIRTABLE_PAT;
  try {
    await assert.rejects(() => runSchemaCli(["--apply"], async () => {
      fetches += 1;
      return new Response("no");
    }), /never printed/);
    assert.equal(fetches, 0);
  } finally {
    if (key !== undefined) process.env.AIRTABLE_API_KEY = key;
    if (pat !== undefined) process.env.AIRTABLE_PAT = pat;
  }
});

test("a failed schema create redacts the token and does not claim the field was written", async () => {
  const token = "patSECRETVALUE";
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ error: { message: `nope ${token}` } }), { status: 422 });
  await assert.rejects(() => applyWaitlistSchema({ token, existingNames: [], fetchImpl }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(token), false);
    assert.match(error.message, /\[redacted\]/);
    assert.match(error.message, /Language/);
    return true;
  });
});
