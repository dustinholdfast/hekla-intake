/**
 * Airtable Waitlist fields from PLAN.md §3.2, without the four TCGplayer fields.
 * Dry-run plans only. Applying is a separate call and is not the default.
 * Existing fields are skipped. Nothing is renamed, edited, or deleted.
 * Qty, Status and Finish are never in the create list. Cost Basis USD is reused, not created.
 */
export const WAITLIST_BASE_ID = "app4Tjz72sZtVMQyp";
export const WAITLIST_TABLE_ID = "tblvHPu7dgDHA91bc";
export const COST_BASIS_FIELD = "Cost Basis USD";
export const COST_BASIS_FIELD_ID = "fldYVFPV62Kycytp7";

export const OMITTED_TCGPLAYER_FIELDS = [
  "TCGplayer SKU",
  "TCGplayer Product ID",
  "TCGplayer Listed Qty",
  "TCGplayer Price USD",
] as const;

export const PROTECTED_FIELDS = ["Qty", "Status", "Finish"] as const;

/** Sold / Reserved / In hand. The TCGplayer listed branch is omitted because that field is not added. */
export const STOCK_STATE_FORMULA = 'IF({Qty}=0,"Sold",IF({Reserved Qty}>0,"Reserved","In hand"))';
export const DAYS_IN_STOCK_FORMULA = "IF({Date Acquired}=BLANK(),BLANK(),DATETIME_DIFF(TODAY(),{Date Acquired},'days'))";
export const COST_BASIS_STATUS_FORMULA = 'IF({Cost Basis USD}=BLANK(),"Unknown",IF({Unknown-Cost Qty}>0,"Partly known","Known"))';

export type SchemaField = {
  name: string;
  type: "singleSelect" | "number" | "date" | "formula";
  description: string;
  options: Record<string, unknown>;
  /** Printed in the dry-run. The Airtable create-field body does not include it. */
  intendedDefault?: string;
};

/**
 * Create order puts formulas after the fields they read.
 * Stock State reads Reserved Qty. Days in Stock reads Date Acquired.
 * Cost Basis Status reads Unknown-Cost Qty and the existing Cost Basis USD field.
 */
export const WAITLIST_FIELDS: readonly SchemaField[] = [
  {
    name: "Language",
    type: "singleSelect",
    description: "Default English. A non-English copy is its own stock row. More languages are added as choices later, not guessed.",
    options: { choices: [{ name: "English" }] },
    intendedDefault: "English",
  },
  {
    name: "Reserved Qty",
    type: "number",
    description: "Copies held for an event or a buyer. Not a sale.",
    options: { precision: 0 },
  },
  {
    name: "Date Acquired",
    type: "date",
    description: "Set on new intake or purchase. Existing rows stay blank.",
    options: { dateFormat: { name: "iso", format: "YYYY-MM-DD" } },
  },
  {
    name: "Unknown-Cost Qty",
    type: "number",
    description: "Units on hand with no known cost. Existing stock starts here. Cost Basis USD is not backfilled.",
    options: { precision: 0 },
  },
  {
    name: "Stock State",
    type: "formula",
    description: "Sold when Qty is 0, otherwise Reserved when Reserved Qty is above 0, otherwise In hand. Does not read a TCGplayer field.",
    options: { formula: STOCK_STATE_FORMULA },
  },
  {
    name: "Days in Stock",
    type: "formula",
    description: "Blank when Date Acquired is blank.",
    options: { formula: DAYS_IN_STOCK_FORMULA },
  },
  {
    name: "Cost Basis Status",
    type: "formula",
    description: "Unknown, Partly known, or Known from Cost Basis USD and Unknown-Cost Qty. Uses the existing Cost Basis USD field.",
    options: { formula: COST_BASIS_STATUS_FORMULA },
  },
];

export type SchemaPlan = {
  baseId: string;
  tableId: string;
  mode: "dry-run";
  create: SchemaField[];
  skip: { name: string; reason: string }[];
  omitted: { name: string; reason: string }[];
  reused: { name: string; fieldId: string; reason: string }[];
  protected: { name: string; reason: string }[];
};

function nameExists(existing: readonly string[], name: string): boolean {
  const wanted = name.toLowerCase();
  return existing.some((field) => field.trim().toLowerCase() === wanted);
}

export function planWaitlistSchema(existingNames: readonly string[]): SchemaPlan {
  const create: SchemaField[] = [];
  const skip: SchemaPlan["skip"] = [];
  for (const field of WAITLIST_FIELDS) {
    if ((PROTECTED_FIELDS as readonly string[]).includes(field.name)) {
      throw new Error(`Refusing to plan a change to ${field.name}.`);
    }
    if ((OMITTED_TCGPLAYER_FIELDS as readonly string[]).includes(field.name)) {
      throw new Error(`Refusing to plan ${field.name}. TCGplayer fields stay out.`);
    }
    if (nameExists(existingNames, field.name)) {
      skip.push({ name: field.name, reason: "Already exists. Not renamed, edited, or deleted." });
    } else {
      create.push(field);
    }
  }
  return {
    baseId: WAITLIST_BASE_ID,
    tableId: WAITLIST_TABLE_ID,
    mode: "dry-run",
    create,
    skip,
    omitted: OMITTED_TCGPLAYER_FIELDS.map((name) => ({
      name,
      reason: "Omitted. TCGplayer is parked until Starfoil has its own seller account.",
    })),
    reused: [{
      name: COST_BASIS_FIELD,
      fieldId: COST_BASIS_FIELD_ID,
      reason: "Existing currency field. The Cost Basis Status formula reads it. It is not created or edited.",
    }],
    protected: PROTECTED_FIELDS.map((name) => ({
      name,
      reason: "Shared with starfoil.store. Never renamed, edited, or deleted.",
    })),
  };
}

/** Body that would be POSTed. No intendedDefault, no field id, no existing-field edit. */
export function fieldRequestBody(field: SchemaField): { name: string; type: string; description: string; options: Record<string, unknown> } {
  return { name: field.name, type: field.type, description: field.description, options: structuredClone(field.options) };
}

export function formatSchemaPlan(plan: SchemaPlan, existingNames: readonly string[] = []): string {
  const lines: string[] = [];
  lines.push("Waitlist schema plan");
  lines.push(`mode: ${plan.mode}`);
  lines.push(`base: ${plan.baseId}`);
  lines.push(`table: ${plan.tableId} (Waitlist)`);
  lines.push("Airtable was not called.");
  lines.push("writes: none");
  lines.push(existingNames.length
    ? `existing fields (supplied locally, not read from Airtable): ${existingNames.join(", ")}`
    : "existing fields: none supplied. Every new field is listed as CREATE. Pass --existing to preview skips. Airtable was not called.");
  lines.push("");
  lines.push(`CREATE ${plan.create.length}`);
  for (const field of plan.create) {
    lines.push(`CREATE ${field.name}`);
    lines.push(`  type: ${field.type}`);
    if (field.intendedDefault) lines.push(`  intended default: ${field.intendedDefault} (choice list only; the Airtable create-field body has no default)`);
    lines.push(`  description: ${field.description}`);
    lines.push(`  options: ${JSON.stringify(field.options)}`);
    lines.push(`  request: ${JSON.stringify(fieldRequestBody(field))}`);
  }
  lines.push("");
  lines.push(`SKIP ${plan.skip.length}`);
  for (const field of plan.skip) lines.push(`SKIP ${field.name} — ${field.reason}`);
  lines.push("");
  lines.push("REUSED");
  for (const field of plan.reused) lines.push(`REUSED ${field.name} (${field.fieldId}) — ${field.reason}`);
  lines.push("");
  lines.push("OMIT");
  for (const field of plan.omitted) lines.push(`OMIT ${field.name} — ${field.reason}`);
  lines.push("");
  lines.push("UNTOUCHED");
  for (const field of plan.protected) lines.push(`UNTOUCHED ${field.name} — ${field.reason}`);
  lines.push("");
  return lines.join("\n");
}

function redact(message: string, token: string): string {
  return token ? message.split(token).join("[redacted]") : message;
}

export type SchemaApplyResult = {
  created: string[];
  skipped: string[];
  requests: { method: string; url: string; body: { name: string; type: string } }[];
};

/**
 * Creates only the fields the plan still lists. POST only. Callers must pass names that already exist
 * so those fields are skipped. This function does not GET the live schema and does not PATCH or DELETE.
 */
export async function applyWaitlistSchema(args: {
  token: string;
  existingNames: readonly string[];
  fetchImpl?: typeof fetch;
}): Promise<SchemaApplyResult> {
  const token = args.token.trim();
  if (!token) throw new Error("Set AIRTABLE_API_KEY or AIRTABLE_PAT. The value is never printed.");
  const plan = planWaitlistSchema(args.existingNames);
  const fetchImpl = args.fetchImpl ?? fetch;
  const url = `https://api.airtable.com/v0/meta/bases/${WAITLIST_BASE_ID}/tables/${WAITLIST_TABLE_ID}/fields`;
  const created: string[] = [];
  const requests: SchemaApplyResult["requests"] = [];
  for (const field of plan.create) {
    const body = fieldRequestBody(field);
    const method = "POST";
    requests.push({ method, url, body: { name: body.name, type: body.type } });
    if (method !== "POST") throw new Error("Schema changes are creates only.");
    const response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let detail = "";
      try {
        const payload = await response.json() as { error?: { message?: string } | string };
        detail = typeof payload.error === "string" ? payload.error : payload.error?.message ?? "";
      } catch { /* ignore */ }
      throw new Error(redact(`Airtable schema create failed for ${field.name} (${response.status})${detail ? `: ${detail}` : "."}`, token));
    }
    created.push(field.name);
  }
  return { created, skipped: plan.skip.map((field) => field.name), requests };
}

export function parseSchemaArgs(argv: readonly string[]): { apply: boolean; existing: string[] } {
  const apply = argv.includes("--apply");
  const index = argv.indexOf("--existing");
  const raw = index >= 0 ? argv[index + 1] ?? "" : "";
  if (raw.startsWith("--")) throw new Error("--existing needs a comma-separated field list.");
  const existing = raw.split(",").map((name) => name.trim()).filter(Boolean);
  return { apply, existing };
}

/** Default is dry-run and does not call fetch. --apply creates missing fields only. */
export async function runSchemaCli(
  argv: readonly string[],
  fetchImpl: typeof fetch = fetch,
  log: (line: string) => void = console.log,
): Promise<number> {
  const args = parseSchemaArgs(argv);
  const plan = planWaitlistSchema(args.existing);
  if (!args.apply) {
    log(formatSchemaPlan(plan, args.existing));
    return 0;
  }
  const token = process.env.AIRTABLE_API_KEY?.trim() || process.env.AIRTABLE_PAT?.trim() || "";
  const result = await applyWaitlistSchema({ token, existingNames: args.existing, fetchImpl });
  log(`created: ${result.created.join(", ") || "(none)"}`);
  log(`skipped: ${result.skipped.join(", ") || "(none)"}`);
  return 0;
}
