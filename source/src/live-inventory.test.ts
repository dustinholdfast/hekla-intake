import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLiveDetail, buildLiveInventory, currentQty } from './live-inventory.ts';
import { DEFAULT_THRESHOLDS, planOpeningEntries, type WaitlistInput } from './inventory.ts';
import { scanInventoryStock } from './stock-scan.ts';
import { readMovementHistory } from './inventorydb.ts';
import { inventoryStock } from './airtable.ts';

const TENANT = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-01T12:00:00Z');
const id = (n: number) => `rec${String(n).padStart(14, '0')}`;
const stockRow = (n: number, qty: number, fields: Record<string, unknown> = {}): WaitlistInput => ({
  id: id(n), createdTime: '2026-01-01T12:00:00Z', fields: {
    'Card Name': `Card ${n}`, Game: 'Lorcana', 'Set #': '1', 'Collector Number': String(n),
    Finish: 'Normal', Condition: 'NM', Qty: qty, Status: 'Listed', ...fields,
  },
});
const stock = (rows: WaitlistInput[]) => ({ rows, startedAt: NOW.toISOString(), completedAt: NOW.toISOString() });
const view = (rows: WaitlistInput[], recorded: WaitlistInput[] = [], filter = {}) => buildLiveInventory({
  tenantId: TENANT, stock: stock(rows), movements: planOpeningEntries(recorded, TENANT, NOW),
  buyList: [], thresholds: { ...DEFAULT_THRESHOLDS }, wantQtyState: 'unread', filter,
});

test('current intake, edit, sale, price and removal effects override stale opening snapshots without fabricated history', () => {
  const original = [stockRow(1, 10), stockRow(2, 5), stockRow(3, 7)];
  const current = [stockRow(1, 8, { 'Market Price USD': 4.99, 'Card Name': 'Updated name' }),
    stockRow(2, 5, { Condition: 'LP' }), stockRow(4, 2)];
  const payload = view(current, original);
  assert.equal(payload.onHandSource, 'airtable');
  assert.equal(payload.totals.units, 15);
  assert.equal(payload.totals.rows, 3);
  assert.deepEqual(payload.accuracy, { different: 2, unrecorded: 1, missing: 1, historyComplete: false });
  const first = payload.rows.find(row => row.recordId === id(1))!;
  assert.equal(first.name, 'Updated name');
  assert.equal(first.marketPriceUsd, 4.99);
  assert.equal(first.accuracy.ledgerQty, 10);
  assert.equal(first.accuracy.difference, -2);
  assert.equal(payload.rows.find(row => row.recordId === id(2))?.condition, 'LP');
  assert.equal(payload.rows.find(row => row.recordId === id(2))?.accuracy.identityChanged, true);
  assert.equal(payload.rows.find(row => row.recordId === id(3))?.state, 'Missing');
  assert.equal(payload.rows.find(row => row.recordId === id(3))?.onHand, 0);
  const movements = planOpeningEntries(original, TENANT, NOW);
  const detail = buildLiveDetail(payload, movements, id(1))!;
  assert.equal(detail.row.onHand, 8);
  assert.equal(detail.movements[0]?.qtyAfter, 10);
  assert.equal(detail.movements.length, 1, 'no sale is invented from a quantity difference');
  assert.equal(buildLiveDetail(payload, movements, id(4))?.movements.length, 0);
  assert.equal(buildLiveDetail(payload, movements, id(99)), null);
  assert.equal(original[0]?.fields.Qty, 10, 'inputs remain unchanged');
});

test('live rows with no history work; filters keep global totals and detect duplicate identities', () => {
  const payload = view([stockRow(1, 2), stockRow(2, 3, { 'Collector Number': '1' })], [], { q: 'Card 1' });
  assert.equal(payload.rows.length, 1);
  assert.equal(payload.totals.units, 5);
  assert.equal(payload.rows[0]?.accuracy.status, 'unrecorded');
  assert.match(payload.rows[0]?.flags.needsReview ?? '', /Duplicate stock identity/);
  assert.equal(view([], []).totals.units, 0);
});

test('live cost totals split partly known stock and do not infer an old cost from movement history', () => {
  const payload = view([
    stockRow(1, 10, { 'Cost Basis USD': 1.5, 'Unknown-Cost Qty': 4 }),
    stockRow(2, 3, { 'Cost Basis USD': 99 }), // decorative number, no unknown quantity
    stockRow(3, 2, { 'Cost Basis USD': 0, 'Unknown-Cost Qty': 0 }), // known zero cost
    stockRow(4, 5, { 'Cost Basis USD': 1, 'Unknown-Cost Qty': 10 }), // inconsistent
  ]);
  assert.equal(payload.totals.units, 20);
  assert.equal(payload.totals.knownCostUnits, 8);
  assert.equal(payload.totals.unknownCostUnits, 12);
  assert.equal(payload.rows.find(row => row.recordId === id(1))?.unitCostCents, 150);
  assert.equal(payload.rows.find(row => row.recordId === id(3))?.unitCostCents, 0);
  assert.equal(payload.rows.find(row => row.recordId === id(2))?.unitCostCents, null);
  assert.equal(payload.rows.find(row => row.recordId === id(4))?.knownCostQty, 0);
  assert.equal(view([stockRow(1, 10, { 'Cost Basis USD': 1, 'Unknown-Cost Qty': 4 })], [], { cost: 'unknown' }).rows.length, 1);
  assert.equal(view([stockRow(1, 10, { 'Cost Basis USD': 1, 'Unknown-Cost Qty': 4 })], [], { cost: 'known' }).rows.length, 1);
});

test('invalid stock quantities fail the complete view; omitted numeric cell is zero; conflicting status stays visible', () => {
  for (const qty of [-1, 1.5, '3', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => view([stockRow(1, 0, { Qty: qty })]), /invalid quantity/);
  }
  assert.equal(currentQty(stockRow(1, 0, { Qty: undefined })), 0);
  for (const status of ['Sold', 'Skip']) {
    const payload = view([stockRow(1, 4, { Status: status })]);
    assert.equal(payload.totals.units, 4, 'preserve the actual Qty and flag the conflict rather than guessing');
    assert.match(payload.rows[0]?.flags.needsReview ?? '', /Check its status and quantity/);
  }
  const same = stockRow(1, 4);
  assert.equal(view([same], [same]).rows[0]?.flags.slow, false, 'quantity agreement does not prove complete sales history');
});

test('stock scanner reads beyond the legacy 20-page cap and returns only permitted fields', async () => {
  let calls = 0;
  const result = await scanInventoryStock('https://api.airtable.com/v0/appTenant/tblTenant', async url => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/v0/appTenant/tblTenant');
    assert.equal(parsed.searchParams.get('offset'), calls === 0 ? null : `page-${calls}`);
    calls++;
    return { records: [stockRow(calls, 1, { Notes: 'not returned', privateField: 'not returned' })], ...(calls < 22 ? { offset: `page-${calls}` } : {}) };
  });
  assert.equal(calls, 22);
  assert.equal(result.rows.length, 22);
  assert.equal('Notes' in result.rows[0]!.fields, false);
  assert.equal('privateField' in result.rows[0]!.fields, false);
});

test('stock scanner rejects incomplete, failed, repeated or too-long pagination, never partial success', async () => {
  await assert.rejects(scanInventoryStock('https://example.test', async () => ({})), /incomplete/);
  await assert.rejects(scanInventoryStock('https://example.test', async () => ({ records: [], offset: 'same' })), /repeated a stock page/);
  await assert.rejects(scanInventoryStock('https://example.test', async () => ({ records: [stockRow(1, 1)], offset: 'next' })), /repeated stock row/);
  let calls = 0;
  await assert.rejects(scanInventoryStock('https://example.test', async () => {
    if (++calls === 2) throw new Error('upstream failed');
    return { records: [stockRow(1, 1)], offset: 'next' };
  }), /upstream failed/);
  let pages = 0;
  await assert.rejects(scanInventoryStock('https://example.test', async () => ({ records: [], offset: String(++pages) })), /page limit/);
  assert.equal(pages, 500);
});

test('operational stock reader scopes all requests to the resolved tenant, uses GET, and validates IDs', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const env = { TENANT_ID: TENANT, AIRTABLE_BASE_ID: 'appTenant2', AIRTABLE_TABLE_ID: 'tblTenant2', AIRTABLE_API_KEY: 'test-token' } as Env;
  try {
    globalThis.fetch = async (url, init) => {
      calls.push(String(url));
      assert.equal(init?.method ?? 'GET', 'GET');
      assert.equal(init?.body, undefined);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token');
      assert.ok(init?.signal);
      return new Response(JSON.stringify({ records: [stockRow(1, 3)] }));
    };
    const result = await inventoryStock(env, id(1));
    assert.equal(result.rows[0]?.fields.Qty, 3);
    assert.equal(new URL(calls[0]!).pathname, '/v0/appTenant2/tblTenant2');
    assert.equal(new URL(calls[0]!).searchParams.get('filterByFormula'), `RECORD_ID()='${id(1)}'`);
    await assert.rejects(inventoryStock({ ...env, TENANT_ID: undefined }), /configured organization/);
    await assert.rejects(inventoryStock(env, 'foreign-or-invalid'), /not a stock row/);
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('history reader includes 20,001+ events, binds tenant/record, and preserves bigint cursor precision', async () => {
  const start = 9007199254740993n;
  const total = 20003;
  let pages = 0;
  const output = await readMovementHistory(TENANT, async (sql, params) => {
    assert.equal(params[0], TENANT);
    if (sql.startsWith('select coalesce')) {
      assert.equal(params[1], id(1));
      return [{ high_water: String(start + BigInt(total - 1)) }];
    }
    assert.equal(params[3], id(1));
    const from = BigInt(String(params[1]));
    const last = BigInt(String(params[2]));
    const first = from < start ? start : from + 1n;
    pages++;
    return Array.from({ length: Math.min(1000, Number(last - first + 1n)) }, (_, i) => ({
      id: String(first + BigInt(i)), tenant_id: TENANT, record_id: id(1), delta: 1, qty_before: 0, qty_after: 1,
      reason: 'intake', source_kind: 'manual', source_ref: String(first + BigInt(i)), applied_by: 'test',
      unit_cost_cents: null, snapshot: {}, created_at: NOW.toISOString(),
    }));
  }, id(1));
  assert.equal(output.length, total);
  assert.equal(pages, 21);
  assert.equal(output.at(-1)?.sourceRef, String(start + BigInt(total - 1)));
  let page = 0;
  await assert.rejects(readMovementHistory(TENANT, async sql => {
    if (sql.startsWith('select coalesce')) return [{ high_water: '2000' }];
    if (++page === 2) throw new Error('database read failed');
    return [{ id: '1000', created_at: NOW.toISOString() }];
  }), /database read failed/);
  await assert.rejects(readMovementHistory(TENANT, async sql => sql.startsWith('select coalesce')
    ? [{ high_water: '1000' }] : []), /history changed/);
});
