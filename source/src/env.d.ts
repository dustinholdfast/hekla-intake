/** Secrets and sign-in settings. Each tenant's Airtable base and table live in Neon (see src/tenants.ts). */
interface Env {
  /** Never Worker vars: tenantEnv() fills these from the signed-in tenant's row. */
  AIRTABLE_BASE_ID: string;
  AIRTABLE_TABLE_ID: string;
  AIRTABLE_API_KEY?: string;
  AIRTABLE_PAT?: string;
  HEKLA_WEBHOOK_URL?: string;
  GEMINI_API_KEY?: string;
  CLERK_SECRET_KEY?: string;
  DATABASE_URL?: string;
}
