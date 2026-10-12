/**
 * CardTrader export. Matches Waitlist cards to CardTrader blueprints and, only after the seller approves a
 * batch, lists them through the seller's own token. Prices are the stored market price, unchanged.
 * Nothing here runs on a schedule. A card's Status becomes Listed only after CardTrader confirms its listing.
 */
import { riftboundNumberKey } from "./preview.ts";
import { effectiveGame, type Game } from "./sets.ts";

type J = Record<string, any>;
const API = "https://api.cardtrader.com/api/v2";

export class CardTraderError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** CardTrader's game id and the category that holds single cards. */
export const CARDTRADER_GAMES: Record<Game, { gameId: number; singlesCategoryId: number }> = {
  Lorcana: { gameId: 18, singlesCategoryId: 214 },
  Riftbound: { gameId: 22, singlesCategoryId: 258 },
  "Magic: The Gathering": { gameId: 1, singlesCategoryId: 1 },
  "Pokémon": { gameId: 5, singlesCategoryId: 73 },
  "Yu-Gi-Oh!": { gameId: 4, singlesCategoryId: 44 },
};

export const CARDTRADER_CONDITION: Record<string, string> = { NM: "Near Mint", LP: "Slightly Played", MP: "Moderately Played", HP: "Played", DMG: "Poor" };

export type ExportCard = {
  id: string; game: string | null; setNumber: string | null; setIdentifier: string | null; collectorNumber: string | null;
  name: string; resolvedName: string | null; finish: string | null; condition: string | null; qty: number;
  status: string | null; marketPriceUsd: number | null; priceSource: string | null; cardTraderListingId: string | null;
};
export type Blueprint = { id: number; name: string; version?: string | null; category_id: number; expansion_id: number; fixed_properties?: J; editable_properties?: J[] };
export type Product = { blueprint_id: number; price: number; quantity: number; error_mode: "strict"; user_data_field: string; properties: Record<string, string | boolean> };
export type ExportRow =
  | { id: string; ready: true; name: string; cardTraderName: string; condition: string; foil: boolean; quantity: number; price: number; product: Product }
  | { id: string; ready: false; name: string; reason: string };

/**
 * The CardTrader expansion code for a card's set, or null when the set has no single counterpart.
 * Outside Lorcana the set identifier is used as typed, so it has to be CardTrader's own code for the set.
 */
export function expansionCode(game: Game, card: { setNumber?: string | null; setIdentifier?: string | null }): string | null {
  if (game !== "Lorcana") return card.setIdentifier?.trim().toLowerCase() || null;
  {
    const set = (card.setNumber ?? "").trim().toUpperCase();
    if (set === "1") return "ch1";
    if (/^\d+$/.test(set)) return `lor${Number(set)}`;
    const quest = /^Q(\d)$/.exec(set);
    if (quest) return `quest${quest[1]}`;
  }
  return null; // Lorcana "P" spans several CardTrader promo sets
}

const sameName = (a: string | null | undefined, b: string | null | undefined) => {
  const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return norm(a) === norm(b);
};
const displayName = (b: Blueprint) => [b.name, b.version].filter(Boolean).join(" · ");

/** Exactly one single card in the expansion with this printed number, or the reason there is not. */
export function matchBlueprint(blueprints: Blueprint[], singlesCategoryId: number, collectorNumber: string | null): { blueprint: Blueprint } | { reason: string } {
  const key = riftboundNumberKey(collectorNumber);
  if (!key) return { reason: "No collector number." };
  const hits = blueprints.filter((b) => b.category_id === singlesCategoryId && riftboundNumberKey(String(b.fixed_properties?.collector_number ?? "")) === key);
  if (hits.length === 0) return { reason: `CardTrader has no card numbered ${collectorNumber} in this set.` };
  if (hits.length > 1) return { reason: `CardTrader has ${hits.length} cards numbered ${collectorNumber} in this set; list this one by hand.` };
  return { blueprint: hits[0]! };
}

/** Turns one card and its blueprint into the product CardTrader would list, or says why it cannot be listed. */
export function buildRow(card: ExportCard, blueprint: Blueprint): ExportRow {
  const name = card.resolvedName || card.name || card.collectorNumber || card.id;
  const no = (reason: string): ExportRow => ({ id: card.id, ready: false, name, reason });
  if (card.resolvedName && !sameName(card.resolvedName, blueprint.name) && !sameName(card.resolvedName, `${blueprint.name}${blueprint.version ?? ""}`)) {
    return no(`CardTrader has "${displayName(blueprint)}" at this number, not "${card.resolvedName}". Check the set and number.`);
  }
  const price = card.marketPriceUsd;
  if (price == null || !(price >= 0.01)) return no("No market price yet.");
  if (!(card.priceSource ?? "").startsWith("CardTrader market")) return no("This price is not from CardTrader yet. Run Scan for changes first.");
  if (!Number.isInteger(card.qty) || card.qty < 1) return no("Quantity must be at least 1.");
  const editable = blueprint.editable_properties ?? [];
  const condition = CARDTRADER_CONDITION[card.condition ?? ""];
  const allowed: unknown[] = editable.find((p) => p.name === "condition")?.possible_values ?? [];
  if (!condition || !allowed.includes(condition)) return no(`CardTrader does not accept condition ${card.condition ?? "blank"} for this card.`);
  const wantFoil = card.finish === "Foil" || card.finish === "Special" || card.finish === "Enchanted";
  const foilProperty = editable.find((p) => typeof p.name === "string" && p.name.endsWith("_foil"));
  // No foil switch means CardTrader sells this card in one finish only (for Riftbound rares and up, that is foil).
  if (!foilProperty && !wantFoil) return no("CardTrader lists this card in a single finish, which is foil. Check the Finish on this row.");
  const properties: Record<string, string | boolean> = { condition };
  if (foilProperty) properties[foilProperty.name] = wantFoil;
  const product: Product = { blueprint_id: blueprint.id, price: Math.round(price * 100) / 100, quantity: card.qty, error_mode: "strict", user_data_field: card.id, properties };
  return { id: card.id, ready: true, name, cardTraderName: displayName(blueprint), condition, foil: wantFoil, quantity: card.qty, price: product.price, product };
}

/* ---------- CardTrader API ---------- */
async function call(token: string, path: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<J> {
  let response: Response;
  try {
    response = await fetcher(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) }, signal: AbortSignal.timeout(20000) });
  } catch {
    throw new CardTraderError("Could not reach CardTrader.", 502);
  }
  const text = await response.text();
  let body: J | null = null;
  try { body = JSON.parse(text) as J; } catch { /* not json */ }
  if (!response.ok) {
    const detail = body?.error ?? body?.errors ?? body?.extra?.message ?? text;
    const message = (typeof detail === "string" ? detail : JSON.stringify(detail)).replace(/\s+/g, " ").slice(0, 200);
    throw new CardTraderError(response.status === 401 ? "CardTrader no longer accepts the saved token. Reconnect it in Settings." : `CardTrader said: ${message || response.status}`, response.status);
  }
  return body ?? {};
}

/** Catalogue data is the same for every seller, so it is cached without the token. */
async function cachedCatalogue(token: string, path: string, ttlSeconds: number): Promise<J> {
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const key = new Request(`https://hekla-cardtrader.cache${path}`);
  if (cache) { const hit = await cache.match(key); if (hit) return await hit.json() as J; }
  const body = await call(token, path);
  if (cache) await cache.put(key, new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttlSeconds}` } }));
  return body;
}

async function expansionId(token: string, gameId: number, code: string): Promise<number | null> {
  const all = await cachedCatalogue(token, "/expansions", 24 * 3600) as unknown as J[];
  const hit = (Array.isArray(all) ? all : []).find((e) => e.game_id === gameId && String(e.code).toLowerCase() === code);
  return typeof hit?.id === "number" ? hit.id : null;
}

/** Slimmed before caching: only the fields matching and listing need. */
async function blueprintsFor(token: string, id: number): Promise<Blueprint[]> {
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const key = new Request(`https://hekla-cardtrader.cache/blueprints/${id}`);
  if (cache) { const hit = await cache.match(key); if (hit) return await hit.json() as Blueprint[]; }
  const raw = await call(token, `/blueprints/export?expansion_id=${id}`) as unknown as J[];
  const slim: Blueprint[] = (Array.isArray(raw) ? raw : []).map((b) => ({ id: b.id, name: b.name, version: b.version, category_id: b.category_id, expansion_id: b.expansion_id, fixed_properties: b.fixed_properties, editable_properties: b.editable_properties }));
  if (cache) await cache.put(key, new Response(JSON.stringify(slim), { headers: { "content-type": "application/json", "cache-control": "public, max-age=43200" } }));
  return slim;
}

/** The one CardTrader blueprint for a card's game, set and printed number, or the reason there is none. */
export async function findBlueprint(token: string, card: { game: string | null; setNumber?: string | null; setIdentifier?: string | null; collectorNumber: string | null }): Promise<{ blueprint: Blueprint } | { reason: string }> {
  const game = effectiveGame(card.game);
  if (!game) return { reason: `${card.game ?? "This game"} is not on CardTrader.` };
  const config = CARDTRADER_GAMES[game];
  const code = expansionCode(game, card);
  const expansion = code ? await expansionId(token, config.gameId, code) : null;
  if (!expansion) return { reason: code ? `CardTrader has no ${game} set with code ${code}.` : "This set has no single CardTrader counterpart." };
  return matchBlueprint(await blueprintsFor(token, expansion), config.singlesCategoryId, card.collectorNumber);
}

/* ---------- market price ---------- */
export type Offer = { price?: { cents?: number; currency?: string }; properties_hash?: J };
export type MarketPrice = { price: number; offers: number; currency: string };

/**
 * The going low price: the median of the five cheapest offers for the same finish and condition, English only.
 * One lowball listing cannot drag it down, and it stays close to what a buyer actually pays.
 * Returns null when nobody offers this exact card, finish and condition.
 */
export function marketPrice(offers: Offer[], want: { condition: string; foil: boolean | null }): MarketPrice | null {
  const matching = offers.filter((offer) => {
    const props = offer.properties_hash ?? {};
    const language = Object.entries(props).find(([key]) => key.endsWith("_language"))?.[1];
    const foil = Object.entries(props).find(([key]) => key.endsWith("_foil"))?.[1];
    return (language === undefined || language === "en") && props.condition === want.condition
      && (want.foil === null || foil === undefined || Boolean(foil) === want.foil)
      && typeof offer.price?.cents === "number" && offer.price.cents > 0;
  });
  if (matching.length === 0) return null;
  const cheapest = matching.map((offer) => offer.price!.cents!).sort((a, b) => a - b).slice(0, 5);
  return { price: cheapest[Math.floor((cheapest.length - 1) / 2)]! / 100, offers: matching.length, currency: String(matching[0]!.price?.currency ?? "") };
}

// CardTrader asks for about one marketplace call a second.
let lastMarketCall = 0;
async function marketplaceOffers(token: string, cacheKey: string, blueprintId: number): Promise<Offer[]> {
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const key = new Request(`https://hekla-cardtrader.cache/market/${cacheKey}/${blueprintId}`);
  if (cache) { const hit = await cache.match(key); if (hit) return await hit.json() as Offer[]; }
  const wait = lastMarketCall + 1000 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastMarketCall = Date.now();
  const body = await call(token, `/marketplace/products?blueprint_id=${blueprintId}&language=en`);
  const offers: Offer[] = (Array.isArray(body[String(blueprintId)]) ? body[String(blueprintId)] : []).map((o: J) => ({ price: { cents: o.price?.cents, currency: o.price?.currency }, properties_hash: o.properties_hash }));
  if (cache) await cache.put(key, new Response(JSON.stringify(offers), { headers: { "content-type": "application/json", "cache-control": "public, max-age=1800" } }));
  return offers;
}

/** The CardTrader market price for one card, with a source line that always starts with "CardTrader". */
export async function cardTraderMarket(token: string, cacheKey: string, card: { game: string | null; setNumber?: string | null; setIdentifier?: string | null; collectorNumber: string | null; finish: string | null; condition: string | null }): Promise<{ price: number | null; source: string }> {
  const match = await findBlueprint(token, card);
  if ("reason" in match) return { price: null, source: `CardTrader: ${match.reason.replace(/^CardTrader has /, "")}`.slice(0, 200) };
  const condition = CARDTRADER_CONDITION[card.condition ?? ""];
  if (!condition) return { price: null, source: `CardTrader: no price for condition ${card.condition ?? "blank"}` };
  const wantFoil = card.finish === "Foil" || card.finish === "Special" || card.finish === "Enchanted";
  const hasFoilSwitch = (match.blueprint.editable_properties ?? []).some((p) => typeof p.name === "string" && p.name.endsWith("_foil"));
  const market = marketPrice(await marketplaceOffers(token, cacheKey, match.blueprint.id), { condition, foil: hasFoilSwitch ? wantFoil : null });
  const what = `${condition}${hasFoilSwitch ? (wantFoil ? " foil" : " non-foil") : ""}`;
  if (!market) return { price: null, source: `CardTrader: no ${what} offers in English right now` };
  if (market.currency !== "USD") return { price: null, source: `CardTrader: prices are in ${market.currency || "another currency"}, not USD` };
  const note = !hasFoilSwitch && !wantFoil ? "; single finish on CardTrader, check Finish" : "";
  return { price: market.price, source: `CardTrader market (${what}, ${market.offers} offer${market.offers === 1 ? "" : "s"}${note})` };
}

/** What each card would become on CardTrader. Read-only: nothing is listed. */
export async function previewExport(token: string, cards: ExportCard[]): Promise<ExportRow[]> {
  const rows: ExportRow[] = [];
  for (const card of cards) {
    const name = card.resolvedName || card.name || card.collectorNumber || card.id;
    const no = (reason: string) => { rows.push({ id: card.id, ready: false, name, reason }); };
    if (card.status !== "Waitlist") { no("Only Waitlist cards can be exported."); continue; }
    if (card.cardTraderListingId) { no(`Already listed on CardTrader (listing ${card.cardTraderListingId}).`); continue; }
    const match = await findBlueprint(token, card);
    if ("reason" in match) { no(match.reason); continue; }
    rows.push(buildRow(card, match.blueprint));
  }
  return rows;
}

export type Listing = { productId: number; currency: string; cents: number };

/** Lists one product. The seller approved this exact batch before this is called. */
export async function createProduct(token: string, product: Product, fetcher?: typeof fetch): Promise<Listing> {
  const body = await call(token, "/products", { method: "POST", body: JSON.stringify(product) }, fetcher);
  const resource = body.resource as J | undefined;
  if (typeof resource?.id !== "number") throw new CardTraderError("CardTrader did not confirm the listing.", 502);
  return { productId: resource.id, currency: String(resource.price?.currency ?? ""), cents: Number(resource.price?.cents ?? NaN) };
}

export async function deleteProduct(token: string, productId: number, fetcher?: typeof fetch): Promise<void> {
  await call(token, `/products/${productId}`, { method: "DELETE" }, fetcher);
}
