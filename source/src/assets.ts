/** Static-asset cache-busting: the HTML pages load /app.js etc. as /app.js?v=<deployed version>. */

/** Short id of the deployed Worker version (or "dev"), used as the asset cache-buster. */
export function assetVersion(env: Env): string {
  const id = (env as { CF_VERSION_METADATA?: { id?: string } }).CF_VERSION_METADATA?.id ?? "";
  return /^[0-9a-f-]{8,}$/i.test(id) ? id.replace(/-/g, "").slice(0, 12) : "dev";
}
/** Adds ?v=<version> to same-origin <script src> and <link rel=stylesheet href> ("/app.js" → "/app.js?v=…"). */
export function versionedUrl(url: string | null, version: string): string | null {
  if (!url || !url.startsWith("/") || url.startsWith("//") || /[?#]/.test(url)) return null;
  return `${url}?v=${version}`;
}
