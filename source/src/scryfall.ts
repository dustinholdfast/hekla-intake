/**
 * Magic set symbols for the intake set picker. Scryfall's /sets gives every set's icon; CardTrader's set codes
 * (what Hekla stores) are matched to Scryfall sets by code, MTGO/Arena code, promo/token prefix, or name.
 * Icons are served same-origin through /set-icons/<file>.svg (cached), so the CSP needs no new host.
 * Scryfall asks for a User-Agent and Accept header, at most ~10 requests a second, and caching for 24 h+.
 */
import type { SetOption } from "./cardtrader.ts";

type J = Record<string, any>;
export const SCRYFALL_HEADERS = { "user-agent": "HeklaIntake/1.0 (+https://hekla-intake.dustin-eef.workers.dev)", accept: "application/json;q=0.9,*/*;q=0.8" };
export type ScryfallSet = { code: string; name: string; icon: string | null; aliases: string[]; parent: string | null; type: string; released: string | null; digital: boolean };
export type IconIndex = {
  byCode: Map<string, ScryfallSet>; byName: Map<string, ScryfallSet>; icons: Set<string>;
  /** Every set (with or without an icon) by exact code / MTGO / Arena code and by exact name, for grouping. */
  exactCode: Map<string, ScryfallSet>; exactName: Map<string, ScryfallSet>;
};

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
    type: String(s.set_type ?? ""), released: typeof s.released_at === "string" ? s.released_at : null, digital: s.digital === true,
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
  const exactCode = new Map<string, ScryfallSet>(); const exactName = new Map<string, ScryfallSet>();
  for (const s of sets) exactCode.set(s.code, s);
  for (const s of sets) {
    for (const a of s.aliases) if (!exactCode.has(a)) exactCode.set(a, s);
    const n = normSetName(s.name);
    if (n && !exactName.has(n)) exactName.set(n, s);
  }
  return { byCode, byName, icons, exactCode, exactName };
}

/**
 * The Scryfall icon file for a CardTrader set, or null (the picker then shows no symbol).
 * Order: exact code (also MTGO/Arena codes) → code without a promo/token/foil/art/commander prefix
 * (p, t, f, a, c: CardTrader's "afra", "cfrc") → exact set name → name without "Promos"/"Tokens"/… suffixes →
 * code before a dash ("sld-odd" → sld) → name before a colon.
 */
export function iconFor(set: SetOption, index: IconIndex): string | null {
  const code = set.code.trim().toLowerCase();
  const head = code.split(/[-_ ]/)[0]!; // CardTrader's "sld-odd", "sld-miku" → "sld"
  const beforeColon = set.name.includes(":") ? set.name.slice(0, set.name.indexOf(":")) : "";
  const hit = index.byCode.get(code)
    ?? (code.length >= 4 && /^[ptfac]/.test(code) ? index.byCode.get(code.slice(1)) : undefined)
    ?? index.byName.get(normSetName(set.name))
    ?? index.byName.get(baseSetName(set.name))
    ?? (head !== code && head.length >= 3 ? index.byCode.get(head) : undefined)
    ?? (beforeColon ? index.byName.get(normSetName(beforeColon)) : undefined);
  return hit?.icon ?? null;
}

export function withIcons(sets: SetOption[], index: IconIndex): { sets: (SetOption & { icon: string | null })[]; matched: number } {
  let matched = 0;
  const out = sets.map((s) => { const icon = iconFor(s, index); if (icon) matched++; return { ...s, icon }; });
  return { sets: out, matched };
}

/* ---------- grouping: core sets first ---------- */

/** The top group ends with this premier set; premier sets released after it go in the lower group. */
export const CORE_END_NAME = "Reality Fracture";
const PREMIER = new Set(["core", "expansion"]);
const isPremier = (s: ScryfallSet) => PREMIER.has(s.type) && !s.digital;

/** The Scryfall set for a CardTrader set by exact code (or MTGO/Arena code) or exact name only. No prefix or
 * "Promos"-suffix guessing here: "pfra" must never land in the core group as "fra". */
export function exactScryfallSet(set: SetOption, index: IconIndex): ScryfallSet | undefined {
  return index.exactCode.get(set.code.trim().toLowerCase()) ?? index.exactName.get(normSetName(set.name));
}

/** Reality Fracture as Scryfall lists it (paper core/expansion set), or null. */
export function coreEnd(index: IconIndex): ScryfallSet | null {
  const s = index.exactName.get(normSetName(CORE_END_NAME));
  return s && isPremier(s) && s.released ? s : null;
}

export type GroupedSet<T> = T & { group: "core" | "other" };
/**
 * Magic's core and expansion sets (paper) released up to Reality Fracture, oldest first, so the group ends with
 * Reality Fracture; then everything else (later premier sets, masters, commander, promos, tokens, sets Scryfall
 * doesn't know), newest first, with unknown dates last in CardTrader's order. Without Reality Fracture in
 * Scryfall's data nothing is grouped (all "other", order unchanged).
 */
export function groupMagicSets<T extends SetOption>(sets: T[], index: IconIndex): { sets: GroupedSet<T>[]; core: number; end: { code: string; released: string } | null } {
  const end = coreEnd(index);
  if (!end) return { sets: sets.map((s) => ({ ...s, group: "other" as const })), core: 0, end: null };
  const rows = sets.map((s, i) => {
    const sf = exactScryfallSet(s, index);
    const core = !!sf && isPremier(sf) && !!sf.released && sf.released <= end.released!;
    return { s, i, released: sf?.released ?? null, core };
  });
  const top = rows.filter((r) => r.core).sort((a, b) => a.released!.localeCompare(b.released!) || b.i - a.i);
  const rest = rows.filter((r) => !r.core).sort((a, b) =>
    a.released && b.released ? b.released.localeCompare(a.released) || a.i - b.i : a.released ? -1 : b.released ? 1 : a.i - b.i);
  return {
    sets: [...top.map((r) => ({ ...r.s, group: "core" as const })), ...rest.map((r) => ({ ...r.s, group: "other" as const }))],
    core: top.length, end: { code: end.code, released: end.released! },
  };
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

/** Durable copy of Scryfall's set list (Neon), so a Scryfall outage or 429 never strips the picker. */
export type ScryfallStore = {
  load(): Promise<{ sets: ScryfallSet[]; at: number } | null>;
  save(sets: ScryfallSet[]): Promise<void>;
};
export const SCRYFALL_TTL_MS = 24 * 3600_000;
const INDEX_CACHE_KEY = "https://hekla-scryfall.cache/sets-v3";

// After a 429/5xx, this isolate leaves Scryfall alone until then (Retry-After, at least a minute).
let backoffUntil = 0;
export function resetScryfallBackoff(): void { backoffUntil = 0; lastCall = 0; }

/** Live GET /sets: User-Agent + Accept, one retry after ~1 s on 429/5xx, then backs off. */
export async function fetchScryfallSets(fetcher: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<ScryfallSet[]> {
  if (Date.now() < backoffUntil) throw new Error(`Scryfall backoff for ${Math.ceil((backoffUntil - Date.now()) / 1000)} s`);
  let status = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    await scryfallGate();
    const r = await fetcher("https://api.scryfall.com/sets", { headers: SCRYFALL_HEADERS, signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const sets = slimSets(((await r.json()) as J).data ?? []);
      if (sets.length < 100) throw new Error(`Scryfall /sets returned only ${sets.length} sets`);
      return sets;
    }
    status = r.status;
    if (status !== 429 && status < 500) break;
    const retryAfter = Number(r.headers.get("retry-after")) || 0;
    if (attempt === 0) { await sleep(Math.min(2000, Math.max(1000, retryAfter * 1000))); continue; }
    backoffUntil = Date.now() + Math.max(60_000, retryAfter * 1000);
  }
  throw new Error(`Scryfall /sets answered ${status}`);
}

export type IndexResult = { index: IconIndex; source: "edge" | "stored" | "live" | "stale"; at: number };
/**
 * Scryfall's sets: edge cache (24 h) → stored copy in Neon if under 24 h → live fetch (saved to both) →
 * a stored copy of any age when Scryfall is failing. Throws only when there is no copy at all.
 */
export async function scryfallIndexWithSource(opts: { fetcher?: typeof fetch; store?: ScryfallStore | null; live?: boolean } = {}): Promise<IndexResult> {
  const { fetcher = fetch, store = null, live = true } = opts;
  const key = new Request(INDEX_CACHE_KEY);
  const c = cache();
  const putEdge = async (sets: ScryfallSet[], at: number) => {
    if (c) await c.put(key, new Response(JSON.stringify({ sets, at }), { headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" } })).catch(() => {});
  };
  if (c) {
    const hit = await c.match(key);
    if (hit) { const v = await hit.json() as { sets: ScryfallSet[]; at: number }; if (Array.isArray(v.sets)) return { index: buildIconIndex(v.sets), source: "edge", at: v.at }; }
  }
  const stored = store ? await store.load().catch((e) => { console.error("scryfall store read failed", String(e)); return null; }) : null;
  if (stored && Date.now() - stored.at < SCRYFALL_TTL_MS) { await putEdge(stored.sets, stored.at); return { index: buildIconIndex(stored.sets), source: "stored", at: stored.at }; }
  if (live) {
    try {
      const sets = await fetchScryfallSets(fetcher);
      const at = Date.now();
      if (store) await store.save(sets).catch((e) => console.error("scryfall store write failed", String(e)));
      await putEdge(sets, at);
      return { index: buildIconIndex(sets), source: "live", at };
    } catch (error) {
      if (!stored) throw error;
      console.error("scryfall live fetch failed; using stored copy", JSON.stringify({ error: String(error), ageHours: Math.round((Date.now() - stored.at) / 3600_000) }));
    }
  }
  if (stored) return { index: buildIconIndex(stored.sets), source: "stale", at: stored.at };
  throw new Error("No Scryfall set list available");
}
export async function scryfallIndex(fetcher: typeof fetch = fetch, store: ScryfallStore | null = null): Promise<IconIndex> {
  return (await scryfallIndexWithSource({ fetcher, store })).index;
}

/** Cron: refresh the stored copy when it is older than 24 h (retried every tick while Scryfall refuses). */
export async function refreshScryfallStore(store: ScryfallStore, fetcher: typeof fetch = fetch): Promise<"fresh" | "refreshed"> {
  const stored = await store.load();
  if (stored && Date.now() - stored.at < SCRYFALL_TTL_MS) return "fresh";
  await store.save(await fetchScryfallSets(fetcher));
  return "refreshed";
}

/** The SVG for one icon file, cached a week. Only files Scryfall lists are fetched. */
export async function setIconSvg(file: string, fetcher: typeof fetch = fetch, store: ScryfallStore | null = null): Promise<string | null> {
  if (!/^[a-z0-9]{1,12}$/.test(file)) return null;
  const key = new Request(`https://hekla-scryfall.cache/icon/${file}.svg`);
  const c = cache();
  if (c) { const hit = await c.match(key); if (hit) return await hit.text(); }
  const index = await scryfallIndex(fetcher, store);
  if (!index.icons.has(file)) return null;
  await scryfallGate();
  const r = await fetcher(`https://svgs.scryfall.io/sets/${file}.svg`, { headers: { ...SCRYFALL_HEADERS, accept: "image/svg+xml,*/*;q=0.8" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const svg = await r.text();
  if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(svg) || svg.length > 200_000) return null;
  if (c) await c.put(key, new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=604800" } }));
  return svg;
}
