const $ = (id) => document.getElementById(id);
const state = { canManage: false };
const PLATFORM = { cardtrader: "CardTrader", starfoil: "starfoil.store", allocation: "Deck sale" };
const DRIFT = { over_listed: "CardTrader shows more than you have", under_listed: "CardTrader shows fewer", missing_on_cardtrader: "Not on CardTrader", unknown_record: "Listing points at an unknown row" };

document.addEventListener("DOMContentLoaded", () => {
  $("logout").addEventListener("click", signOut);
  $("login-signout").addEventListener("click", signOut);
  $("filters").addEventListener("submit", (e) => { e.preventDefault(); loadSales(); });
  $("export").addEventListener("click", () => download(`/api/sales/export?${query()}`, "sales.csv"));
  $("pull-csv").addEventListener("click", () => download(`/api/tcgplayer/pull.csv?hours=${$("pull-hours").value}`, "tcgplayer-import.csv"));
  $("pull-list").addEventListener("click", () => download(`/api/tcgplayer/pull.csv?format=checklist&hours=${$("pull-hours").value}`, "tcgplayer-pull-list.csv"));
  $("pull-hours").addEventListener("change", loadPull);
  $("poll").addEventListener("click", pollNow);
  $("reconcile").addEventListener("click", reconcileNow);
  boot();
});

function show(name) {
  $("boot").hidden = name !== "boot";
  $("login-view").hidden = name !== "login";
  $("sales-view").hidden = name !== "sales";
}

async function boot() {
  let clerk;
  try { clerk = await loadClerk(); } catch (error) { show("login"); $("login-error").textContent = error.message || "Could not load sign-in."; return; }
  if (!clerk.user) { show("login"); clerk.mountSignIn($("clerk-mount"), { forceRedirectUrl: "/sales" }); return; }
  $("login-signout").hidden = false;
  const session = await api("/api/session");
  if (!session.response.ok) { show("login"); $("login-error").textContent = session.data.error || "Could not open sales."; return; }
  $("tenant-name").textContent = session.data.tenant || "";
  state.canManage = session.data.role === "org:admin";
  for (const game of session.data.games || []) { const o = document.createElement("option"); o.value = game; o.textContent = game; $("f-game").appendChild(o); }
  $("poll").hidden = !state.canManage;
  $("reconcile").hidden = !state.canManage;
  show("sales");
  await Promise.all([loadSales(), loadPull(), loadReconcile()]);
}

function query() {
  const p = new URLSearchParams();
  const set = (k, v) => { if (v) p.set(k, v); };
  set("platform", $("f-platform").value); set("from", $("f-from").value); set("to", $("f-to").value);
  set("game", $("f-game").value); set("q", $("f-q").value.trim()); if ($("f-cancelled").checked) p.set("cancelled", "1");
  return p.toString();
}

const money = (cents, currency) => (cents == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(cents / 100));
const et = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : "");
function cell(tr, text, title) { const td = document.createElement("td"); td.textContent = text == null ? "" : String(text); if (title) td.title = title; tr.appendChild(td); return td; }
function empty(tbody, cols, text) { const tr = document.createElement("tr"); const td = cell(tr, text); td.colSpan = cols; td.className = "hint"; tbody.appendChild(tr); }

function describeModes(m) {
  const sales = { off: "CardTrader sales off", log: "logging CardTrader sales", decrement: m.decrementFrom ? `Hekla lowers Qty for CardTrader sales since ${et(m.decrementFrom)} ET` : "decrement mode without a hand-over time (logging only)" }[m.salesMode];
  return `${sales} · stock check ${m.reconcileMode}`;
}

async function loadSales() {
  $("sales-error").textContent = "";
  const { response, data } = await api(`/api/sales?${query()}`);
  if (!response.ok) { $("sales-error").textContent = data.error || "Could not load sales."; return; }
  $("modes").textContent = describeModes(data.modes);
  $("last-poll").textContent = data.lastPoll?.at ? `CardTrader last checked ${et(data.lastPoll.at)} ET` : "";
  const totals = $("totals"); totals.replaceChildren();
  if (!data.totals.length) empty(totals, 6, "No sales in this view.");
  for (const t of data.totals) {
    const tr = document.createElement("tr");
    cell(tr, PLATFORM[t.platform] || t.platform); cell(tr, t.orders); cell(tr, t.qty); cell(tr, money(t.grossCents, t.currency));
    cell(tr, money(t.feeCents, t.currency) + (t.unknownFeeLines ? ` (+${t.unknownFeeLines} unknown)` : "")); cell(tr, money(t.netCents, t.currency));
    totals.appendChild(tr);
  }
  const rows = $("rows"); rows.replaceChildren();
  if (!data.rows.length) empty(rows, 11, "Nothing yet. Sales appear here once CT_SALES_MODE is on, or when starfoil.store sends them.");
  for (const r of data.rows) {
    const tr = document.createElement("tr");
    cell(tr, et(r.soldAt)); cell(tr, PLATFORM[r.platform] || r.platform); cell(tr, r.orderCode || r.externalOrderId, r.externalOrderId);
    cell(tr, r.cardName, r.recordId || ""); cell(tr, r.game); cell(tr, r.qty); cell(tr, money(r.grossCents, r.currency)); cell(tr, money(r.feeCents, r.currency)); cell(tr, money(r.netCents, r.currency));
    cell(tr, r.cancelledAt ? "cancelled" : r.orderState);
    const flags = [r.oversold ? "OVERSOLD" : "", r.decrementedAt ? "Qty lowered by Hekla" : "", r.needsReview ? "needs review" : ""].filter(Boolean).join(" · ");
    cell(tr, flags, r.needsReview || "");
    rows.appendChild(tr);
  }
  $("rows-meta").textContent = data.truncated ? "Showing the newest 1,000. Narrow the dates or download the CSV for everything." : `${data.rows.length} line${data.rows.length === 1 ? "" : "s"}.`;
}

async function loadPull() {
  const { response, data } = await api(`/api/tcgplayer/pull?hours=${$("pull-hours").value}`);
  const tbody = $("pull"); tbody.replaceChildren();
  if (!response.ok) { $("pull-meta").textContent = data.error || "Could not load the pull list."; return; }
  if (!data.items.length) empty(tbody, 7, "Nothing sold elsewhere in this window.");
  for (const i of data.items) {
    const tr = document.createElement("tr");
    cell(tr, i.name, i.recordId || ""); cell(tr, [i.set, i.number && `#${i.number}`].filter(Boolean).join(" ")); cell(tr, [i.condition, i.finish].filter(Boolean).join(" "));
    cell(tr, `−${i.qtySold}`); cell(tr, i.platforms.map((p) => PLATFORM[p] || p).join(" + ")); cell(tr, i.soldOut ? "0 (sold out)" : i.sharedQty ?? "—"); cell(tr, i.tcgplayerSku || "missing");
    tbody.appendChild(tr);
  }
  $("pull-meta").textContent = `${data.importable} in the import file${data.notImportable.length ? `, ${data.notImportable.length} only in the checklist (no SKU or price)` : ""}.`;
}

async function loadReconcile() {
  const { response, data } = await api("/api/reconcile");
  if (!response.ok) { $("reconcile-meta").textContent = data.error || ""; return; }
  $("reconcile-mode").textContent = { off: "It is off (RECONCILE_MODE).", report: "It reports only.", push: "It lowers CardTrader when it shows more than you have two checks in a row; it never raises anything." }[data.mode] || "";
  renderReport(data.report);
}

function renderReport(report) {
  const tbody = $("drift"); tbody.replaceChildren();
  if (!report) { $("reconcile-meta").textContent = "No check has run yet."; return; }
  $("reconcile-meta").textContent = `Last check ${et(report.at)} ET: ${report.checkedRows} rows, ${report.listings} CardTrader listings${report.pushed.length ? `, lowered ${report.pushed.length}` : ""}.${report.errors.length ? ` ${report.errors.join(" ")}` : ""}`;
  if (!report.drift.length) empty(tbody, 5, "Everything matches.");
  for (const d of report.drift) {
    const tr = document.createElement("tr");
    cell(tr, DRIFT[d.kind] || d.kind); cell(tr, d.name || ""); cell(tr, d.airtableQty ?? "—"); cell(tr, `${d.cardTraderQty} (${d.listingIds.join(", ")})`); cell(tr, d.recordId || "");
    tbody.appendChild(tr);
  }
}

async function pollNow() {
  $("sales-error").textContent = ""; $("sales-flash").textContent = "";
  const { response, data } = await api("/api/sales/poll", { method: "POST" });
  if (!response.ok) { $("sales-error").textContent = data.error || "Could not check CardTrader."; return; }
  $("sales-flash").textContent = `Checked ${data.result?.orders ?? 0} orders, ${data.result?.newLines ?? 0} new lines.`;
  await Promise.all([loadSales(), loadPull()]);
}

async function reconcileNow() {
  $("sales-error").textContent = "";
  const button = $("reconcile"); button.disabled = true; button.textContent = "Checking…";
  const { response, data } = await api("/api/reconcile", { method: "POST" });
  button.disabled = false; button.textContent = "Check now";
  if (!response.ok) { $("sales-error").textContent = data.error || "Could not run the check."; return; }
  renderReport(data.report);
}

// Downloads need the bearer token, so fetch the file and hand the browser a blob.
async function download(path, fallbackName) {
  $("sales-error").textContent = "";
  const token = await window.Clerk?.session?.getToken().catch(() => null);
  const response = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {}, credentials: "same-origin" });
  if (!response.ok) { let msg = "Download failed."; try { msg = (await response.json()).error || msg; } catch {} $("sales-error").textContent = msg; return; }
  const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") || "")?.[1] || fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
