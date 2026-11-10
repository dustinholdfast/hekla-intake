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
      const rows = await sql.query(
        `update allocation_results set state = 'done', http_status = $4, result = $5::jsonb, claim_token = null, claimed_until = null
         where tenant_id = $1 and idempotency_key = $2 and claim_token = $3 and state = 'pending'
         returning idempotency_key`,
        [tenantId, key, token, httpStatus, JSON.stringify(body)],
      );
      return rows.length === 1;
    },
    async renew(tenantId, key, token, leaseSeconds) {
      const rows = await sql.query(
        `update allocation_results set claimed_until = now() + make_interval(secs => $4)
         where tenant_id = $1 and idempotency_key = $2 and claim_token = $3 and state = 'pending' and claimed_until > now()
         returning idempotency_key`,
        [tenantId, key, token, leaseSeconds],
      );
      return rows.length === 1;
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
    async renewRow(tenantId, recordId, holder, seconds) {
      const rows = await sql.query(
        `update allocation_row_locks set expires_at = now() + make_interval(secs => $4)
         where tenant_id = $1 and record_id = $2 and holder = $3 and expires_at > now() returning holder`,
        [tenantId, recordId, holder, seconds],
      );
      return rows.length === 1;
    },
    async rowUnresolved(tenantId, recordId, exceptKey) {
      const rows = await sql.query(
        `select 1 from allocation_results r
         where r.tenant_id = $1 and r.waitlist_record_id = $2 and r.idempotency_key <> $3 and r.state = 'pending'
           and exists (select 1 from jsonb_array_elements(coalesce(r.plan->'steps', '[]'::jsonb)) s where s ? 'attemptedAt' and not s ? 'done')
         limit 1`,
        [tenantId, recordId, exceptKey],
      );
      return rows.length > 0;
    },
    async saleLogged(tenantId, recordId, sinceIso) {
      const rows = await sql.query(
        `select 1 from sales where tenant_id = $1 and record_id = $2 and platform <> 'allocation'
           and (sold_at >= $3::timestamptz or created_at >= $3::timestamptz) limit 1`,
        [tenantId, recordId, sinceIso],
      );
      return rows.length > 0;
    },
    async unresolvedOnRow(tenantId, recordId, exceptKey) {
      const rows = await sql.query(
        `select r.idempotency_key, r.plan, (r.claimed_until is not null and r.claimed_until > now()) as lease_live
         from allocation_results r
         where r.tenant_id = $1 and r.waitlist_record_id = $2 and r.idempotency_key <> $3 and r.state = 'pending'
           and exists (select 1 from jsonb_array_elements(coalesce(r.plan->'steps', '[]'::jsonb)) s where s ? 'attemptedAt' and not s ? 'done')
         order by r.created_at`,
        [tenantId, recordId, exceptKey],
      );
      return rows.map((row) => ({ key: String(row.idempotency_key), plan: asJson<CtPlan>(row.plan), leaseLive: row.lease_live === true }));
    },
    async takeOver(tenantId, key, token, leaseSeconds) {
      const [row] = await sql.query(
        `update allocation_results set claim_token = $3, claimed_until = now() + make_interval(secs => $4)
         where tenant_id = $1 and idempotency_key = $2 and state = 'pending' and (claimed_until is null or claimed_until <= now())
         returning allocation_id, deck_id, op, waitlist_record_id, qty, order_id, line_key, plan`,
        [tenantId, key, token, leaseSeconds],
      );
      if (!row) return null;
      return {
        row: { allocationId: String(row.allocation_id), deckId: String(row.deck_id), op: String(row.op), recordId: String(row.waitlist_record_id), qty: Number(row.qty), orderId: text(row.order_id), lineKey: text(row.line_key) },
        plan: row.plan == null ? null : asJson<CtPlan>(row.plan),
      };
    },
    async staleRows(tenantId, attemptedBeforeIso, limit) {
      // An unanswered step (attemptedAt, no done) at or before the cutoff, on a pending key no request holds.
      const rows = await sql.query(
        `select r.waitlist_record_id, min((s->>'attemptedAt')::timestamptz) as oldest
         from allocation_results r
         cross join lateral jsonb_array_elements(coalesce(r.plan->'steps', '[]'::jsonb)) s
         where r.tenant_id = $1 and r.state = 'pending' and (r.claimed_until is null or r.claimed_until <= now())
           and s ? 'attemptedAt' and not s ? 'done' and (s->>'attemptedAt')::timestamptz <= $2::timestamptz
         group by r.waitlist_record_id
         order by oldest
         limit $3`,
        [tenantId, attemptedBeforeIso, limit],
      );
      return rows.map((row) => String(row.waitlist_record_id));
    },
    async unlockRow(tenantId, recordId, holder) {
      await sql.query("delete from allocation_row_locks where tenant_id = $1 and record_id = $2 and holder = $3", [tenantId, recordId, holder]);
    },
  };
}

/** One stored ct_retry_unverifiable on the admin alerts list. Fields from `unverified` are null on answers stored before it existed. */
export type AllocationAlertRow = {
  key: string;
  recordId: string;
  allocationId: string;
  deckId: string;
  direction: "reserve" | "release";
  listingId: number | null;
  from: number | null;
  expected: number | null;
  observed: number | null;
  attemptedAt: string | null;
  note: string;
  createdAt: string;
};

const ACK = "alloc_alert_ack:";
const num = (value: unknown): number | null => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

/**
 * The persistent owner alert list: every stored ct_retry_unverifiable (state done, so retry, expiry, admin clear and
 * sweep all land here) that no admin has marked checked. Marks live in sync_state, so no migration is needed.
 */
export function allocationAlertsWithQuery(query: AllocationQuery) {
  return {
    async open(tenantId: string, limit = 100): Promise<AllocationAlertRow[]> {
      const rows = await query(
        `select r.idempotency_key, r.waitlist_record_id, r.allocation_id, r.deck_id, r.op, r.result, r.created_at
         from allocation_results r
         where r.tenant_id = $1 and r.state = 'done' and r.result->>'error' = 'ct_retry_unverifiable'
           and not exists (select 1 from sync_state a where a.tenant_id = r.tenant_id and a.key = $2 || r.idempotency_key)
         order by r.created_at desc
         limit $3`,
        [tenantId, ACK, limit],
      );
      return rows.map((row) => {
        const body = asBody(row.result);
        const u = (body.unverified ?? {}) as Partial<NonNullable<AllocationResponse["unverified"]>>;
        return {
          key: String(row.idempotency_key), recordId: String(row.waitlist_record_id), allocationId: String(row.allocation_id), deckId: String(row.deck_id),
          direction: row.op === "release" ? "release" : "reserve",
          listingId: num(u.listing_id), from: num(u.from), expected: num(u.expected), observed: num(u.observed),
          attemptedAt: typeof u.attempted_at === "string" ? u.attempted_at : null,
          note: String(body.note ?? ""), createdAt: new Date(String(row.created_at)).toISOString(),
        };
      });
    },
    /** Marks one alert checked. false when the key has no stored ct_retry_unverifiable. Idempotent. */
    async ack(tenantId: string, key: string, by: string): Promise<boolean> {
      const rows = await query(
        `insert into sync_state (tenant_id, key, value)
         select r.tenant_id, $3 || r.idempotency_key, jsonb_build_object('by', $4::text, 'at', now())
         from allocation_results r
         where r.tenant_id = $1 and r.idempotency_key = $2 and r.state = 'done' and r.result->>'error' = 'ct_retry_unverifiable'
         on conflict (tenant_id, key) do update set value = sync_state.value
         returning key`,
        [tenantId, key, ACK, by],
      );
      return rows.length === 1;
    },
  };
}

export function neonAllocationAlerts(env: Env) {
  return allocationAlertsWithQuery((query, params) => db(env).query(query, params));
}
