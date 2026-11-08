/** Secrets and sign-in settings. Each tenant's Airtable base and table live in Neon (see src/tenants.ts). */
interface Env {
  /** Never Worker vars: tenantEnv() fills these from the signed-in tenant's row. */
  AIRTABLE_BASE_ID: string;
  TENANT_ID?: string;
  AIRTABLE_TABLE_ID: string;
  AIRTABLE_API_KEY?: string;
  AIRTABLE_PAT?: string;
  HEKLA_WEBHOOK_URL?: string;
  GEMINI_API_KEY?: string;
  CLERK_SECRET_KEY?: string;
  DATABASE_URL?: string;
  /** Encrypts each tenant's connection tokens before they are stored in Neon. */
  CONNECTIONS_KEY?: string;
  /** Deployed version (wrangler.toml [version_metadata]); cache-busts static assets. */
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
  /** "on" / "true" / "1" opens POST /api/allocations. Unset or anything else answers 503. */
  ALLOCATIONS_ENABLED?: string;
  /** wrangler secret. Signs X-Alloc-Signature. Never a [vars] entry. */
  ALLOCATION_HMAC_SECRET?: string;
}
