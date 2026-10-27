const $ = (id) => document.getElementById(id);
const state = { payload: null, selected: "", opened: false };

document.addEventListener("DOMContentLoaded", () => {
  $("logout").addEventListener("click", () => { if (document.documentElement.dataset.preview === "1") return; signOut(); });
  $("login-signout").addEventListener("click", signOut);
  $("filters").addEventListener("submit", (event) => { event.preventDefault(); load(); });
  $("detail-close").addEventListener("click", () => select(""));
  boot();
});

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

function money(cents) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function badge(parent, text, kind) {
  const span = document.createElement("span");
  span.className = `status ${kind || ""}`.trim();
  span.textContent = text;
  parent.appendChild(span);
}

async function load() {
  $("inventory-error").textContent = "";
  const { response, data } = await api(`/api/inventory?${query()}`);
  if (!response.ok) { $("inventory-error").textContent = data.error || "Could not load inventory."; return; }
  state.payload = data;
  $("tcg-note").textContent = data.placeholders.tcgplayerLevel;
  const liability = data.liability;
  if (liability && Number.isInteger(liability.outstandingCents)) {
    $("credit-cap").classList.remove("inert-cap");
    $("credit-total").textContent = money(liability.outstandingCents);
    $("credit-note").textContent = `${liability.entries} ledger row${liability.entries === 1 ? "" : "s"} · ${liability.customers} customer reference${liability.customers === 1 ? "" : "s"} · issued at receive`;
  } else {
    $("credit-total").textContent = "–";
    $("credit-note").textContent = data.placeholders.storeCredit;
  }
  $("purchase-note").textContent = data.placeholders.purchases;
  if (document.documentElement.dataset.preview === "1" && !$("sr-id").value) $("sr-id").value = "recSRPhase3Ex0012";
  $("event-note").textContent = data.placeholders.eventSale;
  $("units").textContent = String(data.totals.units);
  $("units-note").textContent = `Across ${data.totals.rows} stock rows · from the ledger`;
  $("unknown-cost").textContent = String(data.totals.unknownCostUnits);
  $("cost-note").textContent = `${data.totals.knownCostUnits} known · existing stock is never backfilled`;
  $("flag-count").textContent = String(data.totals.flags);
  $("flag-note").textContent = `${data.totals.low} low · ${data.totals.overstock} overstock · ${data.totals.slow} slow · ${data.totals.needsReview} review`;
  const t = data.thresholds;
  $("threshold-note").textContent = `Low: Want Qty is set and on hand is ${t.lowStockOnHand}. Overstock: above Want Qty, or more than ${t.overstockSkuLimit} while the level setting is ${t.tcgplayerLevel} (a default, not a connected account). Slow: ${t.slowMoverDays} days with no sale. The Days column stays blank because Date Acquired is blank; a slow flag uses first seen, labeled as an estimate.`;
  fillSelect("f-game", data.facets.games, $("f-game").value, "All games");
  fillSelect("f-condition", data.facets.conditions, $("f-condition").value, "Any condition");
  fillSelect("f-finish", data.facets.finishes, $("f-finish").value, "Any finish");
  const body = $("rows");
  body.replaceChildren();
  if (!data.rows.length) {
    const tr = document.createElement("tr");
    const td = cell(tr, "", data.totals.rows ? "Nothing matches these filters." : "No opening entries in the ledger yet. Apply migration 0008 and run the opening-entry script before go-live.", "empty");
    td.colSpan = 9;
    body.appendChild(tr);
  }
  const visible = data.rows.some((row) => row.recordId === state.selected);
  if (!state.opened && data.rows[0]) state.selected = data.rows[0].recordId;
  else if (state.selected && !visible) state.selected = data.rows[0]?.recordId || "";
  for (const row of data.rows) body.appendChild(renderRow(row));
  $("rows-meta").textContent = `${data.rows.length} shown · on hand ${data.onHandSource} · ${data.wantQtyState === "matched" ? "Want Qty read from Buy List" : "Want Qty not loaded"}`;
  if (state.selected) await loadDetail(state.selected);
  else select("");
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
  cell(tr, "Market", money(row.marketPriceUsd), "num");
  const days = cell(tr, "Days", "—", "num");
  days.title = "Date acquired is blank, so days in stock are unknown.";
  const stateCell = cell(tr, "State", "");
  const flags = document.createElement("div");
  flags.className = "flag-row";
  badge(flags, row.state, row.state === "Sold" ? "Sold" : "ok");
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
  const { response, data } = await api(`/api/inventory/${recordId}`);
  if (!response.ok) { $("inventory-error").textContent = data.error || "Could not load that card."; return; }
  const row = data.row;
  for (const tr of $("rows").querySelectorAll("tr")) tr.setAttribute("aria-selected", tr.dataset.recordId === recordId ? "true" : "false");
  $("detail-name").textContent = row.name;
  $("detail-empty").hidden = true;
  $("detail-body").hidden = false;
  const dl = $("detail-id");
  dl.replaceChildren();
  const lines = [
    ["Identity", [row.game, row.setLabel, row.collectorNumber ? `#${row.collectorNumber}` : "", row.finish || row.finishRaw, row.condition, row.language].filter(Boolean).join(" · ")],
    ["On hand", `${row.onHand} from the ledger`],
    ["Want Qty", row.wantQty == null ? "Not tracked" : String(row.wantQty)],
    ["Cost", row.unitCostCents == null ? "unknown" : money(row.unitCostCents / 100)],
    ["Date acquired", "Blank"],
    ["First seen", row.firstSeen ? `${et(row.firstSeen)} · estimate, slow-mover age only` : "Unknown"],
    ["CardTrader", row.cardTraderListingId || "No listing id"],
    ["TCGplayer", "Not connected"],
    ["Review", row.flags.needsReview || "None"],
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
  if (window.matchMedia("(max-width: 860px)").matches) $("detail").scrollIntoView({ block: "nearest" });
}

function labelReason(reason) {
  return reason.replaceAll("_", " ");
}
