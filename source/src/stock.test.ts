import { test } from "node:test";
import assert from "node:assert/strict";
import { readStock, writeStock } from "./airtable.ts";

const env = { AIRTABLE_API_KEY: "key", AIRTABLE_BASE_ID: "appAAAAAAAAAAAAAA", AIRTABLE_TABLE_ID: "tblBBBBBBBBBBBBBB" } as unknown as Env;

test("reading and setting a row's Qty use only parameters Airtable's single-record endpoint accepts", async () => {
  const realFetch = globalThis.fetch;
  const calls: { url: string; method: string; body: string | null }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? String(init.body) : null });
    return new Response(JSON.stringify({ id: "recCCCCCCCCCCCCCC", fields: { Qty: 3, Status: "Listed" } }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await readStock(env, "recCCCCCCCCCCCCCC"), 3);
    await writeStock(env, "recCCCCCCCCCCCCCC", 0);
    const [read, write] = calls;
    assert.equal(read!.url, "https://api.airtable.com/v0/appAAAAAAAAAAAAAA/tblBBBBBBBBBBBBBB/recCCCCCCCCCCCCCC");
    assert.equal(new URL(read!.url).search, "");
    assert.equal(write!.method, "PATCH");
    assert.deepEqual(JSON.parse(write!.body!), { fields: { Qty: 0, Status: "Sold" }, typecast: false });
  } finally { globalThis.fetch = realFetch; }
});
