import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanToken, connectionsReady, openSecret, sealSecret, verifyCardTrader } from "./connections.ts";

const env = (over: Record<string, unknown>) => over as unknown as Env;
const keyed = env({ CONNECTIONS_KEY: "test-key-one" });
const tenantA = "11111111-1111-1111-1111-111111111111";
const tenantB = "22222222-2222-2222-2222-222222222222";

test("a sealed token opens only for the same tenant, provider and key", async () => {
  const sealed = await sealSecret(keyed, tenantA, "cardtrader", "tok_abcdefghijklmnopqrstuvwxyz");
  assert.equal(sealed.ciphertext.includes("tok_"), false);
  assert.equal(await openSecret(keyed, tenantA, "cardtrader", sealed), "tok_abcdefghijklmnopqrstuvwxyz");
  await assert.rejects(openSecret(keyed, tenantB, "cardtrader", sealed));
  await assert.rejects(openSecret(env({ CONNECTIONS_KEY: "another-key" }), tenantA, "cardtrader", sealed));
  const again = await sealSecret(keyed, tenantA, "cardtrader", "tok_abcdefghijklmnopqrstuvwxyz");
  assert.notEqual(again.ciphertext, sealed.ciphertext);
});
test("connections refuse to work without the encryption key", async () => {
  assert.equal(connectionsReady(env({})), false);
  assert.equal(connectionsReady(keyed), true);
  await assert.rejects(sealSecret(env({}), tenantA, "cardtrader", "tok_abcdefghijklmnopqrstuvwxyz"), /CONNECTIONS_KEY/);
});
test("only a plausible single-line token is accepted", () => {
  assert.equal(cleanToken("  eyJhbGciOiJSUzI1NiJ9.abcdefghij  "), "eyJhbGciOiJSUzI1NiJ9.abcdefghij");
  for (const bad of [undefined, null, 42, "", "short", "has a space in the middle of it", "line\nbreak-in-the-token-value"]) assert.equal(cleanToken(bad), null);
});
test("cardtrader verification reports the account and never the shared secret", async () => {
  const seen: string[] = [];
  const ok = await verifyCardTrader("tok_abcdefghijklmnopqrstuvwxyz", (async (url: string, init: RequestInit) => {
    seen.push(String(url), String((init.headers as Record<string, string>).authorization));
    return new Response(JSON.stringify({ id: 1, name: "My Shop", user_id: 606904, shared_secret: "do-not-keep" }), { status: 200 });
  }) as never);
  assert.deepEqual(ok, { ok: true, accountLabel: "My Shop", accountId: "606904" });
  assert.deepEqual(seen, ["https://api.cardtrader.com/api/v2/info", "Bearer tok_abcdefghijklmnopqrstuvwxyz"]);
  assert.equal(JSON.stringify(ok).includes("do-not-keep"), false);
  const rejected = await verifyCardTrader("tok_abcdefghijklmnopqrstuvwxyz", (async () => new Response("no", { status: 401 })) as never);
  assert.deepEqual(rejected, { ok: false, error: "CardTrader did not accept that token." });
  const down = await verifyCardTrader("tok_abcdefghijklmnopqrstuvwxyz", (async () => { throw new Error("offline"); }) as never);
  assert.equal(down.ok, false);
});
