import { neon } from "@neondatabase/serverless";

export type Tenant = {
  id: string;
  clerkOrgId: string;
  name: string;
  airtableBaseId: string;
  airtableTableId: string;
  botWebhookUrl: string | null;
};

export type AuditAction = "create" | "merge" | "edit" | "delete";
export type AuditEntry = { tenantId: string; userId: string; action: AuditAction; recordId: string; snapshot?: unknown };

const TENANT_COLUMNS = "id, clerk_org_id, name, airtable_base_id, airtable_table_id, bot_webhook_url";
const CACHE_MS = 60_000;
const cache = new Map<string, { tenant: Tenant | null; at: number }>();

function db(env: Env) {
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
    AIRTABLE_BASE_ID: tenant.airtableBaseId,
    AIRTABLE_TABLE_ID: tenant.airtableTableId,
    HEKLA_WEBHOOK_URL: tenant.botWebhookUrl ?? undefined,
  } as Env;
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
