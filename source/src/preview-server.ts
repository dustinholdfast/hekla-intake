/** Local inventory page against fixture movements. Does not call Neon or Airtable. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDetail, buildInventory, DEFAULT_THRESHOLDS, type InventoryFilter } from "./inventory.ts";
import { fixtureBuyList, fixtureMovements } from "./inventory-fixtures.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 47232);
const now = new Date();
const movements = fixtureMovements(now);
const buyList = fixtureBuyList();

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function filterOf(url: URL): InventoryFilter {
  const flag = url.searchParams.get("flag") ?? "";
  const cost = url.searchParams.get("cost") ?? "";
  return {
    game: url.searchParams.get("game") || undefined,
    condition: url.searchParams.get("condition") || undefined,
    finish: url.searchParams.get("finish") || undefined,
    q: url.searchParams.get("q") || undefined,
    flag: flag === "low" || flag === "overstock" || flag === "slow" || flag === "review" ? flag : undefined,
    cost: cost === "known" || cost === "unknown" ? cost : undefined,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/api/inventory") {
    const body = JSON.stringify(buildInventory(movements, buyList, { ...DEFAULT_THRESHOLDS }, now, filterOf(url), "matched"));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return;
  }
  const detail = /^\/api\/inventory\/(rec[A-Za-z0-9]{14})$/.exec(url.pathname);
  if (detail?.[1]) {
    const body = buildDetail(movements, buyList, { ...DEFAULT_THRESHOLDS }, now, detail[1]);
    res.writeHead(body ? 200 : 404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body ?? { error: "That card is not in the fixture ledger." }));
    return;
  }
  const rel = url.pathname === "/" || url.pathname === "/inventory" ? "/inventory.html" : url.pathname;
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    let data = await readFile(file);
    if (file.endsWith("inventory.html")) {
      const html = data.toString("utf8").replace("<html lang=\"en\">", "<html lang=\"en\" data-preview=\"1\">");
      data = Buffer.from(html);
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`inventory preview http://127.0.0.1:${port}/inventory`);
});
