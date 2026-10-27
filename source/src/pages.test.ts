import { test } from "node:test";
import assert from "node:assert/strict";
import { pageAssetRequest } from "./pages.ts";

function pathOf(request: Request): string {
  const url = new URL(request.url);
  return url.pathname + url.search;
}

test("html pages are fetched at the clean URL, never the .html path assets would redirect", () => {
  const cases = [
    ["http://127.0.0.1/credit", "/credit"],
    ["http://127.0.0.1/purchases", "/purchases"],
    ["http://127.0.0.1/purchases/new?sr=x", "/purchases?sr=x"],
    ["http://127.0.0.1/inventory", "/inventory"],
    ["http://127.0.0.1/settings", "/settings"],
    ["http://127.0.0.1/", "/"],
    ["http://127.0.0.1/sales", "/sales"],
    ["http://127.0.0.1/reconcile", "/reconcile"],
    ["http://127.0.0.1/admin", "/admin"],
  ] as const;
  for (const [input, expected] of cases) {
    const out = pageAssetRequest(new Request(input));
    assert.equal(pathOf(out), expected);
    assert.equal(new URL(out.url).pathname.endsWith(".html"), false);
  }
});
