/** Webhook signatures. Every comparison is constant-time. */
const enc = new TextEncoder();

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

const toBase64 = (bytes: Uint8Array): string => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** CardTrader: the Signature header is base64(HMAC-SHA256(raw body, app shared_secret)). */
export async function cardTraderSignature(secret: string, body: string): Promise<string> {
  return toBase64(await hmac(secret, body));
}
export async function verifyCardTraderSignature(secret: string, body: string, signature: string | undefined | null): Promise<boolean> {
  if (!signature) return false;
  return safeEqual(await cardTraderSignature(secret, body), signature.trim());
}

/**
 * starfoil.store → Hekla: X-Hekla-Signature is hex(HMAC-SHA256(`${timestamp}.${body}`)), X-Hekla-Timestamp is
 * Unix seconds. Deliveries older than five minutes are refused so a captured request cannot be replayed later.
 * POST /api/allocations uses the same construction with X-Alloc-Signature, X-Alloc-Timestamp, and ALLOCATION_HMAC_SECRET.
 */
export async function starfoilSignature(secret: string, timestamp: string, body: string): Promise<string> {
  return toHex(await hmac(secret, `${timestamp}.${body}`));
}
export async function verifyStarfoil(secret: string, body: string, timestamp: string | undefined | null, signature: string | undefined | null, nowMs = Date.now()): Promise<boolean> {
  if (!timestamp || !signature || !/^\d{9,11}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 300) return false;
  return safeEqual(await starfoilSignature(secret, timestamp, body), signature.trim().toLowerCase());
}

/** A new shared secret: 32 random bytes, hex. */
export function newSecret(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}
