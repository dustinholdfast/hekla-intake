/**
 * Airtable Purchases table from PLAN.md §3.3, plus an optional Store Credit Ledger mirror.
 * Dry-run by default. Nothing here calls Airtable. Existing tables are skipped, never edited.
 * The ledger in Neon is the source of truth. The Airtable credit table is optional.
 */
import { BUY_LIST_TABLE_ID, WAITLIST_BASE_ID, WAITLIST_TABLE_ID } from "./inventory.ts";
import { SELL_REQUEST_TABLE_ID } from "./purchases.ts";

export const PURCHASES_TABLE = "Purchases";
export const CREDIT_MIRROR_TABLE = "Store Credit Ledger";

export type TableField = {
  name: string;
  type: "singleLineText" | "number" | "currency" | "date" | "checkbox" | "singleSelect" | "multipleRecordLinks";
  description: string;
  options: Record<string, unknown>;
};

export type TablePlan = {
  name: string;
  optional: boolean;
  baseId: string;
  links: { field: string; tableId: string; table: string }[];
  fields: readonly TableField[];
  note: string;
};

const choice = (names: readonly string[]) => ({ choices: names.map((name) => ({ name })) });
const currency = { precision: 2, symbol: "$" };
const isoDate = { dateFormat: { name: "iso", format: "YYYY-MM-DD" } };
const link = (tableId: string) => ({ linkedTableId: tableId });

export const PURCHASE_FIELDS: readonly TableField[] = [
  { name: "Hekla Purchase Line ID", type: "singleLineText", description: "Idempotency key mirror. One Airtable row per purchase line.", options: {} },
  { name: "Sell Request", type: "multipleRecordLinks", description: "Link only. Seller name, email, and phone stay on the sell request.", options: link(SELL_REQUEST_TABLE_ID) },
  { name: "Buy List row", type: "multipleRecordLinks", description: "Set when a buy-list row matched. Empty when nothing matched.", options: link(BUY_LIST_TABLE_ID) },
  { name: "Stock row", type: "multipleRecordLinks", description: "Waitlist row. Set at receive, not at accept.", options: link(WAITLIST_TABLE_ID) },
  { name: "Game", type: "singleLineText", description: "Game as shown on the line.", options: {} },
  { name: "Item", type: "singleLineText", description: "Card name from the line. Not the seller.", options: {} },
  { name: "Set", type: "singleLineText", description: "Set name or identifier.", options: {} },
  { name: "Collector #", type: "singleLineText", description: "Collector number.", options: {} },
  { name: "Finish", type: "singleLineText", description: "Printing as Hekla reads it. Regular is the non-foil printing. Waitlist itself still stores Normal.", options: {} },
  { name: "Language", type: "singleLineText", description: "English unless the line says otherwise.", options: {} },
  { name: "Condition", type: "singleSelect", description: "Confirmed condition when received. Offered condition until then.", options: choice(["NM", "LP", "MP", "HP", "DMG"]) },
  { name: "Qty", type: "number", description: "Copies on this line.", options: { precision: 0 } },
  { name: "Payment Type", type: "singleSelect", description: "Cash for PayPal, Venmo, or Check. Store credit when the payout is Store Credit.", options: choice(["Cash", "Store credit"]) },
  { name: "Market Ref USD at offer", type: "currency", description: "Market reference used to split the offer. Never the draft buy price.", options: currency },
  { name: "Condition Multiplier used", type: "number", description: "The cash or credit percent from settings for this grade. NM 50/65, LP 40/55. Not a separate guessed multiplier.", options: { precision: 0 } },
  { name: "Offer Amount USD", type: "currency", description: "This line's share of the sell-request offer, in exact cents.", options: currency },
  { name: "Cash Paid USD", type: "currency", description: "Cash paid for this line. Zero on a store-credit line.", options: currency },
  { name: "Store Credit Issued USD", type: "currency", description: "Store credit issued for this line. Zero on a cash line. Separate from cost basis.", options: currency },
  { name: "Cost Basis USD", type: "currency", description: "Per-unit cost. Cash: cash paid. Store credit: face value of the credit issued (credit rule v1).", options: currency },
  { name: "Cost Rule", type: "singleLineText", description: "cash paid, credit rule v1, or unknown.", options: {} },
  { name: "Date Received", type: "date", description: "The day the cards were received. New stock rows use this as Date Acquired.", options: isoDate },
  { name: "Condition Confirmed", type: "checkbox", description: "Set when receive & confirm records the condition in hand.", options: { icon: "check", color: "greenBright" } },
  { name: "Over Want Qty", type: "number", description: "Copies above Want Qty. Flagged. Zero when Want Qty is blank.", options: { precision: 0 } },
  { name: "Status", type: "singleSelect", description: "Accepted, Received, Rejected, or Cancelled. Rejected means the cards were worse and were returned.", options: choice(["Accepted", "Received", "Rejected", "Cancelled"]) },
];

export const CREDIT_MIRROR_FIELDS: readonly TableField[] = [
  { name: "Hekla Credit Entry ID", type: "singleLineText", description: "Idempotency key mirror for one issue or redemption.", options: {} },
  { name: "Customer Reference", type: "singleLineText", description: "Sell Request record id only. No name, email, or phone.", options: {} },
  { name: "Sell Request", type: "multipleRecordLinks", description: "Optional link to the same sell request. Contact details stay there.", options: link(SELL_REQUEST_TABLE_ID) },
  { name: "Amount USD", type: "currency", description: "Positive when issued, negative when redeemed.", options: currency },
  { name: "Entry", type: "singleSelect", description: "Issue or Redemption.", options: choice(["Issue", "Redemption"]) },
  { name: "Date", type: "date", description: "The day of the issue or redemption.", options: isoDate },
  { name: "Source", type: "singleLineText", description: "sell_request line key, or the redemption source id.", options: {} },
  { name: "Balance After USD", type: "currency", description: "Unspent balance for that sell request after this row.", options: currency },
];

export function purchaseTablePlan(): TablePlan {
  return {
    name: PURCHASES_TABLE,
    optional: false,
    baseId: WAITLIST_BASE_ID,
    links: [
      { field: "Sell Request", tableId: SELL_REQUEST_TABLE_ID, table: "Sell Requests" },
      { field: "Buy List row", tableId: BUY_LIST_TABLE_ID, table: "Buy List" },
      { field: "Stock row", tableId: WAITLIST_TABLE_ID, table: "Waitlist" },
    ],
    fields: PURCHASE_FIELDS,
    note: "Create only. A link field also adds a reverse link on the other table. No seller name, email, or phone.",
  };
}

export function creditMirrorPlan(): TablePlan {
  return {
    name: CREDIT_MIRROR_TABLE,
    optional: true,
    baseId: WAITLIST_BASE_ID,
    links: [{ field: "Sell Request", tableId: SELL_REQUEST_TABLE_ID, table: "Sell Requests" }],
    fields: CREDIT_MIRROR_FIELDS,
    note: "OPTIONAL. Neon store_credit_entries is the ledger. Skip this table unless a mirror is wanted. No customer contact.",
  };
}

export type SchemaTablePlan = {
  mode: "dry-run";
  baseId: string;
  create: TablePlan[];
  skip: { name: string; reason: string }[];
  writes: "none";
};

export function planPurchaseTables(existingTables: readonly string[]): SchemaTablePlan {
  const wanted = new Set(existingTables.map((name) => name.trim().toLowerCase()).filter(Boolean));
  const create: TablePlan[] = [];
  const skip: SchemaTablePlan["skip"] = [];
  for (const table of [purchaseTablePlan(), creditMirrorPlan()]) {
    if (wanted.has(table.name.toLowerCase())) {
      skip.push({ name: table.name, reason: "Already exists. Not renamed, edited, or deleted." });
    } else {
      create.push(table);
    }
  }
  return { mode: "dry-run", baseId: WAITLIST_BASE_ID, create, skip, writes: "none" };
}

export function tableRequestBody(table: TablePlan): { name: string; description: string; fields: { name: string; type: string; description: string; options: Record<string, unknown> }[] } {
  return {
    name: table.name,
    description: table.note,
    fields: table.fields.map((field) => ({ name: field.name, type: field.type, description: field.description, options: structuredClone(field.options) })),
  };
}

export function formatPurchaseSchema(plan: SchemaTablePlan): string {
  const lines: string[] = [];
  lines.push("Purchases schema plan");
  lines.push(`mode: ${plan.mode}`);
  lines.push(`base: ${plan.baseId}`);
  lines.push("Airtable was not called.");
  lines.push("writes: none");
  lines.push("");
  for (const table of plan.create) {
    lines.push(`${table.optional ? "OPTIONAL CREATE" : "CREATE TABLE"} ${table.name}`);
    lines.push(`  note: ${table.note}`);
    for (const target of table.links) lines.push(`  link: ${target.field} → ${target.table} (${target.tableId})`);
    for (const field of table.fields) {
      lines.push(`  FIELD ${field.name}`);
      lines.push(`    type: ${field.type}`);
      lines.push(`    description: ${field.description}`);
      lines.push(`    options: ${JSON.stringify(field.options)}`);
    }
    lines.push(`  request: ${JSON.stringify(tableRequestBody(table))}`);
    lines.push("");
  }
  lines.push(`SKIP ${plan.skip.length}`);
  for (const table of plan.skip) lines.push(`SKIP ${table.name} — ${table.reason}`);
  lines.push("");
  return lines.join("\n");
}

export type TableApplyResult = { created: string[]; skipped: string[]; requests: { method: string; url: string; name: string }[] };

/**
 * POST a missing table. Optional credit mirror is created only when includeCreditMirror is set.
 * This function is not called by the default dry-run, and this phase does not pass --apply-purchases.
 */
export async function applyPurchaseTables(args: {
  token: string;
  existingTables: readonly string[];
  includeCreditMirror?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<TableApplyResult> {
  const token = args.token.trim();
  if (!token) throw new Error("Set AIRTABLE_API_KEY or AIRTABLE_PAT. The value is never printed.");
  const plan = planPurchaseTables(args.existingTables);
  const fetchImpl = args.fetchImpl ?? fetch;
  const url = `https://api.airtable.com/v0/meta/bases/${WAITLIST_BASE_ID}/tables`;
  const created: string[] = [];
  const requests: TableApplyResult["requests"] = [];
  for (const table of plan.create) {
    if (table.optional && !args.includeCreditMirror) continue;
    const body = tableRequestBody(table);
    const method = "POST";
    requests.push({ method, url, name: table.name });
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
      const message = `Airtable schema create failed for ${table.name} (${response.status})${detail ? `: ${detail}` : "."}`;
      throw new Error(token ? message.split(token).join("[redacted]") : message);
    }
    created.push(table.name);
  }
  return { created, skipped: plan.skip.map((table) => table.name), requests };
}
