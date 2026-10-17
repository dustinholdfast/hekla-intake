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
    if (url === "https://api.scryfall.com/sets") return new Response(JSON.stringify({ data: RAW }));
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
