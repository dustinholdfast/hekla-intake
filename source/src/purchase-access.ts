import type { Tenant } from './tenants.ts';
import { WAITLIST_BASE_ID, WAITLIST_TABLE_ID } from './inventory.ts';

/** Purchasing currently uses the original shop's fixed tables. Fail closed for every other organization. */
export function purchasesAllowed(tenant: Pick<Tenant, 'clerkOrgId' | 'airtableBaseId' | 'airtableTableId'>): boolean {
  return tenant.clerkOrgId === 'org_3KYI7xB6yJInWU8sf5KbJ6x3mZx'
    && tenant.airtableBaseId === WAITLIST_BASE_ID && tenant.airtableTableId === WAITLIST_TABLE_ID;
}
