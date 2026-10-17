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
