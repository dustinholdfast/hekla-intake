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
import { listingRisk, riskWords } from "./alloc-risk.ts";
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

/** The tenant's Resend key and valid to/from addresses, or null when alert email is not set up on Settings. */
async function resendConfig(env: Env, tenantId: string): Promise<{ key: string; to: string; from: string } | null> {
  let key: string | null = null;
  let settings: Record<string, unknown> | null = null;
  try {
    key = await connectionSecret(env, tenantId, "resend");
    settings = key ? await connectionSettings(env, tenantId, "resend") : null;
  } catch { return null; }
  const to = validTo(settings?.to); const from = validFrom(settings?.from);
  return key && to && from ? { key, to, from } : null;
}

/** Alert email is set up on Settings (Resend key plus valid to and from). Never returns the key. */
export async function alertEmailConfigured(env: Env, tenantId: string): Promise<boolean> {
  return (await resendConfig(env, tenantId)) !== null;
}

export async function sendEmail(env: Env, tenantId: string, subject: string, text: string, fetcher: typeof fetch = fetch): Promise<"sent" | "not_configured" | "failed"> {
  const config = await resendConfig(env, tenantId);
  if (!config) return "not_configured";
  const { key, to, from } = config;
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

/**
 * What must be true before Hekla takes allocation writes (the deckbuilder only calls it in live mode): an
 * unverified write has to reach the owner by email, not only the /admin list. Empty when ready.
 */
export async function allocationLiveBlockers(env: Env, tenantId: string, configured: (env: Env, tenantId: string) => Promise<boolean> = alertEmailConfigured): Promise<string[]> {
  const missing: string[] = [];
  if (!allocationAlertEmailOn(env)) missing.push("ALLOCATION_ALERT_EMAIL is not on");
  let ok = false;
  try { ok = await configured(env, tenantId); } catch { ok = false; }
  if (!ok) missing.push("alert email is not set up on Settings (Resend key, to and from)");
  return missing;
}

export const alertRisk = (a: Pick<UnverifiableAlert, "direction" | "from" | "expected" | "observed" | "known">) => listingRisk(a);

export function unverifiableAlertText(a: UnverifiableAlert): { subject: string; text: string } {
  const qty = (n: number | null) => (n == null ? "unknown" : String(n));
  const risk = alertRisk(a);
  const listing = a.listingId == null ? "a relisted CardTrader listing (not found)" : `CardTrader listing ${a.listingId}`;
  const lead = risk === "high" ? "CHECK NOW: listing may be too high" : "Listing may be too low";
  return {
    subject: `${lead} · row ${a.recordId}, ${a.direction}, ${listing}`,
    text: [
      `Hekla could not prove an earlier CardTrader ${a.direction} write landed, and did not send it again.`,
      `The listing ${riskWords(risk)}.`,
      `Row: ${a.recordId}`,
      `Listing: ${a.listingId ?? "none found"}`,
      `Direction: ${a.direction}`,
      `Before: ${qty(a.from)}`,
      `Expected quantity: ${qty(a.expected)}`,
      `Observed quantity: ${a.known && a.observed == null ? "listing gone" : qty(a.observed)}`,
      `Found by: ${a.source}`,
      `Allocation ${a.allocationId}, deck ${a.deckId}, key ${a.key}`,
      ...(a.note ? [`Note: ${a.note}`] : []),
      "",
      "Reconcile will not fix it (RECONCILE_MODE is off). Check CardTrader by hand, then mark it checked on /admin.",
    ].join("\n"),
  };
}

/** Email bookkeeping per alert key (sync_state): a short send claim, then email_sent_at once Resend accepted it. */
export type AlertEmailLedger = {
  claimEmail(tenantId: string, key: string): Promise<boolean>;
  markEmailSent(tenantId: string, key: string): Promise<void>;
  releaseEmail(tenantId: string, key: string): Promise<void>;
  /** Open (not checked) alerts with no email_sent_at, oldest first. */
  unsent(tenantId: string, limit: number): Promise<UnverifiableAlert[]>;
};

export type AlertIo = { send: typeof sendEmail; ledger: AlertEmailLedger };

/**
 * Emails one alert if ALLOCATION_ALERT_EMAIL is on and no one has sent it yet. email_sent_at is stored only after
 * Resend accepts it; a failed or unconfigured send gives the claim back, so the sweep sends it again.
 */
export async function emailAllocationAlert(env: Env, alert: UnverifiableAlert, io: AlertIo): Promise<"off" | "skipped" | "sent" | "not_configured" | "failed"> {
  if (!allocationAlertEmailOn(env)) return "off";
  if (!(await io.ledger.claimEmail(alert.tenantId, alert.key))) return "skipped";
  let result: "sent" | "not_configured" | "failed" = "failed";
  try {
    const { subject, text } = unverifiableAlertText(alert);
    result = await io.send(env, alert.tenantId, `[Hekla] ${subject}`, text);
  } finally {
    if (result === "sent") await io.ledger.markEmailSent(alert.tenantId, alert.key);
    else await io.ledger.releaseEmail(alert.tenantId, alert.key).catch(() => undefined);
  }
  if (result !== "sent") console.error(JSON.stringify({ level: "warn", event: "allocation_alert_email", tenantId: alert.tenantId, key: alert.key, result }));
  return result;
}

/** Alert emails the sweep retries per run, at most. */
export const ALERT_RESENDS = 5;

/** Run by the sweep: sends again every open alert with no email_sent_at, oldest first, capped. One failure does not stop the rest. */
export async function resendAllocationAlertEmails(env: Env, tenantId: string, io: AlertIo, limit = ALERT_RESENDS): Promise<Record<string, string>> {
  if (!allocationAlertEmailOn(env)) return {};
  const out: Record<string, string> = {};
  for (const alert of (await io.ledger.unsent(tenantId, limit)).slice(0, limit)) {
    try { out[alert.key] = await emailAllocationAlert(env, { ...alert, source: "resend" }, io); }
    catch (error) { out[alert.key] = "error"; console.error(JSON.stringify({ event: "allocation_alert_resend_failed", key: alert.key, error: error instanceof Error ? error.message.slice(0, 200) : String(error) })); }
  }
  if (Object.keys(out).length) console.log(JSON.stringify({ event: "allocation_alert_resend", tenantId, results: out }));
  return out;
}

/**
 * deps.alert for allocations. Always one error log line (allocation_unverifiable) with the risk; the alert also stays
 * on the /admin list until marked checked. With ALLOCATION_ALERT_EMAIL on it is emailed once per key; a send that
 * fails here is retried by the sweep until email_sent_at is stored.
 */
export function allocationAlerter(env: Env, io: AlertIo) {
  return async (alert: UnverifiableAlert): Promise<void> => {
    console.error(JSON.stringify({
      level: "error", event: "allocation_unverifiable", tenantId: alert.tenantId, key: alert.key, record: alert.recordId,
      direction: alert.direction, listingId: alert.listingId, from: alert.from, expected: alert.expected, observed: alert.observed,
      risk: alertRisk(alert), source: alert.source,
    }));
    await emailAllocationAlert(env, alert, io);
  };
}
