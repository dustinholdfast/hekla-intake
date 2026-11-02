/** Isolated PostgreSQL tests: no connection to Neon, Airtable, or live customer credit. */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { saveAcceptance, saveRedemption } from '../src/purchasesdb.ts';
import { draftRedemption, planAcceptance } from '../src/purchases.ts';
import { exampleAcceptInput } from '../src/purchases-fixtures.ts';
import { requirePurchaseSafety, type PurchaseDatabase, type SqlRow } from '../src/purchase-safety.ts';

const pg = new PGlite();
const T='00000000-0000-4000-8000-000000000001', OTHER='00000000-0000-4000-8000-000000000002';
const CUSTOMER='recSRPhase3Ex0012';
const env={} as Env;
const database: PurchaseDatabase = {
  query: async (text,params) => (await pg.query<SqlRow>(text,params)).rows,
  transaction: statements => pg.transaction(async tx => {
    const result: SqlRow[][]=[];
    for (const s of statements) result.push((await tx.query<SqlRow>(s.text,s.params)).rows);
    return result;
  }),
};
const migration=(n:string) => readFileSync(new URL(`../db/migrations/${n}`,import.meta.url),'utf8');
const safety=migration('0011_purchase_safety.sql');
before(async()=>{
  await pg.exec('create table tenants(id uuid primary key)');
  await pg.query('insert into tenants values($1),($2)',[T,OTHER]);
  await pg.exec(migration('0008_inventory.sql'));
  await pg.exec(migration('0010_purchases.sql'));
  await pg.exec(safety);
});
beforeEach(async()=>{await pg.exec('truncate credit_accounts,store_credit_entries,stock_lots,purchase_lines,purchases');});
after(async()=>{await pg.close();});
async function issue(tenant=T,amount=10000,source='issue-1') {
  return database.query(`insert into store_credit_entries(tenant_id,customer_ref,amount_cents,entry_kind,source_kind,source_ref,occurred_on,balance_after_cents)
    values($1,$2,$3,'issue','purchase',$4,'2026-11-02',0) on conflict do nothing returning id`,[tenant,CUSTOMER,amount,source]);
}
function entry(sourceRef='redeem-1',amountCents=8000,tenantId=T) {
  const result=draftRedemption({tenantId,customerRef:CUSTOMER,sourceRef,amountCents,occurredOn:'2026-11-02',now:'2026-11-02T12:00:00Z'});
  if(!result.ok) throw Error(result.error);
  return result.entry;
}
async function balance(tenant=T) {return Number((await database.query('select balance_cents from credit_accounts where tenant_id=$1 and customer_ref=$2',[tenant,CUSTOMER]))[0]?.balance_cents??0);}
function purchase(tenant=T) {const p=planAcceptance(exampleAcceptInput(tenant));if(!p.ok)throw Error(p.error);return p.purchase;}

test('credit: two simultaneous requests cannot both spend the same balance',async()=>{
  await issue();
  const outcomes=await Promise.allSettled([saveRedemption(env,entry('a'),database),saveRedemption(env,entry('b'),database)]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);
  assert.equal(await balance(),2000);
  assert.equal((await database.query('select * from store_credit_entries',[])).length,2);
});
test('credit: replay succeeds even when the remaining balance is smaller than the original spend',async()=>{
  await issue();const first=await saveRedemption(env,entry(),database),again=await saveRedemption(env,entry(),database);
  assert.equal(first.created,true);assert.equal(again.created,false);assert.deepEqual(again.entry,first.entry);
  assert.equal(first.entry.balanceAfterCents,2000);assert.equal(await balance(),2000);
});
test('credit: reused source with changed amount, customer, or date is rejected without spending',async()=>{
  await issue();await saveRedemption(env,entry(),database);
  for(const change of [{amountCents:-1000},{customerRef:'recAAAAAAAAAAAAAA'},{occurredOn:'2026-11-01'}]) {
    await assert.rejects(saveRedemption(env,{...entry(),...change},database),/already used/);
  }
  assert.equal(await balance(),2000);
});
test('credit: identical external source IDs are independent between tenants',async()=>{
  await issue(T);await issue(OTHER);
  await saveRedemption(env,entry(),database);await saveRedemption(env,entry('redeem-1',1000,OTHER),database);
  assert.equal(await balance(T),2000);assert.equal(await balance(OTHER),9000);
});
test('credit: duplicate issue does not increase the balance and wrong signs roll back',async()=>{
  await issue();await issue();assert.equal(await balance(),10000);
  await assert.rejects(issue(T,-100,'negative-issue'),/invalid_credit_sign/);
  await assert.rejects(saveRedemption(env,{...entry(),amountCents:100},database),/Invalid credit/);
  assert.equal(await balance(),10000);
});
test('purchase acceptance: a later line failure rolls back all header and line changes',async()=>{
  const original=purchase();const saved=await saveAcceptance(env,original,database);
  const broken=structuredClone(original);broken.offerCents=999;broken.lines[1]!.qty=0;
  await assert.rejects(saveAcceptance(env,broken,database));
  const rows=await database.query('select id,offer_cents from purchases',[]);
  assert.equal(rows.length,1);assert.equal(rows[0]!.id,saved.id);assert.equal(rows[0]!.offer_cents,original.offerCents);
  assert.equal((await database.query('select * from purchase_lines',[])).length,original.lines.length);
});
test('purchase acceptance: repeats keep one header and received purchases cannot be replaced',async()=>{
  const draft=purchase();const first=await saveAcceptance(env,draft,database),second=await saveAcceptance(env,draft,database);
  assert.equal(first.created,true);assert.equal(second.created,false);assert.equal(first.id,second.id);
  await database.query("update purchases set status='received' where id=$1",[first.id]);
  await assert.rejects(saveAcceptance(env,draft,database),/purchase_no_longer_accepted/);
});
test('purchase acceptance: two tenant drafts with the same sell-request ID retain separate lines',async()=>{
  const [one,two]=await Promise.all([saveAcceptance(env,purchase(T),database),saveAcceptance(env,purchase(OTHER),database)]);
  assert.notEqual(one.id,two.id);
  const rows=await database.query('select tenant_id,purchase_id from purchase_lines',[]);
  assert.equal(rows.filter(r=>r.tenant_id===T).length,purchase(T).lines.length);
  assert.ok(rows.every(r=>r.purchase_id===(r.tenant_id===T?one.id:two.id)));
});
test('migration: readiness fails closed if the credit trigger is disabled',async()=>{
  await pg.exec('alter table store_credit_entries disable trigger hekla_credit_balance');
  try {await assert.rejects(requirePurchaseSafety(database),/not installed/);} finally {await pg.exec('alter table store_credit_entries enable trigger hekla_credit_balance');}
});
test('migration: an existing positive ledger is backfilled on installation',async()=>{
  await pg.exec('alter table store_credit_entries disable trigger hekla_credit_balance');
  await issue(T,1500);await pg.exec('alter table store_credit_entries enable trigger hekla_credit_balance');
  assert.equal(await balance(),0);await pg.exec(safety);assert.equal(await balance(),1500);
});
test('migration: a legacy negative balance stops installation rather than concealing the debt',async()=>{
  await pg.exec('alter table store_credit_entries disable trigger hekla_credit_balance');
  await issue(T,-1500);await pg.exec('alter table store_credit_entries enable trigger hekla_credit_balance');
  await assert.rejects(pg.exec(safety),/check constraint/);
  await pg.exec('rollback');
  assert.equal(await balance(),0);
  assert.equal((await database.query('select amount_cents from store_credit_entries',[]))[0]!.amount_cents,-1500);
});
