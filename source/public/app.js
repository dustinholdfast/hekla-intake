const STORAGE_KEY = "hekla-intake-defaults-v1";

const state = {
  status: "Waitlist",
  game: "Lorcana",
  cards: [],
  truncated: false,
  search: "",
  priceSort: null, // null (default order), "desc" (highest first) or "asc"
  session: null,
  pending: null,
  bulkPreview: null,
  heklaAction: null,
  submitting: false,
  matches: null,
  override: null,
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
  $("logout").addEventListener("click", () => { if (document.documentElement.dataset.preview === "1") return; signOut(); });
  $("login-signout").addEventListener("click", () => { if (document.documentElement.dataset.preview === "1") return; signOut(); });
  $("add-form").addEventListener("submit", onAdd);
  $("add-form").addEventListener("change", saveDefaults);
  $("game").addEventListener("change", (event) => selectGame(event.target.value));
  wireCombo();
  $("set-identifier").addEventListener("change", () => {
    const code = resolveSet($("set-identifier").value, setLists[state.game]?.sets || []);
    if (code) { $("set-identifier").value = code.toUpperCase(); saveDefaults(); }
    paintCurrentIcon();
    scheduleMagicFinishes();
  });
  $("set-identifier").addEventListener("input", scheduleMagicFinishes);
  $("collector").addEventListener("input", scheduleMagicFinishes);
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
  $("match-override").addEventListener("click", () => openOverride("card"));
  $("override-confirm").addEventListener("click", confirmOverride);
  $("override-cancel").addEventListener("click", () => $("override-dialog").close());
  $("qty").addEventListener("input", () => { if (state.matches) renderMatch(state.matches); });
  for (const id of ["collector", "finish", "condition", "set", "set-identifier", "game"]) {
    $(id).addEventListener("change", clearMatch);
  }
  document.querySelectorAll("input[name=onDuplicate]").forEach((radio) => {
    radio.addEventListener("change", () => { if (state.bulkPreview) renderBulk(state.bulkPreview); });
  });
  $("ask-process").addEventListener("click", runAutoSort);
  $("rerank-listed").addEventListener("click", runRerankListed);
  $("rescan").addEventListener("click", runRescan);
  $("ask-greenlight").addEventListener("click", () => openHekla("greenlight"));
  $("hekla-send").addEventListener("click", sendHekla);
  $("hekla-close").addEventListener("click", () => $("hekla-dialog").close());
  $("hekla-copy").addEventListener("click", copyHekla);
  $("refresh").addEventListener("click", () => refreshAll());
  $("sort-price").addEventListener("click", () => {
    state.priceSort = state.priceSort === null ? "desc" : state.priceSort === "desc" ? "asc" : null;
    renderQueue();
  });
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
    }
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
  if (document.documentElement.dataset.preview === "1") {
    const { response, data } = await api("/api/session");
    if (!response.ok) {
      show("login");
      $("login-error").textContent = data.error || "Preview session failed.";
      return;
    }
    state.session = data;
    $("admin-link").hidden = true;
    buildForm(data);
    applyDefaults();
    markTabs();
    show("app");
    await refreshAll();
    return;
  }
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
  const route = new URLSearchParams(location.search);
  const requestedGame = route.get("game");
  if (requestedGame && data.games.includes(requestedGame)) selectGame(requestedGame, { refresh: false });
  if (["Waitlist", "Listed", "Sold", "Skip"].includes(route.get("status"))) state.status = route.get("status");
  state.search = route.get("q") || "";
  $("search").value = state.search;
  markTabs();
  show("app");
  await refreshAll();
  if (route.has("q")) { $("queue-panel").scrollIntoView({ block: "start" }); $("search").focus(); }
  else $("collector").focus();
}

function show(name) {
  views.boot.hidden = name !== "boot";
  views.login.hidden = name !== "login";
  views.app.hidden = name !== "app";
}

function buildForm(session) {
  fillSelect($("game"), session.games || ["Lorcana"], (game) => game, (game) => game);
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

function knownGame(game) {
  const games = state.session?.games || [];
  return games.includes(game) ? game : "Lorcana";
}

function finishesFor(game) {
  const map = state.session?.finishesByGame || {};
  return map[game] || state.session?.finishes || ["Normal"];
}

function currentFinishName() {
  const selected = $("finish")?.selectedOptions?.[0];
  return selected?.dataset.finish || $("finish")?.value || "";
}

let magicFinishTimer = 0;
let magicFinishGeneration = 0;

function scheduleMagicFinishes() {
  if ((state.game || "Lorcana") !== "Magic: The Gathering") return;
  clearTimeout(magicFinishTimer);
  magicFinishTimer = setTimeout(() => { loadMagicFinishes().catch(() => {}); }, 250);
}

function numberKey(value) {
  return String(value || "").trim().toLowerCase().replace(/^0+(?=\d)/, "");
}

async function loadMagicFinishes() {
  if ((state.game || "Lorcana") !== "Magic: The Gathering") return;
  const generation = ++magicFinishGeneration;
  const set = $("set-identifier").value.trim();
  const number = $("collector").value.trim();
  const hint = $("finish-hint");
  const fallback = () => (finishesFor("Magic: The Gathering") || ["Normal", "Foil"]).map((finish) => ({ finish, label: finish, collectorNumber: number }));
  if (!set || !number) {
    applyFinishOptions(fallback(), currentFinishName());
    if (hint) { hint.hidden = false; hint.textContent = "Enter the set and collector number to load this card's CardTrader finishes."; }
    return;
  }
  if (hint) { hint.hidden = false; hint.textContent = "Checking CardTrader…"; }
  const { response, data } = await api(`/api/magic-finishes?set=${encodeURIComponent(set)}&number=${encodeURIComponent(number)}`);
  if (generation !== magicFinishGeneration || (state.game || "") !== "Magic: The Gathering") return;
  if (!response.ok || !data.ok || !Array.isArray(data.options) || data.options.length === 0) {
    applyFinishOptions((Array.isArray(data.fallback) && data.fallback.length ? data.fallback : ["Normal", "Foil"]).map((finish) => ({ finish, label: finish, collectorNumber: number })), currentFinishName());
    if (hint) hint.textContent = data.hint || data.error || "CardTrader finishes are unavailable. Normal and Foil still work.";
    return;
  }
  applyFinishOptions(data.options, currentFinishName());
  const moved = data.options.some((option) => option.collectorNumber && numberKey(option.collectorNumber) !== numberKey(number));
  if (hint) {
    const name = data.cardName ? `CardTrader finishes for ${data.cardName}` : "Finishes from CardTrader";
    hint.textContent = moved ? `${name}. A treatment with another collector number is saved as that number.` : `${name}.`;
  }
}

function applyFinishOptions(options, preferred) {
  const select = $("finish");
  const want = preferred || currentFinishName();
  select.replaceChildren();
  for (const option of options) {
    const node = document.createElement("option");
    node.value = `${option.blueprintId ?? ""}|${option.finish}|${option.collectorNumber ?? ""}`;
    node.dataset.finish = option.finish;
    node.dataset.collectorNumber = option.collectorNumber || "";
    node.dataset.blueprintId = option.blueprintId == null ? "" : String(option.blueprintId);
    node.textContent = option.label || option.finish;
    select.append(node);
  }
  const match = [...select.options].find((option) => option.dataset.finish === want)
    || [...select.options].find((option) => option.dataset.finish === "Normal")
    || select.options[0];
  if (match) select.value = match.value;
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
  $("game").value = state.game;
  const lorcana = state.game === "Lorcana";
  $("set-number-field").hidden = !lorcana;
  $("set-identifier-field").hidden = lorcana;
  const finishes = finishesFor(state.game);
  const remembered = saved.finishByGame?.[state.game];
  const preferred = remembered || saved.finish || currentFinishName();
  fillSelect($("finish"), finishes, (finish) => finish, (finish) => finish);
  if (finishes.includes(preferred)) $("finish").value = preferred;
  else if (finishes.includes("Normal")) $("finish").value = "Normal";
  const magic = state.game === "Magic: The Gathering";
  const hint = $("finish-hint");
  if (hint) {
    hint.hidden = !magic;
    if (magic) hint.textContent = "Enter the set and collector number to load this card's CardTrader finishes.";
  }
  if (magic) scheduleMagicFinishes();
  if ([...$("set").options].some((option) => option.value === saved.setNumber)) $("set").value = saved.setNumber;
  $("set-identifier").value = savedSetIdentifier(saved, state.game);
  state.setWarned = null;
  if (!lorcana) refreshSetOptions(state.game);
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

/* ---------- Set identifier per game (CardTrader's set codes, the same ones enrichment and export use) ----------
 * Shown and saved upper-case ("VEN", "FDN"), as the Waitlist already has them; lookups ignore case. */
const SET_CACHE_KEY = "hekla-sets-v4"; // v4: lists carry shape + complete; incomplete lists are never stored
const SET_SHAPE = 4; // must match SETS_SHAPE in src/index.ts; a cached list of another shape is ignored
const SET_TTL_MS = 24 * 3600_000;
const SET_RETRY_MS = 60_000; // an incomplete list (Scryfall unavailable) is fetched again after a minute
try { ["hekla-sets-v1", "hekla-sets-v2", "hekla-sets-v3"].forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
const setLists = {}; // game → { sets: [{code, name}], source, hint, at }
const setLoading = {};

/** This game's remembered set identifier. Older saved defaults kept one identifier for every game. */
function savedSetIdentifier(saved, game) {
  if (saved.setIdentifierByGame && typeof saved.setIdentifierByGame[game] === "string") return saved.setIdentifierByGame[game];
  return saved.game === game && typeof saved.setIdentifier === "string" ? saved.setIdentifier : "";
}

function cachedSets(game) {
  const mem = setLists[game];
  if (mem && Date.now() - mem.at < (mem.complete === false ? SET_RETRY_MS : SET_TTL_MS)) return mem;
  try {
    const all = JSON.parse(localStorage.getItem(SET_CACHE_KEY) || "{}");
    const hit = all[game];
    if (hit && hit.shape === SET_SHAPE && hit.complete !== false && Array.isArray(hit.sets) && hit.sets.length && Date.now() - hit.at < SET_TTL_MS) return (setLists[game] = hit);
  } catch { /* ignore */ }
  return null;
}
function storeSets(game, entry) {
  setLists[game] = entry;
  if (!entry.sets.length || entry.complete === false) return; // don't keep "unavailable" or a bare list; retry soon
  try {
    const all = JSON.parse(localStorage.getItem(SET_CACHE_KEY) || "{}");
    all[game] = entry;
    localStorage.setItem(SET_CACHE_KEY, JSON.stringify(all));
  } catch { /* storage full or blocked; memory cache still works */ }
}
async function loadSets(game) {
  const hit = cachedSets(game);
  if (hit) return hit;
  setLoading[game] ||= api(`/api/sets?game=${encodeURIComponent(game)}`).then(({ response, data }) => {
    const entry = response.ok ? { sets: Array.isArray(data.sets) ? data.sets : [], source: data.source, hint: data.hint || "", icons: data.icons || null, shape: data.shape, complete: data.shape === SET_SHAPE && data.complete !== false, at: Date.now() } : { sets: [], source: "none", hint: data.error || "", at: Date.now() };
    storeSets(game, entry);
    return entry;
  }).finally(() => { delete setLoading[game]; });
  return setLoading[game];
}

/** "fdn", "FDN", "fdn — Foundations" or the set's exact name → its code; null when it is not in the list. */
function resolveSet(input, sets) {
  const raw = (input || "").trim().toLowerCase();
  if (!raw) return null;
  const head = raw.split(/\s+[—–-]\s+/)[0].trim();
  return (sets.find((s) => s.code === head || s.code === raw) || sets.find((s) => s.name.toLowerCase() === raw))?.code || null;
}

async function refreshSetOptions(game) {
  const entry = await loadSets(game);
  if (state.game !== game) return; // the game changed while loading
  combo.sets = entry.sets;
  closeCombo();
  const input = $("set-identifier");
  // Magic lists core sets oldest first, so the example is the newest core set (the last one before the divider).
  const core = entry.sets.filter((s) => s.group === "core");
  const first = core.length ? core[core.length - 1] : entry.sets[0];
  input.placeholder = first ? `e.g. ${first.code.toUpperCase()} (${first.name})` : "Set code";
  const symbols = entry.icons && entry.icons.matched ? `, ${entry.icons.matched} with set symbols` : "";
  $("set-hint").textContent = entry.sets.length ? `${entry.sets.length} ${game} sets from CardTrader${symbols}${entry.hint ? `. ${entry.hint}` : ""}` : entry.hint || "";
  // A set from another game (or one CardTrader doesn't have) is cleared on the switch.
  if (entry.sets.length && input.value.trim()) {
    const code = resolveSet(input.value, entry.sets);
    if (code) input.value = code.toUpperCase();
    else { input.value = ""; saveDefaults(); }
  }
  paintCurrentIcon();
  if (document.activeElement === input && entry.sets.length) openCombo(); // focused before the list arrived
}

/* ---------- set combobox: type to filter, ↑/↓, Enter or Tab picks and jumps to Collector number, Esc closes ---------- */
const combo = { sets: [], shown: [], active: -1, split: -1 };
const COMBO_MAX = 1500; // enough for every set CardTrader has for a game; the list scrolls

function setIcon(icon) {
  const span = document.createElement("span");
  span.className = "set-icon";
  span.setAttribute("aria-hidden", "true");
  if (icon && /^[a-z0-9]{1,12}$/.test(icon)) {
    const url = `url("/set-icons/${icon}.svg")`;
    span.style.webkitMaskImage = url; span.style.maskImage = url; // CSSOM, allowed by the CSP
  } else span.classList.add("none");
  return span;
}
function paintCurrentIcon() {
  const holder = $("set-current-icon");
  const code = resolveSet($("set-identifier").value, combo.sets);
  const icon = code && combo.sets.find((s) => s.code === code)?.icon;
  holder.hidden = !icon;
  if (icon) { const url = `url("/set-icons/${icon}.svg")`; holder.style.webkitMaskImage = url; holder.style.maskImage = url; }
}
/**
 * Code prefix, then code containing, then a name word starting with, then name containing, each in list order.
 * Magic's grouping is kept: matching core sets first, then the rest.
 */
function filterSets(text, sets) {
  const q = (text || "").trim().toLowerCase();
  if (!q) return sets;
  const ranked = rankSets(q, sets);
  return ranked.filter((s) => s.group === "core").concat(ranked.filter((s) => s.group !== "core"));
}
function rankSets(q, sets) {
  const head = q.split(/\s+[—–-]\s+/)[0];
  const starts = [], inCode = [], nameStarts = [], inName = [];
  for (const s of sets) {
    const name = s.name.toLowerCase();
    if (s.code.startsWith(head)) starts.push(s);
    else if (s.code.includes(head)) inCode.push(s);
    else if (name.startsWith(q) || name.includes(` ${q}`)) nameStarts.push(s);
    else if (name.includes(q)) inName.push(s);
  }
  return starts.concat(inCode, nameStarts, inName);
}
function openCombo() {
  if (!combo.sets.length) return closeCombo();
  const input = $("set-identifier"), list = $("set-listbox");
  combo.shown = filterSets(input.value, combo.sets);
  const exact = resolveSet(input.value, combo.sets);
  combo.active = combo.shown.length ? Math.max(0, combo.shown.findIndex((s) => s.code === exact)) : -1;
  if (!input.value.trim()) combo.active = -1;
  const items = combo.shown.slice(0, COMBO_MAX).map((s, i) => {
    const li = document.createElement("li");
    li.id = `set-opt-${i}`; li.setAttribute("role", "option"); li.dataset.code = s.code;
    li.setAttribute("aria-selected", i === combo.active ? "true" : "false");
    const code = document.createElement("span"); code.className = "code"; code.textContent = s.code.toUpperCase();
    const name = document.createElement("span"); name.className = "name"; name.textContent = s.name;
    if (combo.sets.some((x) => x.icon !== undefined)) li.append(setIcon(s.icon));
    li.append(code, name);
    li.addEventListener("mousedown", (e) => { e.preventDefault(); pickSet(s.code, true); });
    return li;
  });
  // Divider between Magic's core sets and the rest, only when both groups have matches. Not an option, so
  // ↑/↓ (which walk the options) skip it.
  combo.split = combo.shown.slice(0, COMBO_MAX).findIndex((s) => s.group !== "core");
  if (combo.split <= 0 || combo.shown[0].group !== "core") combo.split = -1;
  let divider = null;
  if (combo.split > 0) {
    divider = document.createElement("li");
    divider.className = "divider"; divider.setAttribute("role", "separator"); divider.setAttribute("aria-label", "Other sets");
    divider.textContent = "Other sets";
    items.splice(combo.split, 0, divider);
  }
  list.replaceChildren(...items);
  if (combo.shown.length > COMBO_MAX) { const more = document.createElement("li"); more.className = "more"; more.textContent = `${combo.shown.length - COMBO_MAX} more, keep typing…`; list.append(more); }
  if (!combo.shown.length) { const none = document.createElement("li"); none.className = "more"; none.textContent = "No matching set"; list.append(none); }
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  moveActive(0);
  // Opened with nothing typed: show the newest core sets (the end of the top group) and the divider.
  if (combo.active < 0 && divider) list.scrollTop = Math.max(0, divider.offsetTop + divider.offsetHeight * 3 - list.clientHeight);
}
function closeCombo() {
  $("set-listbox").hidden = true;
  $("set-identifier").setAttribute("aria-expanded", "false");
  $("set-identifier").removeAttribute("aria-activedescendant");
  combo.active = -1;
}
function moveActive(step) {
  const max = Math.min(combo.shown.length, COMBO_MAX);
  if (!max) return;
  // With nothing active and the list scrolled to the divider, ↑ starts at the last core set, ↓ just below it.
  const start = combo.split > 0 && combo.split < max ? (step > 0 ? combo.split : combo.split - 1) : (step > 0 ? 0 : max - 1);
  if (step) combo.active = combo.active < 0 ? start : (combo.active + step + max) % max;
  document.querySelectorAll("#set-listbox [role=option]").forEach((li, i) => li.setAttribute("aria-selected", i === combo.active ? "true" : "false"));
  const li = combo.active >= 0 ? $(`set-opt-${combo.active}`) : null;
  if (li) { $("set-identifier").setAttribute("aria-activedescendant", li.id); li.scrollIntoView({ block: "nearest" }); }
  else $("set-identifier").removeAttribute("aria-activedescendant");
}
function pickSet(code, jump) {
  $("set-identifier").value = code.toUpperCase();
  state.setWarned = null;
  closeCombo();
  paintCurrentIcon();
  saveDefaults();
  if (jump) $("collector").focus();
}
function wireCombo() {
  const input = $("set-identifier");
  input.addEventListener("input", () => { openCombo(); paintCurrentIcon(); });
  input.addEventListener("focus", () => {
    const entry = setLists[state.game];
    if (entry && entry.complete === false && Date.now() - entry.at >= SET_RETRY_MS) refreshSetOptions(state.game); // retry a bare list
    if (combo.sets.length) openCombo();
  });
  input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== input) closeCombo(); }, 0));
  input.addEventListener("keydown", (e) => {
    const open = !$("set-listbox").hidden;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (!open) openCombo(); moveActive(e.key === "ArrowDown" ? 1 : -1); return; }
    if (e.key === "Escape" && open) { e.preventDefault(); closeCombo(); return; }
    if ((e.key === "Enter" || e.key === "Tab") && open && combo.active >= 0 && combo.shown[combo.active]) {
      e.preventDefault();
      pickSet(combo.shown[combo.active].code, true);
    }
  });
}

/** Null when the set identifier is fine. A code not in the list blocks once; Enter again adds it anyway. */
function checkSetIdentifier(game) {
  const input = $("set-identifier");
  const value = input.value.trim();
  if (!value) return "Set identifier is required.";
  const sets = setLists[game]?.sets || [];
  if (!sets.length) return null; // no list to check against (CardTrader not connected or unavailable)
  const code = resolveSet(value, sets);
  if (code) { input.value = code.toUpperCase(); state.setWarned = null; return null; }
  if (state.setWarned === `${game}|${value.toLowerCase()}`) return null;
  state.setWarned = `${game}|${value.toLowerCase()}`;
  return `“${value}” isn't a CardTrader ${game} set code, so Hekla can't price or list it. Pick one from the list, or press Enter again to add it anyway.`;
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
  document.querySelectorAll("[data-cap-game]").forEach((node) => {
    node.textContent = game;
  });
}

function updateBulkHelp() {
  const game = state.game || "Lorcana";
  const help = $("bulk-help");
  const sample = $("bulk-sample");
  if (!help || !sample) return;
  if (game === "Lorcana") {
    help.textContent = "One Lorcana card per line. First token is the set number, then collector number, finish (Normal, Foil, or Enchanted), condition, optional quantity, an optional cost (2.50), and an optional name. A blank cost is left unknown. Spaces, commas, or tabs. Every line uses Lorcana.";
    sample.textContent = "8 042 Foil NM 1 2.50\n8,156,Normal,NM,2,1.25,Elsa - Snow Queen\n13\t15\tFoil\tLP\t1\tTiana";
    return;
  }
  if (game === "Magic: The Gathering") {
    help.textContent = "One Magic card per line. First token is the set code, then collector number, finish, condition, optional quantity, an optional cost (2.50), and an optional name. A blank cost is left unknown. Finish is Normal, Foil, or that printing's CardTrader treatment (Borderless, Extended Art, Showcase, Etched). Use commas or tabs when the finish has spaces. Every line uses Magic.";
    sample.textContent = bulkSample(game);
    return;
  }
  const finishes = finishesFor(game).join(", ");
  help.textContent = `One ${game} card per line. First token is the set identifier, then collector number, finish (${finishes}), condition, optional quantity, an optional cost (2.50), and an optional name. A blank cost is left unknown. Use commas or tabs when the set identifier has spaces. Every line uses ${game}.`;
  sample.textContent = bulkSample(game);
}

function bulkSample(game) {
  if (game === "Magic: The Gathering") return "FIN 089 Foil NM 1\nFIN,379,Borderless,NM,1,Ardyn, the Usurper\nFIN,444,Extended Art Foil,NM";
  if (game === "Pokémon") return "SV08 25 Foil NM 1\nSV08,25,Normal,NM,2,Pikachu";
  if (game === "Yu-Gi-Oh!") return "LOB 1 Normal NM 1\nLOB,5,Foil,NM,1,Dark Magician";
  return "OGN 12 Foil NM 1\nOGN,12,Special,NM,1";
}

function saveDefaults() {
  const previous = defaults();
  const finishByGame = { ...(previous.finishByGame || {}) };
  if (state.game && currentFinishName()) finishByGame[state.game] = currentFinishName();
  const setIdentifierByGame = { ...(previous.setIdentifierByGame || {}) };
  if (state.game && state.game !== "Lorcana") setIdentifierByGame[state.game] = $("set-identifier").value.trim();
  const payload = {
    game: state.game || "Lorcana",
    setNumber: $("set").value,
    setIdentifier: $("set-identifier").value,
    setIdentifierByGame,
    finish: currentFinishName(),
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

function selectedMagicPrinting() {
  const selected = $("finish")?.selectedOptions?.[0];
  const finish = selected?.dataset.finish || $("finish")?.value || "";
  if ((state.game || "Lorcana") !== "Magic: The Gathering" || !selected?.dataset.collectorNumber) return { finish, collectorNumber: "" };
  const typed = $("collector").value.trim();
  const printing = selected.dataset.collectorNumber;
  if (printing && numberKey(printing) !== numberKey(typed)) return { finish, collectorNumber: printing };
  return { finish, collectorNumber: "" };
}

function cardPayload(extra) {
  const cost = $("cost").value;
  const priority = $("priority").value;
  const printing = selectedMagicPrinting();
  const payload = {
    game: state.game || "Lorcana",
    collectorNumber: printing.collectorNumber || $("collector").value.trim(),
    finish: printing.finish,
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
  if ((state.game || "Lorcana") !== "Lorcana") {
    const problem = checkSetIdentifier(state.game);
    if (problem) {
      $("form-error").textContent = problem;
      if (!$("set-identifier").value.trim()) $("set-identifier").focus();
      return;
    }
    saveDefaults();
  }
  if (state.matches?.length) {
    const selected = document.querySelector("input[name=merge-target]:checked");
    await submitCard(cardPayload({ onDuplicate: "merge", mergeRecordId: selected ? selected.value : state.matches[0].id }));
    return;
  }
  await submitCard(cardPayload({ onDuplicate: "ask" }));
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
      renderMatch(data.matches || []);
      return;
    }
    if (!response.ok) {
      $("form-error").textContent = data.error || "Could not add that card.";
      return;
    }
    state.pending = null;
    clearMatch();
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

function stockLanguage(value) {
  const text = (value || "").trim();
  const lower = text.toLowerCase();
  if (!text || lower === "en" || lower === "english") return "English";
  return text;
}

function selectedMatch() {
  const matches = state.matches || [];
  const selected = document.querySelector("input[name=merge-target]:checked");
  return matches.find((match) => match.id === selected?.value) || matches[0] || null;
}

function clearMatch() {
  state.matches = null;
  const note = $("match-note");
  if (note) note.hidden = true;
  const button = $("add-button");
  if (button) {
    button.textContent = "Add to waitlist";
    button.className = "primary";
  }
  const link = $("match-override");
  if (link) link.hidden = true;
}

function renderMatch(matches) {
  const previous = document.querySelector("input[name=merge-target]:checked")?.value;
  state.matches = matches;
  const note = $("match-note");
  const list = $("match-choices");
  list.replaceChildren();
  if (matches.length > 1) {
    matches.forEach((match, index) => {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "merge-target";
      radio.value = match.id;
      radio.checked = previous ? match.id === previous : index === 0;
      radio.addEventListener("change", () => renderMatch(matches));
      const text = document.createElement("span");
      text.textContent = `${match.name || "Unnamed card"} · qty ${match.qty} · ${match.status}`;
      label.append(radio, text);
      list.append(label);
    });
  }
  const match = selectedMatch();
  const adding = Number($("qty").value) || 1;
  const have = match ? match.qty : 0;
  $("match-copy").textContent = match
    ? `Already in stock: ${have} · ${match.condition || "NM"} · ${stockLanguage(match.language)}. Adding ${adding} brings it to ${have + adding}.`
    : "";
  $("match-listed").hidden = !matches.some((item) => item.status === "Listed");
  note.hidden = false;
  const button = $("add-button");
  button.textContent = "Add to existing";
  button.className = "primary gold";
  $("match-override").hidden = false;
}

function openOverride(kind) {
  state.override = kind;
  $("override-copy").textContent = kind === "bulk"
    ? "Add anyway creates a second row for each matched line. Those duplicates are recorded and the owner is alerted."
    : "This creates a second row for the same card. That duplicate is recorded and the owner is alerted. It does not list the card.";
  $("override-dialog").showModal();
}

async function confirmOverride() {
  const kind = state.override;
  $("override-dialog").close();
  if (kind === "bulk") {
    await commitBulk({ confirmed: true });
    return;
  }
  const payload = state.pending;
  if (!payload) return;
  await submitCard({ ...payload, onDuplicate: "add", confirmOverride: true });
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
    $("cap-error").textContent = data.error || "Counts unavailable.";
    return;
  }
  const listed = data.listedQty || 0;
  document.querySelectorAll("[data-cap=listed]").forEach((node) => {
    node.textContent = String(listed);
  });
  document.querySelectorAll("[data-cap=waitlist]").forEach((node) => {
    node.textContent = String(data.waitlistQty || 0);
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
  $("ct-export").hidden = state.status !== "Waitlist";
  document.querySelectorAll("[data-status]").forEach((button) => {
    const on = button.dataset.status === state.status;
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

/** The cards in the queue for the selected game, after the search box filter. */
function shownCards() {
  const query = state.search.trim().toLowerCase();
  return sortByPrice(cardsForGame(state.cards, state.game).filter((card) => {
    if (!query) return true;
    return [card.name, card.cardName, card.resolvedName, card.collectorNumber, card.setNumber, card.setIdentifier, card.setName, card.game, card.finish, card.condition, card.notes, card.id]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  }), state.priceSort);
}

/** Cards by market price ("desc" highest first, "asc" lowest first); cards with no price always last. Stable, so ties keep the rank order. */
function sortByPrice(cards, direction) {
  if (!direction) return cards;
  const priceOf = (card) => (card.marketPriceUsd === null || card.marketPriceUsd === undefined || card.marketPriceUsd === "" || !Number.isFinite(Number(card.marketPriceUsd)) ? null : Number(card.marketPriceUsd));
  return cards
    .map((card, index) => ({ card, index, price: priceOf(card) }))
    .sort((a, b) => {
      if (a.price === null || b.price === null) return (a.price === null) - (b.price === null) || a.index - b.index;
      return (direction === "desc" ? b.price - a.price : a.price - b.price) || a.index - b.index;
    })
    .map((entry) => entry.card);
}

function markPriceSort() {
  const button = $("sort-price");
  if (!button) return;
  const arrow = state.priceSort === "desc" ? "↓" : state.priceSort === "asc" ? "↑" : "↕";
  button.querySelector("span").textContent = arrow;
  button.classList.toggle("on", state.priceSort !== null);
  button.title = state.priceSort === null ? "Sort by price, highest first" : state.priceSort === "desc" ? "Sort by price, lowest first" : "Back to the default order";
  $("price-th").setAttribute("aria-sort", state.priceSort === "desc" ? "descending" : state.priceSort === "asc" ? "ascending" : "none");
}

function renderQueue() {
  const body = $("queue-body");
  if ($("queue-error").textContent) {
    body.replaceChildren();
    return;
  }
  const rows = shownCards();
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
  markPriceSort();
  const sortNote = state.priceSort ? `Sorted by price, ${state.priceSort === "desc" ? "highest" : "lowest"} first (no price last). Click Price again to change.` : state.status === "Waitlist" ? "Sorted by rank (unsorted last), then priority, then newest." : state.status === "Listed" ? "Sorted by rank, weakest first (pull candidates on top)." : "Sorted by newest.";
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
    if (key === "finish" && effectiveGame(card.game) === "Magic: The Gathering") {
      control.addEventListener("focus", () => { fillMagicEditOptions(card, control).catch(() => {}); }, { once: true });
    }
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

async function fillMagicEditOptions(card, control) {
  const set = card.setIdentifier || "";
  const number = card.collectorNumber || "";
  if (!set || !number) return;
  const { response, data } = await api(`/api/magic-finishes?set=${encodeURIComponent(set)}&number=${encodeURIComponent(number)}`);
  if (!response.ok || !data.ok || !Array.isArray(data.options) || !data.options.length) return;
  const current = control.value;
  const finishes = [];
  for (const option of data.options) {
    if (option.collectorNumber && numberKey(option.collectorNumber) !== numberKey(number)) continue;
    if (!finishes.includes(option.finish)) finishes.push(option.finish);
  }
  if (current && !finishes.includes(current)) finishes.unshift(current);
  control.replaceChildren();
  for (const value of finishes) {
    const node = document.createElement("option");
    node.value = value;
    node.textContent = value;
    control.append(node);
  }
  control.value = finishes.includes(current) ? current : finishes[0];
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

function bulkPolicy() {
  return document.querySelector("input[name=onDuplicate]:checked")?.value || "merge";
}

function bulkTally(rows) {
  const policy = bulkPolicy();
  let fresh = 0;
  let merge = 0;
  let forced = 0;
  let skipped = 0;
  for (const row of rows || []) {
    if (row.error || !row.card) continue;
    const matched = (row.matches || []).length > 0 || (row.alsoInPaste || []).length > 0;
    if (!matched) fresh += 1;
    else if (policy === "add") forced += 1;
    else if (policy === "merge") merge += 1;
    else skipped += 1;
  }
  return { fresh, merge, forced, skipped };
}

function stockTag(matched) {
  if (!matched) return null;
  const policy = bulkPolicy();
  if (policy === "add") return "New row";
  if (policy === "skip") return "Skip";
  return "Add to existing";
}

function bulkCommitLabel(tally, valid) {
  if (!valid) return "Add these to waitlist";
  const parts = [];
  if (tally.fresh) parts.push(`Add ${tally.fresh}`);
  if (tally.merge) parts.push(parts.length ? `merge ${tally.merge}` : `Merge ${tally.merge}`);
  if (tally.forced) parts.push(parts.length ? `force ${tally.forced}` : `Force ${tally.forced}`);
  if (!parts.length && tally.skipped) return `Skip ${tally.skipped}`;
  return parts.join(" · ") || "Add these to waitlist";
}

function bulkCompact(tr, identity, detail) {
  const td = document.createElement("td");
  td.className = "bulk-line";
  const id = document.createElement("div");
  id.className = "bulk-line-id";
  id.textContent = identity;
  const check = document.createElement("div");
  check.className = "bulk-line-check";
  if (typeof detail === "string") check.textContent = detail;
  else check.append(detail);
  td.append(id, check);
  tr.append(td);
}

function renderBulk(data) {
  const body = $("bulk-body");
  body.replaceChildren();
  let valid = 0;
  let dupes = 0;
  for (const row of data.rows || []) {
    const tr = document.createElement("tr");
    if (row.error) {
      tr.append(cell("Line", String(row.line)), cell("Set", "—"), cell("#", "—"), cell("Finish", "—"), cell("Cond", "—"), cell("Qty", "—"), cell("Cost", "—"), cell("Name", "—"), cell("Check", row.error));
      bulkCompact(tr, String(row.line), row.error);
    } else {
      valid += 1;
      const matches = row.matches || [];
      const paste = row.alsoInPaste || [];
      const matched = matches.length > 0 || paste.length > 0;
      if (matched) dupes += 1;
      const check = document.createElement("span");
      const tag = stockTag(matched);
      if (tag) {
        const pill = document.createElement("span");
        pill.className = "stock-tag";
        pill.textContent = tag;
        check.append(pill);
      }
      check.append(document.createTextNode([
        ...matches.map((match) => `${match.status} qty ${match.qty}`),
        ...paste.map((line) => `also line ${line}`),
      ].join(", ") || "Ready"));
      tr.append(
        cell("Line", String(row.line)),
        cell("Set", row.card.game === "Lorcana" ? row.card.setNumber : (row.card.setIdentifier || "—")),
        cell("#", row.card.collectorNumber),
        cell("Finish", row.card.finish),
        cell("Cond", row.card.condition),
        cell("Qty", String(row.card.qty)),
        cell("Cost", row.card.costBasisUsd == null ? "—" : String(row.card.costBasisUsd)),
        cell("Name", row.card.cardName || "—"),
        cell("Check", ""),
      );
      tr.lastChild.replaceChildren(check);
      const detail = document.createElement("span");
      const name = row.card.cardName || "";
      if (name) detail.append(document.createTextNode(`${name} · `));
      if (tag) {
        const pill = document.createElement("span");
        pill.className = "stock-tag";
        pill.textContent = tag;
        detail.append(pill, document.createTextNode(" · "));
      }
      const note = [
        ...matches.map((match) => `${match.status} qty ${match.qty}`),
        ...paste.map((line) => `also line ${line}`),
      ].join(", ") || "Ready";
      detail.append(document.createTextNode(note));
      bulkCompact(tr, `${row.line} · ${row.card.collectorNumber} · ${row.card.finish} · ${row.card.condition} · ×${row.card.qty}`, detail);
    }
    body.append(tr);
  }
  const tally = bulkTally(data.rows);
  const summary = $("bulk-summary");
  summary.hidden = valid === 0;
  summary.textContent = `${tally.fresh} new · ${tally.merge} add to existing · ${tally.forced} new rows forced`;
  $("dup-policy").hidden = dupes === 0;
  const mergeChoice = document.querySelector("input[name=onDuplicate][value=merge]");
  if (mergeChoice && !document.querySelector("input[name=onDuplicate]:checked")) mergeChoice.checked = true;
  if (data.warning) {
    $("bulk-warning").hidden = false;
    $("bulk-warning").textContent = data.warning;
  }
  $("bulk-commit").disabled = valid === 0;
  $("bulk-commit").textContent = bulkCommitLabel(tally, valid);
}

async function commitBulk(options = {}) {
  const text = $("bulk-text").value;
  const onDuplicate = bulkPolicy();
  if (onDuplicate === "add" && !options.confirmed) {
    openOverride("bulk");
    return;
  }
  $("bulk-error").textContent = "";
  $("bulk-commit").disabled = true;
  const { response, data } = await api("/api/intake/bulk", {
    method: "POST",
    body: JSON.stringify({ text, mode: "commit", game: state.game || "Lorcana", onDuplicate, confirmOverride: onDuplicate === "add" }),
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
    $("hekla-copy").textContent = "This tells Hekla you approve the shortlist. Sending this note lists nothing and changes no Status.";
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

