/**
 * Neon storage for POST /api/allocations: one row per tenant and idempotency key (claimed, then finished), the
 * CardTrader plan saved with a claim, the last reserve price for a relist, and a lease per Waitlist row.
 */
import type { AllocationResponse, AllocationStore, Claim, ClaimRow, CtPlan, StoredAllocation } from "./allocations.ts";
import { db } from "./tenants.ts";

type Row = Record<string, unknown>;
export type AllocationQuery = (query: string, params: unknown[]) => Promise<Row[]>;

function asJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function asBody(value: unknown): AllocationResponse {
  const parsed = asJson<unknown>(value);
  if (!parsed || typeof parsed !== "object") throw new Error("Stored allocation result is not an object.");
  return parsed as AllocationResponse;
}

const text = (value: unknown): string | null => (value == null ? null : String(value));

function toStored(row: Row): StoredAllocation {
  return {
    httpStatus: Number(row.http_status),
    body: asBody(row.result),
    allocationId: String(row.allocation_id),
    deckId: String(row.deck_id),
    op: String(row.op),
    recordId: String(row.waitlist_record_id),
    qty: Number(row.qty),
    orderId: text(row.order_id),
    lineKey: text(row.line_key),
  };
}

function sameRequest(row: Row, want: ClaimRow): boolean {
  return String(row.allocation_id) === want.allocationId && String(row.deck_id) === want.deckId && String(row.op) === want.op
    && String(row.waitlist_record_id) === want.recordId && Number(row.qty) === want.qty
    && text(row.order_id) === want.orderId && text(row.line_key) === want.lineKey;
}

export function neonAllocationStore(env: Env): AllocationStore {
  return allocationStoreWithQuery((query, params) => db(env).query(query, params));
}

/** Query injection lets the production SQL be checked against an isolated Postgres engine. */
export function allocationStoreWithQuery(query: AllocationQuery): AllocationStore {
  const sql = { query };
  return {
    async claim(tenantId, key, row, token, leaseSeconds): Promise<Claim> {
      // Insert a pending claim, or take over a pending one whose lease ran out, for the same request only.
      const claimed = await sql.query(
        `insert into allocation_results (tenant_id, idempotency_key, allocation_id, deck_id, op, waitlist_record_id, qty, order_id, line_key, state, claim_token, claimed_until)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, now() + make_interval(secs => $11))
         on conflict (tenant_id, idempotency_key) do update set claim_token = excluded.claim_token, claimed_until = excluded.claimed_until
           where allocation_results.state = 'pending' and allocation_results.claimed_until <= now()
             and allocation_results.allocation_id = excluded.allocation_id and allocation_results.deck_id = excluded.deck_id
             and allocation_results.op = excluded.op and allocation_results.waitlist_record_id = excluded.waitlist_record_id
             and allocation_results.qty = excluded.qty
             and allocation_results.order_id is not distinct from excluded.order_id
             and allocation_results.line_key is not distinct from excluded.line_key
         returning plan`,
        [tenantId, key, row.allocationId, row.deckId, row.op, row.recordId, row.qty, row.orderId, row.lineKey, token, leaseSeconds],
      );
      if (claimed[0]) return { kind: "claimed", plan: claimed[0].plan == null ? null : asJson<CtPlan>(claimed[0].plan) };
      const [existing] = await sql.query(
        `select state, http_status, result, allocation_id, deck_id, op, waitlist_record_id, qty, order_id, line_key
         from allocation_results where tenant_id = $1 and idempotency_key = $2`,
        [tenantId, key],
      );
      if (!existing) return { kind: "busy" };
      if (!sameRequest(existing, row)) return { kind: "mismatch" };
      if (existing.state === "done") return { kind: "done", stored: toStored(existing) };
      return { kind: "busy" };
    },
    async savePlan(tenantId, key, token, plan) {
      const rows = await sql.query(
        `update allocation_results set plan = $4::jsonb where tenant_id = $1 and idempotency_key = $2 and claim_token = $3 and state = 'pending' returning idempotency_key`,
        [tenantId, key, token, JSON.stringify(plan)],
      );
      if (rows.length === 0) throw new Error("Allocation claim was lost before the plan was saved.");
    },
    async finish(tenantId, key, token, httpStatus, body) {
      await sql.query(
        `update allocation_results set state = 'done', http_status = $4, result = $5::jsonb, claim_token = null, claimed_until = null
         where tenant_id = $1 and idempotency_key = $2 and claim_token = $3 and state = 'pending'`,
        [tenantId, key, token, httpStatus, JSON.stringify(body)],
      );
    },
    async abandon(tenantId, key, token) {
      await sql.query(
        `update allocation_results set claim_token = null, claimed_until = now() - interval '1 second'
         where tenant_id = $1 and idempotency_key = $2 and claim_token = $3 and state = 'pending'`,
        [tenantId, key, token],
      );
    },
    async reservePrice(tenantId, allocationId) {
      const rows = await sql.query(
        `select result->>'ct_price_cents' as cents
         from allocation_results
         where tenant_id = $1 and allocation_id = $2 and op = 'reserve' and state = 'done' and (result->>'ct_price_cents') is not null
         order by created_at desc limit 1`,
        [tenantId, allocationId],
      );
      const cents = rows[0] ? Number(rows[0].cents) : NaN;
      return Number.isInteger(cents) && cents > 0 ? cents : null;
    },
    async lockRow(tenantId, recordId, holder, seconds) {
      const rows = await sql.query(
        `insert into allocation_row_locks (tenant_id, record_id, holder, expires_at) values ($1, $2, $3, now() + make_interval(secs => $4))
         on conflict (tenant_id, record_id) do update set holder = excluded.holder, expires_at = excluded.expires_at
           where allocation_row_locks.expires_at <= now() or allocation_row_locks.holder = excluded.holder
         returning holder`,
        [tenantId, recordId, holder, seconds],
      );
      return rows[0]?.holder === holder;
    },
    async unlockRow(tenantId, recordId, holder) {
      await sql.query("delete from allocation_row_locks where tenant_id = $1 and record_id = $2 and holder = $3", [tenantId, recordId, holder]);
    },
  };
}
