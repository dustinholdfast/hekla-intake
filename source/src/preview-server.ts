/** Local inventory and settings pages against fixtures. Does not call Neon or Airtable. */
import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDetail, buildInventory, type InventoryFilter } from "./inventory.ts";
import { defaultInventorySettings, presentSettings, SettingsError, validateInventorySettings } from "./inventory-settings.ts";
import { fixtureBuyList, fixtureMovements, FIXTURE_TENANT } from "./inventory-fixtures.ts";
import { exampleAcceptInput, EXAMPLE_RECEIVED_ON, EXAMPLE_SR_ID } from "./purchases-fixtures.ts";
import { planAcceptance, PurchaseBook } from "./purchases.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 47232);
const now = new Date("2026-10-27T15:00:00.000Z");
let movements = fixtureMovements(now);
const buyList = fixtureBuyList();
let settings = defaultInventorySettings();
let settingsStored = false;
const purchases = new PurchaseBook();

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

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text) as unknown;
}

function purchaseDraft(sr: string) {
  if (sr !== EXAMPLE_SR_ID) return null;
  const input = exampleAcceptInput(FIXTURE_TENANT);
  const planned = planAcceptance(input);
  const purchase = purchases.get(FIXTURE_TENANT, sr);
  return {
    request: { ...input.request, paymentType: input.request.payout === "Store Credit" ? "store_credit" : "cash" },
    lines: input.lines,
    preview: planned.ok ? planned.purchase : null,
    purchase,
    error: planned.ok ? null : planned.error,
    stockChanged: false,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/api/purchases/draft" && req.method === "GET") {
    const draft = purchaseDraft(url.searchParams.get("sr") ?? "");
    if (!draft) { sendJson(res, 404, { error: "That sell request is not in the fixture." }); return; }
    sendJson(res, 200, draft);
    return;
  }
  if (url.pathname === "/api/purchases" && req.method === "POST") {
    try { await readJson(req); } catch { sendJson(res, 400, { error: "That was not valid JSON." }); return; }
    const saved = purchases.accept(exampleAcceptInput(FIXTURE_TENANT));
    if (!saved.ok) { sendJson(res, 400, { error: saved.error }); return; }
    sendJson(res, 200, { purchase: saved.purchase, created: saved.created, stockChanged: false, wantChanged: false });
    return;
  }
  if (url.pathname === "/api/purchases/receive" && req.method === "POST") {
    let body: { sellRequestId?: string; receivedOn?: string; lines?: { lineNo: number; condition: string }[] } = {};
    try { body = await readJson(req) as typeof body; } catch { sendJson(res, 400, { error: "That was not valid JSON." }); return; }
    const received = purchases.receive({
      tenantId: FIXTURE_TENANT,
      sellRequestId: body.sellRequestId || EXAMPLE_SR_ID,
      receivedOn: body.receivedOn || EXAMPLE_RECEIVED_ON,
      now: now.toISOString(),
      confirms: body.lines ?? [],
    });
    if (!received.ok) { sendJson(res, 400, { error: received.error }); return; }
    movements = movements.concat(received.plan.movements);
    sendJson(res, 200, {
      purchase: received.plan.purchase,
      movementsInserted: received.movementsInserted,
      creditsInserted: received.creditsInserted,
      writes: received.plan.writes.length,
    });
    return;
  }
  if (url.pathname === "/api/credit" && req.method === "GET") {
    const liability = purchases.liability(FIXTURE_TENANT);
    sendJson(res, 200, { ...liability, entries: purchases.entries(FIXTURE_TENANT), readOnly: true });
    return;
  }
  if (url.pathname === "/api/inventory/settings") {
    if (req.method === "PUT") {
      let parsed: unknown;
      try {
        parsed = await readJson(req);
      } catch {
        sendJson(res, 400, { error: "That was not valid JSON." });
        return;
      }
      try {
        settings = validateInventorySettings(parsed);
        settingsStored = true;
      } catch (error) {
        const message = error instanceof SettingsError ? error.message : "Could not read those settings.";
        sendJson(res, 400, { error: message });
        return;
      }
    }
    sendJson(res, 200, { ...presentSettings(settings), stored: settingsStored, phase2: true, canManage: true });
    return;
  }
  if (url.pathname === "/api/inventory") {
    const body = JSON.stringify(buildInventory(movements, buyList, settings.thresholds, now, filterOf(url), "matched", purchases.liability(FIXTURE_TENANT)));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return;
  }
  const detail = /^\/api\/inventory\/(rec[A-Za-z0-9]{14})$/.exec(url.pathname);
  if (detail?.[1]) {
    const body = buildDetail(movements, buyList, settings.thresholds, now, detail[1]);
    res.writeHead(body ? 200 : 404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body ?? { error: "That card is not in the fixture ledger." }));
    return;
  }
  const page = url.pathname === "/" || url.pathname === "/inventory"
    ? "/inventory.html"
    : url.pathname === "/settings"
      ? "/settings.html"
      : url.pathname === "/purchases" || url.pathname === "/purchases/new"
        ? "/purchases.html"
        : url.pathname === "/credit"
          ? "/credit.html"
          : url.pathname;
  const file = path.normalize(path.join(publicDir, page));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    let data = await readFile(file);
    if (file.endsWith("inventory.html") || file.endsWith("settings.html") || file.endsWith("purchases.html") || file.endsWith("credit.html")) {
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
  console.log(`purchase preview http://127.0.0.1:${port}/purchases/new?sr=${EXAMPLE_SR_ID}`);
  console.log(`liability preview http://127.0.0.1:${port}/credit`);
});
