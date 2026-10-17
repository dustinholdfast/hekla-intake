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

/** Lowercased word tokens; dashes, en/em-dashes, commas, apostrophes and other punctuation are separators. */
const nameTokens = (s: string | null | undefined): string[] =>
  (s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/['\u2019`]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
const containsSeq = (hay: string[], needle: string[]) => {
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((t, j) => hay[i + j] === t)) return true;
  return false;
};
/** Both sides of a "Name - Subtitle" split (hyphen, en-dash or em-dash surrounded by spaces). */
const dashParts = (s: string) => s.split(/\s+[-\u2013\u2014]\s+/).map((p) => p.trim()).filter(Boolean);

/**
 * Whether a stored card name and a CardTrader name refer to the same card. Accepts equal names after
 * normalizing, a stored name equal to either side of a " - " split (champion/character prefix or
 * Lorcana version), or one name containing the other as a full token sequence of at least two words.
 */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  const eq = (x: string[], y: string[]) => x.length === y.length && x.every((t, i) => t === y[i]);
  if (eq(ta, tb) || ta.join("") === tb.join("")) return true;
  for (const [x, y] of [[a ?? "", tb], [b ?? "", ta]] as const) {
    const parts = dashParts(x);
    if (parts.length > 1 && parts.some((p) => eq(nameTokens(p), y))) return true;
  }
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return short.length >= 2 && containsSeq(long, short);
}
const sameName = namesMatch;
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
  if (card.resolvedName && !sameName(card.resolvedName, blueprint.name) && !sameName(card.resolvedName, `${blueprint.name} - ${blueprint.version ?? ""}`)) {
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
/**
 * CardTrader allows 200 requests per 10 seconds across all endpoints. This keeps one isolate under 150, which
 * leaves room for starfoil-lgs, which uses the same account. A 429 is surfaced to the caller (status 429).
 */
const CT_WINDOW_MS = 10_000;
export const CT_WINDOW_MAX = 150;
const recentCalls: number[] = [];
export async function ctRateGate(now: () => number = Date.now, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  for (;;) {
    const t = now();
    while (recentCalls.length && t - recentCalls[0]! >= CT_WINDOW_MS) recentCalls.shift();
    if (recentCalls.length < CT_WINDOW_MAX) { recentCalls.push(t); return; }
    await wait(CT_WINDOW_MS - (t - recentCalls[0]!) + 5);
  }
}
export function resetCtRateGate(): void { recentCalls.length = 0; }

async function call(token: string, path: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<J> {
  await ctRateGate();
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
export async function cardTraderMarket(token: string, cacheKey: string, card: { game: string | null; setNumber?: string | null; setIdentifier?: string | null; collectorNumber: string | null; finish: string | null; condition: string | null }): Promise<{ price: number | null; source: string; card?: MatchedCard }> {
  const match = await findBlueprint(token, card);
  if ("reason" in match) return { price: null, source: `CardTrader: ${match.reason.replace(/^CardTrader has /, "")}`.slice(0, 200) };
  const matched = matchedCard(match.blueprint);
  const priced = await priceBlueprint(token, cacheKey, match.blueprint, card);
  return { ...priced, card: matched };
}

/** The card CardTrader has at that number: enough to name and rate a card when its game's catalog is down. */
export type MatchedCard = { name: string; rarity: string | null };
export function matchedCard(blueprint: Blueprint): MatchedCard {
  const rarity = Object.entries(blueprint.fixed_properties ?? {}).find(([key]) => key.endsWith("_rarity"))?.[1];
  return { name: blueprint.name, rarity: typeof rarity === "string" && rarity ? rarity : null };
}

async function priceBlueprint(token: string, cacheKey: string, blueprint: Blueprint, card: { finish: string | null; condition: string | null }): Promise<{ price: number | null; source: string }> {
  const condition = CARDTRADER_CONDITION[card.condition ?? ""];
  if (!condition) return { price: null, source: `CardTrader: no price for condition ${card.condition ?? "blank"}` };
  const wantFoil = card.finish === "Foil" || card.finish === "Special" || card.finish === "Enchanted";
  const hasFoilSwitch = (blueprint.editable_properties ?? []).some((p) => typeof p.name === "string" && p.name.endsWith("_foil"));
  const market = marketPrice(await marketplaceOffers(token, cacheKey, blueprint.id), { condition, foil: hasFoilSwitch ? wantFoil : null });
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

/* ---------- sales sync (orders, stock, webhook) ---------- */

/** The newest seller orders, newest first. One request. */
export async function sellerOrders(token: string, limit = 50, fetcher?: typeof fetch): Promise<J[]> {
  const body = await call(token, `/orders?order_as=seller&limit=${Math.min(100, Math.max(1, limit))}&sort=date.desc`, {}, fetcher) as unknown;
  const list = Array.isArray(body) ? body : Array.isArray((body as J)?.array) ? (body as J).array : [];
  return (list as J[]).filter((o) => o?.order_as === "seller");
}

export type CtListing = { id: number; blueprintId: number; quantity: number; recordId: string | null; priceCents: number | null };
/** Every listing on the account, in one request (the same export starfoil-lgs reads). */
export async function exportListings(token: string, fetcher?: typeof fetch): Promise<CtListing[]> {
  const body = await call(token, "/products/export", {}, fetcher) as unknown;
  if (!Array.isArray(body)) throw new CardTraderError("CardTrader returned an unexpected products export.", 502);
  return (body as J[]).map((l) => ({
    id: Number(l.id), blueprintId: Number(l.blueprint_id), quantity: Number(l.quantity) || 0,
    recordId: typeof l.user_data_field === "string" && /^rec[A-Za-z0-9]{14}$/.test(l.user_data_field) ? l.user_data_field : null,
    priceCents: typeof l.price_cents === "number" ? l.price_cents : null,
  }));
}

/** Changes a listing's quantity by delta. At 0 or below CardTrader deletes the listing. */
export async function incrementListing(token: string, productId: number, delta: number, fetcher?: typeof fetch): Promise<void> {
  if (!Number.isInteger(delta) || delta === 0) return;
  await call(token, `/products/${productId}/increment`, { method: "POST", body: JSON.stringify({ delta_quantity: delta }) }, fetcher);
}

export type AppInfo = { id: number | null; name: string | null; userId: string | null; sharedSecret: string | null; webhookUrl: string | null };
export async function appInfo(token: string, fetcher?: typeof fetch): Promise<AppInfo> {
  const b = await call(token, "/info", {}, fetcher);
  return {
    id: typeof b.id === "number" ? b.id : null, name: typeof b.name === "string" ? b.name : null, userId: b.user_id == null ? null : String(b.user_id),
    sharedSecret: typeof b.shared_secret === "string" && b.shared_secret ? b.shared_secret : null, webhookUrl: typeof b.webhook_url === "string" && b.webhook_url ? b.webhook_url : null,
  };
}
/** Sets the account's one webhook URL. An empty string turns CardTrader webhooks off. */
export async function setWebhookUrl(token: string, url: string, fetcher?: typeof fetch): Promise<string | null> {
  const b = await call(token, "/app", { method: "PATCH", body: JSON.stringify({ webhook_url: url }) }, fetcher);
  return typeof b.webhook_url === "string" && b.webhook_url ? b.webhook_url : null;
}

/* ---------- set list for intake ---------- */
export type SetOption = { code: string; name: string };

/**
 * CardTrader's expansions for one game, as {code, name}, newest first (CardTrader ids grow over time).
 * Outside Lorcana the Set Identifier must be CardTrader's own code (see expansionCode), so this is the list
 * the intake form offers. Uses the same 24-hour catalogue cache as blueprint lookup.
 */
export async function expansionsFor(token: string, game: Game): Promise<SetOption[]> {
  const all = await cachedCatalogue(token, "/expansions", 24 * 3600) as unknown as J[];
  return setOptions(Array.isArray(all) ? all : [], CARDTRADER_GAMES[game].gameId);
}
export function setOptions(expansions: J[], gameId: number): SetOption[] {
  const seen = new Set<string>();
  return expansions
    .filter((e) => e && e.game_id === gameId && typeof e.code === "string" && e.code.trim() && typeof e.name === "string")
    .sort((a, b) => Number(b.id) - Number(a.id))
    .map((e) => ({ code: String(e.code).trim().toLowerCase(), name: String(e.name).trim() }))
    .filter((s) => (seen.has(s.code) ? false : (seen.add(s.code), true)));
}

/** "fdn", "FDN", "fdn — Foundations" or the exact set name → the code, if it is one of the options. */
export function resolveSetInput(input: string, options: SetOption[]): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  const head = raw.split(/\s+[—–-]\s+/)[0]!.trim();
  return options.find((o) => o.code === head || o.code === raw)?.code ?? options.find((o) => o.name.toLowerCase() === raw)?.code ?? null;
}
