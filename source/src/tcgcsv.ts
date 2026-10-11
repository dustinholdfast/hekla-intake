/** TCGplayer market prices republished daily by tcgcsv.com (free, no key). */
type J = Record<string, any>;
export const TCGCSV_CATEGORY = { Riftbound: 89 } as const;
const TTL = 12 * 3600;

async function cachedJson(url: string, fetcher: typeof fetch = fetch): Promise<J | null> {
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const key = new Request(url);
  if (cache) { const hit = await cache.match(key); if (hit) return await hit.json() as J; }
  const r = await fetcher(url, { headers: { accept: "application/json", "user-agent": "hekla-intake" } });
  if (r.status === 429 || r.status >= 500) throw new Error(`tcgcsv ${r.status}`);
  if (!r.ok) return null;
  const text = await r.text();
  if (cache) await cache.put(key, new Response(text, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${TTL}` } }));
  return JSON.parse(text) as J;
}

import { riftboundNumberKey } from "./preview.ts";
const numCore = (s: string | null | undefined) => (String(s ?? "").split("/")[0].match(/\d+/)?.[0] ?? "").replace(/^0+(?=\d)/, "");
const norm = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const ext = (p: J, k: string) => (p.extendedData as J[] | undefined)?.find((e) => e.name === k)?.value as string | undefined;

/** Pure matcher: set file products + prices → price for finish. */
export function matchPrice(products: J[], prices: J[], q: { number: string; name: string; finish: string | null }): { price: number | null; productName?: string; subType?: string; mismatch?: boolean } {
  const want = numCore(q.number); const nm = norm(q.name);
  const cards = products.filter((p) => ext(p, "Number"));
  // SP6/006, 006/166 and R06 are different cards: match the printed number exactly before falling back to its digits.
  const key = riftboundNumberKey(q.number);
  const exact = want ? cards.filter((p) => riftboundNumberKey(ext(p, "Number")) === key) : [];
  let cands = exact.length ? exact : want ? cards.filter((p) => numCore(ext(p, "Number")) === want) : [];
  if (cands.length > 1 && nm) { const byName = cands.filter((p) => norm(p.name) === nm || norm(p.name).startsWith(nm)); if (byName.length) cands = byName; }
  if (!cands.length && nm) cands = cards.filter((p) => norm(p.name) === nm);
  if (!cands.length) return { price: null };
  // Prefer the plain printing (shortest name, no "(Alternate Art)" etc.)
  cands.sort((a, b) => String(a.name).length - String(b.name).length);
  const foil = /foil|special/i.test(q.finish ?? ""); // Special is a foil printing; TCGplayer has only Normal and Foil
  for (const p of cands) {
    const rows = prices.filter((x) => x.productId === p.productId);
    const pick = rows.find((x) => (foil ? /foil/i.test(x.subTypeName) : x.subTypeName === "Normal")) ?? (rows.length === 1 ? rows[0] : undefined);
    const v = pick ? (typeof pick.marketPrice === "number" ? pick.marketPrice : null) : null;
    if (v !== null) return { price: v, productName: p.name, subType: pick!.subTypeName, mismatch: (/foil/i.test(pick!.subTypeName)) !== foil };
  }
  return { price: null, productName: cands[0].name };
}

export async function tcgcsvPrice(categoryId: number, setCode: string, q: { number: string; name: string; finish: string | null }, fetcher?: typeof fetch): Promise<{ price: number | null; source: string; productName?: string }> {
  const groups = (await cachedJson(`https://tcgcsv.com/tcgplayer/${categoryId}/groups`, fetcher))?.results as J[] | undefined;
  const code = setCode.trim().toUpperCase();
  const group = groups?.find((g) => String(g.abbreviation).toUpperCase() === code);
  if (!group) return { price: null, source: `price unavailable (tcgcsv: no TCGplayer set ${code || "?"})` };
  const [prod, pr] = await Promise.all([cachedJson(`https://tcgcsv.com/tcgplayer/${categoryId}/${group.groupId}/products`, fetcher), cachedJson(`https://tcgcsv.com/tcgplayer/${categoryId}/${group.groupId}/prices`, fetcher)]);
  const m = matchPrice(prod?.results ?? [], pr?.results ?? [], q);
  if (m.price === null) return { price: null, source: `price unavailable (tcgcsv ${code}: ${m.productName ? "no market price" : "no match"})` };
  return { price: m.price, productName: m.productName, source: `TCGplayer market via tcgcsv (${code} ${m.subType}${m.mismatch ? `; only ${m.subType} printing exists, check finish` : ""})` };
}
