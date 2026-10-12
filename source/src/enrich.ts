/**
 * Auto-sort: rarity/type (catalog), market price (CardTrader only), rank + recommendation.
 * Rank = deterministic base (price, margin, condition, rarity) adjusted by Gemini within ±20.
 * Never writes Status. Recommendation is advisory.
 */
import { cardTraderPrice, type PriceLookup } from "./pricing.ts";
import { RESOLVERS, type PreviewQuery } from "./preview.ts";
import { effectiveGame, type Game } from "./sets.ts";

type J = Record<string, any>;
export type Recommendation = "List" | "Hold" | "Skip";
export const RECOMMENDATIONS: readonly Recommendation[] = ["List", "Hold", "Skip"];
export const RARITY_CHOICES = ["Common", "Uncommon", "Rare", "Super Rare", "Legendary", "Enchanted", "Promo", "Special"] as const;
export type RarityChoice = (typeof RARITY_CHOICES)[number];

export type EnrichInput = {
  id: string; game: string | null; setNumber: string | null; setIdentifier: string | null; collectorNumber: string | null;
  name: string; finish: string | null; condition: string | null; qty: number; costBasisUsd: number | null;
  rarity: string | null; resolvedName: string | null; marketPriceUsd?: number | null;
};
export type Catalog = { found: boolean; name?: string; cardType?: string; sourceRarity?: string; price: number | null; priceSource: string };
export type Decision = { rankScore: number; recommendation: Recommendation; reason: string; base: number; via: "gemini" | "rules" };

/* ---------- rarity / price extraction ---------- */
export function mapRarity(raw: string | undefined | null): RarityChoice | null {
  const r = (raw ?? "").toLowerCase().replace(/_/g, " ").trim();
  if (!r) return null;
  if (r.includes("enchanted")) return "Enchanted";
  if (r.includes("promo")) return "Promo";
  if (r === "legendary" || r === "mythic" || r.includes("mythic")) return "Legendary";
  if (r === "super rare" || r === "super_rare") return "Super Rare";
  if (r === "uncommon") return "Uncommon";
  if (r === "common") return "Common";
  if (r === "rare") return "Rare";
  return "Special";
}
/** Name, type and rarity from the game's catalog. The price is filled in afterwards from CardTrader. */
export function extractCatalog(game: Game, raw: J | undefined): Catalog {
  const none = { price: null, priceSource: "" };
  if (!raw) return { found: false, ...none };
  switch (game) {
    case "Lorcana":
      return { found: true, name: [raw.name, raw.version].filter(Boolean).join(" - "), cardType: (raw.type ?? []).join(" "), sourceRarity: raw.rarity, ...none };
    case "Magic: The Gathering":
      return { found: true, name: raw.name, cardType: raw.type_line ?? raw.card_faces?.[0]?.type_line, sourceRarity: raw.rarity, ...none };
    case "Pokémon":
      return { found: true, name: raw.name, cardType: [raw.supertype, ...(raw.subtypes ?? [])].filter(Boolean).join(" "), sourceRarity: raw.rarity, ...none };
    case "Yu-Gi-Oh!":
      return { found: true, name: raw.name, cardType: [raw.type, raw.race].filter(Boolean).join(" · "), sourceRarity: raw.card_sets?.[0]?.set_rarity, ...none };
    case "Riftbound":
      return { found: true, name: raw.name, cardType: raw.classification?.type, sourceRarity: raw.classification?.rarity, ...none };
  }
}

/* ---------- deterministic rank ---------- */
const CONDITION_PTS: Record<string, number> = { NM: 15, LP: 10, MP: 4, HP: 0, DMG: -5 };
const RARITY_PTS: Record<string, number> = { Common: 0, Uncommon: 2, Rare: 5, "Super Rare": 7, Legendary: 10, Enchanted: 12, Promo: 6, Special: 8 };
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function baseRank(price: number | null, cost: number | null, condition: string | null, rarity: string | null): number {
  let score = price === null ? 15 : Math.min(60, 25 * Math.log10(1 + price));
  if (price !== null && cost !== null && cost > 0) score += clamp(((price - cost) / cost) * 10, -15, 15);
  score += CONDITION_PTS[condition ?? "NM"] ?? 0;
  score += RARITY_PTS[rarity ?? ""] ?? 0;
  return Math.round(clamp(score, 0, 100));
}

export function rulesDecision(base: number, price: number | null): Decision {
  let recommendation: Recommendation; let reason: string;
  if (price === null) { recommendation = "Hold"; reason = "No market price available; review manually."; }
  else if (price < 1) { recommendation = "Skip"; reason = `Market price $${price.toFixed(2)} is below listing threshold.`; }
  else if (base >= 55) { recommendation = "List"; reason = `Strong score ${base} at $${price.toFixed(2)}.`; }
  else if (base >= 30) { recommendation = "Hold"; reason = `Middling score ${base} at $${price.toFixed(2)}.`; }
  else { recommendation = "Skip"; reason = `Low score ${base} at $${price.toFixed(2)}.`; }
  return { rankScore: base, recommendation, reason, base, via: "rules" };
}

/* ---------- Gemini ---------- */
// gemini-3.5-flash is deprecated and auto-routed to gemini-3.6-flash; call 3.6 directly, fall back to 3.5 Flash-Lite.
export const GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-3.6-flash"] as const;
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    rankScore: { type: "INTEGER", description: "0-100" },
    recommendation: { type: "STRING", enum: ["List", "Hold", "Skip"] },
    reason: { type: "STRING", description: "max 140 characters" },
  },
  required: ["rankScore", "recommendation", "reason"],
  propertyOrdering: ["rankScore", "recommendation", "reason"],
};

/** Strict allowlist validation of Gemini output. Returns null if anything is off. */
export function validateGemini(value: unknown): { rankScore: number; recommendation: Recommendation; reason: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as J;
  const keys = Object.keys(v);
  if (keys.some((k) => !["rankScore", "recommendation", "reason"].includes(k))) return null;
  if (!Number.isInteger(v.rankScore) || v.rankScore < 0 || v.rankScore > 100) return null;
  if (!RECOMMENDATIONS.includes(v.recommendation)) return null;
  if (typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 140) return null;
  return { rankScore: v.rankScore, recommendation: v.recommendation, reason: v.reason.trim().replace(/\s+/g, " ") };
}

export type EnrichMode = "waitlist" | "listed";
/** Listed rows reuse List/Hold/Skip as Keep/Watch/Pull. */
export const LISTED_LABELS: Record<Recommendation, string> = { List: "Keep", Hold: "Watch", Skip: "Pull" };

export function listedRulesDecision(base: number, price: number | null): Decision {
  let recommendation: Recommendation; let reason: string;
  if (price === null) { recommendation = "Hold"; reason = "Watch: no market price found; verify the listing price."; }
  else if (price < 0.25) { recommendation = "Skip"; reason = `Pull: $${price.toFixed(2)} is too low to be worth keeping listed.`; }
  else if (base >= 40) { recommendation = "List"; reason = `Keep: solid score ${base} at $${price.toFixed(2)}.`; }
  else { recommendation = "Hold"; reason = `Watch: modest score ${base} at $${price.toFixed(2)}.`; }
  return { rankScore: base, recommendation, reason, base, via: "rules" };
}

export function combine(base: number, gem: { rankScore: number; recommendation: Recommendation; reason: string }): Decision {
  const rankScore = Math.round(clamp(base + clamp(gem.rankScore - base, -20, 20), 0, 100));
  return { rankScore, recommendation: gem.recommendation, reason: gem.reason, base, via: "gemini" };
}

function prompt(card: EnrichInput, cat: Catalog, base: number, price: number | null, mode: EnrichMode = "waitlist"): string {
  const facts = {
    game: card.game, name: cat.name ?? card.name, cardType: cat.cardType ?? null, rarity: cat.sourceRarity ?? card.rarity, finish: card.finish,
    condition: card.condition, qty: card.qty, costBasisUsd: card.costBasisUsd, marketPriceUsd: price, priceSource: cat.price !== null ? cat.priceSource : price !== null ? "existing Airtable price" : cat.priceSource,
    deterministicBaseRank: base,
  };
  if (mode === "listed") return [
    "This card is ALREADY LISTED for sale on CardTrader by a small seller. marketPriceUsd is the going low price on CardTrader for the same card, finish and condition.",
    "Judge whether it is worth keeping listed. rankScore 0-100: higher = stronger listing worth keeping; lower = weakest, not worth the handling.",
    "recommendation: List = KEEP listed, Hold = WATCH/reprice, Skip = PULL (delist). Use these exact words List/Hold/Skip.",
    "Start from deterministicBaseRank and adjust by at most 20 points. If marketPriceUsd is null, never claim a price.",
    "reason: one plain sentence, max 140 characters, starting with Keep:, Watch:, or Pull:. No markdown.",
    `Card: ${JSON.stringify(facts)}`,
  ].join("\n");
  return [
    "You rank trading cards for a small seller who lists on CardTrader. marketPriceUsd is the going low price on CardTrader for the same card, finish and condition.",
    "Decide rankScore (0-100, higher = list sooner) and a recommendation: List (worth listing now), Hold (keep, revisit), Skip (not worth listing).",
    "Start from deterministicBaseRank and adjust by at most 20 points. Consider margin over cost, condition, rarity and quantity. If marketPriceUsd is null, never claim a price.",
    "reason: one plain sentence, max 140 characters, no markdown.",
    `Card: ${JSON.stringify(facts)}`,
  ].join("\n");
}

export async function askGemini(apiKey: string, text: string, fetcher: typeof fetch = fetch): Promise<unknown | null> {
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: "low" } },
  });
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let r: Response;
      try {
        r = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body, signal: AbortSignal.timeout(20000),
        });
      } catch { await sleep(500 * (attempt + 1)); continue; }
      if (!r.ok) {
        const detail = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
        console.warn("gemini error", model, r.status, detail);
        if (r.status === 404 || r.status === 400) break; // model/config unsupported → next model
        if (r.status === 429 || r.status >= 500) { await sleep(800 * (attempt + 1)); continue; }
        return null;
      }
      const data = await r.json() as J;
      const parts: J[] = data?.candidates?.[0]?.content?.parts ?? [];
      const out = parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("").trim();
      try { return JSON.parse(out); } catch { console.warn("gemini unparsable", model, data?.candidates?.[0]?.finishReason, out.slice(0, 120)); break; }
    }
  }
  return null;
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/* ---------- orchestration ---------- */
export type EnrichResult = { id: string; fields: Record<string, string | number | null>; decision: Decision; catalog: Catalog };

/**
 * Catalog facts for one card plus its CardTrader market price. Throws on an upstream 5xx/429 so the caller
 * retries later. A missing catalog match does not stop pricing: CardTrader is matched by set and number.
 */
export async function lookupCatalog(card: EnrichInput, env: Env, deps: { price?: PriceLookup } = {}): Promise<Catalog> {
  const game = effectiveGame(card.game) ?? "Lorcana";
  const q: PreviewQuery = { game, set: (game === "Lorcana" ? card.setNumber : card.setIdentifier) ?? "", number: card.collectorNumber ?? "", name: (card.resolvedName || card.name || "").slice(0, 120) };
  const preview = await RESOLVERS[game](q);
  const catalog = extractCatalog(game, preview.found ? preview.raw : undefined);
  const market = await (deps.price ?? cardTraderPrice)(env, card);
  return { ...catalog, price: market.price, priceSource: market.source };
}

/** Has the market price moved? A missing catalog price is never a change, so an existing price is never cleared. */
export function priceMove(stored: number | null | undefined, catalogPrice: number | null): { changed: boolean; from: number | null; to: number | null } {
  const from = stored ?? null;
  if (catalogPrice === null) return { changed: false, from, to: from };
  return { changed: from === null || Math.round(from * 100) !== Math.round(catalogPrice * 100), from, to: catalogPrice };
}

export async function enrichOne(card: EnrichInput, env: Env, deps: { fetcher?: typeof fetch; now?: () => Date; mode?: EnrichMode; catalog?: Catalog; price?: PriceLookup } = {}): Promise<EnrichResult> {
  const mode: EnrichMode = deps.mode ?? "waitlist";
  const catalog = deps.catalog ?? await lookupCatalog(card, env, deps);
  const rarity = (card.rarity as RarityChoice | null) || mapRarity(catalog.sourceRarity);
  const priceForRank = catalog.price ?? card.marketPriceUsd ?? null;
  const base = baseRank(priceForRank, card.costBasisUsd, card.condition, rarity);
  let decision = mode === "listed" ? listedRulesDecision(base, priceForRank) : rulesDecision(base, priceForRank);
  const key = env.GEMINI_API_KEY?.trim();
  if (key && catalog.found) {
    const gem = validateGemini(await askGemini(key, prompt(card, catalog, base, priceForRank, mode), deps.fetcher));
    if (gem) decision = combine(base, gem);
    else decision = { ...decision, reason: `${decision.reason} (rules; AI unavailable)`.slice(0, 140) };
  } else if (!catalog.found) {
    decision = { ...decision, recommendation: "Hold", reason: mode === "listed" ? "Watch: no catalog match for this set/number; check the entry." : "No catalog match for this set/number; check entry." };
  }
  const fields: Record<string, string | number | null> = {
    "Auto Rank": decision.rankScore,
    Recommendation: decision.recommendation,
    "Rank Reason": decision.reason.slice(0, 140),
    "Price Source": catalog.priceSource,
    "Card Type": [catalog.cardType, catalog.sourceRarity && `(${catalog.sourceRarity})`].filter(Boolean).join(" ").slice(0, 200) || null,
    "Enriched At": (deps.now ?? (() => new Date()))().toISOString(),
  };
  // Price: write only a real CardTrader price; never clear a price that is already there.
  if (catalog.price !== null) fields["Market Price USD"] = catalog.price;
  else if (card.marketPriceUsd != null) fields["Price Source"] = `${catalog.priceSource}; kept existing price`.slice(0, 200);
  if (!card.rarity && rarity) fields.Rarity = rarity;
  if (!card.resolvedName && catalog.name) fields["Resolved Name"] = catalog.name;
  return { id: card.id, fields, decision, catalog };
}

export const ENRICH_WRITABLE = ["Auto Rank", "Recommendation", "Rank Reason", "Market Price USD", "Price Source", "Card Type", "Enriched At", "Rarity", "Resolved Name"] as const;
export function assertEnrichFields(fields: Record<string, unknown>): void {
  for (const k of Object.keys(fields)) if (!(ENRICH_WRITABLE as readonly string[]).includes(k)) throw new Error(`Enrichment may not write ${k}.`);
  if (fields.Recommendation !== undefined && !RECOMMENDATIONS.includes(fields.Recommendation as Recommendation)) throw new Error("Bad recommendation.");
  if (fields.Rarity !== undefined && !(RARITY_CHOICES as readonly string[]).includes(fields.Rarity as string)) throw new Error("Bad rarity.");
}
