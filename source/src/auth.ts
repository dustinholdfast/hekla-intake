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

/** Clerk's components need their own script host, inline styles, a blob worker, and the Turnstile frame. */
export function contentSecurityPolicy(env: Env, imageHosts: readonly string[]): string {
  const host = clerkFrontendApi(env.CLERK_PUBLISHABLE_KEY);
  const clerk = host ? ` https://${host}` : "";
  const turnstile = host ? " https://challenges.cloudflare.com" : "";
  return [
    "default-src 'self'",
    `style-src 'self'${host ? " 'unsafe-inline'" : ""}`,
    `script-src 'self'${clerk}${turnstile}`,
    `img-src 'self' data:${host ? " https://img.clerk.com" : ""} ${imageHosts.join(" ")}`,
    `connect-src 'self'${clerk}`,
    ...(host ? ["worker-src 'self' blob:", `frame-src${turnstile}`] : []),
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}
