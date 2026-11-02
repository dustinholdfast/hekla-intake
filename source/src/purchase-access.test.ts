import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purchasesAllowed } from './purchase-access.ts';
import { WAITLIST_BASE_ID, WAITLIST_TABLE_ID } from './inventory.ts';
import { draftRedemption } from './purchases.ts';

test('fixed purchase tables require both the original organization and the exact inventory configuration', () => {
  const original = { clerkOrgId: 'org_3KYI7xB6yJInWU8sf5KbJ6x3mZx', airtableBaseId: WAITLIST_BASE_ID, airtableTableId: WAITLIST_TABLE_ID };
  assert.equal(purchasesAllowed(original), true);
  for (const patch of [{clerkOrgId:'org_other'}, {airtableBaseId:'app_other'}, {airtableTableId:'tbl_other'}]) {
    assert.equal(purchasesAllowed({...original,...patch}), false);
  }
});

test('redemption drafts validate dates and database integer bounds without authorizing a balance', () => {
  const input = { tenantId:'tenant',customerRef:'recSRPhase3Ex0012',amountCents:100,sourceRef:'order-1',occurredOn:'2026-11-02',now:'2026-11-02T12:00:00Z' };
  assert.equal(draftRedemption(input).ok, true);
  for (const amountCents of [0,-1,0.1,Infinity,NaN,2147483648,Number.MAX_SAFE_INTEGER+1]) assert.equal(draftRedemption({...input,amountCents}).ok,false);
  for (const occurredOn of ['2026-02-30','2026-13-01','yesterday','2026-1-1']) assert.equal(draftRedemption({...input,occurredOn}).ok,false);
});
