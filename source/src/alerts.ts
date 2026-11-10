/**
 * Alert and daily emails for the sales sync. Uses a Resend API key the tenant saves on Settings (sealed with
 * CONNECTIONS_KEY, like the CardTrader token) and the to/from addresses saved with it. starfoil-lgs already
 * emails through Resend, so the same key and a verified from-address can be reused.
 * Each alert key is sent once per tenant. Without a Resend connection the alert is logged and stays visible
 * on the Sales page (needs review / oversold), and nothing fails.
 */
import { connectionSecret, connectionSettings } from "./connections.ts";
import { firstTime, forgetAlert } from "./salesdb.ts";

import type { Alert } from "./sales.ts";
import type { UnverifiableAlert } from "./allocations.ts";
export type { Alert };
export type EmailSettings = { to: string; from: string };

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
/** "Name <a@b.c>" or "a@b.c". */
export function validFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  const m = /^(.{0,80}?)\s*<([^<>]+)>$/.exec(v);
  const address = m ? m[2]! : v;
  return EMAIL.test(address) && v.length <= 200 && !/[\r\n]/.test(v) ? v : null;
}
export function validTo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 && list.length <= 5 && list.every((a) => EMAIL.test(a)) ? list.join(", ") : null;
}

export async function sendEmail(env: Env, tenantId: string, subject: string, text: string, fetcher: typeof fetch = fetch): Promise<"sent" | "not_configured" | "failed"> {
  let key: string | null = null;
  let settings: Record<string, unknown> | null = null;
  try {
    key = await connectionSecret(env, tenantId, "resend");
    settings = key ? await connectionSettings(env, tenantId, "resend") : null;
  } catch { return "not_configured"; }
  const to = validTo(settings?.to); const from = validFrom(settings?.from);
  if (!key || !to || !from) return "not_configured";
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: to.split(", "), subject: subject.slice(0, 200), text }),
      signal: AbortSignal.timeout(8000),
    });
    await response.body?.cancel();
    return response.ok ? "sent" : "failed";
  } catch { return "failed"; }
}

/** Sends each alert once (by key). Logs every alert either way. */
export async function deliverAlerts(env: Env, tenantId: string, alerts: Alert[]): Promise<void> {
  for (const alert of alerts) {
    console.log(JSON.stringify({ level: "warn", event: "sales_alert", tenantId, key: alert.key, subject: alert.subject }));
    if (!(await firstTime(env, tenantId, alert.key))) continue;
    const result = await sendEmail(env, tenantId, `[Hekla] ${alert.subject}`, alert.text);
    if (result === "failed") await forgetAlert(env, tenantId, alert.key); // try again next run
    if (result !== "sent") console.log(JSON.stringify({ level: "warn", event: "sales_alert_email", tenantId, key: alert.key, result }));
  }
}

/** Off unless ALLOCATION_ALERT_EMAIL is on, true, or 1. The admin alerts list and the log line do not depend on it. */
export function allocationAlertEmailOn(env: { ALLOCATION_ALERT_EMAIL?: string }): boolean {
  const v = (env.ALLOCATION_ALERT_EMAIL ?? "").trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

export function unverifiableAlertText(a: UnverifiableAlert): { subject: string; text: string } {
  const qty = (n: number | null) => (n == null ? "unknown" : String(n));
  const listing = a.listingId == null ? "a relisted CardTrader listing (not found)" : `CardTrader listing ${a.listingId}`;
  const risk = a.direction === "release" ? "may now be too high (copies held for a deck could sell)" : "may now be too low (copies may be missing from CardTrader)";
  return {
    subject: `Allocation write not verified: row ${a.recordId}, ${a.direction}, ${listing}`,
    text: [
      `Hekla could not prove an earlier CardTrader ${a.direction} write landed, and did not send it again.`,
      `Row: ${a.recordId}`,
      `Listing: ${a.listingId ?? "none found"}`,
      `Direction: ${a.direction}`,
      `Expected quantity: ${qty(a.expected)} (was ${qty(a.from)})`,
      `Observed quantity: ${a.observed == null ? "listing gone" : a.observed}`,
      `Found by: ${a.source}`,
      `Allocation ${a.allocationId}, deck ${a.deckId}, key ${a.key}`,
      ...(a.note ? [`Note: ${a.note}`] : []),
      "",
      `The listing ${risk}. Reconcile will not fix it (RECONCILE_MODE is off). Check CardTrader by hand, then mark it checked on /admin.`,
    ].join("\n"),
  };
}

/**
 * deps.alert for allocations. Always one error log line (allocation_unverifiable); the alert also stays on the /admin
 * list until marked checked. With ALLOCATION_ALERT_EMAIL on, it is emailed once per key through the tenant's Resend
 * connection (Settings > alert email); a failed send is retried on the next alert for that key, not lost.
 */
export function allocationAlerter(
  env: Env,
  io: { send: typeof sendEmail; once: typeof firstTime; forget: typeof forgetAlert } = { send: sendEmail, once: firstTime, forget: forgetAlert },
) {
  return async (alert: UnverifiableAlert): Promise<void> => {
    console.error(JSON.stringify({
      level: "error", event: "allocation_unverifiable", tenantId: alert.tenantId, key: alert.key, record: alert.recordId,
      direction: alert.direction, listingId: alert.listingId, from: alert.from, expected: alert.expected, observed: alert.observed, source: alert.source,
    }));
    if (!allocationAlertEmailOn(env)) return;
    const dedupe = `alloc_unverifiable:${alert.key}`;
    if (!(await io.once(env, alert.tenantId, dedupe))) return;
    const { subject, text } = unverifiableAlertText(alert);
    const result = await io.send(env, alert.tenantId, `[Hekla] ${subject}`, text);
    if (result === "failed") await io.forget(env, alert.tenantId, dedupe);
    if (result !== "sent") console.error(JSON.stringify({ level: "warn", event: "allocation_alert_email", tenantId: alert.tenantId, key: alert.key, result }));
  };
}
