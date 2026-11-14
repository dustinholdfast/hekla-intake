/** Local inventory and settings pages against fixtures. Does not call Neon or Airtable. */
import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type InventoryFilter, type WaitlistInput } from "./inventory.ts";
import { buildLiveDetail, buildLiveInventory } from "./live-inventory.ts";
import { defaultInventorySettings, presentSettings, SettingsError, validateInventorySettings } from "./inventory-settings.ts";
import { fixtureBuyList, fixtureMovements, fixtureRows, FIXTURE_TENANT } from "./inventory-fixtures.ts";
import { exampleAcceptInput, EXAMPLE_RECEIVED_ON, EXAMPLE_SR_ID } from "./purchases-fixtures.ts";
import { planAcceptance, PurchaseBook } from "./purchases.ts";
import { parseDraft } from "./fields.ts";
import { parseBulk } from "./parse.ts";
import { duplicatesAmong, type QueueCard } from "./airtable.ts";
import { planIntakeUpsert } from "./intake-upsert.ts";
import { CONDITIONS, FINISHES, FINISHES_BY_GAME, GAMES, RARITIES, SETS, type Game } from "./sets.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 47232);
const now = new Date("2026-10-27T15:00:00.000Z");
let movements = fixtureMovements(now);
// A local operational snapshot deliberately differs from the recorded openings.
const currentStock = fixtureRows(now).filter(row => row.id !== 'recFIXTURETIDE002');
currentStock[0]!.fields.Qty = 3;
currentStock.push({ id: 'recNEWINTAKE00001', createdTime: now.toISOString(), fields: {
  'Card Name': 'Example newly received card', Game: 'Lorcana', 'Set #': '1', 'Collector Number': '99',
  Finish: 'Normal', Condition: 'NM', Qty: 2, Status: 'Waitlist',
} });
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

function openQueue(): QueueCard[] {
  return currentStock.flatMap((row) => {
    const fields = row.fields;
    const status = typeof fields.Status === "string" ? fields.Status : null;
    if (status !== "Waitlist" && status !== "Listed") return [];
    const qty = typeof fields.Qty === "number" ? fields.Qty : 0;
    return [{
      id: row.id,
      name: typeof fields["Card Name"] === "string" ? fields["Card Name"] : "",
      cardName: typeof fields["Card Name"] === "string" ? fields["Card Name"] : null,
      resolvedName: null,
      game: typeof fields.Game === "string" ? fields.Game : "Lorcana",
      setNumber: typeof fields["Set #"] === "string" ? fields["Set #"] : null,
      setIdentifier: typeof fields["Set Identifier"] === "string" ? fields["Set Identifier"] : null,
      setName: null,
      collectorNumber: typeof fields["Collector Number"] === "string" ? fields["Collector Number"] : null,
      finish: typeof fields.Finish === "string" ? fields.Finish : null,
      condition: typeof fields.Condition === "string" ? fields.Condition : null,
      language: typeof fields.Language === "string" ? fields.Language : null,
      qty,
      status,
      rankScore: null,
      marketPriceUsd: typeof fields["Market Price USD"] === "number" ? fields["Market Price USD"] : null,
      notes: null,
      priority: null,
      createdTime: row.createdTime ?? "",
      autoRank: null,
      rarity: null,
      costBasisUsd: typeof fields["Cost Basis USD"] === "number" ? fields["Cost Basis USD"] : null,
      cardType: null,
      recommendation: null,
      rankReason: null,
      enrichedAt: null,
      priceSource: null,
    }];
  });
}

function previewBulkRows(rows: ReturnType<typeof parseBulk>, open: QueueCard[]) {
  const virtual: QueueCard[] = [];
  return rows.map((row) => {
    if (!row.card) return { line: row.line, raw: row.raw, error: row.error, matches: [] as QueueCard[], alsoInPaste: [] as number[] };
    const card = row.card;
    const asQueue = (id: string): QueueCard => ({
      id, name: card.cardName ?? "", cardName: card.cardName ?? null, resolvedName: null, game: card.game,
      setNumber: card.game === "Lorcana" ? card.setNumber : null,
      setIdentifier: card.game === "Lorcana" ? null : card.setIdentifier,
      setName: null, collectorNumber: card.collectorNumber, finish: card.finish, condition: card.condition,
      language: null, qty: card.qty, status: "Waitlist", rankScore: null, marketPriceUsd: null, notes: null,
      priority: null, createdTime: "", autoRank: null, rarity: null, costBasisUsd: card.costBasisUsd ?? null,
      cardType: null, recommendation: null, rankReason: null, enrichedAt: null, priceSource: null,
    });
    const matches = duplicatesAmong(open, card);
    const alsoInPaste = duplicatesAmong(virtual, card).map((item) => Number(item.id.replace("line-", ""))).filter((line) => Number.isFinite(line));
    virtual.push(asQueue(`line-${row.line}`));
    return { line: row.line, raw: row.raw, card, matches, alsoInPaste };
  });
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
    for (const movement of received.plan.movements) {
      const existing = currentStock.find(row => row.id === movement.recordId);
      if (existing) existing.fields.Qty = Number(existing.fields.Qty ?? 0) + movement.delta;
      else if (movement.snapshot) {
        const snap = movement.snapshot;
        const made: WaitlistInput = { id: movement.recordId, createdTime: now.toISOString(), fields: {
          'Card Name': snap.cardName, Game: snap.game, 'Set #': snap.setNumber, 'Set Identifier': snap.setIdentifier,
          'Collector Number': snap.collectorNumber, Finish: snap.finishRaw, Condition: snap.condition,
          Language: snap.language, Qty: movement.qtyAfter, Status: snap.status,
        } };
        currentStock.push(made);
      }
    }
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
  if (url.pathname === "/api/session" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true, via: "preview", tenant: "Fixture", role: null, plan: "free", platformAdmin: false,
      baseId: "appFIXTUREBASE01", tableId: "tblFIXTURETABLE1",
      games: GAMES, sets: SETS, finishes: FINISHES, finishesByGame: FINISHES_BY_GAME,
      conditions: CONDITIONS, rarities: RARITIES,
      conditionLabels: { NM: "Near Mint", LP: "Lightly Played", MP: "Moderately Played", HP: "Heavily Played", DMG: "Damaged" },
    });
    return;
  }
  if (url.pathname === "/api/summary" && req.method === "GET") {
    const game = url.searchParams.get("game") || "Lorcana";
    const rows = currentStock.filter((row) => String(row.fields.Game || "Lorcana") === game);
    const counts = { Waitlist: 0, Listed: 0, Sold: 0, Skip: 0 };
    let listedQty = 0;
    let waitlistQty = 0;
    for (const row of rows) {
      const status = String(row.fields.Status || "");
      if (status in counts) counts[status as keyof typeof counts] += 1;
      const qty = typeof row.fields.Qty === "number" ? row.fields.Qty : 0;
      if (status === "Listed") listedQty += qty;
      if (status === "Waitlist") waitlistQty += qty;
    }
    sendJson(res, 200, { listedQty, waitlistQty, counts, truncated: false });
    return;
  }
  if (url.pathname === "/api/queue" && req.method === "GET") {
    const game = url.searchParams.get("game") || "Lorcana";
    const status = url.searchParams.get("status") || "Waitlist";
    const cards = openQueue().filter((card) => card.game === game && card.status === status);
    sendJson(res, 200, { cards, truncated: false });
    return;
  }
  if (url.pathname === "/api/intake" && req.method === "POST") {
    let body: unknown;
    try { body = await readJson(req); } catch { sendJson(res, 400, { error: "That was not valid JSON." }); return; }
    const draft = parseDraft(body as Parameters<typeof parseDraft>[0]);
    if (!draft.ok) { sendJson(res, 400, { error: draft.error }); return; }
    const matches = duplicatesAmong(openQueue(), draft.card);
    const record = body as { onDuplicate?: "ask" | "merge" | "add"; confirmOverride?: boolean; mergeRecordId?: string };
    const plan = planIntakeUpsert({
      card: draft.card,
      matches: matches.map((card) => ({ id: card.id, qty: card.qty, status: card.status, costBasisUsd: card.costBasisUsd, unknownCostQty: card.unknownCostQty ?? null })),
      choice: record.onDuplicate ?? "ask",
      confirmOverride: record.confirmOverride === true,
      mergeRecordId: record.mergeRecordId,
    });
    if (plan.action === "reject") { sendJson(res, 400, { error: plan.error }); return; }
    if (plan.action === "ask") { sendJson(res, 409, { error: "duplicate", message: "Already in stock.", matches }); return; }
    if (plan.action === "merge") {
      const row = currentStock.find((item) => item.id === plan.target.id);
      if (row) row.fields.Qty = Number(row.fields.Qty ?? 0) + draft.card.qty;
      const card = openQueue().find((item) => item.id === plan.target.id);
      sendJson(res, 200, { card, merged: true, costLot: draft.card.costBasisUsd != null });
      return;
    }
    if (plan.action !== "create") { sendJson(res, 409, { error: "That card is already in stock." }); return; }
    sendJson(res, 201, { card: { ...draft.card, id: "recPREVIEWNEW0001", name: draft.card.cardName || draft.card.collectorNumber, status: "Waitlist" }, merged: false, duplicate: plan.recordOverride });
    return;
  }
  if (url.pathname === "/api/intake/bulk" && req.method === "POST") {
    let body: { text?: string; game?: string; mode?: string } = {};
    try { body = await readJson(req) as typeof body; } catch { sendJson(res, 400, { error: "That was not valid JSON." }); return; }
    const game = (GAMES as readonly string[]).includes(body.game || "") ? body.game as Game : "Lorcana";
    const rows = parseBulk(typeof body.text === "string" ? body.text : "", game);
    if (body.mode === "commit") { sendJson(res, 200, { preview: false, created: [], merged: [], skipped: [], errors: [] }); return; }
    sendJson(res, 200, { preview: true, dedupeChecked: true, rows: previewBulkRows(rows, openQueue().filter((card) => card.game === game)) });
    return;
  }
  if (url.pathname === "/api/inventory") {
    const body = JSON.stringify(buildLiveInventory({ tenantId: FIXTURE_TENANT,
      stock: { rows: currentStock, startedAt: now.toISOString(), completedAt: now.toISOString() },
      movements, buyList, thresholds: settings.thresholds, filter: filterOf(url), wantQtyState: 'matched', liability: purchases.liability(FIXTURE_TENANT) }));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return;
  }
  const detail = /^\/api\/inventory\/(rec[A-Za-z0-9]{14})$/.exec(url.pathname);
  if (detail?.[1]) {
    const payload = buildLiveInventory({ tenantId: FIXTURE_TENANT,
      stock: { rows: currentStock, startedAt: now.toISOString(), completedAt: now.toISOString() },
      movements, buyList, thresholds: settings.thresholds, wantQtyState: 'matched' });
    const body = buildLiveDetail(payload, movements, detail[1]);
    res.writeHead(body ? 200 : 404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body ?? { error: "That card is not in the fixture ledger." }));
    return;
  }
  const page = url.pathname === "/intake"
    ? "/index.html"
    : url.pathname === "/" || url.pathname === "/inventory"
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
    if (file.endsWith("inventory.html") || file.endsWith("settings.html") || file.endsWith("purchases.html") || file.endsWith("credit.html") || file.endsWith("index.html")) {
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
  console.log(`intake preview http://127.0.0.1:${port}/intake`);
  console.log(`inventory preview http://127.0.0.1:${port}/inventory`);
  console.log(`purchase preview http://127.0.0.1:${port}/purchases/new?sr=${EXAMPLE_SR_ID}`);
  console.log(`liability preview http://127.0.0.1:${port}/credit`);
});
