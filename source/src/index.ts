import { clerkMiddleware, getAuth } from "@clerk/hono";
import { Hono, type Context } from "hono";
import {
  AirtableError,
  createCards,
  deleteCard,
  editCard,
  enrichListedPage,
  enrichPending,
  enrichPendingListed,
  enrichRecord,
  duplicatesAmong,
  findDuplicates,
  listByStatus,
  listOpenPrintings,
  mergeQty,
  summary,
  type QueueCard,
} from "./airtable.ts";
import { authConfigured, clerkFrontendApi, contentSecurityPolicy } from "./auth.ts";
import { parseDraft, parseIntakeBody, type DraftCard } from "./fields.ts";
import { PREVIEW_IMAGE_HOSTS, resolvePreview } from "./preview.ts";
import { parseBulk, type ParsedRow } from "./parse.ts";
import { canonicalGame, CONDITIONS, FINISHES, FINISHES_BY_GAME, GAMES, isStatus, LISTED_CAP, RARITIES, SETS, type Game } from "./sets.ts";
import { listTenants, recordAudit, tenantEnv, tenantForOrg, type AuditAction, type Tenant } from "./tenants.ts";

type Variables = { tenant: Tenant; tenantEnv: Env; userId: string; orgRole: string | null };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  c.header("x-frame-options", "DENY");
});

app.use("/api/*", async (c, next) => {
  c.header("cache-control", "no-store");
  await next();
});

// Public: the sign-in page needs these before anyone has a session. Neither value is secret.
app.get("/api/config", (c) => {
  const clerkPublishableKey = c.env.CLERK_PUBLISHABLE_KEY?.trim() || null;
  return c.json({ clerkPublishableKey, clerkFrontendApi: clerkFrontendApi(c.env.CLERK_PUBLISHABLE_KEY) });
});

app.use("/api/*", async (c, next) => {
  if (!authConfigured(c.env)) {
    return c.json({ error: "Set CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, and DATABASE_URL before using intake." }, 503);
  }
  return clerkMiddleware({ secretKey: c.env.CLERK_SECRET_KEY, publishableKey: c.env.CLERK_PUBLISHABLE_KEY })(c, next);
});

// Every route below runs as one signed-in user inside one tenant (their active Clerk Organization).
app.use("/api/*", async (c, next) => {
  const auth = getAuth(c);
  if (!auth.userId) return c.json({ error: "Sign in required." }, 401);
  if (!auth.orgId) return c.json({ error: "Choose an organization to continue.", code: "no_org" }, 403);
  const tenant = await tenantForOrg(c.env, auth.orgId);
  if (!tenant) return c.json({ error: "This organization has not been set up for intake yet.", code: "no_tenant" }, 403);
  c.set("tenant", tenant);
  c.set("tenantEnv", tenantEnv(c.env, tenant));
  c.set("userId", auth.userId);
  c.set("orgRole", auth.orgRole ?? null);
  await next();
});

app.get("/api/session", (c) => {
  return c.json({
    ok: true,
    via: "clerk",
    tenant: c.var.tenant.name,
    role: c.var.orgRole,
    cap: LISTED_CAP,
    baseId: c.var.tenant.airtableBaseId,
    tableId: c.var.tenant.airtableTableId,
    games: GAMES,
    sets: SETS,
    finishes: FINISHES,
    finishesByGame: FINISHES_BY_GAME,
    conditions: CONDITIONS,
    rarities: RARITIES,
    conditionLabels: {
      NM: "Near Mint",
      LP: "Lightly Played",
      MP: "Moderately Played",
      HP: "Heavily Played",
      DMG: "Damaged",
    },
  });
});

app.get("/api/summary", async (c) => {
  const game = readGame(c.req.query("game"));
  if (!game) return c.json({ error: gameError() }, 400);
  return c.json(await summary(c.var.tenantEnv, game));
});

app.get("/api/queue", async (c) => {
  const status = c.req.query("status") ?? "Waitlist";
  if (!isStatus(status)) return c.json({ error: "Status must be Waitlist, Listed, Sold, or Skip." }, 400);
  const game = readGame(c.req.query("game"));
  if (!game) return c.json({ error: gameError() }, 400);
  const result = await listByStatus(c.var.tenantEnv, status, game);
  return c.json(result);
});

app.post("/api/intake", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsedBody = parseIntakeBody(body.value);
  if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
  const draft = parseDraft(parsedBody.body);
  if (!draft.ok) return c.json({ error: draft.error }, 400);

  const choice = parsedBody.body.onDuplicate ?? "ask";
  if (choice !== "add") {
    const matches = await findDuplicates(c.var.tenantEnv, draft.card);
    if (matches.length > 0) {
      if (choice === "ask" || (choice === "merge" && matches.length > 1 && !parsedBody.body.mergeRecordId)) {
        return c.json(
          {
            error: "duplicate",
            message: "This game, set, collector number, and finish is already Waitlist or Listed.",
            matches,
          },
          409,
        );
      }
      const target = parsedBody.body.mergeRecordId
        ? matches.find((match) => match.id === parsedBody.body.mergeRecordId)
        : matches[0];
      if (!target) return c.json({ error: "That row is not a matching Waitlist or Listed card." }, 400);
      const card = await mergeQty(c.var.tenantEnv, target.id, draft.card.qty);
      audit(c, "merge", [card]);
      backgroundEnrich(c, card.id);
      return c.json({ card, merged: true });
    }
  }

  const [card] = await createCards(c.var.tenantEnv, [draft.card]);
  if (!card) return c.json({ error: "Airtable did not return the new row." }, 502);
  audit(c, "create", [card]);
  backgroundEnrich(c, card.id);
  return c.json({ card, merged: false }, 201);
});

app.post("/api/intake/bulk", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const text = body.value.text;
  if (typeof text !== "string") return c.json({ error: "Paste the cards as text." }, 400);
  if (text.length > 20_000) return c.json({ error: "That paste is too long." }, 400);
  const mode = body.value.mode === "commit" ? "commit" : "preview";
  const onDuplicate = body.value.onDuplicate;
  if (mode === "commit" && onDuplicate !== "skip" && onDuplicate !== "merge" && onDuplicate !== "add") {
    return c.json({ error: "Choose skip, merge, or add for duplicates." }, 400);
  }

  const game = readGame(typeof body.value.game === "string" ? body.value.game : "Lorcana");
  if (!game) return c.json({ error: gameError() }, 400);

  const rows = parseBulk(text, game);
  if (rows.length === 0) return c.json({ error: "No card lines found." }, 400);
  if (rows.length > 100) return c.json({ error: "Paste at most 100 cards at a time." }, 400);

  if (mode === "preview") {
    const open = await listOpenPrintings(c.var.tenantEnv, game).catch((error: unknown) => {
      if (error instanceof AirtableError && error.status === 503) return null;
      throw error;
    });
    return c.json({
      preview: true,
      dedupeChecked: open !== null,
      warning: open === null ? "Airtable is not configured, so existing rows were not checked." : undefined,
      rows: previewRows(rows, open ?? []),
    });
  }

  const open = await listOpenPrintings(c.var.tenantEnv, game);
  const created: QueueCard[] = [];
  const merged: QueueCard[] = [];
  const skipped: { line: number; raw: string; reason: string }[] = [];
  const errors: { line: number; raw: string; error: string }[] = [];
  let pending: { line: number; raw: string; card: DraftCard }[] = [];
  let writeFailed = false;

  const flush = async () => {
    if (writeFailed || pending.length === 0) return;
    const batch = pending;
    pending = [];
    try {
      const cards = await createCards(c.var.tenantEnv, batch.map((item) => item.card));
      cards.forEach((card) => {
        created.push(card);
        open.push(card);
      });
      if (cards.length !== batch.length) {
        writeFailed = true;
        errors.push({ line: batch[0]?.line ?? 0, raw: batch[0]?.raw ?? "", error: "Airtable returned an unexpected number of rows. Stopped the rest of the paste." });
      }
    } catch (error) {
      writeFailed = true;
      const message = error instanceof AirtableError ? error.message : "Airtable write failed. Stopped the rest of the paste.";
      for (const item of batch) errors.push({ line: item.line, raw: item.raw, error: message });
    }
  };

  for (const row of rows) {
    if (writeFailed) {
      if (row.card && !row.error) errors.push({ line: row.line, raw: row.raw, error: "Skipped because an earlier Airtable write failed." });
      else errors.push({ line: row.line, raw: row.raw, error: row.error ?? "Could not read this line." });
      continue;
    }
    if (!row.card || row.error) {
      errors.push({ line: row.line, raw: row.raw, error: row.error ?? "Could not read this line." });
      continue;
    }
    if (onDuplicate === "add") {
      pending.push({ line: row.line, raw: row.raw, card: row.card });
      if (pending.length === 10) await flush();
      continue;
    }

    const stagedHit = pending.some((item) => duplicatesAmong([draftAsCard(item.card, `pending-${item.line}`)], row.card!).length > 0);
    if (stagedHit) await flush();
    if (writeFailed) {
      errors.push({ line: row.line, raw: row.raw, error: "Skipped because an earlier Airtable write failed." });
      continue;
    }
    const matches = duplicatesAmong(open, row.card);
    if (matches.length === 0) {
      pending.push({ line: row.line, raw: row.raw, card: row.card });
      if (pending.length === 10) await flush();
      continue;
    }
    if (onDuplicate === "skip") {
      skipped.push({ line: row.line, raw: row.raw, reason: `Already ${matches.map((match) => match.status).join(" / ")}.` });
      continue;
    }
    if (matches.length > 1) {
      errors.push({
        line: row.line,
        raw: row.raw,
        error: "Several matching rows. Merge this card from Quick Add so you can pick the row.",
      });
      continue;
    }
    const target = matches[0];
    if (!target) continue;
    try {
      const updated = await mergeQty(c.var.tenantEnv, target.id, row.card.qty);
      const index = open.findIndex((card) => card.id === updated.id);
      if (index >= 0) open[index] = updated;
      else open.push(updated);
      merged.push(updated);
    } catch (error) {
      writeFailed = true;
      const message = error instanceof AirtableError ? error.message : "Could not merge that row.";
      errors.push({ line: row.line, raw: row.raw, error: message });
    }
  }
  await flush();
  audit(c, "create", created);
  audit(c, "merge", merged);
  if (created.length || merged.length) {
    const env = c.var.tenantEnv;
    try { c.executionCtx.waitUntil((async () => { for (const m of merged) await enrichRecord(env, m.id).catch(() => null); await enrichPending(env).catch(() => null); })()); } catch { /* no ctx in tests */ }
  }

  return c.json({ preview: false, created, merged, skipped, errors });
});

app.patch("/api/cards/:id", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const card = await editCard(c.var.tenantEnv, c.req.param("id"), body.value);
  audit(c, "edit", [card]);
  return c.json({ card });
});

app.delete("/api/cards/:id", async (c) => {
  const result = await deleteCard(c.var.tenantEnv, c.req.param("id"));
  if (result.deleted) audit(c, "delete", [{ id: result.id }]);
  return c.json(result);
});

app.get("/api/preview", async (c) => {
  const game = readGame(c.req.query("game"));
  if (!game) return c.json({ error: gameError() }, 400);
  const cap = (v: string | undefined) => (v ?? "").trim().slice(0, 120);
  const query = { game, set: cap(c.req.query("set")), number: cap(c.req.query("number")), name: cap(c.req.query("name")) };
  if (!query.name && !(query.set && query.number)) return c.json({ found: false, source: "none" });
  return c.json(await resolvePreview(query, c.executionCtx));
});

app.post("/api/enrich/:id", async (c) => {
  const result = await enrichRecord(c.var.tenantEnv, c.req.param("id"));
  return c.json(result);
});

app.post("/api/enrich-listed", async (c) => {
  const game = readGame(c.req.query("game"));
  if (!game) return c.json({ error: gameError() }, 400);
  const offset = Number.parseInt(c.req.query("offset") ?? "0", 10) || 0;
  return c.json(await enrichListedPage(c.var.tenantEnv, game, offset));
});

app.post("/api/enrich", async (c) => {
  // Run now for everything pending (up to 4 batches per click to stay inside request limits).
  let enriched = 0; let picked = 0; const failed: { id: string; error: string }[] = []; let remaining = false; let ai = false;
  for (let round = 0; round < 4; round++) {
    const r = await enrichPending(c.var.tenantEnv);
    enriched += r.enriched; picked += r.picked; failed.push(...r.failed); remaining = r.remaining; ai = r.ai;
    if (!r.remaining || r.enriched === 0) break;
  }
  return c.json({ picked, enriched, failed, remaining, ai });
});

app.post("/api/hekla", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const action = body.value.action === "greenlight" ? "greenlight" : body.value.action === "process" ? "process" : null;
  if (!action) return c.json({ error: "Action must be process or greenlight." }, 400);

  const payload = {
    source: "hekla-intake",
    action: action === "process" ? "process_new_rows" : "greenlight_shortlist",
    at: new Date().toISOString(),
    listsCards: false,
    message:
      action === "process"
        ? "Please rank new Waitlist rows. Do not list anything from this request."
        : "Dustin greenlit the shortlist. Listing still happens in Hekla, not in this intake app.",
  };

  const webhook = c.var.tenantEnv.HEKLA_WEBHOOK_URL?.trim();
  if (!webhook) {
    return c.json({ delivered: false, copyText: payload.message, payload, mailto: mailtoLink(payload.message) });
  }

  let target: URL;
  try {
    target = new URL(webhook);
  } catch {
    return c.json({ error: "HEKLA_WEBHOOK_URL is not a valid URL." }, 500);
  }
  if (target.protocol !== "https:") return c.json({ error: "HEKLA_WEBHOOK_URL must use https." }, 500);

  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  await response.body?.cancel();
  if (!response.ok) {
    return c.json({
      delivered: false,
      copyText: payload.message,
      payload,
      mailto: mailtoLink(payload.message),
      webhookStatus: response.status,
    });
  }
  return c.json({ delivered: true, copyText: payload.message, payload });
});

app.get("*", async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", contentSecurityPolicy(c.env, PREVIEW_IMAGE_HOSTS));
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
});

app.onError((error, c) => {
  if (error instanceof AirtableError) {
    const status = error.status === 503 ? 503 : error.status >= 500 ? 502 : 400;
    return c.json({ error: error.message }, status);
  }
  console.log(JSON.stringify({ level: "error", message: error instanceof Error ? error.message : "unknown" }));
  return c.json({ error: "Something went wrong." }, 500);
});

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

function backgroundEnrich(c: AppContext, id: string): void {
  const env = c.var.tenantEnv;
  try { c.executionCtx.waitUntil(enrichRecord(env, id).catch((e) => console.error("enrich failed", id, e instanceof Error ? e.message : e))); } catch { /* no ctx */ }
}

/** Best-effort trail of who changed what. A failed audit write never fails the request. */
function audit(c: AppContext, action: AuditAction, cards: { id: string }[]): void {
  const entries = cards.map((card) => ({ tenantId: c.var.tenant.id, userId: c.var.userId, action, recordId: card.id, snapshot: action === "delete" ? null : card }));
  const work = recordAudit(c.env, entries).catch((e) => console.error("audit failed", action, e instanceof Error ? e.message : e));
  try { c.executionCtx.waitUntil(work); } catch { /* no ctx */ }
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      let tenants: Tenant[];
      try { tenants = await listTenants(env); } catch (e) { console.error("cron tenants failed", e instanceof Error ? e.message : e); return; }
      for (const tenant of tenants) {
        try {
          const scoped = tenantEnv(env, tenant);
          const r = await enrichPending(scoped);
          console.log("cron enrich", JSON.stringify({ tenant: tenant.id, picked: r.picked, enriched: r.enriched, failed: r.failed.length, ai: r.ai }));
          // Failed Waitlist rows stay pending and are re-picked every run; always leave Listed a budget.
          {
            const l = await enrichPendingListed(scoped, Math.max(10, 25 - r.enriched));
            if (l.picked) console.log("cron enrich listed", JSON.stringify({ tenant: tenant.id, picked: l.picked, enriched: l.enriched, failed: l.failed.length }));
          }
        } catch (e) { console.error("cron enrich failed", tenant.id, e instanceof Error ? e.message : e); }
      }
    })());
  },
} satisfies ExportedHandler<Env>;

function mailtoLink(message: string): string {
  return `mailto:?subject=${encodeURIComponent("Hekla intake")}&body=${encodeURIComponent(message)}`;
}

async function readJson(c: { req: { text: () => Promise<string> } }): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  let text = "";
  try {
    text = await c.req.text();
  } catch {
    return { ok: false, error: "Could not read the request." };
  }
  if (text.length > 100_000) return { ok: false, error: "Request is too large." };
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Expected a JSON object." };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: "That was not valid JSON." };
  }
}

function readGame(input: string | undefined): Game | null {
  return canonicalGame(input?.trim() ? input : "Lorcana");
}

function gameError(): string {
  return "Game must be Lorcana, Magic: The Gathering, Riftbound, Pokémon, or Yu-Gi-Oh!.";
}

function draftAsCard(card: DraftCard, id: string): QueueCard {
  return {
    id,
    name: card.cardName ?? "",
    cardName: card.cardName ?? null,
    resolvedName: null,
    autoRank: null, rarity: card.rarity ?? null, costBasisUsd: card.costBasisUsd ?? null, cardType: null, recommendation: null, rankReason: null, enrichedAt: null, priceSource: null,
    game: card.game,
    setNumber: card.game === "Lorcana" ? card.setNumber : null,
    setIdentifier: card.game === "Lorcana" ? null : card.setIdentifier,
    setName: null,
    collectorNumber: card.collectorNumber,
    finish: card.finish,
    condition: card.condition,
    qty: card.qty,
    status: "Waitlist",
    rankScore: null,
    marketPriceUsd: null,
    notes: card.notes ?? null,
    priority: card.priority ?? null,
    createdTime: "",
  };
}

function previewRows(rows: ParsedRow[], open: QueueCard[]) {
  const virtual: QueueCard[] = [];
  return rows.map((row) => {
    if (!row.card) return { line: row.line, raw: row.raw, error: row.error, matches: [], alsoInPaste: [] as number[] };
    const matches = duplicatesAmong(open, row.card);
    const alsoInPaste = duplicatesAmong(virtual, row.card)
      .map((card) => Number(card.id.replace("line-", "")))
      .filter((line) => Number.isFinite(line));
    virtual.push(draftAsCard(row.card, `line-${row.line}`));
    return {
      line: row.line,
      raw: row.raw,
      card: row.card,
      matches,
      alsoInPaste,
    };
  });
}
