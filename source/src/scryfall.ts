/**
 * Magic set symbols for the intake set picker. Scryfall's /sets gives every set's icon; CardTrader's set codes
 * (what Hekla stores) are matched to Scryfall sets by code, MTGO/Arena code, promo/token prefix, or name.
 * Icons are served same-origin through /set-icons/<file>.svg (cached), so the CSP needs no new host.
 * Scryfall asks for a User-Agent and Accept header, at most ~10 requests a second, and caching for 24 h+.
 */
import type { SetOption } from "./cardtrader.ts";

type J = Record<string, any>;
export const SCRYFALL_HEADERS = { "user-agent": "HeklaIntake/1.0 (+https://hekla-intake.dustin-eef.workers.dev)", accept: "application/json;q=0.9,*/*;q=0.8" };
export type ScryfallSet = { code: string; name: string; icon: string | null; aliases: string[]; parent: string | null };
export type IconIndex = { byCode: Map<string, ScryfallSet>; byName: Map<string, ScryfallSet>; icons: Set<string> };

/** "https://svgs.scryfall.io/sets/dom.svg?1700000000" → "dom". */
export function iconFile(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  const m = /^https:\/\/svgs\.scryfall\.io\/sets\/([a-z0-9]{1,12})\.svg(?:\?.*)?$/.exec(uri);
  return m ? m[1]! : null;
}

export function slimSets(raw: J[]): ScryfallSet[] {
  return raw.filter((s) => s && typeof s.code === "string").map((s) => ({
    code: s.code.toLowerCase(), name: String(s.name ?? ""), icon: iconFile(s.icon_svg_uri),
    aliases: [s.mtgo_code, s.arena_code].filter((x): x is string => typeof x === "string" && !!x).map((x) => x.toLowerCase()),
    parent: typeof s.parent_set_code === "string" ? s.parent_set_code.toLowerCase() : null,
  }));
}

const normSetName = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
/** "Dominaria Promos", "Dominaria Tokens", "Dominaria: Extras" → "dominaria". */
const baseSetName = (s: string) => normSetName(s).replace(/\b(promos?|tokens?|extras|art series|minigames|front cards|substitute cards|oversized|jumpstart front cards)\b/g, " ").replace(/\s+/g, " ").trim();

export function buildIconIndex(sets: ScryfallSet[]): IconIndex {
  const byCode = new Map<string, ScryfallSet>(); const byName = new Map<string, ScryfallSet>(); const icons = new Set<string>();
  for (const s of sets) {
    if (!s.icon) continue;
    icons.add(s.icon);
    byCode.set(s.code, s);
  }
  for (const s of sets) {
    if (!s.icon) continue;
    for (const a of s.aliases) if (!byCode.has(a)) byCode.set(a, s);
    const n = normSetName(s.name);
    if (n && !byName.has(n)) byName.set(n, s);
  }
  for (const s of sets) {
    if (!s.icon) continue;
    const b = baseSetName(s.name);
    if (b && !byName.has(b)) byName.set(b, s);
  }
  return { byCode, byName, icons };
}

/**
 * The Scryfall icon file for a CardTrader set, or null (the picker then shows no symbol).
 * Order: exact code (also MTGO/Arena codes) → code without a promo/token/foil prefix (p, t, f) →
 * exact set name → name without "Promos"/"Tokens"/… suffixes.
 */
export function iconFor(set: SetOption, index: IconIndex): string | null {
  const code = set.code.trim().toLowerCase();
  const hit = index.byCode.get(code)
    ?? (code.length >= 4 && /^[ptf]/.test(code) ? index.byCode.get(code.slice(1)) : undefined)
    ?? index.byName.get(normSetName(set.name))
    ?? index.byName.get(baseSetName(set.name));
  return hit?.icon ?? null;
}

export function withIcons(sets: SetOption[], index: IconIndex): { sets: (SetOption & { icon: string | null })[]; matched: number } {
  let matched = 0;
  const out = sets.map((s) => { const icon = iconFor(s, index); if (icon) matched++; return { ...s, icon }; });
  return { sets: out, matched };
}

/* ---------- fetching (cached) ---------- */

// Spaces this isolate's Scryfall requests ~100 ms apart (Scryfall asks for no more than 10 per second).
let lastCall = 0;
async function scryfallGate(): Promise<void> {
  const wait = lastCall + 100 - Date.now();
  lastCall = Math.max(Date.now(), lastCall + 100);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

const cache = () => (globalThis as any).caches?.default as Cache | undefined;

export async function scryfallIndex(fetcher: typeof fetch = fetch): Promise<IconIndex> {
  const key = new Request("https://hekla-scryfall.cache/sets-v1");
  const c = cache();
  let sets: ScryfallSet[] | null = null;
  if (c) { const hit = await c.match(key); if (hit) sets = await hit.json() as ScryfallSet[]; }
  if (!sets) {
    await scryfallGate();
    const r = await fetcher("https://api.scryfall.com/sets", { headers: SCRYFALL_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Scryfall /sets answered ${r.status}`);
    sets = slimSets(((await r.json()) as J).data ?? []);
    if (c) await c.put(key, new Response(JSON.stringify(sets), { headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" } }));
  }
  return buildIconIndex(sets);
}

/** The SVG for one icon file, cached a week. Only files Scryfall lists are fetched. */
export async function setIconSvg(file: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!/^[a-z0-9]{1,12}$/.test(file)) return null;
  const key = new Request(`https://hekla-scryfall.cache/icon/${file}.svg`);
  const c = cache();
  if (c) { const hit = await c.match(key); if (hit) return await hit.text(); }
  const index = await scryfallIndex(fetcher);
  if (!index.icons.has(file)) return null;
  await scryfallGate();
  const r = await fetcher(`https://svgs.scryfall.io/sets/${file}.svg`, { headers: { ...SCRYFALL_HEADERS, accept: "image/svg+xml,*/*;q=0.8" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const svg = await r.text();
  if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(svg) || svg.length > 200_000) return null;
  if (c) await c.put(key, new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=604800" } }));
  return svg;
}
