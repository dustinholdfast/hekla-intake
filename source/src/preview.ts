import type { Game } from "./sets.ts";

export type CardPreview = { found: boolean; error?: string; raw?: Record<string, any>; name?: string; subtitle?: string; text?: string; image?: string; source: string; link?: string };
export type PreviewQuery = { game: Game; set: string; number: string; name: string };

export const PREVIEW_IMAGE_HOSTS = [
  "https://cards.lorcast.io",
  "https://cards.scryfall.io",
  "https://images.pokemontcg.io",
  "https://images.ygoprodeck.com",
  "https://cmsassets.rgpub.io",
] as const;

const UA = { "user-agent": "HeklaIntake/1.0 (private card intake)", accept: "application/json" };
type J = Record<string, any>;

async function getJson(url: string): Promise<J | null> {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(7000) });
  if (!r.ok) { await r.body?.cancel(); if (r.status >= 500 || r.status === 429) throw new Error(`upstream ${r.status}`); return null; }
  return await r.json() as J;
}
const clean = (s: unknown) => (typeof s === "string" ? s.trim() : "");
export function collectorCore(n: string): string { const head = clean(n).split("/")[0] ?? ""; return head.trim(); }
/**
 * Riftbound reuses numbers inside one set: 006/166 is a main-set card, SP6/006 a showcase card and R06 a rune.
 * The key keeps the letter prefix and suffix so they stay three different cards: "006" → "6", "SP6/006" → "sp6",
 * "R06a" → "r6a", "019a/166" → "19a".
 */
export function riftboundNumberKey(n: string | null | undefined): string {
  const head = collectorCore(String(n ?? "")).toLowerCase().replace(/\s+/g, "");
  const m = /^([a-z]*)0*(\d+)([a-z*]?)$/.exec(head);
  return m ? `${m[1]}${m[2]}${m[3]}` : head;
}
/** The same key from a Riftcodex id such as "ven-sp6-006" or "ven-006-166". */
const riftcodexKey = (card: J): string => riftboundNumberKey(String(card.riftbound_id ?? "").split("-")[1] ?? "");
function safeImage(url: unknown): string | undefined {
  const u = clean(url); if (!u) return undefined;
  return PREVIEW_IMAGE_HOSTS.some((h) => u.startsWith(h + "/")) ? u : undefined;
}
const none = (source: string): CardPreview => ({ found: false, source });

async function lorcana(q: PreviewQuery): Promise<CardPreview> {
  const src = "Lorcast";
  let c: J | null = null;
  const num = collectorCore(q.number).replace(/^0+(?=\d)/, "");
  if (q.set && num) c = await getJson(`https://api.lorcast.com/v0/cards/${encodeURIComponent(q.set)}/${encodeURIComponent(num)}`);
  if (!c && q.name) { const r = await getJson(`https://api.lorcast.com/v0/cards/search?q=${encodeURIComponent(q.name)}`); c = r?.results?.[0] ?? null; }
  if (!c) return none(src);
  return { found: true, raw: c, source: src, name: [c.name, c.version].filter(Boolean).join(" - "), subtitle: [c.type?.join?.(" "), c.ink, c.rarity, c.set?.name].filter(Boolean).join(" · "), text: clean(c.text), image: safeImage(c.image_uris?.digital?.normal) };
}

async function mtg(q: PreviewQuery): Promise<CardPreview> {
  const src = "Scryfall";
  let c: J | null = null;
  const num = collectorCore(q.number);
  if (q.set && num) c = await getJson(`https://api.scryfall.com/cards/${encodeURIComponent(q.set.toLowerCase())}/${encodeURIComponent(num)}`);
  if (!c && q.name) c = await getJson(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(q.name)}`);
  if (!c || c.object !== "card") return none(src);
  const face = c.card_faces?.[0] ?? {};
  const text = c.oracle_text ?? (c.card_faces ?? []).map((f: J) => `${f.name}: ${f.oracle_text ?? ""}`).join("\n\n");
  return { found: true, raw: c, source: src, link: c.scryfall_uri, name: c.name, subtitle: [c.mana_cost ?? face.mana_cost, c.type_line, c.set_name, c.rarity].filter(Boolean).join(" · "), text: clean(text), image: safeImage(c.image_uris?.normal ?? face.image_uris?.normal) };
}

async function pokemon(q: PreviewQuery): Promise<CardPreview> {
  const src = "Pokémon TCG API";
  const num = collectorCore(q.number).replace(/^0+(?=\d)/, "");
  const esc = (s: string) => s.replace(/[^A-Za-z0-9 .'\-]/g, "");
  const tries: string[] = [];
  if (q.set && num) tries.push(`(set.id:"${esc(q.set)}" OR set.ptcgoCode:"${esc(q.set)}") number:"${esc(num)}"`);
  if (q.name) tries.push(`name:"${esc(q.name)}"`);
  for (const t of tries) {
    const r = await getJson(`https://api.pokemontcg.io/v2/cards?pageSize=1&q=${encodeURIComponent(t)}`);
    const c = r?.data?.[0];
    if (!c) continue;
    const text = [...(c.abilities ?? []).map((a: J) => `${a.type}: ${a.name} — ${a.text}`), ...(c.attacks ?? []).map((a: J) => `${a.name}${a.damage ? ` (${a.damage})` : ""}${a.text ? ` — ${a.text}` : ""}`), ...(c.rules ?? [])].join("\n");
    return { found: true, raw: c, source: src, name: c.name, subtitle: [c.supertype, c.hp && `HP ${c.hp}`, c.set?.name, c.number && `#${c.number}`, c.rarity].filter(Boolean).join(" · "), text: clean(text), image: safeImage(c.images?.large ?? c.images?.small) };
  }
  return none(src);
}

async function ygo(q: PreviewQuery): Promise<CardPreview> {
  const src = "YGOPRODeck";
  let name = q.name;
  const num = collectorCore(q.number);
  const code = num.includes("-") ? num : q.set && num ? `${q.set}-${num}` : "";
  if (code) { const s = await getJson(`https://db.ygoprodeck.com/api/v7/cardsetsinfo.php?setcode=${encodeURIComponent(code.toUpperCase())}`); if (s?.name) name = s.name; }
  if (!name) return none(src);
  let r = await getJson(`https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${encodeURIComponent(name)}`);
  if (!r?.data?.length) r = await getJson(`https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(name)}`);
  const c = r?.data?.[0];
  if (!c) return none(src);
  return { found: true, raw: c, source: src, link: c.ygoprodeck_url, name: c.name, subtitle: [c.type, c.race, c.attribute, c.atk !== undefined && `ATK ${c.atk}`, c.def !== undefined && `DEF ${c.def}`].filter(Boolean).join(" · "), text: clean(c.desc), image: safeImage(c.card_images?.[0]?.image_url) };
}

async function riftbound(q: PreviewQuery): Promise<CardPreview> {
  const src = "Riftcodex";
  let c: J | null = null;
  const key = riftboundNumberKey(q.number);
  const num = Number.parseInt(key.replace(/^[a-z]+/, ""), 10);
  if (q.set && Number.isFinite(num)) {
    // An exact match on the printed number wins. Only when the set has none do we fall back to the bare number.
    let loose: J | null = null;
    for (let page = 1; page <= 6 && !c; page++) {
      const r = await getJson(`https://api.riftcodex.com/cards?set_id=${encodeURIComponent(q.set.toUpperCase())}&size=100&page=${page}`);
      const items: J[] = r?.items ?? [];
      c = items.find((i) => riftcodexKey(i) === key) ?? null;
      loose ??= items.find((i) => i.collector_number === num && !i.metadata?.alternate_art && !i.metadata?.signature) ?? items.find((i) => i.collector_number === num) ?? null;
      if (!r || page >= (r.pages ?? 1)) break;
    }
    c ??= loose;
  }
  if (!c && q.name) { const r = await getJson(`https://api.riftcodex.com/cards/name?fuzzy=${encodeURIComponent(q.name)}`); c = r?.items?.[0] ?? null; }
  if (!c) return none(src);
  return { found: true, raw: c, source: src, name: c.name, subtitle: [c.classification?.type, c.classification?.domain?.join?.("/"), c.classification?.rarity, c.set?.label, `#${c.collector_number}`].filter(Boolean).join(" · "), text: clean(c.text?.plain), image: safeImage(c.media?.image_url) };
}

export const RESOLVERS: Record<Game, (q: PreviewQuery) => Promise<CardPreview>> = {
  Lorcana: lorcana, "Magic: The Gathering": mtg, "Pokémon": pokemon, "Yu-Gi-Oh!": ygo, Riftbound: riftbound,
};

export function previewCacheKey(q: PreviewQuery): string {
  const p = new URLSearchParams({ g: q.game, s: q.set.toLowerCase(), n: collectorCore(q.number).toLowerCase(), m: q.name.toLowerCase(), v: "1" });
  return `https://hekla-preview.cache/${p.toString()}`;
}

export async function resolvePreview(q: PreviewQuery, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<CardPreview> {
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const key = new Request(previewCacheKey(q));
  if (cache) { const hit = await cache.match(key); if (hit) return await hit.json() as CardPreview; }
  let result: CardPreview;
  try { const { raw: _raw, ...rest } = await RESOLVERS[q.game](q); result = rest; } catch { return { found: false, source: "error", error: "Card source is not responding. Try again shortly." } as CardPreview; }
  if (cache) {
    const ttl = result.found ? 7 * 86400 : 6 * 3600;
    const put = cache.put(key, new Response(JSON.stringify(result), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` } }));
    ctx ? ctx.waitUntil(put) : await put;
  }
  return result;
}
