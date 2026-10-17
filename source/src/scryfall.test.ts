import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIconIndex, iconFile, iconFor, setIconSvg, slimSets, withIcons } from "./scryfall.ts";

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
