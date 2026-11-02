import type { WaitlistInput } from './inventory.ts';
import type { LiveStock } from './live-inventory.ts';

// Read all fields so older bases without optional cost/language columns still work.
// Only this allowlist leaves the reader; notes and other unrelated cells are discarded.
const FIELDS = ['Card Name', 'Resolved Name', 'Game', 'Set #', 'Set Identifier', 'Collector Number',
  'Finish', 'Condition', 'Language', 'Qty', 'Status', 'Market Price USD', 'Cost Basis USD',
  'Unknown-Cost Qty', 'CardTrader Listing ID'] as const;
const MAX_STOCK_PAGES = 500;

/** Complete scan or error: never return a truncated page set as current inventory. */
export async function scanInventoryStock(endpoint: string, request: (url: string) => Promise<unknown>): Promise<LiveStock> {
  const startedAt = new Date().toISOString();
  const rows: WaitlistInput[] = [];
  const offsets = new Set<string>();
  const ids = new Set<string>();
  let offset: string | undefined;
  for (let page = 0; page < MAX_STOCK_PAGES; page++) {
    const url = new URL(endpoint);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const body = await request(url.toString()) as { records?: unknown; offset?: unknown } | null;
    if (!body || !Array.isArray(body.records)) throw new Error('Airtable returned an incomplete stock response. Refresh inventory.');
    for (const value of body.records) {
      const record = value as { id?: unknown; fields?: unknown; createdTime?: unknown } | null;
      if (!record || typeof record.id !== 'string' || !/^rec[A-Za-z0-9]{14}$/.test(record.id)
        || !record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields) || ids.has(record.id)) {
        throw new Error('Airtable returned an invalid or repeated stock row. Refresh inventory.');
      }
      ids.add(record.id);
      const fields: Record<string, unknown> = {};
      for (const field of FIELDS) if (field in record.fields) fields[field] = (record.fields as Record<string, unknown>)[field];
      rows.push({ id: record.id, fields, createdTime: typeof record.createdTime === 'string' ? record.createdTime : null });
    }
    if (body.offset == null) return { rows, startedAt, completedAt: new Date().toISOString() };
    if (typeof body.offset !== 'string' || !body.offset || offsets.has(body.offset)) throw new Error('Airtable repeated a stock page. Refresh inventory.');
    offsets.add(body.offset);
    offset = body.offset;
  }
  throw new Error('The stock scan could not finish within its page limit. Current totals were not calculated.');
}
