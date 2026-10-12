import { neon } from "@neondatabase/serverless";

export type Tenant = {
  id: string;
  clerkOrgId: string;
  name: string;
  airtableBaseId: string;
  airtableTableId: string;
  botWebhookUrl: string | null;
  plan: Plan;
};

export type Plan = "free" | "pro";
export type TenantPlan = {
  id: string;
  name: string;
  clerkOrgId: string;
  plan: Plan;
  planSource: "comp" | "paid" | null;
  planChangedBy: string | null;
  planChangedAt: string | null;
  planNote: string | null;
  createdAt: string;
};

export type AuditAction = "create" | "merge" | "edit" | "delete" | "connect" | "disconnect" | "list";
export type AuditEntry = { tenantId: string; userId: string; action: AuditAction; recordId: string; snapshot?: unknown };

const TENANT_COLUMNS = "id, clerk_org_id, name, airtable_base_id, airtable_table_id, bot_webhook_url, plan";
const PLAN_COLUMNS = "id, name, clerk_org_id, plan, plan_source, plan_changed_by, plan_changed_at, plan_note, created_at";
const CACHE_MS = 60_000;
const cache = new Map<string, { tenant: Tenant | null; at: number }>();

export function db(env: Env) {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set.");
  return neon(url);
}

export function toTenant(row: Record<string, unknown>): Tenant {
  return {
    id: String(row.id),
    clerkOrgId: String(row.clerk_org_id),
    name: String(row.name),
    airtableBaseId: String(row.airtable_base_id),
    airtableTableId: String(row.airtable_table_id),
    botWebhookUrl: typeof row.bot_webhook_url === "string" ? row.bot_webhook_url : null,
    plan: row.plan === "pro" ? "pro" : "free",
  };
}

const text = (value: unknown): string | null => (value == null ? null : String(value));
const time = (value: unknown): string | null => (value == null ? null : new Date(value as string).toISOString());

export function toTenantPlan(row: Record<string, unknown>): TenantPlan {
  return {
    id: String(row.id),
    name: String(row.name),
    clerkOrgId: String(row.clerk_org_id),
    plan: row.plan === "pro" ? "pro" : "free",
    planSource: row.plan_source === "comp" || row.plan_source === "paid" ? row.plan_source : null,
    planChangedBy: text(row.plan_changed_by),
    planChangedAt: time(row.plan_changed_at),
    planNote: text(row.plan_note),
    createdAt: time(row.created_at) ?? "",
  };
}

/** The tenant for a Clerk Organization, or null when that organization has no tenant row. */
export async function tenantForOrg(env: Env, orgId: string): Promise<Tenant | null> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.tenant;
  const rows = await db(env).query(`select ${TENANT_COLUMNS} from tenants where clerk_org_id = $1`, [orgId]);
  const tenant = rows[0] ? toTenant(rows[0]) : null;
  cache.set(orgId, { tenant, at: Date.now() });
  return tenant;
}

export async function listTenants(env: Env): Promise<Tenant[]> {
  const rows = await db(env).query(`select ${TENANT_COLUMNS} from tenants order by created_at`);
  return rows.map(toTenant);
}

/**
 * The env the Airtable and enrichment code sees for one tenant. The base, table and bot webhook
 * come from the tenant row, never from the Worker's own vars, so one tenant cannot reach another's.
 */
export function tenantEnv(env: Env, tenant: Tenant): Env {
  return {
    ...env,
    TENANT_ID: tenant.id,
    AIRTABLE_BASE_ID: tenant.airtableBaseId,
    AIRTABLE_TABLE_ID: tenant.airtableTableId,
    HEKLA_WEBHOOK_URL: tenant.botWebhookUrl ?? undefined,
  } as Env;
}

/** Every tenant with its plan, for the platform admin screen. */
export async function listTenantPlans(env: Env): Promise<TenantPlan[]> {
  const rows = await db(env).query(`select ${PLAN_COLUMNS} from tenants order by name`);
  return rows.map(toTenantPlan);
}

/**
 * Grants or removes complimentary Pro. A paid plan is never touched here, so removing a comp
 * can't cancel something a seller is paying for. Returns null when no tenant was changed.
 */
export async function setCompPlan(env: Env, tenantId: string, plan: Plan, adminUserId: string, note: string | null): Promise<TenantPlan | null> {
  const rows = await db(env).query(
    `update tenants
     set plan = $2, plan_source = case when $2 = 'pro' then 'comp' end, plan_changed_by = $3, plan_changed_at = now(), plan_note = $4
     where id = $1 and plan_source is distinct from 'paid'
     returning ${PLAN_COLUMNS}`,
    [tenantId, plan, adminUserId, note],
  );
  if (!rows[0]) return null;
  const changed = toTenantPlan(rows[0]);
  cache.delete(changed.clerkOrgId);
  return changed;
}

export async function recordAudit(env: Env, entries: AuditEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const rows = entries.map((e) => ({ tenant_id: e.tenantId, clerk_user_id: e.userId, action: e.action, record_id: e.recordId, snapshot: e.snapshot ?? null }));
  await db(env).query(
    `insert into audit_log (tenant_id, clerk_user_id, action, record_id, snapshot)
     select tenant_id, clerk_user_id, action, record_id, snapshot
     from jsonb_to_recordset($1::jsonb) as x(tenant_id uuid, clerk_user_id text, action text, record_id text, snapshot jsonb)`,
    [JSON.stringify(rows)],
  );
}
