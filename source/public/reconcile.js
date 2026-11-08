const $ = (id) => document.getElementById(id);
const state = { canManage: false, rows: [], selected: new Set() };
const ACTION = { check_cardtrader: "Checked CardTrader", tcgplayer_upload: "Uploaded TCGplayer export", tcgplayer_confirm: "Confirmed TCGplayer match", tcgplayer_unconfirm: "Removed TCGplayer match", tcgplayer_sku_write: "Wrote SKU to Airtable", tcgplayer_import_csv: "Built TCGplayer import", cardtrader_set: "Set CardTrader qty", airtable_set: "Set Airtable Qty", cleanup_update: "Cleanup: updated survivor", cleanup_delete: "Cleanup: deleted row", cleanup_archive: "Cleanup: archived row", cleanup_restore: "Cleanup: restored row", cleanup_skip: "Cleanup: group skipped/failed" };
const SOURCE = { sku: "Airtable SKU", confirmed: "confirmed", suggested: "suggested" };

document.addEventListener("DOMContentLoaded", () => {
  $("logout").addEventListener("click", signOut);
  $("login-signout").addEventListener("click", signOut);
  $("filters").addEventListener("submit", (e) => { e.preventDefault(); load(); });
  $("f-reconciled").addEventListener("change", load);
  $("export").addEventListener("click", () => download(`/api/reconcile/view.csv?${query()}`, "reconcile.csv"));
  $("ct-check").addEventListener("click", checkCardTrader);
  $("tcg-upload").addEventListener("click", uploadTcg);
  $("tcg-import").addEventListener("click", buildImport);
  $("reconcile-all").addEventListener("click", reconcileAll);
  $("cleanup-preview").addEventListener("click", previewCleanup);
  $("cleanup-apply").addEventListener("click", applyCleanup);
  $("cl-snap-box").addEventListener("toggle", (e) => { if (e.target.open) loadSnapshots(); });
  $("select-all").addEventListener("change", (e) => { for (const r of state.rows) e.target.checked ? state.selected.add(r.recordId) : state.selected.delete(r.recordId); render(); });
  boot();
});

function show(name) { $("boot").hidden = name !== "boot"; $("login-view").hidden = name !== "login"; $("recon-view").hidden = name !== "recon"; }

async function boot() {
  let clerk;
  try { clerk = await loadClerk(); } catch (error) { show("login"); $("login-error").textContent = error.message || "Could not load sign-in."; return; }
  if (!clerk.user) { show("login"); clerk.mountSignIn($("clerk-mount"), { forceRedirectUrl: "/reconcile" }); return; }
  $("login-signout").hidden = false;
  const session = await api("/api/session");
  if (!session.response.ok) { show("login"); $("login-error").textContent = session.data.error || "Could not open reconcile."; return; }
  $("tenant-name").textContent = session.data.tenant || "";
  state.canManage = session.data.role === "org:admin";
  for (const game of session.data.games || []) { const o = document.createElement("option"); o.value = game; o.textContent = game; $("f-game").appendChild(o); }
  for (const id of ["ct-check", "tcg-upload-box", "tcg-import", "select-all", "reconcile-all", "cleanup-panel"]) $(id).hidden = !state.canManage;
  show("recon");
  await load();
}

function query() {
  const p = new URLSearchParams();
  if ($("f-mismatch").value) p.set("mismatch", $("f-mismatch").value);
  if ($("f-reconciled").checked) p.set("reconciled", "1");
  if ($("f-game").value) p.set("game", $("f-game").value);
  return p.toString();
}
const et = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : "");
const money = (cents) => (cents == null ? "—" : `$${(cents / 100).toFixed(2)}`);
function cell(tr, text, title) { const td = document.createElement("td"); td.textContent = text == null ? "" : String(text); if (title) td.title = title; tr.appendChild(td); return td; }
function empty(tbody, cols, text) { const tr = document.createElement("tr"); const td = cell(tr, text); td.colSpan = cols; td.className = "hint"; tbody.appendChild(tr); }
function button(parent, label, onClick, cls = "ghost tiny") { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = label; b.addEventListener("click", onClick); parent.appendChild(b); return b; }
function say(text, isError) { $("error").textContent = isError ? text : ""; $("flash").textContent = isError ? "" : text; }

async function load() {
  const { response, data } = await api(`/api/reconcile/view?${query()}`);
  if (!response.ok) { say(data.error || "Could not load reconcile.", true); return; }
  state.data = data; state.rows = data.rows;
  for (const id of [...state.selected]) if (!data.rows.some((r) => r.recordId === id)) state.selected.delete(id);
  $("ct-at").textContent = data.ctAt ? `listings fetched ${et(data.ctAt)} ET.` : "not checked yet. Press Run check now (read-only, one CardTrader request).";
  $("ct-cron").textContent = data.cron.mode === "off" ? "The 15-minute stock check is off (RECONCILE_MODE=off); this page's check runs on demand only." : data.cron.at ? `15-minute stock check (${data.cron.mode}): ${et(data.cron.at)} ET, ${data.cron.summary}` : `15-minute stock check (${data.cron.mode}) has not run yet.`;
  $("tcg-at").textContent = data.snapshot ? `export uploaded ${et(data.snapshot.uploadedAt)} ET${data.snapshot.filename ? ` (${data.snapshot.filename})` : ""}: ${data.snapshot.stockedRows} stocked of ${data.snapshot.totalRows} rows.` : "no export uploaded yet.";
  $("sku-col").textContent = data.hasSkuColumn ? "The Waitlist has a TCGplayer SKU column; SKUs there match exactly." : "The Waitlist has no “TCGplayer SKU” column. Matches are fuzzy until you confirm them; to save SKUs to Airtable, add a text column named exactly “TCGplayer SKU” (Hekla never creates Airtable fields).";
  renderCounts();
  render();
  renderUnmatched();
  renderActions();
}

function renderCounts() {
  const data = state.data, c = data.counts;
  $("counts").textContent = `${c.rows} cards, ${c.open} to reconcile · ${data.ctAt ? `${c.ctMismatch} CardTrader mismatches` : "CardTrader not checked"} · ${data.tcgAt ? `${c.tcgMismatch} TCGplayer mismatches${c.pendingUpload ? `, ${c.pendingUpload} pending upload` : ""}, ${c.suggested} suggested matches to confirm` : "no TCGplayer export"}`;
}

/* ---------- a row leaves the list once reconciled (no reload) ---------- */
const tcgOpen = (r) => r.tcgMismatch && !r.tcgPending;
const isReconciled = (r) => !r.ctMismatch && !tcgOpen(r) && r.tcg?.source !== "suggested";
function visible(r) {
  if ($("f-reconciled").checked) return true;
  const kind = $("f-mismatch").value;
  return kind === "cardtrader" ? r.ctMismatch : kind === "tcgplayer" ? tcgOpen(r) || r.tcg?.source === "suggested" : !isReconciled(r);
}
/** Keep in step with src/listable.ts. A Free Qty number wins. Otherwise Qty minus both holds. Blanks are 0. Never negative. */
function wholeHold(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
function listableQty(r) {
  if (Number.isFinite(r.freeQty)) return Math.max(0, Math.floor(r.freeQty));
  return Math.max(0, wholeHold(r.airtableQty) - wholeHold(r.reservedQty) - wholeHold(r.deckReservedQty));
}
function flags(r) {
  r.expectedQty = r.status === "Listed" ? listableQty(r) : 0;
  r.ctMismatch = r.ct != null && r.ct.qty !== r.expectedQty;
  r.tcgMismatch = state.data.tcgAt != null && (r.tcg?.qty ?? 0) !== r.expectedQty;
  return r;
}
/** Applies a successful action to one row, keeps the counts right, and drops the row if it is now reconciled. */
function updateRow(recordId, change) {
  const r = state.rows.find((x) => x.recordId === recordId);
  if (!r) return;
  const before = { ct: r.ctMismatch, tcg: tcgOpen(r), pending: r.tcgMismatch && !!r.tcgPending, open: !isReconciled(r), suggested: r.tcg?.source === "suggested" };
  change(r); flags(r);
  const c = state.data.counts;
  c.ctMismatch += (r.ctMismatch ? 1 : 0) - (before.ct ? 1 : 0);
  c.tcgMismatch += (tcgOpen(r) ? 1 : 0) - (before.tcg ? 1 : 0);
  c.pendingUpload += (r.tcgMismatch && r.tcgPending ? 1 : 0) - (before.pending ? 1 : 0);
  c.open += (!isReconciled(r) ? 1 : 0) - (before.open ? 1 : 0);
  c.suggested += (r.tcg?.source === "suggested" ? 1 : 0) - (before.suggested ? 1 : 0);
  if (!visible(r)) { state.rows = state.rows.filter((x) => x !== r); state.selected.delete(recordId); }
  renderCounts();
  render();
}

function render() {
  const tbody = $("rows"); tbody.replaceChildren();
  if (!state.rows.length) empty(tbody, 11, "Nothing to show with these filters.");
  for (const r of state.rows) {
    const tr = document.createElement("tr");
    const sel = document.createElement("td");
    if (state.canManage) { const box = document.createElement("input"); box.type = "checkbox"; box.checked = state.selected.has(r.recordId); box.addEventListener("change", () => (box.checked ? state.selected.add(r.recordId) : state.selected.delete(r.recordId))); sel.appendChild(box); }
    tr.appendChild(sel);
    cell(tr, r.name, r.recordId); cell(tr, r.game); cell(tr, [r.set, r.number && `#${r.number}`].filter(Boolean).join(" · ")); cell(tr, [r.condition, r.finish].filter(Boolean).join(" · "));
    const holds = [];
    if (wholeHold(r.reservedQty)) holds.push(`${wholeHold(r.reservedQty)} reserved`);
    if (wholeHold(r.deckReservedQty)) holds.push(`${wholeHold(r.deckReservedQty)} deck`);
    const qtyText = r.status !== "Listed" ? `${r.airtableQty} (expects 0)` : holds.length ? `${r.airtableQty} (${holds.join(", ")}, ${r.expectedQty} listable)` : String(r.airtableQty);
    cell(tr, r.status); cell(tr, qtyText);
    const ct = cell(tr, r.ct ? r.ct.qty : state.data.ctAt ? "—" : "", r.ct?.listingIds.join(", ")); if (r.ctMismatch) ct.className = "error";
    const tcg = cell(tr, r.tcg ? `${r.tcg.qty}${r.tcgPending ? ` → ${r.tcg.qty + r.tcgPending.delta} pending upload` : ""}` : state.data.tcgAt ? "0 (no match)" : "", r.tcg ? `${r.tcg.productName || ""} ${r.tcg.setName || ""} ${r.tcg.condition || ""} ${money(r.tcg.priceCents)}` : ""); if (tcgOpen(r)) tcg.className = "error";
    cell(tr, r.tcg ? `${SOURCE[r.tcg.source]}${r.tcg.source === "suggested" ? ` ${Math.round(r.tcg.confidence * 100)}% (${r.tcg.confidence >= 0.9 ? "high" : r.tcg.confidence >= 0.75 ? "medium" : "low"})` : ""} · ${r.tcg.tcgplayerId}` : "");
    const actions = document.createElement("td"); actions.className = "actions"; tr.appendChild(actions);
    if (state.canManage) {
      if (r.ctMismatch) button(actions, `Set CardTrader to ${r.expectedQty}`, () => setCardTrader(r));
      if (r.tcg?.source === "suggested") { button(actions, "Confirm match", () => confirmMatch(r, false)); button(actions, "Confirm + save SKU to Airtable", () => confirmMatch(r, true)); }
      if (r.tcg?.source === "confirmed") button(actions, "Unconfirm", () => unconfirm(r));
      const targets = r.status !== "Listed" ? new Set() : new Set([r.ct?.qty, r.tcg && r.tcg.source !== "suggested" ? r.tcg.qty : undefined].filter((n) => n != null && n !== r.airtableQty && n !== r.expectedQty));
      for (const n of targets) button(actions, `Set Airtable to ${n}`, () => setAirtable(r, n));
    }
    tbody.appendChild(tr);
  }
}

function renderUnmatched() {
  const d = state.data;
  const ct = $("ct-unmatched"); ct.replaceChildren();
  if (!d.ctAt) empty(ct, 5, "Run a CardTrader check first."); else if (!d.unmatchedCardTrader.length) empty(ct, 5, "Every CardTrader listing belongs to a Waitlist row.");
  for (const l of d.unmatchedCardTrader) { const tr = document.createElement("tr"); cell(tr, l.id); cell(tr, l.blueprintId); cell(tr, l.quantity); cell(tr, money(l.priceCents)); cell(tr, l.recordId || "none"); ct.appendChild(tr); }
  const tcg = $("tcg-unmatched"); tcg.replaceChildren();
  $("tcg-unmatched-meta").textContent = d.unmatchedTcgplayerTotal > d.unmatchedTcgplayer.length ? `showing ${d.unmatchedTcgplayer.length} of ${d.unmatchedTcgplayerTotal}` : "";
  if (!d.tcgAt) empty(tcg, 8, "Upload a TCGplayer export first."); else if (!d.unmatchedTcgplayer.length) empty(tcg, 8, "Every stocked TCGplayer SKU is matched.");
  for (const t of d.unmatchedTcgplayer) {
    const tr = document.createElement("tr");
    cell(tr, t.tcgplayerId); cell(tr, t.productName); cell(tr, t.productLine); cell(tr, [t.setName, t.number && `#${t.number}`].filter(Boolean).join(" · ")); cell(tr, t.condition); cell(tr, t.totalQty); cell(tr, money(t.priceCents));
    const td = document.createElement("td"); tr.appendChild(td);
    if (state.canManage) button(td, "Match to a row…", () => manualMatch(t));
    tcg.appendChild(tr);
  }
}

function renderActions() {
  const tbody = $("actions"); tbody.replaceChildren();
  if (!state.data.actions.length) empty(tbody, 4, "No reconcile actions yet.");
  for (const a of state.data.actions) { const tr = document.createElement("tr"); cell(tr, et(a.at)); cell(tr, ACTION[a.action] || a.action, a.userId); cell(tr, a.recordId || ""); cell(tr, JSON.stringify(a.detail)); tbody.appendChild(tr); }
}

async function post(path, body, method = "POST") {
  const { response, data } = await api(path, { method, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) { say(data.error || "That did not work.", true); return null; }
  return data;
}

async function checkCardTrader() {
  const b = $("ct-check"); b.disabled = true; b.textContent = "Checking…";
  const data = await post("/api/reconcile/check");
  b.disabled = false; b.textContent = "Run check now";
  if (data) { say(`Fetched ${data.listings} CardTrader listings. Nothing was changed.`); await load(); }
}

async function uploadTcg() {
  const file = $("tcg-file").files?.[0];
  if (!file) { say("Choose the TCGplayer export CSV first.", true); return; }
  if (file.size > 15_000_000) { say("That file is too large (15 MB at most).", true); return; }
  const b = $("tcg-upload"); b.disabled = true; b.textContent = "Uploading…";
  const token = await window.Clerk?.session?.getToken().catch(() => null);
  const response = await fetch("/api/reconcile/tcgplayer/upload", { method: "POST", body: await file.text(), credentials: "same-origin", headers: { "content-type": "text/csv", accept: "application/json", "x-filename": file.name.replace(/[^\w .()-]/g, ""), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  b.disabled = false; b.textContent = "Upload export";
  let data = {}; try { data = await response.json(); } catch {}
  if (!response.ok) { say(data.error || "Upload failed.", true); return; }
  say(`Saved ${data.snapshot.stockedRows} stocked TCGplayer rows (of ${data.snapshot.totalRows})${data.skippedBad ? `, skipped ${data.skippedBad} unreadable` : ""}${data.duplicateIds ? `, ${data.duplicateIds} duplicate SKUs` : ""}.`);
  await load();
}

async function confirmMatch(r, writeSku) {
  if (writeSku && !confirm(`Write TCGplayer SKU ${r.tcg.tcgplayerId} to the “TCGplayer SKU” column of “${r.name}” in Airtable?`)) return;
  const data = await post("/api/reconcile/tcgplayer/confirm", { recordId: r.recordId, tcgplayerId: r.tcg.tcgplayerId, writeSku, confidence: r.tcg.confidence });
  if (!data) return;
  say(data.sku === "written" ? "Match confirmed and SKU saved to Airtable." : data.sku === "no_column" ? "Match saved in Hekla only: the Waitlist has no “TCGplayer SKU” column. Add a text column with that name to save SKUs." : "Match confirmed.");
  updateRow(r.recordId, (row) => { row.tcg = { ...row.tcg, source: "confirmed", confidence: 1 }; });
}
async function manualMatch(t) {
  const recordId = prompt(`Airtable record id (rec…) of the Waitlist row for TCGplayer SKU ${t.tcgplayerId} “${t.productName}”:`);
  if (!recordId) return;
  if (await post("/api/reconcile/tcgplayer/confirm", { recordId: recordId.trim(), tcgplayerId: t.tcgplayerId, writeSku: false })) { say("Match confirmed."); await load(); }
}
async function unconfirm(r) {
  if (await post(`/api/reconcile/tcgplayer/confirm/${encodeURIComponent(r.recordId)}`, null, "DELETE")) { say("Match removed."); await load(); }
}

async function setCardTrader(r) {
  const zero = r.expectedQty === 0 ? "\n\nAt 0 CardTrader deletes the listing; it would have to be listed again from the Export screen." : "";
  if (!confirm(`Set CardTrader for “${r.name}” from ${r.ct.qty} to ${r.expectedQty} (Qty minus manual and deck holds)?${zero}`)) return;
  const data = await post("/api/reconcile/cardtrader/set", { recordId: r.recordId, expectedTarget: r.expectedQty, expectedCurrent: r.ct.qty });
  if (data) { say(`CardTrader now ${data.target} for “${r.name}” (was ${data.before}).`); updateRow(r.recordId, (row) => { row.ct = { ...row.ct, qty: data.ctQty }; }); }
}

async function setAirtable(r, qty) {
  const sold = qty === 0 ? "\n\nAt 0 the row's Status becomes Sold." : "";
  if (!confirm(`Change Airtable Qty for “${r.name}” from ${r.airtableQty} to ${qty}?${sold}\n\nThis changes the shared inventory number.`)) return;
  const data = await post("/api/reconcile/airtable/set", { recordId: r.recordId, qty, expectedCurrent: r.airtableQty });
  if (data) { say(`Airtable Qty for “${r.name}” is now ${data.after} (was ${data.before}).`); updateRow(r.recordId, (row) => { row.airtableQty = data.after; row.freeQty = null; if (data.after === 0) row.status = "Sold"; }); }
}

async function buildImport() {
  const recordIds = state.rows.filter((r) => state.selected.has(r.recordId)).map((r) => r.recordId);
  if (!recordIds.length) { say("Select rows first (the boxes on the left).", true); return; }
  await downloadImport(recordIds, null);
}

/** Builds the TCGplayer import for these rows, downloads it, and marks the included rows pending upload. */
async function downloadImport(recordIds, batchId) {
  const data = await post("/api/reconcile/tcgplayer/import", { recordIds, batchId });
  if (!data) return null;
  if (data.included.length) {
    const url = URL.createObjectURL(new Blob([data.csv], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = data.filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const why = {}; for (const s of data.skipped) why[s.reason] = (why[s.reason] || 0) + 1;
  say(`${data.included.length} rows in the import file, marked pending upload.${data.skipped.length ? ` Left out: ${Object.entries(why).map(([k, n]) => `${n} ${k}`).join(", ")}.` : ""}`);
  for (const i of data.included) updateRow(i.recordId, (row) => { row.tcgPending = { at: data.pendingAt, delta: i.delta }; });
  return data;
}

/* ---------- Reconcile All: Airtable is the truth; never changes Airtable ---------- */
const FRESH_MS = 2 * 60_000;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function describePlan(plan, kind) {
  const s = plan.summary;
  const lines = ["Airtable is the source of truth. Airtable Qty is NOT changed.", ""];
  if (kind !== "tcgplayer") {
    lines.push(`CardTrader: ${plural(s.ctRows, "card")} changed (${s.ctUp} up, ${s.ctDown} down), ${plural(s.ctListingsChanged, "listing")} touched.`);
    if (s.ctDeletes) lines.push(`  ⚠ ${plural(s.ctDeletes, "CardTrader listing")} will be DELETED${s.ctToZeroRows ? ` (${plural(s.ctToZeroRows, "card")} where Airtable is 0)` : ""}. They would have to be listed again from the Export screen.`);
    if (plan.cardtraderBlocked.length) lines.push(`  ${plural(plan.cardtraderBlocked.length, "card")} can't be changed here (no CardTrader listing to raise), skipped.`);
    if (!plan.ctAt) lines.push("  CardTrader has not been checked, nothing will change there.");
  }
  if (kind !== "cardtrader") {
    lines.push(`TCGplayer: ${plural(s.tcgRows, "row")} in one import CSV (SKU or confirmed matches), marked pending upload.`);
    if (s.tcgSuggested) lines.push(`  ${plural(s.tcgSuggested, "unconfirmed suggested match", "unconfirmed suggested matches")} left out. Confirm them first.`);
    if (s.tcgSkipped) lines.push(`  ${plural(s.tcgSkipped, "other row")} left out (no price or already matching).`);
    if (!plan.tcgAt) lines.push("  No TCGplayer export uploaded, nothing for TCGplayer.");
  }
  lines.push("", "Continue?");
  return lines.join("\n");
}

function resultRow(name, platform, status, detail) {
  const tr = document.createElement("tr");
  cell(tr, name); cell(tr, platform); const st = cell(tr, status); if (status === "failed") st.className = "error"; cell(tr, detail);
  $("all-results").appendChild(tr);
}

async function reconcileAll() {
  const kind = $("f-mismatch").value;
  const wantCt = kind !== "tcgplayer", wantTcg = kind !== "cardtrader";
  const button = $("reconcile-all"); button.disabled = true;
  try {
    say("");
    // 1. A fresh read-only CardTrader check when the last one is older than 2 minutes.
    if (wantCt && (!state.data.ctAt || Date.now() - Date.parse(state.data.ctAt) > FRESH_MS)) {
      $("all-progress").textContent = "Checking CardTrader first (read-only)…"; $("all-box").hidden = false;
      if (!(await post("/api/reconcile/check"))) return;
      await load();
    }
    const visibleRows = state.rows.filter((r) => !isReconciled(r));
    if (!visibleRows.length) { say("Nothing to reconcile in this view."); return; }
    const names = new Map(visibleRows.map((r) => [r.recordId, r.name]));
    // 2. Plan and confirm.
    const plan = await post("/api/reconcile/all/plan", { recordIds: visibleRows.map((r) => r.recordId), cardtrader: wantCt, tcgplayer: wantTcg });
    if (!plan) return;
    if (!plan.cardtrader.length && !plan.tcgplayer.recordIds.length) { say(`Nothing Reconcile All can do here.${plan.summary.tcgSuggested ? ` ${plural(plan.summary.tcgSuggested, "suggested match", "suggested matches")} need confirming first.` : ""}`); return; }
    if (!confirm(describePlan(plan, kind))) return;
    const batchId = crypto.randomUUID();
    $("all-box").hidden = false; $("all-results").replaceChildren();
    for (const b of plan.cardtraderBlocked) resultRow(b.name, "CardTrader", "skipped", b.reason);
    // 3. CardTrader, in batches the page drives (no single request runs long).
    const tally = { succeeded: 0, skipped: plan.cardtraderBlocked.length, failed: 0 };
    const items = plan.cardtrader.map((i) => ({ recordId: i.recordId, expectedTarget: i.target, expectedCurrent: i.before }));
    for (let at = 0; at < items.length; at += plan.batchSize) {
      const batch = items.slice(at, at + plan.batchSize);
      $("all-progress").textContent = `CardTrader: ${at} of ${items.length} done…`;
      const { response, data } = await api("/api/reconcile/all/cardtrader", { method: "POST", body: JSON.stringify({ batchId, items: batch }) });
      if (!response.ok) {
        for (const i of batch) { tally.failed++; resultRow(names.get(i.recordId) || i.recordId, "CardTrader", "failed", data.error || `HTTP ${response.status}`); }
        continue;
      }
      for (const r of data.results) {
        tally[r.status]++;
        resultRow(names.get(r.recordId) || r.recordId, "CardTrader", r.status, r.status === "succeeded" ? `${r.before} → ${r.target}` : r.reason || "");
        if (r.status === "succeeded") updateRow(r.recordId, (row) => { row.ct = { ...row.ct, qty: r.target }; });
      }
    }
    // 4. TCGplayer: one import CSV for every included row.
    let tcgLine = "";
    if (plan.tcgplayer.recordIds.length) {
      $("all-progress").textContent = "Building the TCGplayer import CSV…";
      const csv = await downloadImport(plan.tcgplayer.recordIds, batchId);
      if (csv) { for (const i of csv.included) resultRow(names.get(i.recordId) || i.recordId, "TCGplayer", "in import CSV", `Add to Quantity ${i.delta > 0 ? "+" : ""}${i.delta}`); tcgLine = ` TCGplayer: ${plural(csv.included.length, "row")} in the downloaded import, pending upload.`; }
      else tcgLine = " TCGplayer: the import CSV could not be built.";
    }
    const ctLine = items.length || plan.cardtraderBlocked.length ? `CardTrader: ${tally.succeeded} succeeded, ${tally.skipped} skipped, ${tally.failed} failed.` : "";
    $("all-progress").textContent = `Done. ${ctLine}${tcgLine}`;
    say(`Reconcile All finished. ${ctLine}${tcgLine}`, tally.failed > 0);
  } finally { button.disabled = false; }
}

// Downloads need the bearer token, so fetch the file and hand the browser a blob.
async function download(path, fallbackName) {
  say("");
  const token = await window.Clerk?.session?.getToken().catch(() => null);
  const response = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {}, credentials: "same-origin" });
  if (!response.ok) { let msg = "Download failed."; try { msg = (await response.json()).error || msg; } catch {} say(msg, true); return; }
  const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") || "")?.[1] || fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- CardTrader cleanup → Airtable: grouped preview, one confirm, batches, Restore ---------- */

const cleanup = { preview: null, choice: new Map() };
const where = (r) => [r.set, r.number ? `#${r.number}` : "", r.condition, r.finish].filter(Boolean).join(" · ");
const usd = (n) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);

async function previewCleanup() {
  const b = $("cleanup-preview"); b.disabled = true; b.textContent = "Checking CardTrader…";
  try {
    const data = await post("/api/reconcile/cleanup/preview");
    if (!data) return;
    cleanup.preview = data; cleanup.choice = new Map(data.merges.map((g) => [g.key, "keep"]));
    renderCleanup();
  } finally { b.disabled = false; b.textContent = "Preview cleanup (fresh CardTrader check, changes nothing)"; }
}

function choiceSelect(g) {
  const sel = document.createElement("select"); sel.setAttribute("aria-label", `Choice for ${g.name}`);
  for (const [v, t] of [["keep", "Keep CardTrader qty"], ["skip", "Skip this group"]]) { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); }
  sel.value = cleanup.choice.get(g.key) || "keep";
  sel.addEventListener("change", () => { cleanup.choice.set(g.key, sel.value); renderCleanup(); });
  return sel;
}

function cleanupGroupsToApply() {
  const p = cleanup.preview;
  return [...p.merges, ...p.syncs].filter((g) => !(g.qtyMismatch && cleanup.choice.get(g.key) === "skip"));
}

function renderCleanup() {
  const p = cleanup.preview; if (!p) return;
  $("cleanup-box").hidden = false;
  $("cleanup-meta").textContent = `CardTrader checked ${et(p.ctAt)} ET · removal mode: ${p.removeMode}`;
  const skipped = p.merges.filter((g) => g.qtyMismatch && cleanup.choice.get(g.key) === "skip");
  const applying = cleanupGroupsToApply();
  const deleting = applying.reduce((n, g) => n + g.removed.length, 0);
  $("cleanup-counts").textContent = `${plural(p.counts.merges, "merge group")} (${plural(p.counts.deletes, "row")} to ${p.removeMode}), ${plural(p.counts.syncs, "qty sync")}, ${p.counts.goneNoSurvivor + p.counts.listingsNoRow} with no match, ${plural(p.counts.qtyMismatches, "qty mismatch", "qty mismatches")}${skipped.length ? ` (${skipped.length} skipped)` : ""}, ${p.counts.ambiguous} left alone.`;
  $("cl-merge-n").textContent = `(${p.merges.length})`; $("cl-delete-n").textContent = `(${p.deletes.length})`; $("cl-sync-n").textContent = `(${p.syncs.length})`;
  $("cl-nomatch-n").textContent = `(${p.counts.goneNoSurvivor + p.counts.listingsNoRow}; nothing is done to these)`; $("cl-mm-n").textContent = `(${p.counts.qtyMismatches})`; $("cl-amb-n").textContent = String(p.ambiguous.length);
  const merges = $("cl-merges"); merges.replaceChildren();
  for (const g of p.merges) {
    const tr = document.createElement("tr");
    cell(tr, g.name); cell(tr, where(g.survivor)); cell(tr, `${g.survivor.qty} → ${g.ctQty}`, g.survivor.recordId);
    cell(tr, g.removed.map((r) => `${r.recordId} (qty ${r.qty})`).join(", "));
    const t = cell(tr, `${g.airtableQtySum} vs ${g.ctQty}${g.qtyMismatch ? " · qty mismatch" : ""}`); if (g.qtyMismatch) t.className = "error";
    cell(tr, g.cost.changed ? `${usd(g.cost.before)} → ${usd(g.cost.after)}` : usd(g.cost.after));
    const td = document.createElement("td"); if (g.qtyMismatch) td.appendChild(choiceSelect(g)); else td.textContent = "Merge"; tr.appendChild(td);
    merges.appendChild(tr);
  }
  if (!p.merges.length) empty(merges, 7, "No duplicates to merge.");
  const dels = $("cl-deletes"); dels.replaceChildren();
  for (const d of p.deletes) { const tr = document.createElement("tr"); const skip = cleanup.choice.get(p.merges.find((g) => g.survivor.recordId === d.intoRecordId)?.key) === "skip"; cell(tr, `${d.name}${skip ? " (group skipped)" : ""}`); cell(tr, d.qty); cell(tr, `${d.intoName} (${d.intoRecordId})`); cell(tr, d.recordId); dels.appendChild(tr); }
  if (!p.deletes.length) empty(dels, 4, "Nothing to delete.");
  const syncs = $("cl-syncs"); syncs.replaceChildren();
  for (const g of p.syncs) { const tr = document.createElement("tr"); cell(tr, `${g.name} · ${where(g.survivor)}`); cell(tr, `${g.survivor.qty} → ${g.ctQty}`); cell(tr, [g.update.cost ? `cost ${usd(g.cost.before)} → ${usd(g.cost.after)}` : "", g.update.listingId ? `listing id → ${g.listingId}` : ""].filter(Boolean).join("; ")); syncs.appendChild(tr); }
  if (!p.syncs.length) empty(syncs, 3, "Every surviving row already has CardTrader's quantity.");
  const nm = $("cl-nomatch"); nm.replaceChildren();
  for (const r of p.noMatch.goneNoSurvivor) { const tr = document.createElement("tr"); cell(tr, "Airtable row, CardTrader listing gone, no survivor"); cell(tr, `${r.name} · ${where(r)}`); cell(tr, `Airtable Qty ${r.qty}, listing ${r.listingId}`); nm.appendChild(tr); }
  for (const l of p.noMatch.listingsNoRow) { const tr = document.createElement("tr"); cell(tr, "CardTrader listing, no Airtable row"); cell(tr, `listing ${l.id}`); cell(tr, `qty ${l.quantity}${l.recordId ? `, tag ${l.recordId}` : ""}`); nm.appendChild(tr); }
  if (!nm.children.length) empty(nm, 3, "None.");
  const mm = $("cl-mm"); mm.replaceChildren();
  for (const g of p.merges.filter((x) => x.qtyMismatch)) { const tr = document.createElement("tr"); cell(tr, `${g.name} · ${where(g.survivor)}`); cell(tr, g.airtableQtySum); cell(tr, g.ctQty); const td = document.createElement("td"); td.appendChild(choiceSelect(g)); tr.appendChild(td); mm.appendChild(tr); }
  if (!mm.children.length) empty(mm, 4, "None.");
  const amb = $("cl-amb"); amb.replaceChildren();
  for (const a of p.ambiguous) { const tr = document.createElement("tr"); cell(tr, a.key); cell(tr, a.listingIds.join(", ")); amb.appendChild(tr); }
  const apply = $("cleanup-apply");
  apply.hidden = !applying.length;
  apply.textContent = `Apply: update ${plural(applying.filter((g) => g.patch).length, "row")}, ${p.removeMode} ${plural(deleting, "row")}`;
}

async function applyCleanup() {
  const p = cleanup.preview; if (!p) return;
  const groups = cleanupGroupsToApply();
  const deleting = groups.flatMap((g) => g.removed.map((r) => `• ${r.name} (Airtable Qty ${r.qty}) → into ${g.survivor.recordId}`));
  const updating = groups.filter((g) => g.patch).map((g) => `• ${g.name}: Qty ${g.survivor.qty} → ${g.ctQty}${g.update.cost ? `, cost ${usd(g.cost.before)} → ${usd(g.cost.after)}` : ""}`);
  const text = `Apply the CardTrader cleanup?\n\n${p.removeMode === "archive" ? "Archive" : "DELETE from Airtable"} ${plural(deleting.length, "record")}:\n${deleting.slice(0, 40).join("\n")}${deleting.length > 40 ? `\n…and ${deleting.length - 40} more (all listed on the page)` : ""}\n\nUpdate ${plural(updating.length, "row")}:\n${updating.slice(0, 20).join("\n")}${updating.length > 20 ? `\n…and ${updating.length - 20} more` : ""}\n\nEvery record is copied to Hekla first and can be restored. Each group is re-checked against CardTrader and Airtable right before it changes.`;
  if (!confirm(text)) return;
  const batchId = crypto.randomUUID();
  const items = [...groups.map((g) => ({ key: g.key, survivorId: g.survivor.recordId, listingId: g.listingId, ctQty: g.ctQty, removeIds: g.removed.map((r) => r.recordId), mode: "keep" })),
    ...p.merges.filter((g) => g.qtyMismatch && cleanup.choice.get(g.key) === "skip").map((g) => ({ key: g.key, survivorId: g.survivor.recordId, listingId: g.listingId, ctQty: g.ctQty, removeIds: g.removed.map((r) => r.recordId), mode: "skip" }))];
  const btn = $("cleanup-apply"); btn.disabled = true; $("cl-results-box").hidden = false; $("cl-results").replaceChildren();
  const tally = { succeeded: 0, skipped: 0, failed: 0 };
  const add = (name, status, detail) => { const tr = document.createElement("tr"); cell(tr, name); const s = cell(tr, status); if (status === "failed") s.className = "error"; cell(tr, detail); $("cl-results").appendChild(tr); };
  try {
    for (let at = 0; at < items.length; at += p.batchSize) {
      const batch = items.slice(at, at + p.batchSize);
      $("cl-progress").textContent = `${at} of ${items.length} groups done…`;
      const { response, data } = await api("/api/reconcile/cleanup/apply", { method: "POST", body: JSON.stringify({ batchId, groups: batch }) });
      if (!response.ok) { for (const i of batch) { tally.failed++; add(i.key, "failed", data.error || `HTTP ${response.status}`); } continue; }
      for (const r of data.results) {
        tally[r.status]++;
        add(r.name, r.status, r.status === "succeeded" ? [r.updated ? `updated ${Object.entries(r.updated).map(([k, v]) => `${k}=${v}`).join(", ")}` : "", r.removed.length ? `${data.mode === "archive" ? "archived" : "deleted"} ${r.removed.join(", ")}` : ""].filter(Boolean).join("; ") : `${r.reason || ""}${r.removed?.length ? ` (removed before failing: ${r.removed.join(", ")})` : ""}`);
      }
    }
    $("cl-progress").textContent = `Done: ${tally.succeeded} succeeded, ${tally.skipped} skipped, ${tally.failed} failed.`;
    say(`Cleanup finished: ${tally.succeeded} succeeded, ${tally.skipped} skipped, ${tally.failed} failed.`, tally.failed > 0);
    $("cleanup-apply").hidden = true; cleanup.preview = null;
    await load();
    if ($("cl-snap-box").open) loadSnapshots();
  } finally { btn.disabled = false; }
}

async function loadSnapshots() {
  const { response, data } = await api("/api/reconcile/cleanup/snapshots");
  const tb = $("cl-snaps"); tb.replaceChildren();
  if (!response.ok) { empty(tb, 6, data.error || "Could not load."); return; }
  for (const s of data.snapshots) {
    const tr = document.createElement("tr");
    cell(tr, et(s.takenAt)); cell(tr, s.name); cell(tr, `${s.action}${s.appliedAt ? "" : " (not applied)"}`); cell(tr, s.qty); cell(tr, s.restoredRecordId ? `${s.recordId} → restored as ${s.restoredRecordId}` : s.recordId);
    const td = document.createElement("td");
    if (data.canManage && s.appliedAt && !s.restoredAt && s.action !== "update") button(td, "Restore", async () => { if (!confirm(`Re-create “${s.name}” in Airtable from the snapshot?`)) return; const r = await post("/api/reconcile/cleanup/restore", { snapshotId: s.id }); if (r) { say(`Restored as ${r.recordId}.`); loadSnapshots(); load(); } });
    tr.appendChild(td); tb.appendChild(tr);
  }
  if (!data.snapshots.length) empty(tb, 6, "No cleanup snapshots yet.");
}
