import { test } from "node:test";
import assert from "node:assert/strict";
import { authConfigured, clerkFrontendApi, contentSecurityPolicy, isPlatformAdmin } from "./auth.ts";
import { tenantEnv, toTenant, toTenantPlan } from "./tenants.ts";

const key = (host: string) => `pk_test_${btoa(`${host}$`)}`;
const env = (over: Record<string, unknown>) => over as unknown as Env;

test("clerk frontend api host is read from the publishable key", () => {
  assert.equal(clerkFrontendApi(key("calm-fox-12.clerk.accounts.dev")), "calm-fox-12.clerk.accounts.dev");
  assert.equal(clerkFrontendApi("pk_live_" + btoa("clerk.example.com$")), "clerk.example.com");
});
test("clerk frontend api rejects anything that is not a plain host", () => {
  for (const bad of [undefined, "", "sk_test_abc", "pk_test_!!!", "pk_test_" + btoa("no-dollar.dev"), key("evil.dev/x"), key("a.dev https://evil.dev")]) {
    assert.equal(clerkFrontendApi(bad), null);
  }
});
test("auth needs the publishable key, the secret key and the database", () => {
  const full = { CLERK_PUBLISHABLE_KEY: key("a.clerk.accounts.dev"), CLERK_SECRET_KEY: "x", DATABASE_URL: "postgres://x" };
  assert.equal(authConfigured(env(full)), true);
  for (const missing of Object.keys(full)) assert.equal(authConfigured(env({ ...full, [missing]: " " })), false);
});
test("csp stays strict without clerk and only opens the clerk host with it", () => {
  const strict = contentSecurityPolicy(env({}), ["https://img.example"]);
  assert.equal(strict, "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: https://img.example; connect-src 'self'; base-uri 'none'; form-action 'self'");
  const open = contentSecurityPolicy(env({ CLERK_PUBLISHABLE_KEY: key("a.clerk.accounts.dev") }), ["https://img.example"]);
  assert.match(open, /script-src 'self' https:\/\/a\.clerk\.accounts\.dev https:\/\/challenges\.cloudflare\.com https:\/\/\*\.protect\.clerk\.com;/);
  assert.match(open, /connect-src 'self' https:\/\/a\.clerk\.accounts\.dev https:\/\/\*\.protect\.clerk\.com:\* https:\/\/clerk-telemetry\.com;/);
  assert.doesNotMatch(open, /script-src[^;]*'unsafe-inline'/);
});
test("tenant env takes base, table and webhook from the tenant, never from the worker", () => {
  const tenant = toTenant({ id: "t1", clerk_org_id: "org_1", name: "Shop", airtable_base_id: "appTenant", airtable_table_id: "tblTenant", bot_webhook_url: null });
  const scoped = tenantEnv(env({ AIRTABLE_BASE_ID: "appOther", AIRTABLE_TABLE_ID: "tblOther", HEKLA_WEBHOOK_URL: "https://other.example", AIRTABLE_API_KEY: "k" }), tenant);
  assert.equal(scoped.AIRTABLE_BASE_ID, "appTenant");
  assert.equal(scoped.AIRTABLE_TABLE_ID, "tblTenant");
  assert.equal(scoped.HEKLA_WEBHOOK_URL, undefined);
  assert.equal(scoped.AIRTABLE_API_KEY, "k");
});
test("platform admin is an exact match against the configured user ids", () => {
  const e = env({ PLATFORM_ADMIN_USER_IDS: "user_a, user_b" });
  assert.equal(isPlatformAdmin(e, "user_a"), true);
  assert.equal(isPlatformAdmin(e, "user_b"), true);
  for (const no of ["user_c", "user_", "", null, undefined, "user_a, user_b"]) assert.equal(isPlatformAdmin(e, no), false);
  assert.equal(isPlatformAdmin(env({}), "user_a"), false);
  assert.equal(isPlatformAdmin(env({ PLATFORM_ADMIN_USER_IDS: "" }), ""), false);
});
test("a tenant is free unless its row says pro, and comp is kept apart from paid", () => {
  const row = { id: "t1", clerk_org_id: "org_1", name: "Shop", airtable_base_id: "a", airtable_table_id: "t", bot_webhook_url: null, created_at: "2026-10-11T00:00:00Z" };
  assert.equal(toTenant(row).plan, "free");
  assert.equal(toTenant({ ...row, plan: "pro" }).plan, "pro");
  assert.equal(toTenant({ ...row, plan: "enterprise" }).plan, "free");
  const comp = toTenantPlan({ ...row, plan: "pro", plan_source: "comp", plan_changed_by: "user_a", plan_changed_at: "2026-10-11T12:00:00Z", plan_note: "launch partner" });
  assert.deepEqual([comp.plan, comp.planSource, comp.planChangedBy, comp.planNote], ["pro", "comp", "user_a", "launch partner"]);
  assert.equal(toTenantPlan(row).planSource, null);
});
