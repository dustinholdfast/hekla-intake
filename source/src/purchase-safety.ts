import { db } from './tenants.ts';

export type SqlStatement = { text: string; params: unknown[] };
export type SqlRow = Record<string, unknown>;
export type PurchaseDatabase = {
  query(text: string, params: unknown[]): Promise<SqlRow[]>;
  transaction(statements: SqlStatement[]): Promise<SqlRow[][]>;
};
export function purchaseDatabase(env: Env): PurchaseDatabase {
  const sql = db(env);
  return { query: (text, params) => sql.query(text, params),
    transaction: statements => sql.transaction(statements.map(s => sql.query(s.text, s.params))) };
}
export class PurchaseSafetyError extends Error {
  readonly status: 400 | 403 | 409 | 503;
  constructor(message: string, status: 400 | 403 | 409 | 503 = 409) { super(message); this.status = status; }
}
export async function requirePurchaseSafety(database: PurchaseDatabase): Promise<void> {
  const rows = await database.query(`select to_regclass('credit_accounts') is not null
    and to_regprocedure('hekla_guard_acceptance(uuid,text)') is not null
    and exists(select 1 from pg_trigger where tgrelid=to_regclass('store_credit_entries')
      and tgname='hekla_credit_balance' and not tgisinternal and tgenabled in ('O','A')) as ready`, []);
  if (rows[0]?.ready !== true) throw new PurchaseSafetyError('Purchase safety is not installed yet. An administrator must apply migration 0011 before saving purchases or redeeming credit.', 503);
}
