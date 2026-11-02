const $ = (id) => document.getElementById(id);
const state = { payload: null, selected: "", opened: false };
let loadVersion = 0;
let detailVersion = 0;

document.addEventListener("DOMContentLoaded", () => {
  restoreFilters();
  $("logout").addEventListener("click", () => { if (document.documentElement.dataset.preview === "1") return; signOut(); });
  $("login-signout").addEventListener("click", signOut);
  $("filters").addEventListener("submit", (event) => { event.preventDefault(); load(); });
  $("detail-close").addEventListener("click", () => select(""));
  $("inventory-refresh").addEventListener("click", load);
  $("clear-filters").addEventListener("click", () => {
    for (const id of ["f-q", "f-game", "f-condition", "f-finish", "f-flag", "f-cost"]) $(id).value = "";
    load();
    $("f-q").focus();
  });
  $("review-stock").addEventListener("click", () => { $("f-flag").value = "review"; load(); $("filters").scrollIntoView({ block: "start" }); });
  document.addEventListener("keydown", (event) => {
    const editing = event.target.closest?.("input, select, textarea, [contenteditable]");
    if (event.key === "/" && !editing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); $("f-q").focus();
    }
  });
  boot();
});

function restoreFilters() {
  const params = new URLSearchParams(location.search);
  for (const [key, id] of Object.entries({ q: "f-q", game: "f-game", condition: "f-condition", finish: "f-finish", flag: "f-flag", cost: "f-cost" })) {
    const value = params.get(key);
    if (!value) continue;
    // Game/condition/finish options arrive with the first response; retain the requested selection.
    if (["game", "condition", "finish"].includes(key)) {
      const option = document.createElement("option"); option.value = value; option.textContent = value; $(id).appendChild(option);
    }
    $(id).value = value;
  }
}

function show(name) {
  $("boot").hidden = name !== "boot";
  $("login-view").hidden = name !== "login";
  $("inventory-view").hidden = name !== "inventory";
}

async function boot() {
  if (document.documentElement.dataset.preview === "1") {
    $("tenant-name").textContent = "Fixture ledger";
    $("logout").hidden = true;
    show("inventory");
    await load();
    return;
  }
  let clerk;
  try { clerk = await loadClerk(); } catch (error) { show("login"); $("login-error").textContent = error.message || "Could not load sign-in."; return; }
  if (!clerk.user) { show("login"); clerk.mountSignIn($("clerk-mount"), { forceRedirectUrl: "/inventory" }); return; }
  $("login-signout").hidden = false;
  const session = await api("/api/session");
  if (!session.response.ok) { show("login"); $("login-error").textContent = session.data.error || "Could not open inventory."; return; }
  $("tenant-name").textContent = session.data.tenant || "";
  show("inventory");
  await load();
}

function query() {
  const params = new URLSearchParams();
  const set = (key, value) => { if (value) params.set(key, value); };
  set("q", $("f-q").value.trim());
  set("game", $("f-game").value);
  set("condition", $("f-condition").value);
  set("finish", $("f-finish").value);
  set("flag", $("f-flag").value);
  set("cost", $("f-cost").value);
  return params.toString();
}

const money = (usd) => (usd == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(usd));
const et = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : "");

function fillSelect(id, values, current, allLabel) {
  const select = $(id);
  const chosen = current ?? select.value;
  select.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = allLabel;
  select.appendChild(all);
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  select.value = values.includes(chosen) ? chosen : "";
}

function cell(tr, label, text, className) {
  const td = document.createElement("td");
  td.dataset.label = label;
  if (className) td.className = className;
  td.textContent = text == null ? "" : String(text);
  tr.appendChild(td);
  return td;
}

function badge(parent, text, kind) {
  const span = document.createElement("span");
  span.className = `status ${kind || ""}`.trim();
  span.textContent = text;
  parent.appendChild(span);
}

async function load() {
  const version = ++loadVersion;
  ++detailVersion;
  $("inventory-error").textContent = "";
  $("accuracy-note").textContent = "Reading current stock…";
  $("inventory-refresh").textContent = "Refreshing…";
  $("inventory-refresh").disabled = true;
  const filters = query();
  if (typeof history !== "undefined" && typeof location !== "undefined") {
    history.replaceState(null, "", location.pathname + (filters ? `?${filters}` : ""));
    document.querySelectorAll?.('.workspace-subnav a').forEach(link => {
      const href = link.getAttribute('href');
      if (href !== '/inventory' && href !== '/inventory?flag=review') return;
      if (href === ($("f-flag").value === 'review' ? '/inventory?flag=review' : '/inventory')) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }
  let result;
  try { result = await api(`/api/inventory?${filters}`); }
  catch { if (version === loadVersion) unavailable("Current stock could not be reached. Refresh to try again."); return; }
  if (version !== loadVersion) return;
  $("inventory-refresh").textContent = "Refresh stock";
  $("inventory-refresh").disabled = false;
  const { response, data } = result;
  if (!response.ok) { unavailable(data.error || "Could not load inventory."); return; }
  state.payload = data;
  const live = data.onHandSource === "airtable";
  const accuracy = data.accuracy;
  $("accuracy-note").textContent = live
    ? `Updated ${et(data.generatedAt)} · ${accuracy.different} differences · ${accuracy.unrecorded} without history · ${accuracy.missing} missing records. History is incomplete.`
    : "Fixture quantities from recorded movements. This is not a live stock read.";
  const liability = data.liability;
  if (liability && Number.isInteger(liability.outstandingCents)) {
    $("credit-cap").classList.remove("inert-cap");
    $("credit-total").textContent = money(liability.outstandingCents / 100);
    $("credit-note").textContent = `${liability.entries} ledger row${liability.entries === 1 ? "" : "s"} · ${liability.customers} customer reference${liability.customers === 1 ? "" : "s"} · issued at receive`;
  } else {
    $("credit-total").textContent = "–";
    $("credit-note").textContent = data.placeholders.storeCredit;
  }
  $("units").textContent = String(data.totals.units);
  $("units-note").textContent = `Across ${data.totals.rows} stock rows · from ${live ? "Airtable" : "fixture movements"}`;
  $("unknown-cost").textContent = String(data.totals.unknownCostUnits);
  $("cost-note").textContent = `${data.totals.knownCostUnits} known units · ${data.totals.unknownCostUnits} unknown · mixed-cost rows split by quantity`;
  $("flag-count").textContent = String(data.totals.needsReview);
  $("flag-note").textContent = `${data.totals.low} low-stock flags · ${data.totals.overstock} overstock flags`;
  const t = data.thresholds;
  $("threshold-note").textContent = `Low: Want Qty is set and on hand is at most ${t.lowStockOnHand}. Overstock: above Want Qty, or more than ${t.overstockSkuLimit} while the level setting is ${t.tcgplayerLevel}. Acquisition dates are not inferred from row creation. Sold or skipped rows with a positive quantity need review.`;
  fillSelect("f-game", data.facets.games, $("f-game").value, "All games");
  fillSelect("f-condition", data.facets.conditions, $("f-condition").value, "Any condition");
  fillSelect("f-finish", data.facets.finishes, $("f-finish").value, "Any finish");
  const body = $("rows");
  body.replaceChildren();
  if (!data.rows.length) {
    const tr = document.createElement("tr");
    const td = cell(tr, "", data.totals.rows ? "Nothing matches these filters." : "No stock rows found in this organization's Airtable table.", "empty");
    td.colSpan = 8;
    body.appendChild(tr);
  }
  const visible = data.rows.some((row) => row.recordId === state.selected);
  if (!state.opened && data.rows[0]) state.selected = data.rows[0].recordId;
  else if (state.selected && !visible) state.selected = data.rows[0]?.recordId || "";
  for (const row of data.rows) body.appendChild(renderRow(row));
  $("rows-meta").textContent = `${data.rows.length} shown · quantities from ${live ? "Airtable" : "fixture movements"} · ${data.wantQtyState === "matched" ? "Want Qty read from Buy List" : "Want Qty not loaded"}`;
  if (state.selected) await loadDetail(state.selected);
  else select("");
}

function unavailable(message) {
  state.payload = null;
  ++detailVersion;
  $("inventory-refresh").textContent = "Refresh stock";
  $("inventory-refresh").disabled = false;
  $("inventory-error").textContent = message;
  $("accuracy-note").textContent = "Current inventory is unavailable. Previous totals have been cleared.";
  for (const id of ["units", "unknown-cost", "flag-count", "credit-total"]) $(id).textContent = "—";
  for (const id of ["units-note", "cost-note", "flag-note", "credit-note", "rows-meta"]) $(id).textContent = "";
  $("rows").replaceChildren();
  $("detail-body").hidden = true;
  $("detail-empty").hidden = false;
  $("detail-name").textContent = "Card";
}

function renderRow(row) {
  const tr = document.createElement("tr");
  tr.tabIndex = 0;
  tr.dataset.recordId = row.recordId;
  tr.setAttribute("aria-selected", row.recordId === state.selected ? "true" : "false");
  tr.addEventListener("click", () => select(row.recordId));
  tr.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(row.recordId); } });
  const card = document.createElement("td");
  card.dataset.label = "Card";
  const wrap = document.createElement("div");
  wrap.className = "cell-card";
  const thumb = document.createElement("span");
  thumb.className = `thumb ${thumbClass(row.game)}`;
  thumb.textContent = thumbText(row.game);
  const copy = document.createElement("div");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = row.name;
  const sub = document.createElement("span");
  sub.className = "sub";
  sub.textContent = [row.game, row.setLabel, row.collectorNumber ? `#${row.collectorNumber}` : ""].filter(Boolean).join(" · ");
  copy.append(name, sub);
  wrap.append(thumb, copy);
  card.appendChild(wrap);
  tr.appendChild(card);
  const finish = cell(tr, "Finish", "");
  const finishWrap = document.createElement("div");
  finishWrap.textContent = row.finish || row.finishRaw || "—";
  if (row.rarityNote || (row.finishRaw === "Normal" && row.finish === "Regular")) {
    const note = document.createElement("span");
    note.className = "sub";
    note.textContent = row.rarityNote ? `${row.rarityNote} rarity` : "was Normal";
    finishWrap.appendChild(note);
  }
  finish.replaceChildren(finishWrap);
  cell(tr, "Cond", row.condition || "—");
  cell(tr, "Lang", row.language === "English" ? "EN" : row.language, "num");
  cell(tr, "On hand", row.onHand, "num");
  const cost = cell(tr, "Cost/unit", row.unitCostCents == null ? "unknown" : money(row.unitCostCents / 100), row.unitCostCents == null ? "num unk" : "num");
  if (row.unitCostCents == null) cost.classList.add("unk");
  if (row.knownCostQty != null) cost.title = `${row.knownCostQty} units with known cost; ${row.unknownCostQty} units with unknown cost. The unit price applies only to known-cost units.`;
  cell(tr, "Market", money(row.marketPriceUsd), "num");
  const stateCell = cell(tr, "State", "");
  const flags = document.createElement("div");
  flags.className = "flag-row";
  badge(flags, row.state, row.state === "Missing" ? "bad" : row.state === "Sold" ? "Sold" : "ok");
  if (row.flags.low) badge(flags, "low", "bad");
  if (row.flags.overstock) badge(flags, row.flags.overstockBy ? `overstock +${row.flags.overstockBy}` : "overstock", "gold");
  if (row.flags.slow) badge(flags, row.flags.ageSource === "first_seen" ? `slow · ${row.flags.daysWithoutSale}d first seen` : "slow", "warn");
  if (row.flags.needsReview) badge(flags, "needs review", "bad");
  stateCell.appendChild(flags);
  return tr;
}

function thumbClass(game) {
  if (game === "Magic: The Gathering") return "magic";
  if (game === "Riftbound") return "rift";
  return "lorcana";
}
function thumbText(game) {
  if (game === "Magic: The Gathering") return "MG";
  if (game === "Riftbound") return "RB";
  return "LC";
}

async function select(recordId) {
  ++detailVersion;
  state.opened = true;
  state.selected = recordId;
  for (const tr of $("rows").querySelectorAll("tr")) tr.setAttribute("aria-selected", tr.dataset.recordId === recordId ? "true" : "false");
  if (!recordId) {
    $("detail-name").textContent = "Card";
    $("detail-empty").hidden = false;
    $("detail-body").hidden = true;
    return;
  }
  await loadDetail(recordId);
}

async function loadDetail(recordId) {
  const version = ++detailVersion;
  $("detail-body").hidden = true;
  let result;
  try { result = await api(`/api/inventory/${recordId}`); }
  catch { if (version === detailVersion) $("inventory-error").textContent = "Could not load that card. Try again."; return; }
  if (version !== detailVersion || state.selected !== recordId) return;
  const { response, data } = result;
  if (!response.ok) { $("inventory-error").textContent = data.error || "Could not load that card."; return; }
  const row = data.row;
  for (const tr of $("rows").querySelectorAll("tr")) tr.setAttribute("aria-selected", tr.dataset.recordId === recordId ? "true" : "false");
  $("detail-name").textContent = row.name;
  $("detail-empty").hidden = true;
  $("detail-body").hidden = false;
  $("detail-review").textContent = row.flags.needsReview || "Current quantity matches the recorded total. History may still be incomplete.";
  $("detail-review").classList.toggle("has-issue", Boolean(row.flags.needsReview));
  const intake = $("open-intake-row");
  const status = row.airtableStatus;
  intake.hidden = row.state === "Missing" || !["Waitlist", "Listed", "Sold", "Skip"].includes(status);
  if (!intake.hidden) intake.href = `/?${new URLSearchParams({ game: row.game || "Lorcana", status, q: row.recordId })}#queue-panel`;
  const dl = $("detail-id");
  dl.replaceChildren();
  const lines = [
    ["Identity", [row.game, row.setLabel, row.collectorNumber ? `#${row.collectorNumber}` : "", row.finish || row.finishRaw, row.condition, row.language].filter(Boolean).join(" · ")],
    ["On hand", row.state === "Missing" ? "Not present in Airtable; not counted as current stock" : `${row.onHand} from ${data.onHandSource === "airtable" ? "Airtable" : "fixture movements"}`],
    ["Recorded quantity", row.accuracy ? (row.accuracy.ledgerQty == null ? "No recorded history" : String(row.accuracy.ledgerQty)) : String(row.onHand)],
    ["Want Qty", row.wantQty == null ? "Not tracked" : String(row.wantQty)],
    ["Cost", row.unitCostCents == null ? "unknown" : money(row.unitCostCents / 100)],
    ["CardTrader", row.cardTraderListingId || "No listing id"],
  ];
  for (const [term, value] of lines) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  }
  const history = $("history");
  history.replaceChildren();
  $("history-note").textContent = data.historyComplete === false
    ? `Recorded movements only; some stock changes may be missing. Current stock was read ${et(data.generatedAt)}.`
    : "Fixture movement history.";
  if (!data.movements.length) {
    const tr = document.createElement("tr");
    cell(tr, "", "No movements have been recorded for this stock row.").colSpan = 4;
    history.appendChild(tr);
  }
  for (const movement of data.movements) {
    const tr = document.createElement("tr");
    cell(tr, "When (ET)", et(movement.createdAt));
    const delta = cell(tr, "Δ", movement.delta > 0 ? `+${movement.delta}` : String(movement.delta), "num");
    delta.classList.add(movement.delta > 0 ? "delta-p" : movement.delta < 0 ? "delta-m" : "");
    cell(tr, "Qty", movement.qtyAfter, "num");
    const source = cell(tr, "Source", "");
    source.textContent = `${labelReason(movement.reason)} · ${movement.sourceKind}`;
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = [movement.appliedBy, movement.note].filter(Boolean).join(" · ");
    source.appendChild(sub);
    history.appendChild(tr);
  }
  if (state.opened && window.matchMedia("(max-width: 860px)").matches) $("detail").scrollIntoView({ block: "nearest" });
}

function labelReason(reason) {
  return reason.replaceAll("_", " ");
}
