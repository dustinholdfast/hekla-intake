import { test } from "node:test";
import assert from "node:assert/strict";
import { allocationAlerter, allocationAlertEmailOn, allocationLiveBlockers, emailAllocationAlert, resendAllocationAlertEmails, unverifiableAlertText, type AlertEmailLedger, type AlertIo } from "./alerts.ts";
import type { UnverifiableAlert } from "./allocations.ts";

const T = "00000000-0000-4000-8000-000000000001";
const alert = (over: Partial<UnverifiableAlert> = {}): UnverifiableAlert => ({
  tenantId: T, key: "k-1", recordId: "recAAAAAAAAAAAAAA", allocationId: "alloc-1", deckId: "deck-1", direction: "release",
  listingId: 50, from: 1, expected: 3, observed: 3, known: true, source: "sweep", note: "cannot prove", ...over,
});
const ON = { ALLOCATION_ALERT_EMAIL: "on" } as Env;

/** The sync_state email ledger in memory: claim (lease), email_sent_at, release; plus the open alerts it reads. */
function ledger(open: UnverifiableAlert[] = []) {
  const state = new Map<string, { sentAt?: string; claimed?: boolean }>();
  const l: AlertEmailLedger & { state: typeof state } = {
    state,
    async claimEmail(_t, key) { const s = state.get(key); if (s?.sentAt || s?.claimed) return false; state.set(key, { claimed: true }); return true; },
    async markEmailSent(_t, key) { state.set(key, { sentAt: "2026-11-09T12:00:00.000Z" }); },
    async releaseEmail(_t, key) { if (!state.get(key)?.sentAt) state.delete(key); },
    async unsent(_t, limit) { return open.filter((a) => !state.get(a.key)?.sentAt).slice(0, limit); },
  };
  return l;
}
function io(results: ("sent" | "not_configured" | "failed" | "throw")[], l = ledger()): AlertIo & { sent: { subject: string; text: string }[]; ledger: ReturnType<typeof ledger> } {
  const sent: { subject: string; text: string }[] = [];
  return {
    sent, ledger: l,
    send: async (_env, _t, subject, text) => {
      const r = results.length > 1 ? results.shift()! : results[0]!;
      if (r === "throw") throw new Error("network");
      if (r === "sent") sent.push({ subject, text });
      return r;
    },
  };
}

test("allocation alert email is off unless ALLOCATION_ALERT_EMAIL is on", () => {
  assert.equal(allocationAlertEmailOn({}), false);
  assert.equal(allocationAlertEmailOn({ ALLOCATION_ALERT_EMAIL: "off" }), false);
  assert.equal(allocationAlertEmailOn({ ALLOCATION_ALERT_EMAIL: "On" }), true);
});

test("live preflight: needs ALLOCATION_ALERT_EMAIL on and alert email set up", async () => {
  const yes = async () => true; const no = async () => false; const down = async () => { throw new Error("neon"); };
  assert.deepEqual(await allocationLiveBlockers(ON, T, yes), []);
  assert.deepEqual((await allocationLiveBlockers({ ALLOCATION_ALERT_EMAIL: "off" } as Env, T, yes)).length, 1);
  assert.match((await allocationLiveBlockers({} as Env, T, yes))[0]!, /ALLOCATION_ALERT_EMAIL/);
  assert.match((await allocationLiveBlockers(ON, T, no))[0]!, /alert email is not set up/);
  assert.equal((await allocationLiveBlockers({} as Env, T, no)).length, 2);
  assert.equal((await allocationLiveBlockers(ON, T, down)).length, 1, "cannot check counts as not set up");
});

test("an unverified write is always logged with its risk, and emailed once per key only when the var is on", async () => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => { logs.push(String(line)); };
  try {
    const off = io(["sent"]);
    await allocationAlerter({ ALLOCATION_ALERT_EMAIL: "off" } as Env, off)(alert());
    assert.equal(off.sent.length, 0);
    const logged = JSON.parse(logs[0]!);
    assert.deepEqual([logged.event, logged.record, logged.listingId, logged.expected, logged.observed, logged.direction, logged.risk], ["allocation_unverifiable", "recAAAAAAAAAAAAAA", 50, 3, 3, "release", "high"]);

    const on = io(["sent"]);
    const send = allocationAlerter(ON, on);
    await send(alert());
    await send(alert());
    assert.equal(on.sent.length, 1, "one email per key");
    assert.equal(on.ledger.state.get("k-1")?.sentAt, "2026-11-09T12:00:00.000Z", "email_sent_at stored");
    assert.match(on.sent[0]!.subject, /^\[Hekla\] CHECK NOW: listing may be too high · row recAAAAAAAAAAAAAA, release, CardTrader listing 50/);
  } finally { console.error = original; }
});

test("a failed or unconfigured send stores no email_sent_at, and the sweep's resend sends it, capped per run", async () => {
  const open = [alert({ key: "a" }), alert({ key: "b" }), alert({ key: "c" })];
  const l = ledger(open);
  const failing = io(["failed"], l);
  assert.equal(await emailAllocationAlert(ON, open[0]!, failing), "failed");
  assert.equal(l.state.get("a"), undefined, "claim given back, no email_sent_at");
  const thrown = io(["throw"], l);
  await assert.rejects(emailAllocationAlert(ON, open[1]!, thrown));
  assert.equal(l.state.get("b"), undefined, "a throwing send also gives the claim back");
  assert.equal(await emailAllocationAlert(ON, open[2]!, io(["not_configured"], l)), "not_configured");

  // Sweep resend, cap 2: the two oldest go out; the third waits for the next run.
  const ok = io(["sent"], l);
  assert.deepEqual(await resendAllocationAlertEmails(ON, T, ok, 2), { a: "sent", b: "sent" });
  assert.equal(ok.sent.length, 2);
  assert.match(ok.sent[0]!.text, /Found by: resend/);
  assert.deepEqual(await resendAllocationAlertEmails(ON, T, ok, 2), { c: "sent" });
  assert.deepEqual(await resendAllocationAlertEmails(ON, T, ok, 2), {}, "nothing left without email_sent_at");
  assert.equal(ok.sent.length, 3);

  // One send that throws does not stop the rest of the run.
  const l2 = ledger([alert({ key: "x" }), alert({ key: "y" })]);
  assert.deepEqual(await resendAllocationAlertEmails(ON, T, io(["throw", "sent"], l2)), { x: "error", y: "sent" });
  // Off: no resend at all.
  assert.deepEqual(await resendAllocationAlertEmails({} as Env, T, io(["sent"], ledger(open))), {});
});

test("the alert text names the row, listing, before, expected and observed quantity, and direction", () => {
  const { subject, text } = unverifiableAlertText(alert());
  assert.match(subject, /row recAAAAAAAAAAAAAA/);
  for (const want of [/Row: recAAAAAAAAAAAAAA/, /Listing: 50/, /Direction: release/, /Before: 1/, /Expected quantity: 3/, /Observed quantity: 3/, /may be too high, check now/, /RECONCILE_MODE is off/]) assert.match(text, want);
  const gone = unverifiableAlertText(alert({ direction: "reserve", listingId: null, observed: null, from: 2, expected: 0 }));
  assert.match(gone.text, /Listing: none found/);
  assert.match(gone.text, /Observed quantity: listing gone/);
  assert.match(gone.text, /may be too low/);
  assert.doesNotMatch(gone.text, /too high/);
  const legacy = unverifiableAlertText(alert({ known: false, from: null, expected: null, observed: null, direction: "reserve" }));
  assert.match(legacy.text, /may be too high, check now/);
  assert.match(legacy.text, /Observed quantity: unknown/);
});
