import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIconIndex, coreEnd, groupMagicSets, iconFile, iconFor, setIconSvg, slimSets, withIcons } from "./scryfall.ts";

const RAW = [
  { code: "dom", name: "Dominaria", mtgo_code: "dar", arena_code: "dar", icon_svg_uri: "https://svgs.scryfall.io/sets/dom.svg?1700" },
  { code: "pdom", name: "Dominaria Promos", parent_set_code: "dom", icon_svg_uri: "https://svgs.scryfall.io/sets/dom.svg?1700" },
  { code: "tdom", name: "Dominaria Tokens", parent_set_code: "dom", icon_svg_uri: "https://svgs.scryfall.io/sets/dom.svg?1700" },
  { code: "fdn", name: "Foundations", icon_svg_uri: "https://svgs.scryfall.io/sets/fdn.svg?1730" },
  { code: "con", name: "Conflux", mtgo_code: "cfx", icon_svg_uri: "https://svgs.scryfall.io/sets/con.svg?1" },
  { code: "lea", name: "Limited Edition Alpha", icon_svg_uri: "https://svgs.scryfall.io/sets/lea.svg?1" },
  { code: "mh3", name: "Modern Horizons 3", icon_svg_uri: "https://evil.example/mh3.svg" },
];
const index = buildIconIndex(slimSets(RAW));

test("iconFile only accepts Scryfall's set-icon URLs", () => {
  assert.equal(iconFile("https://svgs.scryfall.io/sets/dom.svg?1700"), "dom");
  assert.equal(iconFile("https://evil.example/sets/dom.svg"), null);
  assert.equal(iconFile("https://svgs.scryfall.io/sets/../x.svg"), null);
  assert.equal(iconFile(undefined), null);
});

test("iconFor: exact code in any case, MTGO/Arena alias, promo/token prefix, name, name without suffix", () => {
  const f = (code: string, name = "") => iconFor({ code, name }, index);
  assert.equal(f("DOM"), "dom");
  assert.equal(f("dar"), "dom", "Arena/MTGO code");
  assert.equal(f("cfx"), "con");
  assert.equal(f("pfdn"), "fdn", "promo prefix without a Scryfall set of its own");
  assert.equal(f("tfdn"), "fdn", "token prefix");
  assert.equal(f("xyz1", "Limited Edition Alpha"), "lea", "different code, same name");
  assert.equal(f("abc", "Foundations Promos"), "fdn", "name without the Promos suffix");
  assert.equal(f("abc", "Foundations: Extras"), "fdn");
  assert.equal(f("mh3", "Modern Horizons 3"), null, "an icon from another host is ignored");
  assert.equal(f("zzz", "Unknown Set"), null, "no icon, no guess");
});

test("withIcons counts matches", () => {
  const r = withIcons([{ code: "dom", name: "Dominaria" }, { code: "zzz", name: "Nope" }, { code: "fdn", name: "Foundations" }], index);
  assert.equal(r.matched, 2);
  assert.deepEqual(r.sets.map((s) => s.icon), ["dom", null, "fdn"]);
});

test("setIconSvg fetches only listed icons, with a User-Agent and Accept, and rejects non-SVG bodies", async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url === "https://api.scryfall.com/sets") return new Response(JSON.stringify({ data: [...RAW, ...Array.from({ length: 100 }, (_, i) => ({ code: `x${i}`, name: `X ${i}` }))] }));
    if (url.endsWith("/dom.svg")) return new Response('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
    if (url.endsWith("/fdn.svg")) return new Response("<html>not an svg</html>");
    return new Response("", { status: 404 });
  }) as typeof fetch;
  assert.match((await setIconSvg("dom", fetcher))!, /^<\?xml/);
  assert.equal(await setIconSvg("fdn", fetcher), null, "not an SVG");
  assert.equal(await setIconSvg("nope", fetcher), null, "not a Scryfall icon: never fetched");
  assert.equal(await setIconSvg("../etc", fetcher), null);
  assert.ok(!seen.some((s) => s.url.endsWith("/nope.svg")));
  for (const s of seen) { assert.match(s.headers["user-agent"]!, /^HeklaIntake\//); assert.ok(s.headers.accept); }
});

const ICON = (c: string) => `https://svgs.scryfall.io/sets/${c}.svg?1`;
const GRAW = [
  { code: "lea", name: "Limited Edition Alpha", set_type: "core", released_at: "1993-08-05", icon_svg_uri: ICON("lea") },
  { code: "dom", name: "Dominaria", set_type: "expansion", released_at: "2018-04-27", mtgo_code: "dar", icon_svg_uri: ICON("dom") },
  { code: "pdom", name: "Dominaria Promos", set_type: "promo", released_at: "2018-04-27", parent_set_code: "dom", icon_svg_uri: ICON("dom") },
  { code: "fdn", name: "Foundations", set_type: "core", released_at: "2024-11-15", icon_svg_uri: ICON("fdn") },
  { code: "mh3", name: "Modern Horizons 3", set_type: "masters", released_at: "2024-06-14", icon_svg_uri: ICON("mh3") },
  { code: "fra", name: "Reality Fracture", set_type: "expansion", released_at: "2026-10-02", icon_svg_uri: ICON("fra") },
  { code: "pfra", name: "Reality Fracture Promos", set_type: "promo", released_at: "2026-10-02", icon_svg_uri: ICON("fra") },
  { code: "frc", name: "Reality Fracture Commander", set_type: "commander", released_at: "2026-10-02", icon_svg_uri: ICON("frc") },
  { code: "yfra", name: "Alchemy: Reality Fracture", set_type: "alchemy", digital: true, released_at: "2026-10-13", icon_svg_uri: ICON("y26") },
  { code: "trk", name: "Star Trek", set_type: "expansion", released_at: "2026-11-13", icon_svg_uri: ICON("trk") },
  { code: "kld", name: "Kaladesh Remastered", set_type: "expansion", digital: true, released_at: "2020-11-12", icon_svg_uri: ICON("kld") },
];
const gindex = buildIconIndex(slimSets(GRAW));
// CardTrader order: newest first.
const CT = [
  { code: "trk", name: "Star Trek" }, { code: "frc", name: "Reality Fracture Commander" }, { code: "pfra", name: "Reality Fracture Promos" },
  { code: "fra", name: "Reality Fracture" }, { code: "xfra", name: "Reality Fracture Art Series" }, { code: "fdn", name: "Foundations" },
  { code: "mh3", name: "Modern Horizons 3" }, { code: "dar", name: "Dominaria (CT)" }, { code: "pdom", name: "Dominaria Promos" },
  { code: "kld", name: "Kaladesh Remastered" }, { code: "alpha", name: "Limited Edition Alpha" }, { code: "zzz", name: "Mystery Box" },
];

test("coreEnd finds Reality Fracture as a paper expansion", () => {
  assert.deepEqual([coreEnd(gindex)?.code, coreEnd(gindex)?.released], ["fra", "2026-10-02"]);
  assert.equal(coreEnd(buildIconIndex(slimSets(GRAW.filter((s) => s.code !== "fra")))), null);
});

test("groupMagicSets: core/expansion paper sets oldest first ending with Reality Fracture, then the rest newest first", () => {
  const r = groupMagicSets(CT, gindex);
  assert.deepEqual(r.end, { code: "fra", released: "2026-10-02" });
  assert.equal(r.core, 4);
  assert.deepEqual(r.sets.filter((s) => s.group === "core").map((s) => s.code), ["alpha", "dar", "fdn", "fra"], "matched by name and by MTGO code; ends with RF");
  assert.deepEqual(r.sets.filter((s) => s.group === "other").map((s) => s.code),
    ["trk", "frc", "pfra", "mh3", "kld", "pdom", "xfra", "zzz"],
    "later premier set (Star Trek) first, then newest first; digital and unknown sets below; no-date last in CardTrader order");
  assert.equal(r.sets.length, CT.length);
});

test("groupMagicSets never promotes a promo/token code by stripping its prefix", () => {
  const r = groupMagicSets([{ code: "pfdn", name: "Foundations Promo Pack" }, { code: "tfra", name: "Reality Fracture Tokens" }], gindex);
  assert.deepEqual(r.sets.map((s) => s.group), ["other", "other"]);
});

test("groupMagicSets without Reality Fracture leaves the order alone", () => {
  const r = groupMagicSets(CT, buildIconIndex(slimSets(GRAW.filter((s) => s.code !== "fra"))));
  assert.equal(r.core, 0); assert.equal(r.end, null);
  assert.deepEqual(r.sets.map((s) => s.code), CT.map((s) => s.code));
});

/* ---------- PR #8: CardTrader-style codes, resilience ---------- */
import { fetchScryfallSets, refreshScryfallStore, resetScryfallBackoff, scryfallIndexWithSource, type ScryfallSet } from "./scryfall.ts";
import { assetVersion, versionedUrl } from "./assets.ts";

test("iconFor handles CardTrader's codes: art/commander prefixes, dashed Secret Lair codes, name before a colon", () => {
  const idx = buildIconIndex(slimSets([...GRAW, { code: "sld", name: "Secret Lair Drop", set_type: "box", released_at: "2019-12-02", icon_svg_uri: ICON("star") }]));
  const f = (code: string, name = "") => iconFor({ code, name }, idx);
  assert.equal(f("afra", "Reality Fracture Art Series"), "fra");
  assert.equal(f("cfrc", "Reality Fracture Commander Decks"), "frc");
  assert.equal(f("sld-odd", "Secret Lair x Odd"), "star");
  assert.equal(f("sld-miku", "SLD Miku"), "star");
  assert.equal(f("xyz9", "Secret Lair Drop: Something"), "star");
  assert.equal(f("unk", "Unknown Event"), null);
});

const SETS_BODY = JSON.stringify({ data: Array.from({ length: 120 }, (_, i) => ({ code: `s${i}`, name: `Set ${i}`, set_type: "expansion", released_at: "2020-01-01", icon_svg_uri: ICON(`s${i}`) })) });
const memStore = (initial: { sets: ScryfallSet[]; at: number } | null = null) => {
  let v = initial; let saves = 0;
  return { store: { load: async () => v, save: async (sets: ScryfallSet[]) => { v = { sets, at: Date.now() }; saves++; } }, saves: () => saves, value: () => v };
};
const reply = (status: number, body = "", headers: Record<string, string> = {}) => new Response(body, { status, headers });

test("Scryfall 429: one retry, then a stored copy of any age is used (stale), never a bare list", async () => {
  resetScryfallBackoff();
  const old = slimSets(JSON.parse(SETS_BODY).data);
  const m = memStore({ sets: old, at: Date.now() - 3 * 24 * 3600_000 });
  let calls = 0;
  const fetcher = (async () => { calls++; return reply(429, "slow down", { "retry-after": "1" }); }) as typeof fetch;
  const r = await scryfallIndexWithSource({ fetcher, store: m.store });
  assert.equal(r.source, "stale"); assert.equal(calls, 2, "one retry");
  assert.equal(r.index.byCode.size, 120);
  // Backed off: the next request does not call Scryfall at all.
  const r2 = await scryfallIndexWithSource({ fetcher, store: m.store });
  assert.equal(r2.source, "stale"); assert.equal(calls, 2);
  resetScryfallBackoff();
});

test("Scryfall: fresh stored copy skips the live fetch; live success is saved; no copy + failure throws", async () => {
  resetScryfallBackoff();
  let calls = 0;
  const ok = (async (url: string, init: RequestInit) => { calls++; assert.match(String((init.headers as Record<string, string>)["user-agent"]), /HeklaIntake/); return reply(200, SETS_BODY); }) as unknown as typeof fetch;
  const fresh = memStore({ sets: slimSets(JSON.parse(SETS_BODY).data), at: Date.now() - 3600_000 });
  assert.equal((await scryfallIndexWithSource({ fetcher: ok, store: fresh.store })).source, "stored"); assert.equal(calls, 0);
  const empty = memStore();
  assert.equal((await scryfallIndexWithSource({ fetcher: ok, store: empty.store })).source, "live"); assert.equal(empty.saves(), 1);
  const bad = (async () => reply(403, "no")) as typeof fetch;
  await assert.rejects(scryfallIndexWithSource({ fetcher: bad, store: memStore().store }), /403/);
  resetScryfallBackoff();
});

test("refreshScryfallStore refreshes only a copy older than 24 h; fetchScryfallSets rejects a truncated list", async () => {
  resetScryfallBackoff();
  const ok = (async () => reply(200, SETS_BODY)) as typeof fetch;
  const fresh = memStore({ sets: [], at: Date.now() });
  assert.equal(await refreshScryfallStore(fresh.store, ok), "fresh");
  const stale = memStore({ sets: [], at: Date.now() - 25 * 3600_000 });
  assert.equal(await refreshScryfallStore(stale.store, ok), "refreshed"); assert.equal(stale.value()!.sets.length, 120);
  await assert.rejects(fetchScryfallSets((async () => reply(200, JSON.stringify({ data: [{ code: "a", name: "A" }] }))) as typeof fetch), /only 1/);
});

test("asset cache-busting: same-origin script/style URLs get ?v=<version>", () => {
  assert.equal(assetVersion({ CF_VERSION_METADATA: { id: "1b8e98b9-1fef-4857-a0f8-98d4141cc8fb" } } as unknown as Env), "1b8e98b91fef");
  assert.equal(assetVersion({} as Env), "dev");
  assert.equal(versionedUrl("/app.js", "abc"), "/app.js?v=abc");
  assert.equal(versionedUrl("https://cdn.example/x.js", "abc"), null);
  assert.equal(versionedUrl("//cdn.example/x.js", "abc"), null);
  assert.equal(versionedUrl("/x.js?y=1", "abc"), null);
  assert.equal(versionedUrl(null, "abc"), null);
});
