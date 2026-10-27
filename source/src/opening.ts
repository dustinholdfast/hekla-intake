/**
 * Opening balances from the Airtable Waitlist. Reads only. Never writes Airtable.
 * Date Acquired stays blank. Normal becomes Regular, Enchanted is stored as Holofoil,
 * Special is flagged and not guessed. Category and Sealed buy-list rows are never decremented.
 */
import {
  BUY_LIST_TABLE_ID,
  planOpeningEntries,
  WAITLIST_BASE_ID,
  WAITLIST_TABLE_ID,
  type BuyListInput,
  type MovementDraft,
  type WaitlistInput,
} from "./inventory.ts";
import { insertMovements } from "./inventorydb.ts";

export const WAITLIST_READ_FIELDS = [
  "Card Name", "Resolved Name", "Game", "Set #", "Set Identifier", "Collector Number",
  "Finish", "Condition", "Qty", "Status", "Rarity", "Market Price USD", "Cost Basis USD",
  "CardTrader Listing ID",
] as const;

export const BUY_LIST_READ_FIELDS = ["Item", "Game", "Kind", "Set", "Finish", "Want Qty", "Collector #", "Status"] as const;

const MAX_PAGES = 40;

export function assertReadableTable(baseId: string, tableId: string): void {
  if (baseId !== WAITLIST_BASE_ID) throw new Error("Refusing to read a base other than the Starfoil base.");
  if (tableId !== WAITLIST_TABLE_ID && tableId !== BUY_LIST_TABLE_ID) throw new Error("Refusing to read a table other than Waitlist or Buy List.");
}

export function airtableListUrl(baseId: string, tableId: string, fields: readonly string[], offset?: string): string {
  assertReadableTable(baseId, tableId);
  const url = new URL(`https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`);
  url.searchParams.set("pageSize", "100");
  for (const field of fields) url.searchParams.append("fields[]", field);
  if (offset) url.searchParams.set("offset", offset);
  return url.toString();
}

type AirtablePage = { records?: { id: string; createdTime?: string; fields?: Record<string, unknown> }[]; offset?: string };

function redact(message: string, token: string): string {
  return token ? message.split(token).join("[redacted]") : message;
}

async function listAll(
  baseId: string,
  tableId: string,
  fields: readonly string[],
  token: string,
  fetchImpl: typeof fetch,
): Promise<WaitlistInput[]> {
  const records: WaitlistInput[] = [];
  let offset: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (page > 0) await new Promise((resolve) => setTimeout(resolve, 220));
    const url = airtableListUrl(baseId, tableId, fields, offset);
    const response = await fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json() as { error?: { message?: string } | string };
        detail = typeof body.error === "string" ? body.error : body.error?.message ?? "";
      } catch { /* ignore */ }
      throw new Error(redact(detail ? `Airtable read failed (${response.status}): ${detail}` : `Airtable read failed (${response.status}).`, token));
    }
    const body = await response.json() as AirtablePage;
    for (const record of body.records ?? []) records.push({ id: record.id, createdTime: record.createdTime ?? null, fields: record.fields ?? {} });
    if (!body.offset) return records;
    offset = body.offset;
  }
  throw new Error("Airtable returned too many pages. Nothing was written.");
}

export async function loadWaitlist(token: string, fetchImpl: typeof fetch = fetch): Promise<WaitlistInput[]> {
  if (!token.trim()) throw new Error("Set AIRTABLE_API_KEY or AIRTABLE_PAT. The value is never printed.");
  return listAll(WAITLIST_BASE_ID, WAITLIST_TABLE_ID, WAITLIST_READ_FIELDS, token, fetchImpl);
}

export async function loadBuyList(token: string, fetchImpl: typeof fetch = fetch): Promise<BuyListInput[]> {
  if (!token.trim()) throw new Error("Set AIRTABLE_API_KEY or AIRTABLE_PAT. The value is never printed.");
  const rows = await listAll(WAITLIST_BASE_ID, BUY_LIST_TABLE_ID, BUY_LIST_READ_FIELDS, token, fetchImpl);
  return rows.map((row) => ({ id: row.id, fields: row.fields }));
}

export type OpeningReport = {
  apply: boolean;
  read: number;
  planned: number;
  inserted: number;
  already: number;
  needsReview: number;
  units: number;
  specials: number;
  nonEnglish: number;
};

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function reportOf(movements: readonly MovementDraft[], apply: boolean, inserted: number): OpeningReport {
  return {
    apply,
    read: movements.length,
    planned: movements.length,
    inserted,
    already: apply ? movements.length - inserted : 0,
    needsReview: movements.filter((movement) => movement.needsReview).length,
    units: movements.reduce((sum, movement) => sum + movement.delta, 0),
    specials: movements.filter((movement) => movement.needsReview?.includes("Special finish")).length,
    nonEnglish: movements.filter((movement) => movement.needsReview?.includes("Non-English")).length,
  };
}

/** Dry-run by default. --apply writes Neon only, and a second run inserts nothing new. */
export async function runOpening(options: { apply: boolean; env: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Promise<OpeningReport> {
  const token = options.env.AIRTABLE_API_KEY?.trim() || options.env.AIRTABLE_PAT?.trim() || "";
  const tenantId = options.env.TENANT_ID?.trim() || "";
  if (!TENANT_UUID.test(tenantId)) throw new Error("Set TENANT_ID to the tenant uuid. The value is never printed.");
  const rows = await loadWaitlist(token, options.fetchImpl);
  const movements = planOpeningEntries(rows, tenantId, new Date());
  if (!options.apply) return reportOf(movements, false, 0);
  if (!options.env.DATABASE_URL?.trim()) throw new Error("Set DATABASE_URL before --apply. The value is never printed.");
  const { inserted } = await insertMovements({ DATABASE_URL: options.env.DATABASE_URL } as Env, movements);
  return reportOf(movements, true, inserted);
}
