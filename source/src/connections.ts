/**
 * Per-tenant connections to outside services. A tenant's token is encrypted before it reaches Neon and is
 * never sent back to the browser; the Settings screen only ever sees the account label.
 */
import { db } from "./tenants.ts";

export type Provider = "cardtrader";
export type Sealed = { ciphertext: string; iv: string };
export type ConnectionStatus = { connected: false } | { connected: true; accountLabel: string; accountId: string | null; connectedBy: string; connectedAt: string };

export class ConnectionError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBase64 = (bytes: Uint8Array): string => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

export function connectionsReady(env: Env): boolean {
  return Boolean(env.CONNECTIONS_KEY?.trim());
}

async function aesKey(env: Env): Promise<CryptoKey> {
  const secret = env.CONNECTIONS_KEY?.trim();
  if (!secret) throw new ConnectionError("Set the CONNECTIONS_KEY secret before connecting a service.", 503);
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Binds a ciphertext to one tenant and provider, so a row copied onto another tenant cannot be decrypted. */
const boundTo = (tenantId: string, provider: Provider) => enc.encode(`${tenantId}|${provider}`);

export async function sealSecret(env: Env, tenantId: string, provider: Provider, secret: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: boundTo(tenantId, provider) }, await aesKey(env), enc.encode(secret));
  return { ciphertext: toBase64(new Uint8Array(data)), iv: toBase64(iv) };
}

export async function openSecret(env: Env, tenantId: string, provider: Provider, sealed: Sealed): Promise<string> {
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: boundTo(tenantId, provider) }, await aesKey(env), fromBase64(sealed.ciphertext));
  return dec.decode(data);
}

/** A pasted token: one line, no spaces, plausible length. Returns null when it cannot be a token. */
export function cleanToken(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const token = input.trim();
  return token.length >= 20 && token.length <= 4000 && !/\s/.test(token) ? token : null;
}

/** Asks CardTrader who a token belongs to. Read-only; nothing is listed or changed. */
export async function verifyCardTrader(token: string, fetcher: typeof fetch = fetch): Promise<{ ok: true; accountLabel: string; accountId: string | null } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetcher("https://api.cardtrader.com/api/v2/info", { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  } catch {
    return { ok: false, error: "Could not reach CardTrader. Try again." };
  }
  if (response.status === 401 || response.status === 403) { await response.body?.cancel(); return { ok: false, error: "CardTrader did not accept that token." }; }
  if (!response.ok) { await response.body?.cancel(); return { ok: false, error: `CardTrader answered ${response.status}. Try again.` }; }
  const info = await response.json().catch(() => null) as { name?: unknown; user_id?: unknown } | null;
  const accountId = info?.user_id == null ? null : String(info.user_id);
  const name = typeof info?.name === "string" && info.name.trim() ? info.name.trim().slice(0, 120) : null;
  return { ok: true, accountLabel: name ?? (accountId ? `CardTrader user ${accountId}` : "CardTrader account"), accountId };
}

export async function connectionStatus(env: Env, tenantId: string, provider: Provider): Promise<ConnectionStatus> {
  const rows = await db(env).query("select account_label, account_id, connected_by, connected_at from tenant_connections where tenant_id = $1 and provider = $2", [tenantId, provider]);
  const row = rows[0];
  if (!row) return { connected: false };
  return { connected: true, accountLabel: String(row.account_label), accountId: row.account_id == null ? null : String(row.account_id), connectedBy: String(row.connected_by), connectedAt: new Date(row.connected_at as string).toISOString() };
}

export async function saveConnection(env: Env, tenantId: string, provider: Provider, secret: string, account: { accountLabel: string; accountId: string | null }, userId: string): Promise<void> {
  const sealed = await sealSecret(env, tenantId, provider, secret);
  await db(env).query(
    `insert into tenant_connections (tenant_id, provider, secret_ciphertext, secret_iv, account_label, account_id, connected_by)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (tenant_id, provider) do update
       set secret_ciphertext = excluded.secret_ciphertext, secret_iv = excluded.secret_iv, account_label = excluded.account_label,
           account_id = excluded.account_id, connected_by = excluded.connected_by, connected_at = now()`,
    [tenantId, provider, sealed.ciphertext, sealed.iv, account.accountLabel, account.accountId, userId],
  );
}

export async function deleteConnection(env: Env, tenantId: string, provider: Provider): Promise<boolean> {
  const rows = await db(env).query("delete from tenant_connections where tenant_id = $1 and provider = $2 returning provider", [tenantId, provider]);
  return rows.length > 0;
}

/** The tenant's own token for server-side calls, or null when that tenant has not connected the service. */
export async function connectionSecret(env: Env, tenantId: string, provider: Provider): Promise<string | null> {
  const rows = await db(env).query("select secret_ciphertext, secret_iv from tenant_connections where tenant_id = $1 and provider = $2", [tenantId, provider]);
  const row = rows[0];
  return row ? openSecret(env, tenantId, provider, { ciphertext: String(row.secret_ciphertext), iv: String(row.secret_iv) }) : null;
}
