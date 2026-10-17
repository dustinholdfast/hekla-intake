const $ = (id) => document.getElementById(id);
const state = { canManage: false, rows: [], selected: new Set() };
const ACTION = { check_cardtrader: "Checked CardTrader", tcgplayer_upload: "Uploaded TCGplayer export", tcgplayer_confirm: "Confirmed TCGplayer match", tcgplayer_unconfirm: "Removed TCGplayer match", tcgplayer_sku_write: "Wrote SKU to Airtable", tcgplayer_import_csv: "Built TCGplayer import", cardtrader_set: "Set CardTrader qty", airtable_set: "Set Airtable Qty" };
const SOURCE = { sku: "Airtable SKU", confirmed: "confirmed", suggested: "suggested" };

document.addEventListener("DOMContentLoaded", () => {
  $("logout").addEventListener("click", signOut);
  $("login-signout").addEventListener("click", signOut);
  $("filters").addEventListener("submit", (e) => { e.preventDefault(); load(); });
  $("export").addEventListener("click", () => download(`/api/reconcile/view.csv?${query()}`, "reconcile.csv"));
  $("ct-check").addEventListener("click", checkCardTrader);
  $("tcg-upload").addEventListener("click", uploadTcg);
  $("tcg-import").addEventListener("click", buildImport);
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
  for (const id of ["ct-check", "tcg-upload-box", "tcg-import", "select-all"]) $(id).hidden = !state.canManage;
  show("recon");
  await load();
}

function query() {
  const p = new URLSearchParams();
  if ($("f-mismatch").value) p.set("mismatch", $("f-mismatch").value);
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
  const c = data.counts;
  $("counts").textContent = `${c.rows} cards · ${data.ctAt ? `${c.ctMismatch} CardTrader mismatches` : "CardTrader not checked"} · ${data.tcgAt ? `${c.tcgMismatch} TCGplayer mismatches, ${c.suggested} suggested matches to confirm` : "no TCGplayer export"}`;
  render();
  renderUnmatched();
  renderActions();
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
    cell(tr, r.status); cell(tr, r.status === "Listed" ? r.airtableQty : `${r.airtableQty} (expects 0)`);
    const ct = cell(tr, r.ct ? r.ct.qty : state.data.ctAt ? "—" : "", r.ct?.listingIds.join(", ")); if (r.ctMismatch) ct.className = "error";
    const tcg = cell(tr, r.tcg ? r.tcg.qty : state.data.tcgAt ? "0 (no match)" : "", r.tcg ? `${r.tcg.productName || ""} ${r.tcg.setName || ""} ${r.tcg.condition || ""} ${money(r.tcg.priceCents)}` : ""); if (r.tcgMismatch) tcg.className = "error";
    cell(tr, r.tcg ? `${SOURCE[r.tcg.source]}${r.tcg.source === "suggested" ? ` ${Math.round(r.tcg.confidence * 100)}% (${r.tcg.confidence >= 0.9 ? "high" : r.tcg.confidence >= 0.75 ? "medium" : "low"})` : ""} · ${r.tcg.tcgplayerId}` : "");
    const actions = document.createElement("td"); actions.className = "actions"; tr.appendChild(actions);
    if (state.canManage) {
      if (r.ctMismatch) button(actions, `Set CardTrader to ${r.expectedQty}`, () => setCardTrader(r));
      if (r.tcg?.source === "suggested") { button(actions, "Confirm match", () => confirmMatch(r, false)); button(actions, "Confirm + save SKU to Airtable", () => confirmMatch(r, true)); }
      if (r.tcg?.source === "confirmed") button(actions, "Unconfirm", () => unconfirm(r));
      const targets = r.status !== "Listed" ? new Set() : new Set([r.ct?.qty, r.tcg && r.tcg.source !== "suggested" ? r.tcg.qty : undefined].filter((n) => n != null && n !== r.airtableQty));
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
  await load();
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
  if (!confirm(`Set CardTrader for “${r.name}” from ${r.ct.qty} to ${r.expectedQty} (the Airtable quantity)?${zero}`)) return;
  const data = await post("/api/reconcile/cardtrader/set", { recordId: r.recordId, expectedTarget: r.expectedQty, expectedCurrent: r.ct.qty });
  if (data) { say(`CardTrader now ${data.target} for “${r.name}” (was ${data.before}).`); await load(); }
}

async function setAirtable(r, qty) {
  const sold = qty === 0 ? "\n\nAt 0 the row's Status becomes Sold." : "";
  if (!confirm(`Change Airtable Qty for “${r.name}” from ${r.airtableQty} to ${qty}?${sold}\n\nThis changes the shared inventory number.`)) return;
  const data = await post("/api/reconcile/airtable/set", { recordId: r.recordId, qty, expectedCurrent: r.airtableQty });
  if (data) { say(`Airtable Qty for “${r.name}” is now ${data.after} (was ${data.before}).`); await load(); }
}

async function buildImport() {
  const recordIds = state.rows.filter((r) => state.selected.has(r.recordId)).map((r) => r.recordId);
  if (!recordIds.length) { say("Select rows first (the boxes on the left).", true); return; }
  const data = await post("/api/reconcile/tcgplayer/import", { recordIds });
  if (!data) return;
  if (data.included.length) {
    const url = URL.createObjectURL(new Blob([data.csv], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = data.filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const why = {}; for (const s of data.skipped) why[s.reason] = (why[s.reason] || 0) + 1;
  say(`${data.included.length} rows in the import file.${data.skipped.length ? ` Left out: ${Object.entries(why).map(([k, n]) => `${n} ${k}`).join(", ")}.` : ""}`);
  await load();
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
