/**
 * Owner alerts for a stock identity that has more than one Waitlist or Listed row.
 * The /admin list does not depend on email. Email is off unless DUPLICATE_ALERT_EMAIL is on, true, or 1.
 */
import { sendEmail } from "./alerts.ts";
import { db } from "./tenants.ts";
import type { Sql } from "./intake-upsert.ts";

export type DuplicateSource = "override" | "observed";

export type DuplicateAlert = {
  id: string;
  tenantId: string;
  identityKey: string;
  recordIds: string[];
  source: DuplicateSource;
  note: string | null;
  createdAt: string;
  emailSentAt: string | null;
};

export type DuplicateNotice = {
  identityKey: string;
  recordIds: string[];
  source: DuplicateSource;
  note: string;
};

/** Off unless DUPLICATE_ALERT_EMAIL is on, true, or 1. The admin list does not depend on it. */
export function duplicateAlertEmailOn(env: { DUPLICATE_ALERT_EMAIL?: string }): boolean {
  const value = (env.DUPLICATE_ALERT_EMAIL ?? "").trim().toLowerCase();
  return value === "on" || value === "true" || value === "1";
}

export function duplicateAlertText(alert: Pick<DuplicateAlert, "identityKey" | "recordIds" | "source" | "note">): { subject: string; text: string } {
  return {
    subject: `Duplicate stock · ${alert.identityKey}`,
    text: [
      "Hekla found more than one Waitlist or Listed row for the same stock identity.",
      `Identity: ${alert.identityKey}`,
      `Rows: ${alert.recordIds.join(", ")}`,
      `Found by: ${alert.source}`,
      ...(alert.note ? [`Note: ${alert.note}`] : []),
      "",
      "An override creates a second row on purpose. Anything else means a duplicate landed from another path.",
      "Check the rows, then mark the alert checked on /admin. Reconcile will not merge them.",
    ].join("\n"),
  };
}

const OPEN_ONE_SQL = `select id, identity_key, record_ids, source, note, created_at, email_sent_at
  from duplicate_identity_alerts
  where tenant_id = $1 and identity_key = $2 and acked_at is null`;

const INSERT_SQL = `insert into duplicate_identity_alerts (tenant_id, identity_key, record_ids, source, note)
  values ($1, $2, $3::jsonb, $4, $5)
  returning id, identity_key, record_ids, source, note, created_at, email_sent_at`;

const UPDATE_SQL = `update duplicate_identity_alerts
  set record_ids = $2::jsonb, source = $3, note = $4
  where id = $1 and acked_at is null
  returning id, identity_key, record_ids, source, note, created_at, email_sent_at`;

const OPEN_SQL = `select id, identity_key, record_ids, source, note, created_at, email_sent_at
  from duplicate_identity_alerts
  where tenant_id = $1 and acked_at is null
  order by created_at desc
  limit $2`;

const ACK_SQL = `update duplicate_identity_alerts
  set acked_at = now(), acked_by = $3
  where tenant_id = $1 and identity_key = $2 and acked_at is null
  returning id`;

const EMAIL_SQL = `update duplicate_identity_alerts
  set email_sent_at = now()
  where tenant_id = $1 and identity_key = $2 and acked_at is null and email_sent_at is null
  returning id`;

function asIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch { return []; }
  }
  return [];
}

function toAlert(tenantId: string, row: Record<string, unknown>): DuplicateAlert {
  return {
    id: String(row.id),
    tenantId,
    identityKey: String(row.identity_key),
    recordIds: asIds(row.record_ids),
    source: row.source === "override" ? "override" : "observed",
    note: row.note == null ? null : String(row.note),
    createdAt: new Date(String(row.created_at)).toISOString(),
    emailSentAt: row.email_sent_at == null ? null : new Date(String(row.email_sent_at)).toISOString(),
  };
}

export function isMissingDuplicateAlerts(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate_identity_alerts/.test(message) && /does not exist|undefined_table|42P01/i.test(message);
}

export function duplicateAlertStore(sql: Sql) {
  return {
    /** Inserts one open alert per identity. A second open notice adds record ids and does not start another row. */
    async record(tenantId: string, notice: DuplicateNotice): Promise<{ created: boolean; alert: DuplicateAlert }> {
      const updateOpen = async (row: Record<string, unknown>) => {
        const ids = [...new Set([...asIds(row.record_ids), ...notice.recordIds])];
        const source: DuplicateSource = notice.source === "override" || row.source === "override" ? "override" : "observed";
        const updated = await sql(UPDATE_SQL, [row.id, JSON.stringify(ids), source, notice.note]);
        const next = updated[0];
        if (!next) throw new Error("The duplicate alert was not stored.");
        return { created: false, alert: toAlert(tenantId, next) };
      };
      const open = await sql(OPEN_ONE_SQL, [tenantId, notice.identityKey]);
      if (open[0]) return updateOpen(open[0]);
      try {
        const inserted = await sql(INSERT_SQL, [tenantId, notice.identityKey, JSON.stringify(notice.recordIds), notice.source, notice.note]);
        const row = inserted[0];
        if (!row) throw new Error("The duplicate alert was not stored.");
        return { created: true, alert: toAlert(tenantId, row) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate|unique/i.test(message)) throw error;
        const again = await sql(OPEN_ONE_SQL, [tenantId, notice.identityKey]);
        if (!again[0]) throw error;
        return updateOpen(again[0]);
      }
    },
    async open(tenantId: string, limit = 100): Promise<DuplicateAlert[]> {
      const rows = await sql(OPEN_SQL, [tenantId, limit]);
      return rows.map((row) => toAlert(tenantId, row));
    },
    async ack(tenantId: string, identityKey: string, by: string): Promise<boolean> {
      const rows = await sql(ACK_SQL, [tenantId, identityKey, by]);
      return rows.length === 1;
    },
    async markEmailSent(tenantId: string, identityKey: string): Promise<boolean> {
      const rows = await sql(EMAIL_SQL, [tenantId, identityKey]);
      return rows.length === 1;
    },
  };
}

export function neonDuplicateAlerts(env: Env) {
  return duplicateAlertStore((text, params) => db(env).query(text, params));
}

/**
 * Emails one alert when DUPLICATE_ALERT_EMAIL is on. A send that is off, unconfigured, or failed leaves
 * email_sent_at empty. The admin list still shows the alert.
 */
export async function emailDuplicateAlert(env: Env, alert: DuplicateAlert, send: typeof sendEmail = sendEmail): Promise<"off" | "sent" | "not_configured" | "failed" | "skipped"> {
  if (!duplicateAlertEmailOn(env)) return "off";
  if (alert.emailSentAt) return "skipped";
  const { subject, text } = duplicateAlertText(alert);
  const result = await send(env, alert.tenantId, `[Hekla] ${subject}`, text);
  if (result === "sent") {
    try { await neonDuplicateAlerts(env).markEmailSent(alert.tenantId, alert.identityKey); } catch { /* the list still shows it */ }
  }
  if (result !== "sent") console.error(JSON.stringify({ level: "warn", event: "duplicate_alert_email", tenantId: alert.tenantId, key: alert.identityKey, result }));
  return result;
}
