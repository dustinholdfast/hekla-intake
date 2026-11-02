/** Neon-backed storage for the sales log, stock leases and per-tenant sync state. */
import type { PendingDecrement, Platform, SaleRow, SalesFilter, SaleStore } from "./sales.ts";
import { db } from "./tenants.ts";

type Row = Record<string, unknown>;
const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
const num = (v: unknown): number | null => (v == null ? null : Number(v));

export type SaleQuery = (query: string, params: unknown[]) => Promise<Row[]>;
const PENDING_COLUMNS = `s.id, s.record_id, s.qty, s.platform, s.external_order_id, s.order_code, s.card_name,
  s.qty_before, s.qty_target, s.decrement_started_at`;
function pendingRow(r: Row): PendingDecrement {
  return { id: Number(r.id), recordId: String(r.record_id), qty: Number(r.qty), platform: r.platform as Platform,
    externalOrderId: String(r.external_order_id), orderCode: (r.order_code as string) ?? null, cardName: (r.card_name as string) ?? null,
    qtyBefore: num(r.qty_before), qtyTarget: num(r.qty_target), started: r.decrement_started_at != null };
}
export function neonSaleStore(env: Env): SaleStore {
  return saleStoreWithQuery((query, params) => db(env).query(query, params));
}
/** Query injection allows the production SQL transitions to be checked against an isolated Postgres engine. */
export function saleStoreWithQuery(query: SaleQuery): SaleStore {
  const sql = { query };
  return {
    async insertLines(tenantId, lines) {
      if (lines.length === 0) return 0;
      const rows = lines.map((l) => ({
        tenant_id: tenantId, platform: l.platform, external_order_id: l.externalOrderId, order_code: l.orderCode, line_key: l.lineKey,
        record_id: l.recordId, game: l.game, card_name: l.cardName, qty: l.qty, currency: l.currency, gross_cents: l.grossCents,
        fee_cents: l.feeCents, net_cents: l.netCents, sold_at: l.soldAt, order_state: l.orderState, decrement_owner: l.decrementOwner, raw: l.raw ?? {},
      }));
      const inserted = await sql.query(
        `insert into sales (tenant_id, platform, external_order_id, order_code, line_key, record_id, game, card_name, qty, currency,
                            gross_cents, fee_cents, net_cents, sold_at, order_state, decrement_owner, raw)
         select tenant_id, platform, external_order_id, order_code, line_key, record_id, game, card_name, qty, currency,
                gross_cents, fee_cents, net_cents, sold_at, order_state, decrement_owner, raw
         from jsonb_to_recordset($1::jsonb) as x(tenant_id uuid, platform text, external_order_id text, order_code text, line_key text,
              record_id text, game text, card_name text, qty integer, currency text, gross_cents integer, fee_cents integer,
              net_cents integer, sold_at timestamptz, order_state text, decrement_owner text, raw jsonb)
         on conflict (tenant_id, platform, external_order_id, line_key) do update set order_state = excluded.order_state
           where sales.order_state is distinct from excluded.order_state
         returning (xmax = 0) as inserted`,
        [JSON.stringify(rows)],
      );
      return inserted.filter((r) => r.inserted === true).length;
    },
    async markCancelled(tenantId, platform, externalOrderId, at, state) {
      const rows = await sql.query(
        `update sales set cancelled_at = $4, order_state = $5,
           needs_review = case when decrement_owner = 'hekla' and decrement_started_at is not null
             then 'Cancelled during or after a stock update. Check the sale and Qty before restocking.' else needs_review end
         where tenant_id = $1 and platform = $2 and external_order_id = $3 and cancelled_at is null
         returning id, record_id, qty, card_name, decrement_owner, decrement_started_at`,
        [tenantId, platform, externalOrderId, at, state],
      );
      return rows.filter((r) => r.decrement_owner === "hekla" && r.decrement_started_at != null).map((r) => ({ id: Number(r.id), recordId: (r.record_id as string) ?? null, qty: Number(r.qty), cardName: (r.card_name as string) ?? null }));
    },
    async pendingDecrements(tenantId, limit) {
      const rows = await sql.query(
        `select id, record_id, qty, platform, external_order_id, order_code, card_name, qty_before, qty_target, decrement_started_at
         from sales
         where tenant_id = $1 and decrement_owner = 'hekla' and decremented_at is null and cancelled_at is null
           and needs_review is null and record_id is not null
         order by sold_at, id limit $2`,
        [tenantId, limit],
      );
      return rows.map(pendingRow);
    },
    async pendingDecrement(scope, id) {
      const rows = await sql.query(`select ${PENDING_COLUMNS} from sales s join stock_locks l
        on l.tenant_id = s.tenant_id and l.record_id = s.record_id
        where s.tenant_id = $1 and s.record_id = $2 and s.id = $3 and l.holder = $4 and l.expires_at > now()
          and s.decrement_owner = 'hekla' and s.decremented_at is null and s.cancelled_at is null and s.needs_review is null`,
        [scope.tenantId, scope.recordId, id, scope.holder]);
      return rows[0] ? pendingRow(rows[0]) : null;
    },
    async startDecrement(scope, id, before, target) {
      const rows = await sql.query(`with lease as (
        update stock_locks set expires_at = now() + interval '60 seconds'
        where tenant_id = $1 and record_id = $2 and holder = $4 and expires_at > now() returning tenant_id, record_id
      ) update sales s set decrement_started_at = coalesce(s.decrement_started_at, now()), qty_before = $5, qty_target = $6
        from lease l where s.tenant_id = l.tenant_id and s.record_id = l.record_id and s.id = $3
          and s.decrement_owner = 'hekla' and s.decremented_at is null and s.cancelled_at is null and s.needs_review is null
          and (s.decrement_started_at is null or (s.qty_before = $5 and s.qty_target = $6))
          and not exists (select 1 from sales other where other.tenant_id = s.tenant_id and other.record_id = s.record_id
            and other.id <> s.id and other.decrement_owner = 'hekla' and other.decrement_started_at is not null and other.decremented_at is null)
        returning s.id`, [scope.tenantId, scope.recordId, id, scope.holder, before, target]);
      return rows.length > 0;
    },
    async finishDecrement(scope, id, oversold, review) {
      const rows = await sql.query(`update sales s set decremented_at = now(), oversold = $5, needs_review = $6
        from stock_locks l where s.tenant_id = $1 and s.record_id = $2 and s.id = $3
          and l.tenant_id = s.tenant_id and l.record_id = s.record_id and l.holder = $4 and l.expires_at > now()
          and s.decrement_owner = 'hekla' and s.decrement_started_at is not null
          and s.decremented_at is null and s.cancelled_at is null and s.needs_review is null returning s.id`,
        [scope.tenantId, scope.recordId, id, scope.holder, oversold, review]);
      return rows.length > 0;
    },
    async flag(scope, id, review) {
      const rows = await sql.query(`update sales s set needs_review = $5 from stock_locks l
        where s.tenant_id = $1 and s.record_id = $2 and s.id = $3 and s.decrement_owner = 'hekla' and s.decremented_at is null
          and l.tenant_id = s.tenant_id and l.record_id = s.record_id and l.holder = $4 and l.expires_at > now()
        returning s.id`, [scope.tenantId, scope.recordId, id, scope.holder, review]);
      return rows.length > 0;
    },
    async acquireLock(tenantId, recordId, holder, seconds) {
      // A timed-out lease with a persisted plan can still have an external request in flight.
      // Mark that uncertainty for operators; do not give another worker permission to overwrite it.
      await sql.query(`update sales s set needs_review = coalesce(s.needs_review, 'Stock lease expired during an unfinished update. Check Airtable and the sale before clearing review.')
        from stock_locks l where s.tenant_id = $1 and s.record_id = $2 and l.tenant_id = s.tenant_id and l.record_id = s.record_id
          and l.expires_at <= now() and s.decrement_owner = 'hekla' and s.decrement_started_at is not null and s.decremented_at is null`, [tenantId, recordId]);
      const rows = await sql.query(
        `insert into stock_locks (tenant_id, record_id, holder, expires_at) values ($1, $2, $3, now() + make_interval(secs => $4))
         on conflict (tenant_id, record_id) do update set holder = excluded.holder, expires_at = excluded.expires_at
           where (stock_locks.expires_at > now() and stock_locks.holder = excluded.holder)
             or (stock_locks.expires_at <= now() and not exists (
               select 1 from sales s where s.tenant_id = $1 and s.record_id = $2 and s.decrement_owner = 'hekla'
                 and s.decrement_started_at is not null and s.decremented_at is null))
         returning holder`,
        [tenantId, recordId, holder, seconds],
      );
      return rows[0]?.holder === holder;
    },
    async releaseLock(tenantId, recordId, holder) {
      await sql.query("delete from stock_locks where tenant_id = $1 and record_id = $2 and holder = $3", [tenantId, recordId, holder]);
    },
  };
}

const SALE_COLUMNS = `id, platform, external_order_id, order_code, line_key, record_id, game, card_name, qty, currency, gross_cents, fee_cents,
  net_cents, sold_at, order_state, cancelled_at, decrement_owner, decremented_at, oversold, needs_review`;

function toSaleRow(r: Row): SaleRow {
  return {
    id: Number(r.id), platform: r.platform as Platform, externalOrderId: String(r.external_order_id), orderCode: (r.order_code as string) ?? null,
    lineKey: String(r.line_key), recordId: (r.record_id as string) ?? null, game: (r.game as string) ?? null, cardName: (r.card_name as string) ?? null,
    qty: Number(r.qty), currency: String(r.currency), grossCents: Number(r.gross_cents), feeCents: num(r.fee_cents), netCents: num(r.net_cents),
    soldAt: iso(r.sold_at) ?? "", orderState: (r.order_state as string) ?? null, cancelledAt: iso(r.cancelled_at),
    decrementOwner: r.decrement_owner as SaleRow["decrementOwner"], decrementedAt: iso(r.decremented_at), oversold: r.oversold === true, needsReview: (r.needs_review as string) ?? null,
  };
}

/** Sales for the page and the CSV. Day bounds are whole days in America/New_York. */
export async function listSales(env: Env, tenantId: string, f: SalesFilter, limit: number): Promise<{ rows: SaleRow[]; truncated: boolean }> {
  const where = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];
  const add = (clause: string, value: unknown) => { params.push(value); where.push(clause.replace("?", `$${params.length}`)); };
  if (f.platform) add("platform = ?", f.platform);
  if (f.from) add("sold_at >= (?::date)::timestamp at time zone 'America/New_York'", f.from);
  if (f.to) add("sold_at < ((?::date) + 1)::timestamp at time zone 'America/New_York'", f.to);
  if (f.game) add("game = ?", f.game);
  if (f.q) add("card_name ilike ?", `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  if (!f.includeCancelled) where.push("cancelled_at is null");
  params.push(limit + 1);
  const rows = await db(env).query(`select ${SALE_COLUMNS} from sales where ${where.join(" and ")} order by sold_at desc, id desc limit $${params.length}`, params);
  return { rows: rows.slice(0, limit).map(toSaleRow), truncated: rows.length > limit };
}

/** Non-cancelled sales since a moment, for the TCGplayer pull list. */
export async function salesSince(env: Env, tenantId: string, since: string): Promise<SaleRow[]> {
  const rows = await db(env).query(`select ${SALE_COLUMNS} from sales where tenant_id = $1 and sold_at >= $2 and cancelled_at is null order by sold_at`, [tenantId, since]);
  return rows.map(toSaleRow);
}

export async function getState<T>(env: Env, tenantId: string, key: string): Promise<T | null> {
  const rows = await db(env).query("select value from sync_state where tenant_id = $1 and key = $2", [tenantId, key]);
  return rows[0] ? (rows[0].value as T) : null;
}
export async function setState(env: Env, tenantId: string, key: string, value: unknown): Promise<void> {
  await db(env).query(
    `insert into sync_state (tenant_id, key, value, updated_at) values ($1, $2, $3::jsonb, now())
     on conflict (tenant_id, key) do update set value = excluded.value, updated_at = now()`,
    [tenantId, key, JSON.stringify(value)],
  );
}
/** True the first time a key is seen for a tenant: used so one problem sends one email. */
export async function firstTime(env: Env, tenantId: string, key: string): Promise<boolean> {
  const rows = await db(env).query(
    `insert into sync_state (tenant_id, key, value) values ($1, $2, '{}'::jsonb) on conflict (tenant_id, key) do nothing returning key`,
    [tenantId, `alerted:${key}`],
  );
  return rows.length > 0;
}
export async function forgetAlert(env: Env, tenantId: string, key: string): Promise<void> {
  await db(env).query("delete from sync_state where tenant_id = $1 and key = $2", [tenantId, `alerted:${key}`]);
}
