const STORAGE_KEY = "hekla-intake-defaults-v1";

const state = {
  status: "Waitlist",
  game: "Lorcana",
  cards: [],
  truncated: false,
  search: "",
  session: null,
  pending: null,
  bulkPreview: null,
  heklaAction: null,
  submitting: false,
};

let queueGeneration = 0;
let summaryGeneration = 0;

const $ = (id) => document.getElementById(id);

const views = {
  boot: $("boot"),
  login: $("login-view"),
  app: $("app-view"),
};

document.addEventListener("DOMContentLoaded", () => {
  $("logout").addEventListener("click", signOut);
  $("login-signout").addEventListener("click", signOut);
  $("add-form").addEventListener("submit", onAdd);
  $("add-form").addEventListener("change", saveDefaults);
  $("open-bulk").addEventListener("click", () => {
    $("bulk-error").textContent = "";
    updateBulkHelp();
    $("bulk-dialog").showModal();
    $("bulk-text").focus();
  });
  $("bulk-close").addEventListener("click", () => $("bulk-dialog").close());
  $("bulk-preview").addEventListener("click", previewBulk);
  $("bulk-commit").addEventListener("click", commitBulk);
  $("bulk-text").addEventListener("input", () => {
    state.bulkPreview = null;
    $("bulk-commit").disabled = true;
  });
  $("dupe-merge").addEventListener("click", () => resolveDupe("merge"));
  $("dupe-add").addEventListener("click", () => resolveDupe("add"));
  $("dupe-cancel").addEventListener("click", () => $("dupe-dialog").close());
  $("ask-process").addEventListener("click", runAutoSort);
  $("rerank-listed").addEventListener("click", runRerankListed);
  $("rescan").addEventListener("click", runRescan);
  $("ask-greenlight").addEventListener("click", () => openHekla("greenlight"));
  $("hekla-send").addEventListener("click", sendHekla);
  $("hekla-close").addEventListener("click", () => $("hekla-dialog").close());
  $("hekla-copy").addEventListener("click", copyHekla);
  $("refresh").addEventListener("click", () => refreshAll());
  $("search").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderQueue();
  });
  document.body.addEventListener("click", (event) => {
    const statusButton = event.target.closest("[data-status]");
    if (statusButton) {
      state.status = statusButton.dataset.status;
      markTabs();
      loadQueue();
      document.getElementById("queue-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const go = event.target.closest("[data-go='form']");
    if (go) document.getElementById("quick-add").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.querySelectorAll("input[type=number]").forEach((input) => {
    input.addEventListener("wheel", () => input.blur(), { passive: true });
  });
  boot();
});

function showOrganizations(clerk, message) {
  show("login");
  $("login-error").textContent = message || "";
  clerk.mountOrganizationList($("clerk-mount"), {
    hidePersonal: true,
    afterSelectOrganizationUrl: "/",
    afterCreateOrganizationUrl: "/",
  });
}

async function boot() {
  let clerk;
  try {
    clerk = await loadClerk();
  } catch (error) {
    show("login");
    $("login-error").textContent = error.message || "Could not load sign-in.";
    return;
  }
  if (!clerk.user) {
    show("login");
    clerk.mountSignIn($("clerk-mount"));
    return;
  }
  $("login-signout").hidden = false;
  if (!clerk.organization) {
    showOrganizations(clerk, "");
    return;
  }
  const { response, data } = await api("/api/session");
  if (response.status === 403) {
    showOrganizations(clerk, data.error);
    return;
  }
  if (!response.ok) {
    show("login");
    $("login-error").textContent = data.error || "Could not open intake.";
    return;
  }
  state.session = data;
  $("admin-link").hidden = !data.platformAdmin;
  buildForm(data);
  applyDefaults();
  markTabs();
  show("app");
  await refreshAll();
  $("collector").focus();
}

function show(name) {
  views.boot.hidden = name !== "boot";
  views.login.hidden = name !== "login";
  views.app.hidden = name !== "app";
}

function buildForm(session) {
  buildGameBar(session.games || ["Lorcana"]);
  fillSelect($("set"), session.sets, (set) => set.id, (set) => `${set.id} · ${set.name}`);
  fillSelect($("finish"), session.finishes, (finish) => finish, (finish) => finish);
  fillSelect(
    $("condition"),
    session.conditions,
    (condition) => condition,
    (condition) => `${condition} · ${session.conditionLabels[condition] || condition}`,
  );
  fillSelect($("rarity"), [{ id: "", label: "—" }, ...session.rarities.map((rarity) => ({ id: rarity, label: rarity }))], (rarity) => rarity.id, (rarity) => rarity.label);
  const href = `https://airtable.com/${session.baseId}/${session.tableId}`;
  document.querySelectorAll(".airtable-link").forEach((link) => {
    link.href = href;
  });
}

function fillSelect(select, options, valueOf, labelOf) {
  select.replaceChildren();
  for (const option of options) {
    const node = document.createElement("option");
    node.value = valueOf(option);
    node.textContent = labelOf(option);
    select.append(node);
  }
}

function buildGameBar(games) {
  const bar = $("game-bar");
  bar.replaceChildren();
  for (const game of games) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.dataset.game = game;
    button.textContent = game;
    button.addEventListener("click", () => selectGame(game));
    bar.append(button);
  }
}

function knownGame(game) {
  const games = state.session?.games || [];
  return games.includes(game) ? game : "Lorcana";
}

function finishesFor(game) {
  const map = state.session?.finishesByGame || {};
  return map[game] || state.session?.finishes || ["Normal"];
}

function defaults() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && typeof saved === "object") return saved;
  } catch {
    /* ignore broken local storage */
  }
  return { game: "Lorcana", setNumber: "13", setIdentifier: "", finish: "Normal", condition: "NM", qty: 1, finishByGame: {} };
}

function applyDefaults() {
  const saved = defaults();
  selectGame(knownGame(saved.game), { refresh: false, saved });
}

function selectGame(game, options = {}) {
  if (options.refresh !== false) saveDefaults();
  const saved = options.saved || defaults();
  state.game = knownGame(game);
  document.querySelectorAll("#game-bar [data-game]").forEach((button) => {
    const on = button.dataset.game === state.game;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", on ? "true" : "false");
  });
  const lorcana = state.game === "Lorcana";
  $("set-number-field").hidden = !lorcana;
  $("set-identifier-field").hidden = lorcana;
  const finishes = finishesFor(state.game);
  const remembered = saved.finishByGame?.[state.game];
  const preferred = remembered || saved.finish || $("finish").value;
  fillSelect($("finish"), finishes, (finish) => finish, (finish) => finish);
  if (finishes.includes(preferred)) $("finish").value = preferred;
  else if (finishes.includes("Normal")) $("finish").value = "Normal";
  if ([...$("set").options].some((option) => option.value === saved.setNumber)) $("set").value = saved.setNumber;
  if (typeof saved.setIdentifier === "string") $("set-identifier").value = saved.setIdentifier;
  if ([...$("condition").options].some((option) => option.value === saved.condition)) $("condition").value = saved.condition;
  const qty = Number(saved.qty);
  $("qty").value = Number.isInteger(qty) && qty >= 1 ? String(qty) : "1";
  paintGame();
  updateBulkHelp();
  saveDefaults();
  if (options.refresh !== false) {
    state.bulkPreview = null;
    $("bulk-commit").disabled = true;
    state.cards = cardsForGame(state.cards, state.game);
    state.truncated = false;
    renderQueue();
    refreshAll();
  }
}

function cardsForGame(cards, game) {
  const selected = game || "Lorcana";
  return cards.filter((card) => effectiveGame(card?.game) === selected);
}

function effectiveGame(game) {
  if (typeof game !== "string" || !game.trim()) return "Lorcana";
  return game.trim();
}

function paintGame() {
  const game = state.game || "Lorcana";
  document.title = `Hekla · ${game} intake`;
  document.querySelectorAll("[data-cap-game], [data-cap-scope]").forEach((node) => {
    node.textContent = game;
  });
}

function updateBulkHelp() {
  const game = state.game || "Lorcana";
  const help = $("bulk-help");
  const sample = $("bulk-sample");
  if (!help || !sample) return;
  if (game === "Lorcana") {
    help.textContent = "One Lorcana card per line. First token is the set number, then collector number, finish (Normal, Foil, or Enchanted), condition, optional quantity, and an optional name. Spaces, commas, or tabs. Every line uses Lorcana.";
    sample.textContent = "8 042 Foil NM 1\n8,156,Normal,NM,2,Elsa - Snow Queen\n13\t15\tFoil\tLP\t1\tTiana";
    return;
  }
  const finishes = finishesFor(game).join(", ");
  help.textContent = `One ${game} card per line. First token is the set identifier, then collector number, finish (${finishes}), condition, optional quantity, and an optional name. Use commas or tabs when the set identifier has spaces. Every line uses ${game}.`;
  sample.textContent = bulkSample(game);
}

function bulkSample(game) {
  if (game === "Magic: The Gathering") return "MH3 123 Foil NM 1\nMH3,456,Normal,NM,2,Orcish Bowmasters";
  if (game === "Pokémon") return "SV08 25 Foil NM 1\nSV08,25,Normal,NM,2,Pikachu";
  if (game === "Yu-Gi-Oh!") return "LOB 1 Normal NM 1\nLOB,5,Foil,NM,1,Dark Magician";
  return "OGN 12 Foil NM 1\nOGN,12,Special,NM,1";
}

function saveDefaults() {
  const previous = defaults();
  const finishByGame = { ...(previous.finishByGame || {}) };
  if (state.game && $("finish").value) finishByGame[state.game] = $("finish").value;
  const payload = {
    game: state.game || "Lorcana",
    setNumber: $("set").value,
    setIdentifier: $("set-identifier").value,
    finish: $("finish").value,
    condition: $("condition").value,
    qty: Number($("qty").value) || 1,
    finishByGame,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* private mode can block storage; the form still works */
  }
}

function cardPayload(extra) {
  const cost = $("cost").value;
  const priority = $("priority").value;
  const payload = {
    game: state.game || "Lorcana",
    collectorNumber: $("collector").value.trim(),
    finish: $("finish").value,
    condition: $("condition").value,
    qty: Number($("qty").value),
    cardName: $("card-name").value.trim(),
    rarity: $("rarity").value,
    costBasisUsd: cost === "" ? null : Number(cost),
    priority: priority === "" ? null : Number(priority),
    notes: $("notes").value,
    ...extra,
  };
  if (payload.game === "Lorcana") payload.setNumber = $("set").value;
  else payload.setIdentifier = $("set-identifier").value.trim();
  return payload;
}

async function onAdd(event) {
  event.preventDefault();
  if (state.submitting) return;
  saveDefaults();
  $("form-error").textContent = "";
  $("form-flash").textContent = "";
  if ((state.game || "Lorcana") !== "Lorcana" && !$("set-identifier").value.trim()) {
    $("form-error").textContent = "Set identifier is required.";
    $("set-identifier").focus();
    return;
  }
  const payload = cardPayload({ onDuplicate: "ask" });
  await submitCard(payload);
}

async function submitCard(payload) {
  state.submitting = true;
  $("add-button").disabled = true;
  try {
    const { response, data } = await api("/api/intake", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (response.status === 409 && data.error === "duplicate") {
      state.pending = payload;
      openDupe(data.matches || []);
      return;
    }
    if (!response.ok) {
      $("form-error").textContent = data.error || "Could not add that card.";
      return;
    }
    state.pending = null;
    const name = data.card?.name || data.card?.collectorNumber || "Card";
    $("form-flash").textContent = data.merged
      ? `Merged qty onto ${name}. Still not listed.`
      : `Added ${name} to Waitlist. Hekla can rank it; nothing is listed.`;
    clearEntry();
    if (state.status !== "Waitlist") {
      state.status = "Waitlist";
      markTabs();
    }
    await refreshAll();
    $("collector").focus();
  } finally {
    state.submitting = false;
    $("add-button").disabled = false;
  }
}

function clearEntry() {
  $("collector").value = "";
  $("card-name").value = "";
  $("rarity").value = "";
  $("cost").value = "";
  $("priority").value = "";
  $("notes").value = "";
}

function openDupe(matches) {
  const list = $("dupe-list");
  list.replaceChildren();
  matches.forEach((match, index) => {
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "merge-target";
    radio.value = match.id;
    radio.checked = index === 0;
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = match.name || "Unnamed card";
    const detail = document.createElement("span");
    detail.className = "sub";
    const setLabel = match.game && match.game !== "Lorcana" ? (match.setIdentifier || "?") : (match.setNumber || "?");
    detail.textContent = `${match.game || "Card"} · ${setLabel} · #${match.collectorNumber || "?"} · ${match.finish || "?"} · ${match.condition || "?"} · qty ${match.qty} · ${match.status}`;
    text.append(title, detail);
    label.append(radio, text);
    list.append(label);
  });
  $("dupe-listed").hidden = !matches.some((match) => match.status === "Listed");
  $("dupe-dialog").showModal();
}

async function resolveDupe(choice) {
  const payload = state.pending;
  if (!payload) return;
  const selected = document.querySelector("input[name=merge-target]:checked");
  $("dupe-dialog").close();
  if (choice === "merge") {
    await submitCard({ ...payload, onDuplicate: "merge", mergeRecordId: selected ? selected.value : undefined });
    return;
  }
  await submitCard({ ...payload, onDuplicate: "add" });
}

async function refreshAll() {
  await Promise.all([loadSummary(), loadQueue()]);
}

async function loadSummary() {
  const generation = ++summaryGeneration;
  const game = state.game || "Lorcana";
  $("cap-error").textContent = "";
  const { response, data } = await api(`/api/summary?game=${encodeURIComponent(game)}`);
  if (generation !== summaryGeneration) return;
  if (!response.ok) {
    $("cap-error").textContent = data.error || "Cap unavailable.";
    return;
  }
  const cap = data.cap || 100;
  const listed = data.listedQty || 0;
  document.querySelectorAll("[data-cap=listed]").forEach((node) => {
    node.textContent = String(listed);
  });
  document.querySelectorAll("[data-cap=max]").forEach((node) => {
    node.textContent = String(cap);
  });
  document.querySelectorAll("[data-cap=waitlist]").forEach((node) => {
    node.textContent = String(data.waitlistQty || 0);
  });
  const bucket = listed <= 0 ? 0 : Math.min(100, Math.max(5, Math.round((listed / cap) * 20) * 5));
  document.querySelectorAll("[data-cap=bar]").forEach((node) => {
    node.dataset.pct = String(bucket);
    node.parentElement?.classList.toggle("over", listed > cap);
  });
  for (const status of ["Waitlist", "Listed", "Sold", "Skip"]) {
    document.querySelectorAll(`[data-count=${status}]`).forEach((node) => {
      node.textContent = String(data.counts?.[status] ?? 0);
    });
  }
}

async function loadQueue() {
  const generation = ++queueGeneration;
  const game = state.game || "Lorcana";
  const status = state.status;
  $("queue-error").textContent = "";
  $("queue-meta").textContent = "Loading…";
  const { response, data } = await api(`/api/queue?status=${encodeURIComponent(status)}&game=${encodeURIComponent(game)}`);
  if (generation !== queueGeneration) return;
  if (response.status === 401) {
    location.reload();
    return;
  }
  if (!response.ok) {
    state.cards = [];
    $("queue-error").textContent = data.error || "Could not load the queue.";
    $("queue-meta").textContent = "";
    renderQueue();
    return;
  }
  state.cards = cardsForGame(data.cards || [], game);
  state.truncated = Boolean(data.truncated);
  renderQueue();
}

function markTabs() {
  $("rerank-listed").hidden = state.status !== "Listed";
  $("ask-process").hidden = state.status === "Listed";
  $("rescan").hidden = state.status !== "Waitlist" && state.status !== "Listed";
  document.querySelectorAll("[data-status]").forEach((button) => {
    const on = button.dataset.status === state.status;
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function renderQueue() {
  const body = $("queue-body");
  if ($("queue-error").textContent) {
    body.replaceChildren();
    return;
  }
  const query = state.search.trim().toLowerCase();
  const rows = cardsForGame(state.cards, state.game).filter((card) => {
    if (!query) return true;
    return [card.name, card.cardName, card.resolvedName, card.collectorNumber, card.setNumber, card.setIdentifier, card.setName, card.game, card.finish, card.condition, card.notes, card.id]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
  body.replaceChildren();
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 9;
    td.className = "empty";
    td.textContent = state.cards.length === 0
      ? `No ${state.game} ${state.status} cards yet.`
      : "Nothing in this queue matches that search.";
    tr.append(td);
    body.append(tr);
  } else {
    for (const card of rows) body.append(renderRow(card));
  }
  const sortNote = state.status === "Waitlist" ? "Sorted by rank (unsorted last), then priority, then newest." : state.status === "Listed" ? "Sorted by rank, weakest first (pull candidates on top)." : "Sorted by newest.";
  const trunc = state.truncated ? " List truncated." : "";
  $("queue-meta").textContent = `${rows.length} shown · ${state.cards.length} ${state.game} ${state.status}. ${sortNote}${trunc}`;
}

function renderRow(card) {
  const tr = document.createElement("tr");
  const setLabel = card.game && card.game !== "Lorcana"
    ? (card.setIdentifier || "—")
    : (card.setName ? `${card.setNumber} · ${card.setName}` : (card.setNumber || card.setIdentifier || "—"));
  tr.append(
    cell("Set", setLabel),
    cell("#", card.collectorNumber || "—"),
    nameCell(card),
    ...(card.status === "Waitlist"
      ? [editCell(card, "finish", "Finish"), editCell(card, "condition", "Cond"), editCell(card, "qty", "Qty")]
      : [cell("Finish", card.finish || "—"), cell("Cond", card.condition || "—"), cell("Qty", String(card.qty ?? 0))]),
    statusCell(card),
    rankCell(card),
    cell("Price", money(card.marketPriceUsd)),
  );
  attachPreview(tr, card);
  return tr;
}

/* ---------- Auto-sort ---------- */
function rankCell(card) {
  const td = document.createElement("td");
  td.dataset.label = "Rank";
  td.className = "rank-cell";
  const top = document.createElement("div");
  top.className = "rank-line";
  const score = document.createElement("span");
  score.className = "rank-num";
  score.textContent = card.autoRank === null || card.autoRank === undefined ? "—" : String(Math.round(card.autoRank));
  score.title = card.rankScore != null ? `Hekla Rank Score: ${card.rankScore}` : "Auto rank (0–100)";
  top.append(score);
  if (card.recommendation) top.append(recBadge(card.recommendation, card.status));
  td.append(top);
  if (card.status === "Waitlist") td.append(deleteControl(card));
  if (card.status === "Waitlist" || card.status === "Listed") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "resort";
    btn.textContent = card.enrichedAt ? "Re-sort" : "Sort now";
    btn.title = card.rankReason || "Run auto-sort for this card";
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      btn.disabled = true; btn.textContent = "Sorting…";
      const { response, data } = await api(`/api/enrich/${encodeURIComponent(card.id)}`, { method: "POST" }).catch(() => ({ response: { ok: false }, data: { error: "Network error" } }));
      if (!response.ok || !data.card) {
        btn.disabled = false; btn.textContent = "Retry";
        btn.title = data.error || (data.failed && data.failed[0]?.error) || "Auto-sort failed";
        return;
      }
      const index = state.cards.findIndex((c) => c.id === card.id);
      if (index >= 0) state.cards[index] = data.card;
      previewCache.clear();
      sortCardsByRank();
      renderQueue();
    });
    td.append(btn);
  }
  return td;
}

function deleteControl(card) {
  const wrap = document.createElement("span");
  wrap.className = "del-wrap";
  const del = document.createElement("button");
  del.type = "button"; del.className = "del-btn"; del.textContent = "Delete";
  del.setAttribute("aria-label", `Delete ${card.name || card.id}`);
  const confirmBox = document.createElement("span");
  confirmBox.className = "del-confirm"; confirmBox.hidden = true;
  const q = document.createElement("span"); q.textContent = "Delete?";
  const yes = document.createElement("button"); yes.type = "button"; yes.className = "del-yes"; yes.textContent = "Yes";
  const no = document.createElement("button"); no.type = "button"; no.className = "del-no"; no.textContent = "Cancel";
  const err = document.createElement("span"); err.className = "save-state error"; err.setAttribute("role", "alert");
  confirmBox.append(q, yes, no);
  wrap.append(del, confirmBox, err);
  const stop = (e) => e.stopPropagation();
  wrap.addEventListener("click", stop);
  del.addEventListener("click", () => { del.hidden = true; confirmBox.hidden = false; err.textContent = ""; yes.focus(); });
  no.addEventListener("click", () => { confirmBox.hidden = true; del.hidden = false; del.focus(); });
  yes.addEventListener("click", async () => {
    yes.disabled = true; no.disabled = true; yes.textContent = "Deleting…";
    const { response, data } = await api(`/api/cards/${encodeURIComponent(card.id)}`, { method: "DELETE" }).catch(() => ({ response: { ok: false }, data: { error: "Network error" } }));
    if (!response.ok || !data.deleted) {
      yes.disabled = false; no.disabled = false; yes.textContent = "Yes";
      confirmBox.hidden = true; del.hidden = false;
      err.textContent = data.error || "Delete failed";
      return;
    }
    closePreview();
    state.cards = state.cards.filter((c) => c.id !== card.id);
    renderQueue();
    loadSummary();
  });
  return wrap;
}

const LISTED_LABELS = { List: "Keep", Hold: "Watch", Skip: "Pull" };
function recBadge(rec, status) {
  const b = document.createElement("span");
  const kind = ["List", "Hold", "Skip"].includes(rec) ? rec : "Hold";
  b.className = `rec rec-${kind.toLowerCase()}`;
  b.textContent = status === "Listed" ? LISTED_LABELS[kind] : kind;
  if (status === "Listed") b.title = `Stored as ${kind} (Keep=List, Watch=Hold, Pull=Skip)`;
  return b;
}

function sortCardsByRank() {
  if (state.status === "Listed") {
    state.cards.sort((a, b) => (a.autoRank ?? 101) - (b.autoRank ?? 101) || String(b.createdTime).localeCompare(String(a.createdTime)));
    return;
  }
  if (state.status !== "Waitlist") return;
  state.cards.sort((a, b) => {
    const ar = a.autoRank ?? -1, br = b.autoRank ?? -1;
    if (ar !== br) return br - ar;
    const ap = a.priority ?? Infinity, bp = b.priority ?? Infinity;
    if (ap !== bp) return ap - bp;
    return String(b.createdTime).localeCompare(String(a.createdTime));
  });
}

async function runRerankListed() {
  const btn = $("rerank-listed");
  const flash = $("queue-flash");
  const game = state.game || "Lorcana";
  btn.disabled = true;
  $("queue-error").textContent = "";
  let offset = 0, enriched = 0, failed = 0, total = 0, ai = false;
  try {
    for (let guard = 0; guard < 50; guard++) {
      btn.textContent = total ? `Re-ranking ${offset}/${total}…` : "Re-ranking…";
      const { response, data } = await api(`/api/enrich-listed?game=${encodeURIComponent(game)}&offset=${offset}`, { method: "POST" });
      if (!response.ok) throw new Error(data.error || "Re-rank failed");
      total = data.total; enriched += data.enriched; failed += data.failed?.length || 0; ai = data.ai;
      flash.textContent = `Re-ranked ${data.done}/${total}…`;
      if (data.nextOffset === null || data.nextOffset === undefined) break;
      offset = data.nextOffset;
    }
    flash.textContent = `Re-ranked ${enriched}/${total} listed ${game} cards${failed ? ` · ${failed} failed (retry)` : ""}${ai ? "" : " · AI off (rules only)"}. Weakest first.`;
  } catch (error) {
    $("queue-error").textContent = `${error.message || error} — stopped at ${offset}/${total}; click again to retry.`;
  } finally {
    btn.disabled = false; btn.textContent = "Re-rank listed cards";
    previewCache.clear();
    await refreshAll();
  }
}

async function runRescan() {
  const btn = $("rescan");
  const flash = $("queue-flash");
  const game = state.game || "Lorcana";
  const money = (value) => (value === null || value === undefined ? "no price" : `${Number(value).toFixed(2)}`);
  btn.disabled = true;
  $("queue-error").textContent = "";
  let offset = 0, total = 0, failed = 0, ai = true;
  const changed = [];
  try {
    for (let guard = 0; guard < 120; guard++) {
      btn.textContent = total ? `Scanning ${offset}/${total}…` : "Scanning…";
      const { response, data } = await api(`/api/rescan?game=${encodeURIComponent(game)}&offset=${offset}`, { method: "POST" });
      if (!response.ok) throw new Error(data.error || "Scan failed");
      total = data.total; failed += data.failed?.length || 0; ai = data.ai;
      changed.push(...(data.changed || []));
      flash.textContent = `Scanned ${data.done}/${total}…`;
      if (data.nextOffset === null || data.nextOffset === undefined) break;
      offset = data.nextOffset;
    }
    const moves = changed.slice(0, 5).map((move) => `${move.name} ${money(move.priceFrom)} → ${money(move.priceTo)} (rank ${move.rankFrom ?? "–"} → ${move.rankTo})`);
    const more = changed.length > 5 ? ` and ${changed.length - 5} more` : "";
    flash.textContent = `Scanned ${total} open ${game} cards: ${changed.length ? `${changed.length} updated — ${moves.join("; ")}${more}` : "no price changes"}${failed ? ` · ${failed} failed (retry)` : ""}${ai ? "" : " · AI off (rules only)"}.`;
  } catch (error) {
    $("queue-error").textContent = `${error.message || error} — stopped at ${offset}/${total}; click again to retry.`;
  } finally {
    btn.disabled = false; btn.textContent = "Scan for changes";
    previewCache.clear();
    await refreshAll();
  }
}

async function runAutoSort() {
  const btn = $("ask-process");
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Auto-sorting…";
  const { response, data } = await api("/api/enrich", { method: "POST" }).catch(() => ({ response: { ok: false }, data: { error: "Network error" } }));
  btn.disabled = false; btn.textContent = label;
  if (!response.ok) { $("queue-error").textContent = data.error || "Auto-sort failed."; return; }
  const bits = [`Auto-sorted ${data.enriched} of ${data.picked} pending`];
  if (data.failed?.length) bits.push(`${data.failed.length} will retry`);
  if (data.remaining) bits.push("more pending — the 10-min job continues");
  if (!data.ai) bits.push("AI off (rules only)");
  const flash = $("queue-flash");
  if (flash) { flash.textContent = bits.join(" · ") + "."; }
  previewCache.clear();
  await refreshAll();
}

/* ---------- Inline edits (Waitlist rows only) ---------- */
function editCell(card, key, label) {
  const td = document.createElement("td");
  td.dataset.label = label;
  td.className = "edit-cell";
  let control;
  if (key === "qty") {
    control = document.createElement("input");
    control.type = "number"; control.min = "1"; control.max = "999"; control.step = "1"; control.inputMode = "numeric";
    control.value = String(card.qty ?? 1);
  } else {
    control = document.createElement("select");
    const game = effectiveGame(card.game) || state.game;
    const options = key === "finish" ? finishesFor(game) : (state.session?.conditions || ["NM", "LP", "MP", "HP", "DMG"]);
    const current = card[key];
    const list = current && !options.includes(current) ? [current, ...options] : options;
    for (const value of list) {
      const option = document.createElement("option");
      option.value = value; option.textContent = value;
      control.append(option);
    }
    control.value = current || options[0];
  }
  control.className = "inline-edit";
  control.setAttribute("aria-label", `${label} for ${card.name || card.id}`);
  const status = document.createElement("span");
  status.className = "save-state";
  status.setAttribute("role", "status");
  td.append(control, status);
  let committed = control.value;
  const save = async () => {
    const value = control.value;
    if (value === committed) return;
    if (key === "qty" && !(/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 999)) {
      control.value = committed; setSaveState(status, "error", "Qty must be 1–999"); return;
    }
    setSaveState(status, "saving", "Saving…");
    control.disabled = true;
    const { response, data } = await api(`/api/cards/${encodeURIComponent(card.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ [key]: key === "qty" ? Number(value) : value }),
    }).catch(() => ({ response: { ok: false }, data: { error: "Network error" } }));
    control.disabled = false;
    if (!response.ok || !data.card) {
      control.value = committed;
      setSaveState(status, "error", data.error || "Save failed");
      return;
    }
    committed = control.value;
    Object.assign(card, data.card);
    const index = state.cards.findIndex((c) => c.id === card.id);
    if (index >= 0) state.cards[index] = data.card;
    setSaveState(status, "saved", "Saved");
    if (key === "qty") loadSummary();
  };
  control.addEventListener("change", save);
  if (key === "qty") control.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); control.blur(); } });
  return td;
}

function setSaveState(el, kind, text) {
  el.className = `save-state ${kind}`;
  el.textContent = text;
  el.title = text;
  clearTimeout(el._t);
  if (kind === "saved") el._t = setTimeout(() => { el.textContent = ""; el.className = "save-state"; }, 1800);
}

/* ---------- Hover card preview ---------- */
const previewCache = new Map();
let previewTimer = null;
let previewRow = null;
let previewToken = 0;

function previewParams(card) {
  const game = effectiveGame(card.game) || state.game;
  const set = game === "Lorcana" ? (card.setNumber || "") : (card.setIdentifier || "");
  return new URLSearchParams({ game, set, number: card.collectorNumber || "", name: card.name || "" }).toString();
}

function attachPreview(tr, card) {
  tr.tabIndex = 0;
  tr.classList.add("has-preview");
  const schedule = () => { clearTimeout(previewTimer); previewTimer = setTimeout(() => openPreview(tr, card), 250); };
  tr.addEventListener("mouseenter", schedule);
  tr.addEventListener("mouseleave", (e) => { clearTimeout(previewTimer); if (!e.relatedTarget || !$("card-preview").contains(e.relatedTarget)) closePreview(); });
  tr.addEventListener("focus", (e) => { if (e.target === tr) schedule(); });
  tr.addEventListener("click", (e) => {
    if (e.target.closest("a, select, input, button")) return;
    if (previewRow === tr && !$("card-preview").hidden) closePreview(); else openPreview(tr, card);
  });
}

function ensurePreviewEl() {
  let el = $("card-preview");
  if (el) return el;
  el = document.createElement("div");
  el.id = "card-preview";
  el.className = "card-preview";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Card preview");
  el.hidden = true;
  el.addEventListener("mouseleave", (e) => { if (!previewRow || !previewRow.contains(e.relatedTarget)) closePreview(); });
  document.body.append(el);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePreview(); });
  document.addEventListener("click", (e) => { if (!el.hidden && !el.contains(e.target) && !(previewRow && previewRow.contains(e.target))) closePreview(); });
  window.addEventListener("scroll", () => { if (!el.hidden && previewRow) positionPreview(el, previewRow); }, { passive: true });
  return el;
}

function closePreview() {
  const el = $("card-preview");
  if (el) el.hidden = true;
  previewRow = null;
  previewToken++;
}

async function openPreview(tr, card) {
  const el = ensurePreviewEl();
  previewRow = tr;
  const token = ++previewToken;
  const key = previewParams(card);
  const cached = previewCache.get(key);
  if (cached) renderPreview(el, cached, card);
  else renderPreviewLoading(el);
  el.hidden = false;
  positionPreview(el, tr);
  if (cached) return;
  let data;
  try {
    const result = await api(`/api/preview?${key}`);
    data = result.response.ok ? result.data : { found: false, error: result.data.error };
  } catch { data = { found: false, error: "Network error" }; }
  if (data && !data.error) previewCache.set(key, data);
  if (token !== previewToken) return;
  renderPreview(el, data, card);
  positionPreview(el, tr);
}

function renderPreviewLoading(el) {
  el.replaceChildren();
  el.classList.add("loading");
  const img = document.createElement("div"); img.className = "cp-img skeleton";
  const body = document.createElement("div"); body.className = "cp-body";
  for (const w of ["70%", "45%", "100%", "90%", "60%"]) { const line = document.createElement("div"); line.className = "skeleton line"; line.style.width = w; body.append(line); }
  el.append(img, body);
}

function renderPreview(el, data, card) {
  el.classList.remove("loading");
  el.replaceChildren();
  const body = document.createElement("div"); body.className = "cp-body";
  if (!data || !data.found) {
    const title = document.createElement("div"); title.className = "cp-name"; title.textContent = card.name || card.collectorNumber || "Card";
    const msg = document.createElement("p"); msg.className = "cp-empty";
    msg.textContent = data?.error ? `Preview unavailable: ${data.error}` : "No preview available for this card.";
    body.append(title, msg, sortBlock(card));
    el.append(body);
    return;
  }
  if (data.image) {
    const img = document.createElement("img"); img.className = "cp-img"; img.src = data.image; img.alt = data.name || ""; img.loading = "eager"; img.decoding = "async";
    img.addEventListener("error", () => img.remove());
    el.append(img);
  }
  const name = document.createElement("div"); name.className = "cp-name"; name.textContent = data.name || card.name;
  body.append(name);
  if (data.subtitle) { const sub = document.createElement("div"); sub.className = "cp-sub"; sub.textContent = data.subtitle; body.append(sub); }
  if (data.text) { const text = document.createElement("p"); text.className = "cp-text"; text.textContent = data.text; body.append(text); }
  body.append(sortBlock(card));
  const src = document.createElement("div"); src.className = "cp-src"; src.textContent = `Source: ${data.source}`;
  body.append(src);
  el.append(body);
}

function sortBlock(card) {
  const box = document.createElement("div");
  box.className = "cp-sort";
  const line = document.createElement("div");
  line.className = "cp-sort-line";
  const rank = document.createElement("span");
  rank.className = "cp-rank";
  rank.textContent = card.autoRank === null || card.autoRank === undefined ? "Rank —" : `Rank ${Math.round(card.autoRank)}`;
  line.append(rank);
  if (card.recommendation) line.append(recBadge(card.recommendation, card.status));
  const price = document.createElement("span");
  price.className = "cp-price";
  price.textContent = card.marketPriceUsd === null || card.marketPriceUsd === undefined ? "Price —" : money(card.marketPriceUsd);
  line.append(price);
  box.append(line);
  const reason = document.createElement("div");
  reason.className = "cp-reason";
  reason.textContent = card.enrichedAt ? (card.rankReason || "") : "Not auto-sorted yet.";
  box.append(reason);
  if (card.priceSource || card.cardType) {
    const meta = document.createElement("div");
    meta.className = "cp-sub";
    meta.textContent = [card.cardType, card.priceSource].filter(Boolean).join(" · ");
    box.append(meta);
  }
  return box;
}

function positionPreview(el, tr) {
  const r = tr.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  let top, left;
  if (vw < 700) {
    left = Math.max(8, (vw - w) / 2);
    top = r.bottom + 8 + h > vh ? Math.max(8, r.top - h - 8) : r.bottom + 8;
  } else {
    left = Math.min(Math.max(8, r.left + 120), vw - w - 8);
    top = r.bottom + 6 + h > vh ? Math.max(8, r.top - h - 6) : r.bottom + 6;
  }
  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(left)}px`;
}

function cell(label, text) {
  const td = document.createElement("td");
  td.dataset.label = label;
  td.textContent = text;
  return td;
}

function nameCell(card) {
  const td = document.createElement("td");
  td.dataset.label = "Name";
  const title = document.createElement("div");
  title.className = "name";
  title.textContent = card.name || "Unnamed — Hekla can resolve it";
  td.append(title);
  if (card.priority !== null && card.priority !== undefined) {
    const priority = document.createElement("span");
    priority.className = "sub";
    priority.textContent = `Priority ${card.priority}`;
    td.append(priority);
  }
  if (card.notes) {
    const notes = document.createElement("span");
    notes.className = "sub";
    notes.textContent = card.notes;
    td.append(notes);
  }
  const meta = document.createElement("span");
  meta.className = "sub";
  const link = document.createElement("a");
  const base = state.session?.baseId;
  const table = state.session?.tableId;
  link.href = `https://airtable.com/${base}/${table}/${card.id}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = card.id;
  meta.append(link);
  td.append(meta);
  return td;
}

function statusCell(card) {
  const td = document.createElement("td");
  td.dataset.label = "Status";
  const pill = document.createElement("span");
  const status = ["Waitlist", "Listed", "Sold", "Skip"].includes(card.status) ? card.status : "Waitlist";
  pill.className = `status ${status}`;
  pill.textContent = card.status || "—";
  td.append(pill);
  return td;
}

function money(value) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

async function previewBulk() {
  $("bulk-error").textContent = "";
  $("bulk-warning").hidden = true;
  const text = $("bulk-text").value;
  const { response, data } = await api("/api/intake/bulk", {
    method: "POST",
    body: JSON.stringify({ text, mode: "preview", game: state.game || "Lorcana" }),
  });
  if (!response.ok) {
    $("bulk-error").textContent = data.error || "Could not preview that paste.";
    $("bulk-commit").disabled = true;
    return;
  }
  state.bulkPreview = data;
  renderBulk(data);
}

function renderBulk(data) {
  const body = $("bulk-body");
  body.replaceChildren();
  let valid = 0;
  let dupes = 0;
  for (const row of data.rows || []) {
    const tr = document.createElement("tr");
    if (row.error) {
      tr.append(cell("Line", String(row.line)), cell("Set", "—"), cell("#", "—"), cell("Finish", "—"), cell("Cond", "—"), cell("Qty", "—"), cell("Name", "—"), cell("Check", row.error));
    } else {
      valid += 1;
      const matches = row.matches || [];
      const paste = row.alsoInPaste || [];
      if (matches.length || paste.length) dupes += 1;
      const check = [
        ...matches.map((match) => `${match.status} qty ${match.qty}`),
        ...paste.map((line) => `also line ${line}`),
      ].join(", ") || "Ready";
      tr.append(
        cell("Line", String(row.line)),
        cell("Set", row.card.game === "Lorcana" ? row.card.setNumber : (row.card.setIdentifier || "—")),
        cell("#", row.card.collectorNumber),
        cell("Finish", row.card.finish),
        cell("Cond", row.card.condition),
        cell("Qty", String(row.card.qty)),
        cell("Name", row.card.cardName || "—"),
        cell("Check", check),
      );
    }
    body.append(tr);
  }
  $("dup-policy").hidden = dupes === 0;
  if (data.warning) {
    $("bulk-warning").hidden = false;
    $("bulk-warning").textContent = data.warning;
  }
  $("bulk-commit").disabled = valid === 0;
  $("bulk-commit").textContent = valid ? `Add ${valid} to waitlist` : "Add these to waitlist";
}

async function commitBulk() {
  const text = $("bulk-text").value;
  const selected = document.querySelector("input[name=onDuplicate]:checked");
  const needsPolicy = !$("dup-policy").hidden;
  if (needsPolicy && !selected) {
    $("bulk-error").textContent = "Choose skip, merge, or add anyway for the duplicate lines.";
    return;
  }
  $("bulk-error").textContent = "";
  $("bulk-commit").disabled = true;
  const { response, data } = await api("/api/intake/bulk", {
    method: "POST",
    body: JSON.stringify({ text, mode: "commit", game: state.game || "Lorcana", onDuplicate: selected ? selected.value : "add" }),
  });
  $("bulk-commit").disabled = false;
  if (!response.ok) {
    $("bulk-error").textContent = data.error || "Could not write those cards.";
    return;
  }
  const created = data.created?.length || 0;
  const merged = data.merged?.length || 0;
  const skipped = data.skipped?.length || 0;
  const errors = data.errors?.length || 0;
  $("form-flash").textContent = `Bulk write: ${created} added, ${merged} merged, ${skipped} skipped, ${errors} errors. Nothing was listed.`;
  $("bulk-dialog").close();
  $("bulk-text").value = "";
  state.bulkPreview = null;
  $("bulk-body").replaceChildren();
  if (state.status !== "Waitlist") {
    state.status = "Waitlist";
    markTabs();
  }
  await refreshAll();
  $("collector").focus();
}

function openHekla(action) {
  state.heklaAction = action;
  $("hekla-message").hidden = true;
  $("hekla-copy").hidden = true;
  $("hekla-mail").hidden = true;
  $("hekla-result").textContent = "";
  $("hekla-send").hidden = false;
  if (action === "process") {
    $("hekla-title").textContent = "Ask Hekla to process new rows";
    $("hekla-copy").textContent = "This sends a note asking Hekla to rank new Waitlist rows. It does not change Status and does not list cards.";
    $("hekla-send").textContent = "Send to Hekla";
  } else {
    $("hekla-title").textContent = "Greenlight shortlist";
    $("hekla-copy").textContent = "This tells Hekla you approve the shortlist. Listing still happens in Hekla after your go. Intake will not mark anything Listed and will not call TCGPlayer.";
    $("hekla-send").textContent = "Send greenlight";
  }
  $("hekla-dialog").showModal();
}

async function sendHekla() {
  $("hekla-send").disabled = true;
  const { response, data } = await api("/api/hekla", {
    method: "POST",
    body: JSON.stringify({ action: state.heklaAction }),
  });
  $("hekla-send").disabled = false;
  if (!response.ok) {
    $("hekla-result").textContent = data.error || "Could not send that note.";
    return;
  }
  $("hekla-send").hidden = true;
  $("hekla-message").hidden = false;
  $("hekla-message").textContent = data.copyText || "";
  $("hekla-copy").hidden = false;
  if (data.mailto) {
    $("hekla-mail").hidden = false;
    $("hekla-mail").href = data.mailto;
  }
  $("hekla-result").textContent = data.delivered
    ? "Hekla’s webhook accepted the note. No cards were listed."
    : "No webhook is configured, so nothing was sent automatically. Copy the note below. No cards were listed.";
}

async function copyHekla() {
  const text = $("hekla-message").textContent || "";
  try {
    await navigator.clipboard.writeText(text);
    $("hekla-result").textContent = "Copied. Listing still stays with Hekla.";
  } catch {
    $("hekla-result").textContent = "Select the note and copy it manually.";
  }
}

