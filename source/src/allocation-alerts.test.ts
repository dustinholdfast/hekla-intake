import { test } from "node:test";
import assert from "node:assert/strict";
import { allocationAlerter, allocationAlertEmailOn, unverifiableAlertText } from "./alerts.ts";
import type { UnverifiableAlert } from "./allocations.ts";

const T = "00000000-0000-4000-8000-000000000001";
const alert = (over: Partial<UnverifiableAlert> = {}): UnverifiableAlert => ({
  tenantId: T, key: "k-1", recordId: "recAAAAAAAAAAAAAA", allocationId: "alloc-1", deckId: "deck-1", direction: "release",
  listingId: 50, from: 1, expected: 3, observed: 1, source: "sweep", note: "cannot prove", ...over,
});

function io(result: "sent" | "not_configured" | "failed" = "sent") {
  const seen = new Set<string>();
  const calls = { send: [] as { subject: string; text: string }[], forgot: [] as string[] };
  return {
    calls,
    io: {
      send: async (_env: Env, _t: string, subject: string, text: string) => { calls.send.push({ subject, text }); return result; },
      once: async (_env: Env, _t: string, key: string) => { if (seen.has(key)) return false; seen.add(key); return true; },
      forget: async (_env: Env, _t: string, key: string) => { calls.forgot.push(key); seen.delete(key); },
    },
  };
}

test("allocation alert email is off unless ALLOCATION_ALERT_EMAIL is on", () => {
  assert.equal(allocationAlertEmailOn({}), false);
  assert.equal(allocationAlertEmailOn({ ALLOCATION_ALERT_EMAIL: "off" }), false);
  assert.equal(allocationAlertEmailOn({ ALLOCATION_ALERT_EMAIL: "On" }), true);
});

test("an unverified allocation write is always logged, and emailed once per key only when the var is on", async () => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => { logs.push(String(line)); };
  try {
    const off = io();
    await allocationAlerter({ ALLOCATION_ALERT_EMAIL: "off" } as Env, off.io)(alert());
    assert.equal(off.calls.send.length, 0);
    const logged = JSON.parse(logs[0]!);
    assert.deepEqual([logged.event, logged.record, logged.listingId, logged.expected, logged.observed, logged.direction], ["allocation_unverifiable", "recAAAAAAAAAAAAAA", 50, 3, 1, "release"]);

    const on = io();
    const send = allocationAlerter({ ALLOCATION_ALERT_EMAIL: "on" } as Env, on.io);
    await send(alert());
    await send(alert());
    assert.equal(on.calls.send.length, 1, "one email per key");
    assert.match(on.calls.send[0]!.subject, /^\[Hekla\] Allocation write not verified: row recAAAAAAAAAAAAAA, release, CardTrader listing 50/);

    const failing = io("failed");
    await allocationAlerter({ ALLOCATION_ALERT_EMAIL: "on" } as Env, failing.io)(alert({ key: "k-2" }));
    assert.deepEqual(failing.calls.forgot, ["alloc_unverifiable:k-2"], "a failed send can go out next time");
  } finally { console.error = original; }
});

test("the alert text names the row, listing, expected and observed quantity, and direction", () => {
  const { subject, text } = unverifiableAlertText(alert());
  assert.match(subject, /row recAAAAAAAAAAAAAA/);
  for (const want of [/Row: recAAAAAAAAAAAAAA/, /Listing: 50/, /Direction: release/, /Expected quantity: 3 \(was 1\)/, /Observed quantity: 1/, /too high/, /RECONCILE_MODE is off/]) assert.match(text, want);
  const gone = unverifiableAlertText(alert({ direction: "reserve", listingId: null, observed: null, from: 0 })).text;
  assert.match(gone, /Listing: none found/);
  assert.match(gone, /Observed quantity: listing gone/);
  assert.match(gone, /too low/);
});
