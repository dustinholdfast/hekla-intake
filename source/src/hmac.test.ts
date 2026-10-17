import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { cardTraderSignature, newSecret, safeEqual, starfoilSignature, verifyCardTraderSignature, verifyStarfoil } from "./hmac.ts";

test("CardTrader signature is base64 HMAC-SHA256 of the raw body", async () => {
  const body = '{"id":"x","cause":"order.create"}';
  const expected = createHmac("sha256", "shh").update(body).digest("base64");
  assert.equal(await cardTraderSignature("shh", body), expected);
  assert.equal(await verifyCardTraderSignature("shh", body, expected), true);
  assert.equal(await verifyCardTraderSignature("shh", body + " ", expected), false);
  assert.equal(await verifyCardTraderSignature("other", body, expected), false);
  assert.equal(await verifyCardTraderSignature("shh", body, null), false);
});

test("starfoil signature covers timestamp and body and expires after 5 minutes", async () => {
  const body = '{"orderId":"cs_1"}'; const now = 1_800_000_000_000; const ts = String(now / 1000);
  const sig = await starfoilSignature("k", ts, body);
  assert.equal(sig, createHmac("sha256", "k").update(`${ts}.${body}`).digest("hex"));
  assert.equal(await verifyStarfoil("k", body, ts, sig, now), true);
  assert.equal(await verifyStarfoil("k", body, ts, sig, now + 301_000), false);
  assert.equal(await verifyStarfoil("k", '{"orderId":"cs_2"}', ts, sig, now), false);
  assert.equal(await verifyStarfoil("k", body, undefined, sig, now), false);
});

test("helpers", () => {
  assert.equal(safeEqual("abc", "abc"), true); assert.equal(safeEqual("abc", "abd"), false); assert.equal(safeEqual("a", "ab"), false);
  assert.match(newSecret(), /^[0-9a-f]{64}$/);
});
