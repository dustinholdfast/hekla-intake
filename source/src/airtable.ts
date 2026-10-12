import {
  buildCreateFields,
  buildEditFields,
  buildMergeFields,
  type EditInput,
  collectorVariants,
  dedupeKey,
  setIdentityOf,
  type DraftCard,
  type PrintingRef,
} from "./fields.ts";
import { effectiveGame, setName, type Game, type Status } from "./sets.ts";

const READ_FIELDS = [
  "Card Name", "Resolved Name", "Game", "Set #", "Set Identifier", "Collector Number",
  "Finish", "Condition", "Qty", "Status", "Rank Score", "Market Price USD", "Notes", "Priority",
  "Rarity", "Cost Basis USD", "Auto Rank", "Card Type", "Recommendation", "Rank Reason", "Enriched At", "Price Source",
] as const;
const MAX_PAGES = 20;

export class AirtableError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = "AirtableError"; this.status = status; }
}
type AirtableRecord = { id: string; createdTime: string; fields: Record<string, unknown> };
export type QueueCard = {
  id: string; name: string; cardName: string | null; resolvedName: string | null; game: string | null;
  setNumber: string | null; setIdentifier: string | null; setName: string | null; collectorNumber: string | null;
  finish: string | null; condition: string | null; qty: number; status: string | null; rankScore: number | null;
  marketPriceUsd: number | null; notes: string | null; priority: number | null; createdTime: string;
  autoRank: number | null; rarity: string | null; costBasisUsd: number | null; cardType: string | null; recommendation: string | null; rankReason: string | null; enrichedAt: string | null; priceSource: string | null;
};
export type Summary = { listedQty: number; waitlistQty: number; counts: Record<Status, number>; truncated: boolean };

function tokenOf(env: Env): string { const token = env.AIRTABLE_API_KEY?.trim() || env.AIRTABLE_PAT?.trim(); if (!token) throw new AirtableError("Set AIRTABLE_API_KEY (or AIRTABLE_PAT) before intake can read or write.", 503); return token; }
function endpoint(env: Env): string { const baseId = env.AIRTABLE_BASE_ID; const tableId = env.AIRTABLE_TABLE_ID; return `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`; }
function formulaString(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

let lastAirtableCall = 0;
async function throttle(): Promise<void> { const wait = lastAirtableCall + 220 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); lastAirtableCall = Date.now(); }
async function airtable(env: Env, url: string, init: RequestInit = {}): Promise<unknown> {
  await throttle();
  const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${tokenOf(env)}`); if (init.body) headers.set("Content-Type", "application/json");
  let response: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) { response = await fetch(url, { ...init, headers }); if (response.status !== 429) break; await response.body?.cancel(); await new Promise((resolve) => setTimeout(resolve, 400)); }
  if (!response) throw new AirtableError("Airtable did not respond.", 502);
  if (!response.ok) {
    let detail = "";
    try { const body = await response.json() as { error?: { message?: string } | string }; if (typeof body.error === "string") detail = body.error; else if (body.error?.message) detail = body.error.message; } catch { await response.body?.cancel(); }
    if (response.status === 401 || response.status === 403) throw new AirtableError("Airtable rejected the token. Check AIRTABLE_API_KEY scopes for this base.", 502);
    throw new AirtableError(detail ? `Airtable: ${detail}` : `Airtable request failed (${response.status}).`, response.status >= 500 ? 502 : 400);
  }
  return response.json();
}
function textField(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function numberField(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
export function toQueueCard(record: AirtableRecord): QueueCard {
  const fields = record.fields ?? {}; const cardName = textField(fields["Card Name"]); const resolvedName = textField(fields["Resolved Name"]); const setNumber = textField(fields["Set #"]);
  return { id: record.id, name: cardName || resolvedName || "", cardName, resolvedName, game: storedGame(fields.Game), setNumber, setIdentifier: textField(fields["Set Identifier"]), setName: setName(setNumber), collectorNumber: textField(fields["Collector Number"]), finish: textField(fields.Finish), condition: textField(fields.Condition), qty: numberField(fields.Qty) ?? 0, status: textField(fields.Status), rankScore: numberField(fields["Rank Score"]), marketPriceUsd: numberField(fields["Market Price USD"]), notes: textField(fields.Notes), priority: numberField(fields.Priority), createdTime: record.createdTime, autoRank: numberField(fields["Auto Rank"]), rarity: textField(fields.Rarity), costBasisUsd: numberField(fields["Cost Basis USD"]), cardType: textField(fields["Card Type"]), recommendation: textField(fields.Recommendation), rankReason: textField(fields["Rank Reason"]), enrichedAt: textField(fields["Enriched At"]), priceSource: textField(fields["Price Source"]) };
}
async function listRecords(env: Env, filterByFormula: string, fields: readonly string[] = READ_FIELDS): Promise<{ records: AirtableRecord[]; truncated: boolean }> {
  const records: AirtableRecord[] = []; let offset: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) { const url = new URL(endpoint(env)); url.searchParams.set("pageSize", "100"); url.searchParams.set("filterByFormula", filterByFormula); for (const field of fields) url.searchParams.append("fields[]", field); if (offset) url.searchParams.set("offset", offset); const body = await airtable(env, url.toString()) as { records?: AirtableRecord[]; offset?: string }; records.push(...(body.records ?? [])); if (!body.offset) return { records, truncated: false }; offset = body.offset; }
  return { records, truncated: true };
}
export function gameFormula(game: Game): string { const exact = `{Game}=${formulaString(game)}`; return game === "Lorcana" ? `OR(${exact},{Game}=BLANK())` : exact; }
export function cardMatchesGame(game: string | null | undefined, selected: Game): boolean { return effectiveGame(game) === selected; }
function storedGame(value: unknown): string { const text = textField(value); return effectiveGame(text) ?? text ?? "Lorcana"; }
function sortQueue(cards: QueueCard[], status: Status): QueueCard[] { const copy = [...cards]; copy.sort((a, b) => { if (status === "Waitlist") { const ar = a.autoRank ?? -1; const br = b.autoRank ?? -1; if (ar !== br) return br - ar; const ap = a.priority ?? Number.POSITIVE_INFINITY; const bp = b.priority ?? Number.POSITIVE_INFINITY; if (ap !== bp) return ap - bp; } if (status === "Listed") { const ar = a.autoRank ?? 101; const br = b.autoRank ?? 101; if (ar !== br) return ar - br; } return b.createdTime.localeCompare(a.createdTime); }); return copy; }

export async function listByStatus(env: Env, status: Status, game: Game): Promise<{ cards: QueueCard[]; truncated: boolean }> { const formula = `AND({Status}=${formulaString(status)},${gameFormula(game)})`; const { records, truncated } = await listRecords(env, formula); const cards = records.map(toQueueCard).filter((card) => card.status === status && cardMatchesGame(card.game, game)); return { cards: sortQueue(cards, status), truncated }; }
export async function summary(env: Env, game: Game): Promise<Summary> { const { records, truncated } = await listRecords(env, gameFormula(game), ["Status", "Qty", "Game"]); const counts: Record<Status, number> = { Waitlist: 0, Listed: 0, Sold: 0, Skip: 0 }; let listedQty = 0; let waitlistQty = 0; for (const record of records) { if (!cardMatchesGame(textField(record.fields.Game), game)) continue; const status = textField(record.fields.Status) as Status | null; const qty = numberField(record.fields.Qty) ?? 0; if (status && status in counts) counts[status] += 1; if (status === "Listed") listedQty += qty; if (status === "Waitlist") waitlistQty += qty; } return { listedQty, waitlistQty, counts, truncated }; }

function orEquals(field: string, values: string[]): string { const clauses = [...new Set(values)].map((value) => `{${field}}=${formulaString(value)}`); return clauses.length === 1 ? (clauses[0] ?? "FALSE()") : `OR(${clauses.join(",")})`; }
function setClause(card: PrintingRef): string { if (effectiveGame(card.game) === "Lorcana") return `{Set #}=${formulaString(card.setNumber ?? "")}`; const identifier = (card.setIdentifier ?? "").trim().toLowerCase(); return `LOWER({Set Identifier}&"")=${formulaString(identifier)}`; }
export async function findDuplicates(env: Env, card: PrintingRef): Promise<QueueCard[]> { const selected = effectiveGame(card.game); if (!selected) return []; const collectorClause = orEquals("Collector Number", collectorVariants(card.collectorNumber)); const formula = `AND(${gameFormula(selected)},${setClause(card)},{Finish}=${formulaString(card.finish)},OR({Status}='Waitlist',{Status}='Listed'),${collectorClause})`; const { records } = await listRecords(env, formula); return sortQueue(records.map(toQueueCard).filter((row) => matchesPrinting(row, card)), "Waitlist"); }
async function writeRecords(env: Env, method: "POST" | "PATCH", records: { id?: string; fields: Record<string, string | number> }[]): Promise<QueueCard[]> { const body = await airtable(env, endpoint(env), { method, body: JSON.stringify({ records, typecast: false }) }) as { records?: AirtableRecord[] }; return (body.records ?? []).map(toQueueCard); }
export async function createCards(env: Env, cards: DraftCard[]): Promise<QueueCard[]> { const created: QueueCard[] = []; for (let index = 0; index < cards.length; index += 10) { const chunk = cards.slice(index, index + 10).map((card) => ({ fields: buildCreateFields(card) })); created.push(...await writeRecords(env, "POST", chunk)); } return created; }
export async function mergeQty(env: Env, recordId: string, addQty: number): Promise<QueueCard> { if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) throw new AirtableError("That record id is not an Airtable row.", 400); const url = new URL(endpoint(env)); url.pathname += `/${recordId}`; const existing = await airtable(env, url.toString()) as AirtableRecord; const card = toQueueCard(existing); if (card.status !== "Waitlist" && card.status !== "Listed") throw new AirtableError("Only Waitlist or Listed rows can take a quantity merge.", 400); const nextQty = (card.qty || 0) + addQty; const [updated] = await writeRecords(env, "PATCH", [{ id: recordId, fields: buildMergeFields(nextQty) }]); if (!updated) throw new AirtableError("Airtable did not return the merged row.", 502); return updated; }
export function matchesPrinting(card: QueueCard, draft: PrintingRef): boolean { if (effectiveGame(card.game) !== draft.game || card.finish !== draft.finish) return false; if (card.status !== "Waitlist" && card.status !== "Listed") return false; if (setIdentityOf(card) !== setIdentityOf(draft)) return false; const wanted = new Set(collectorVariants(draft.collectorNumber).map((value) => value.toLowerCase())); return collectorVariants(card.collectorNumber ?? "").some((value) => wanted.has(value.toLowerCase())); }
export function printingKey(card: Pick<QueueCard, "game" | "setNumber" | "setIdentifier" | "collectorNumber" | "finish">): string[] { return collectorVariants(card.collectorNumber ?? "").map((value) => dedupeKey(effectiveGame(card.game) ?? "", setIdentityOf(card), value, card.finish ?? "")); }
export async function listOpenPrintings(env: Env, game: Game): Promise<QueueCard[]> { const formula = `AND(OR({Status}='Waitlist',{Status}='Listed'),${gameFormula(game)})`; const { records } = await listRecords(env, formula); return records.map(toQueueCard).filter((card) => cardMatchesGame(card.game, game)); }
export function duplicatesAmong(cards: QueueCard[], draft: PrintingRef): QueueCard[] { return cards.filter((card) => matchesPrinting(card, draft)); }

/** Inline edit from the queue: Waitlist rows only, Finish/Condition/Qty only. */
export async function editCard(env: Env, recordId: string, input: EditInput): Promise<QueueCard> {
  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) throw new AirtableError("That record id is not an Airtable row.", 400);
  const url = new URL(endpoint(env)); url.pathname += `/${recordId}`;
  const existing = toQueueCard(await airtable(env, url.toString()) as AirtableRecord);
  if (existing.status !== "Waitlist") throw new AirtableError("Only Waitlist rows can be edited here.", 400);
  const game = effectiveGame(existing.game) ?? "Lorcana";
  const built = buildEditFields(input, game);
  if (!built.ok) throw new AirtableError(built.error, 400);
  const [updated] = await writeRecords(env, "PATCH", [{ id: recordId, fields: built.fields }]);
  if (!updated) throw new AirtableError("Airtable did not return the edited row.", 502);
  return updated;
}

/* ---------- Auto-sort enrichment ---------- */
import { assertEnrichFields, enrichOne, lookupCatalog, priceMove, type EnrichMode, type EnrichResult } from "./enrich.ts";
export const ENRICH_BATCH = 25;

async function applyEnrichment(env: Env, results: EnrichResult[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < results.length; i += 10) {
    const chunk = results.slice(i, i + 10).map((r) => { assertEnrichFields(r.fields); return { id: r.id, fields: r.fields }; });
    const body = await airtable(env, endpoint(env), { method: "PATCH", body: JSON.stringify({ records: chunk, typecast: false }) }) as { records?: unknown[] };
    written += body.records?.length ?? 0;
  }
  return written;
}

export type EnrichSummary = { picked: number; enriched: number; failed: { id: string; error: string }[]; ai: boolean; remaining: boolean };

async function enrichCards(env: Env, cards: QueueCard[], mode: EnrichMode = "waitlist"): Promise<EnrichSummary> {
  const wanted = mode === "listed" ? "Listed" : "Waitlist";
  const results: EnrichResult[] = []; const failed: { id: string; error: string }[] = [];
  for (const card of cards) {
    if (card.status !== wanted) { failed.push({ id: card.id, error: `Not a ${wanted} row.` }); continue; }
    try { results.push(await enrichOne(card, env, { mode })); }
    catch (error) { failed.push({ id: card.id, error: error instanceof Error ? error.message : "lookup failed" }); }
  }
  const enriched = await applyEnrichment(env, results);
  return { picked: cards.length, enriched, failed, ai: Boolean(env.GEMINI_API_KEY?.trim()), remaining: false };
}

export async function enrichRecord(env: Env, recordId: string): Promise<EnrichSummary & { card?: QueueCard }> {
  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) throw new AirtableError("That record id is not an Airtable row.", 400);
  const url = new URL(endpoint(env)); url.pathname += `/${recordId}`;
  const card = toQueueCard(await airtable(env, url.toString()) as AirtableRecord);
  if (card.status !== "Waitlist" && card.status !== "Listed") throw new AirtableError("Only Waitlist or Listed rows are auto-sorted.", 400);
  const summary = await enrichCards(env, [card], card.status === "Listed" ? "listed" : "waitlist");
  const fresh = toQueueCard(await airtable(env, url.toString()) as AirtableRecord);
  return { ...summary, card: fresh };
}

export async function enrichPending(env: Env, limit = ENRICH_BATCH): Promise<EnrichSummary> {
  const url = new URL(endpoint(env));
  url.searchParams.set("pageSize", String(Math.min(100, limit + 1)));
  url.searchParams.set("filterByFormula", "AND({Status}='Waitlist',{Enriched At}=BLANK())");
  for (const field of READ_FIELDS) url.searchParams.append("fields[]", field);
  const body = await airtable(env, url.toString()) as { records?: AirtableRecord[] };
  const all = (body.records ?? []).map(toQueueCard);
  const summary = await enrichCards(env, all.slice(0, limit));
  return { ...summary, remaining: all.length > limit };
}

/** Re-rank Listed rows of one game, in pages. Stable order by record id; client passes offset back. */
export const LISTED_BATCH = 20;
export function pageWindow(total: number, offset: number, size = LISTED_BATCH): { start: number; end: number; nextOffset: number | null } {
  const start = Math.max(0, Math.min(Number.isFinite(offset) ? Math.floor(offset) : 0, total));
  const end = Math.min(total, start + size);
  return { start, end, nextOffset: end < total ? end : null };
}
export async function enrichListedPage(env: Env, game: Game, offset: number): Promise<EnrichSummary & { total: number; done: number; nextOffset: number | null }> {
  const { records } = await listRecords(env, `AND({Status}='Listed',${gameFormula(game)})`);
  const cards = records.map(toQueueCard).filter((c) => c.status === "Listed" && cardMatchesGame(c.game, game)).sort((a, b) => a.id.localeCompare(b.id));
  const { start, end, nextOffset } = pageWindow(cards.length, offset);
  const summary = await enrichCards(env, cards.slice(start, end), "listed");
  return { ...summary, remaining: nextOffset !== null, total: cards.length, done: end, nextOffset };
}

/** Cron helper: Listed rows queued by clearing Enriched At. */
export async function enrichPendingListed(env: Env, limit = ENRICH_BATCH): Promise<EnrichSummary> {
  const url = new URL(endpoint(env));
  url.searchParams.set("pageSize", String(Math.min(100, limit + 1)));
  url.searchParams.set("filterByFormula", "AND({Status}='Listed',{Enriched At}=BLANK())");
  for (const field of READ_FIELDS) url.searchParams.append("fields[]", field);
  const body = await airtable(env, url.toString()) as { records?: AirtableRecord[] };
  const all = (body.records ?? []).map(toQueueCard);
  const summary = await enrichCards(env, all.slice(0, limit), "listed");
  return { ...summary, remaining: all.length > limit };
}

/**
 * Re-scan: re-check the CardTrader price of open (Waitlist and Listed) rows and re-rank only the ones whose
 * price moved, that were never sorted, or that were last priced from somewhere other than CardTrader.
 * Unchanged rows cost the lookups and no AI call or write.
 */
export const RESCAN_BATCH = 20;
export type PriceMove = { id: string; name: string; status: string | null; priceFrom: number | null; priceTo: number | null; rankFrom: number | null; rankTo: number; recommendation: string };
export type RescanSummary = { total: number; offset: number; done: number; nextOffset: number | null; scanned: number; changed: PriceMove[]; failed: { id: string; error: string }[]; ai: boolean };

/** Rows last priced from any other source are re-assessed on the next scan, even if the number happens to match. */
export function pricedByCardTrader(priceSource: string | null | undefined): boolean {
  return (priceSource ?? "").startsWith("CardTrader");
}

/** The page the cron scans this run: one page per 10-minute slot, wrapping, so every row comes round. */
export function rescanSlotOffset(total: number, nowMs: number, size = RESCAN_BATCH, slotMs = 600_000): number {
  const pages = Math.ceil(total / size);
  return pages <= 1 ? 0 : (Math.floor(nowMs / slotMs) % pages) * size;
}

export async function rescanPage(env: Env, game: Game | null, offset: number | ((total: number) => number)): Promise<RescanSummary> {
  const open = "OR({Status}='Waitlist',{Status}='Listed')";
  const { records } = await listRecords(env, game ? `AND(${open},${gameFormula(game)})` : open);
  const cards = records.map(toQueueCard)
    .filter((c) => (c.status === "Waitlist" || c.status === "Listed") && (!game || cardMatchesGame(c.game, game)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const { start, end, nextOffset } = pageWindow(cards.length, typeof offset === "function" ? offset(cards.length) : offset, RESCAN_BATCH);
  const results: EnrichResult[] = []; const changed: PriceMove[] = []; const failed: { id: string; error: string }[] = [];
  for (const card of cards.slice(start, end)) {
    try {
      const catalog = await lookupCatalog(card, env);
      const move = priceMove(card.marketPriceUsd, catalog.price);
      if (!move.changed && card.enrichedAt && pricedByCardTrader(card.priceSource)) continue;
      const result = await enrichOne(card, env, { mode: card.status === "Listed" ? "listed" : "waitlist", catalog });
      results.push(result);
      changed.push({ id: card.id, name: card.resolvedName || card.name || catalog.name || card.collectorNumber || card.id, status: card.status, priceFrom: move.from, priceTo: move.to, rankFrom: card.autoRank, rankTo: result.decision.rankScore, recommendation: result.decision.recommendation });
    } catch (error) { failed.push({ id: card.id, error: error instanceof Error ? error.message : "lookup failed" }); }
  }
  await applyEnrichment(env, results);
  return { total: cards.length, offset: start, done: end, nextOffset, scanned: end - start, changed, failed, ai: Boolean(env.GEMINI_API_KEY?.trim()) };
}

/**
 * CardTrader export. The export reads the listing id alongside the usual fields. It is kept out of
 * READ_FIELDS so a base without the field still loads its queue.
 */
export const CARDTRADER_FIELD = "CardTrader Listing ID";
export type ExportQueueCard = QueueCard & { cardTraderListingId: string | null };
export async function cardsForExport(env: Env, recordIds: string[]): Promise<ExportQueueCard[]> {
  const ids = [...new Set(recordIds)];
  if (ids.some((id) => !/^rec[A-Za-z0-9]{14}$/.test(id))) throw new AirtableError("That record id is not an Airtable row.", 400);
  if (ids.length === 0) return [];
  const formula = `OR(${ids.map((id) => `RECORD_ID()='${id}'`).join(",")})`;
  const { records } = await listRecords(env, formula, [...READ_FIELDS, CARDTRADER_FIELD]);
  const byId = new Map(records.map((r) => [r.id, { ...toQueueCard(r), cardTraderListingId: textField(r.fields[CARDTRADER_FIELD]) }]));
  return ids.flatMap((id) => { const card = byId.get(id); return card ? [card] : []; });
}
/**
 * What a successful CardTrader listing writes: the listing id, and Status = Listed. This is the one place
 * intake changes Status, at Dustin's request (Oct 11). It runs only after CardTrader confirms the listing.
 */
export function cardTraderListingFields(listingId: number): Record<string, string> {
  return { [CARDTRADER_FIELD]: String(listingId), Status: "Listed" };
}
export async function recordCardTraderListing(env: Env, recordId: string, listingId: number): Promise<void> {
  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) throw new AirtableError("That record id is not an Airtable row.", 400);
  const url = new URL(endpoint(env)); url.pathname += `/${recordId}`;
  await airtable(env, url.toString(), { method: "PATCH", body: JSON.stringify({ fields: cardTraderListingFields(listingId), typecast: false }) });
}

/** Delete a single Waitlist record by id. */
export function assertDeletable(recordId: string, status: string | null): void {
  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) throw new AirtableError("That record id is not an Airtable row.", 400);
  if (status !== "Waitlist") throw new AirtableError("Only Waitlist rows can be deleted here.", 400);
}
export async function deleteCard(env: Env, recordId: string): Promise<{ id: string; deleted: boolean }> {
  assertDeletable(recordId, "Waitlist");
  const url = new URL(endpoint(env)); url.pathname += `/${recordId}`;
  const existing = toQueueCard(await airtable(env, url.toString()) as AirtableRecord);
  assertDeletable(recordId, existing.status);
  const body = await airtable(env, url.toString(), { method: "DELETE" }) as { id?: string; deleted?: boolean };
  if (!body.deleted) throw new AirtableError("Airtable did not confirm the delete.", 502);
  return { id: recordId, deleted: true };
}
