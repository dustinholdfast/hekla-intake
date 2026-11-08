/** Neon storage for POST /api/allocations idempotency. One row per tenant and key. */
import type { AllocationResponse, AllocationStore, StoredAllocation } from "./allocations.ts";
import { db } from "./tenants.ts";

type Row = Record<string, unknown>;
export type AllocationQuery = (query: string, params: unknown[]) => Promise<Row[]>;

function asBody(value: unknown): AllocationResponse {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object") throw new Error("Stored allocation result is not an object.");
  return parsed as AllocationResponse;
}

function toStored(row: Row): StoredAllocation {
  return {
    httpStatus: Number(row.http_status),
    body: asBody(row.result),
    allocationId: String(row.allocation_id),
    deckId: String(row.deck_id),
    op: String(row.op),
    recordId: String(row.waitlist_record_id),
    qty: Number(row.qty),
  };
}

export function neonAllocationStore(env: Env): AllocationStore {
  return allocationStoreWithQuery((query, params) => db(env).query(query, params));
}

/** Query injection lets the production SQL be checked against an isolated Postgres engine. */
export function allocationStoreWithQuery(query: AllocationQuery): AllocationStore {
  const sql = { query };
  return {
    async get(tenantId, key) {
      const rows = await sql.query(
        `select http_status, result, allocation_id, deck_id, op, waitlist_record_id, qty
         from allocation_results where tenant_id = $1 and idempotency_key = $2`,
        [tenantId, key],
      );
      return rows[0] ? toStored(rows[0]) : null;
    },
    async put(tenantId, key, row) {
      const inserted = await sql.query(
        `insert into allocation_results (tenant_id, idempotency_key, allocation_id, deck_id, op, waitlist_record_id, qty, http_status, result)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         on conflict (tenant_id, idempotency_key) do nothing
         returning idempotency_key`,
        [tenantId, key, row.allocationId, row.deckId, row.op, row.recordId, row.qty, row.httpStatus, JSON.stringify(row.body)],
      );
      return inserted.length > 0 ? "stored" : "exists";
    },
  };
}
