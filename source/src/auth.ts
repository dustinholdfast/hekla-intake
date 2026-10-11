/** Clerk encodes its Frontend API host in the publishable key: pk_(test|live)_<base64("host$")>. */
export function clerkFrontendApi(publishableKey: string | undefined): string | null {
  const match = /^pk_(?:test|live)_([A-Za-z0-9+/_=-]+)$/.exec(publishableKey?.trim() ?? "");
  if (!match?.[1]) return null;
  let decoded: string;
  try {
    decoded = atob(match[1].replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  if (!decoded.endsWith("$")) return null;
  const host = decoded.slice(0, -1);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) ? host : null;
}

export function authConfigured(env: Env): boolean {
  return Boolean(env.CLERK_SECRET_KEY?.trim() && clerkFrontendApi(env.CLERK_PUBLISHABLE_KEY) && env.DATABASE_URL?.trim());
}

/** Platform admins run the service itself (granting plans). This is not a Clerk organization role. */
export function isPlatformAdmin(env: Env, userId: string | null | undefined): boolean {
  if (!userId) return false;
  return (env.PLATFORM_ADMIN_USER_IDS ?? "").split(/[\s,]+/).includes(userId);
}

/** Clerk's components need their own script host, its bot-protection script, inline styles, a blob worker, and the Turnstile frame. */
export function contentSecurityPolicy(env: Env, imageHosts: readonly string[]): string {
  const host = clerkFrontendApi(env.CLERK_PUBLISHABLE_KEY);
  const clerk = host ? ` https://${host}` : "";
  const turnstile = host ? " https://challenges.cloudflare.com" : "";
  return [
    "default-src 'self'",
    `style-src 'self'${host ? " 'unsafe-inline'" : ""}`,
    `script-src 'self'${clerk}${turnstile}${host ? " https://*.protect.clerk.com" : ""}`,
    `img-src 'self' data:${host ? " https://img.clerk.com" : ""} ${imageHosts.join(" ")}`,
    `connect-src 'self'${clerk}${host ? " https://*.protect.clerk.com:* https://clerk-telemetry.com" : ""}`,
    ...(host ? ["worker-src 'self' blob:", `frame-src${turnstile}`] : []),
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}
