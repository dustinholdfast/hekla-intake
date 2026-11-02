/** Runs the production store queries against isolated embedded Postgres. No Neon or Airtable connection. */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { saleStoreWithQuery } from '../src/salesdb.ts';
import { applyPendingDecrements, type SaleLine, type DecrementScope } from '../src/sales.ts';

const pg = new PGlite();
const T = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const REC = 'recAAAAAAAAAAAAAA';
const scope = (holder = 'worker'): DecrementScope => ({ tenantId: T, recordId: REC, holder });
const store = () => saleStoreWithQuery(async (sql, params) => (await pg.query<Record<string, unknown>>(sql, params)).rows);
const line = (order = 'one'): SaleLine => ({ platform: 'cardtrader', externalOrderId: order, orderCode: order,
  lineKey: 'line', recordId: REC, game: 'Lorcana', cardName: 'Test card', qty: 2, currency: 'USD',
  grossCents: 200, feeCents: 0, netCents: 200, soldAt: '2026-11-01T12:00:00Z', orderState: 'paid', decrementOwner: 'hekla' });
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const opts = { lockWaitMs: 1 };
const sales = async () => (await pg.query<Record<string, unknown>>('select * from sales order by id')).rows;

before(async () => {
  await pg.exec('create table tenants (id uuid primary key)');
  await pg.query('insert into tenants values ($1), ($2)', [T, OTHER]);
  const migration = readFileSync(new URL('../db/migrations/0005_sales.sql', import.meta.url), 'utf8');
  await pg.exec(migration.split('-- Non-secret settings')[0]!);
});
beforeEach(async () => { await pg.exec('truncate sales, stock_locks restart identity'); });
after(async () => { await pg.close(); });

test('production SQL: a worker resuming a stale candidate after another finishes does not write again', async () => {
  const sqlStore = store();
  await sqlStore.insertLines(T, [line()]);
  const bothRead = gate(), firstReleased = gate(); let captured = 0;
  const list = sqlStore.pendingDecrements.bind(sqlStore), acquire = sqlStore.acquireLock.bind(sqlStore), release = sqlStore.releaseLock.bind(sqlStore);
  sqlStore.pendingDecrements = async (tenant, limit) => { const result = await list(tenant, limit); if (++captured === 2) bothRead.release(); await bothRead.promise; return result; };
  sqlStore.acquireLock = async (tenant, rec, holder, seconds) => { if (holder === 'cron') await firstReleased.promise; return acquire(tenant, rec, holder, seconds); };
  sqlStore.releaseLock = async (tenant, rec, holder) => { await release(tenant, rec, holder); if (holder === 'webhook') firstReleased.release(); };
  let qty = 10; const writes: number[] = [];
  const stock = { read: async () => qty, write: async (_id: string, target: number) => { qty = target; writes.push(target); } };
  const result = await Promise.all([
    applyPendingDecrements(sqlStore, stock, T, { ...opts, holder: 'webhook' }),
    applyPendingDecrements(sqlStore, stock, T, { ...opts, holder: 'cron' }),
  ]);
  assert.equal(qty, 8); assert.deepEqual(writes, [8]);
  assert.equal(result.reduce((n, r) => n + r.applied, 0), 1);
  assert.ok((await sales())[0]!.decremented_at);
});

test('production SQL: concurrent runs preserve two distinct sales of the same stock row', async () => {
  const sqlStore = store(); await sqlStore.insertLines(T, [line('one'), line('two')]);
  let qty = 10; const writes: number[] = [];
  const stock = { read: async () => qty, write: async (_id: string, target: number) => { qty = target; writes.push(target); } };
  await Promise.all([applyPendingDecrements(sqlStore, stock, T, opts), applyPendingDecrements(sqlStore, stock, T, opts)]);
  await applyPendingDecrements(sqlStore, stock, T, opts); // a contended candidate can be deferred
  assert.equal(qty, 6); assert.deepEqual(writes, [8, 6]);
  assert.equal((await sales()).filter(row => row.decremented_at).length, 2);
});

test('production SQL: transition guards reject wrong tenant, record, holder, finished sale and changed target', async () => {
  const sqlStore = store(); await sqlStore.insertLines(T, [line()]);
  await sqlStore.acquireLock(T, REC, 'worker', 60);
  for (const bad of [{ ...scope(), tenantId: OTHER }, { ...scope(), recordId: 'recBBBBBBBBBBBBBB' }, scope('wrong')]) {
    assert.equal(await sqlStore.pendingDecrement(bad, 1), null);
    assert.equal(await sqlStore.startDecrement(bad, 1, 10, 8), false);
    assert.equal(await sqlStore.finishDecrement(bad, 1, false, null), false);
    assert.equal(await sqlStore.flag(bad, 1, 'not authorized'), false);
  }
  assert.equal(await sqlStore.startDecrement(scope(), 1, 10, 8), true);
  assert.equal(await sqlStore.startDecrement(scope(), 1, 8, 6), false);
  assert.equal(await sqlStore.finishDecrement(scope(), 1, false, null), true);
  assert.equal(await sqlStore.startDecrement(scope(), 1, 8, 6), false);
  assert.equal(await sqlStore.finishDecrement(scope(), 1, false, null), false);
});

test('production SQL: cancellation while stock is read prevents the write', async () => {
  const sqlStore = store(); await sqlStore.insertLines(T, [line()]); let writes = 0;
  const result = await applyPendingDecrements(sqlStore, {
    read: async () => { await sqlStore.markCancelled(T, 'cardtrader', 'one', new Date().toISOString(), 'canceled'); return 10; },
    write: async () => { writes++; },
  }, T, opts);
  assert.equal(writes, 0); assert.equal(result.applied, 0); assert.equal(result.skipped, 1);
});

test('production SQL: cancellation during a write remains visible and blocks following updates pending review', async () => {
  const sqlStore = store(); await sqlStore.insertLines(T, [line()]); let qty = 10; let writes = 0;
  const stock = { read: async () => qty, write: async (_id: string, target: number) => {
    writes++; qty = target;
    const cancelled = await sqlStore.markCancelled(T, 'cardtrader', 'one', new Date().toISOString(), 'canceled');
    assert.equal(cancelled.length, 1);
  } };
  await applyPendingDecrements(sqlStore, stock, T, opts);
  assert.match(String((await sales())[0]!.needs_review), /Cancelled/);
  await sqlStore.insertLines(T, [line('two')]);
  await applyPendingDecrements(sqlStore, stock, T, opts);
  assert.equal(qty, 8); assert.equal(writes, 1);
});

test('production SQL: an unknown write is not automatically repeated or followed by another sale on that row', async () => {
  const sqlStore = store(); await sqlStore.insertLines(T, [line()]); let qty = 10; let writes = 0;
  const stock = { read: async () => qty, write: async (_id: string, target: number) => { writes++; qty = target; throw new Error('response lost'); } };
  const result = await applyPendingDecrements(sqlStore, stock, T, opts);
  assert.equal(result.flagged, 1); assert.equal(result.alerts.length, 1);
  assert.match(String((await sales())[0]!.needs_review), /outcome is unknown/);
  await sqlStore.insertLines(T, [line('two')]);
  await applyPendingDecrements(sqlStore, stock, T, opts);
  assert.equal(qty, 8); assert.equal(writes, 1);
});

test('production SQL: expiry before a stock write prevents mutation; an idle expired lease can be recovered', async () => {
  const sqlStore = store(); await sqlStore.insertLines(T, [line()]); let writes = 0;
  await applyPendingDecrements(sqlStore, {
    read: async () => { await pg.exec("update stock_locks set expires_at = now() - interval '1 second'"); return 10; },
    write: async () => { writes++; },
  }, T, opts);
  assert.equal(writes, 0);
  assert.equal(await sqlStore.acquireLock(T, REC, 'new-worker', 60), true);
});

test('production SQL: an expired in-flight lease is not stolen and its unfinished plan is flagged', async () => {
  const sqlStore = store(); await sqlStore.insertLines(T, [line()]);
  await sqlStore.acquireLock(T, REC, 'old', 60);
  assert.equal(await sqlStore.startDecrement(scope('old'), 1, 10, 8), true);
  await pg.exec("update stock_locks set expires_at = now() - interval '1 second'");
  assert.equal(await sqlStore.acquireLock(T, REC, 'replacement', 60), false);
  assert.match(String((await sales())[0]!.needs_review), /lease expired/);
  assert.equal(await sqlStore.startDecrement(scope('old'), 1, 10, 8), false);
  assert.equal(await sqlStore.finishDecrement(scope('old'), 1, false, null), false);
});

test('production SQL: a successful stock write followed by failed finalization is confirmed without another write', async () => {
  let fail = true;
  const sqlStore = saleStoreWithQuery(async (sql, params) => {
    if (fail && sql.includes('set decremented_at')) { fail = false; throw new Error('database unavailable'); }
    return (await pg.query<Record<string, unknown>>(sql, params)).rows;
  });
  await sqlStore.insertLines(T, [line()]); let qty = 10; let writes = 0;
  const stock = { read: async () => qty, write: async (_id: string, target: number) => { qty = target; writes++; } };
  await assert.rejects(applyPendingDecrements(sqlStore, stock, T, opts), /database unavailable/);
  const result = await applyPendingDecrements(sqlStore, stock, T, opts);
  assert.equal(result.applied, 1); assert.equal(qty, 8); assert.equal(writes, 1);
});

test('production SQL: if an unknown write cannot be flagged, the lease is retained and later expiry cannot authorize a replay', async () => {
  let failFlag = true;
  const sqlStore = saleStoreWithQuery(async (sql, params) => {
    if (failFlag && sql.includes('set needs_review = $5')) { failFlag = false; throw new Error('review persistence failed'); }
    return (await pg.query<Record<string, unknown>>(sql, params)).rows;
  });
  await sqlStore.insertLines(T, [line()]); let qty = 10; let writes = 0;
  const stock = { read: async () => qty, write: async (_id: string, target: number) => { qty = target; writes++; throw new Error('response lost'); } };
  await assert.rejects(applyPendingDecrements(sqlStore, stock, T, opts), /review persistence failed/);
  assert.equal((await pg.query('select * from stock_locks')).rows.length, 1);
  await pg.exec("update stock_locks set expires_at = now() - interval '1 second'");
  await applyPendingDecrements(sqlStore, stock, T, opts);
  assert.match(String((await sales())[0]!.needs_review), /lease expired/);
  assert.equal(qty, 8); assert.equal(writes, 1);
});

test('production SQL: an old worker finishing after expiry cannot unblock another sale automatically', async () => {
  const sqlStore = store(); await sqlStore.insertLines(T, [line()]); let qty = 10; let writes = 0;
  const stock = { read: async () => qty, write: async (_id: string, target: number) => {
    writes++;
    await pg.exec("update stock_locks set expires_at = now() - interval '1 second'");
    assert.equal(await sqlStore.acquireLock(T, REC, 'replacement', 60), false);
    qty = target;
  } };
  await applyPendingDecrements(sqlStore, stock, T, opts);
  await sqlStore.insertLines(T, [line('two')]);
  await applyPendingDecrements(sqlStore, stock, T, opts);
  assert.match(String((await sales())[0]!.needs_review), /lease expired/);
  assert.equal(qty, 8); assert.equal(writes, 1);
});
