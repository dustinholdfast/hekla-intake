// CardTrader export dialog. Uses state, $, api, shownCards and refreshAll from app.js / session.js.
// Flow: pick which cards → check them against CardTrader (read-only) → review → approve → list.

const EXPORT_PAGE = 15;
const EXPORT_MAX = 200;
const ctExport = { rows: [], canSend: false, busy: false };

document.addEventListener("DOMContentLoaded", () => {
  $("ct-export").addEventListener("click", openCardTraderExport);
  $("ct-check").addEventListener("click", checkCardTrader);
  $("ct-send").addEventListener("click", sendCardTrader);
  $("ct-close").addEventListener("click", () => $("ct-dialog").close());
  $("ct-body").addEventListener("change", updateSendButton);
});

function exportCandidates() {
  const shown = shownCards().filter((card) => card.status === "Waitlist");
  return { shown, list: shown.filter((card) => card.recommendation === "List") };
}

function openCardTraderExport() {
  const { shown, list } = exportCandidates();
  ctExport.rows = [];
  ctExport.canSend = false;
  $("ct-intro").textContent = `Lists ${state.game} Waitlist cards on your CardTrader account at their market price. Nothing is listed until you review the check and approve it.`;
  $("ct-scope-list").textContent = `Recommended List (${list.length})`;
  $("ct-scope-shown").textContent = `All ${shown.length} shown in the queue${state.search.trim() ? " for this search" : ""}`;
  const pick = list.length ? "list" : "shown";
  document.querySelectorAll("input[name=ctScope]").forEach((input) => { input.checked = input.value === pick; });
  $("ct-error").textContent = "";
  $("ct-result").textContent = "";
  $("ct-check").disabled = shown.length === 0;
  renderCardTraderRows();
  $("ct-dialog").showModal();
}

function chosenCards() {
  const { shown, list } = exportCandidates();
  const scope = document.querySelector("input[name=ctScope]:checked")?.value;
  return scope === "list" ? list : shown;
}

async function checkCardTrader() {
  if (ctExport.busy) return;
  const cards = chosenCards();
  $("ct-error").textContent = "";
  $("ct-result").textContent = "";
  if (cards.length === 0) { $("ct-error").textContent = "No cards to check."; return; }
  if (cards.length > EXPORT_MAX) { $("ct-error").textContent = `That is ${cards.length} cards. Narrow the search to ${EXPORT_MAX} or fewer.`; return; }
  ctExport.busy = true;
  ctExport.rows = [];
  const button = $("ct-check");
  button.disabled = true;
  try {
    for (let offset = 0; offset < cards.length; offset += EXPORT_PAGE) {
      button.textContent = `Checking ${offset}/${cards.length}…`;
      const page = cards.slice(offset, offset + EXPORT_PAGE);
      const { response, data } = await api("/api/export/cardtrader/preview", { method: "POST", body: JSON.stringify({ recordIds: page.map((card) => card.id) }) });
      if (!response.ok) throw new Error(data.error || "Could not check CardTrader.");
      ctExport.canSend = Boolean(data.canSend);
      for (const row of data.rows || []) ctExport.rows.push({ ...row, card: page.find((card) => card.id === row.id), checked: row.ready });
      renderCardTraderRows();
    }
    const ready = ctExport.rows.filter((row) => row.ready).length;
    $("ct-result").textContent = `${ready} of ${ctExport.rows.length} can be listed.${ctExport.canSend ? "" : " Only an organization admin can list them."}`;
  } catch (error) {
    $("ct-error").textContent = error.message || String(error);
  } finally {
    ctExport.busy = false;
    button.disabled = false;
    button.textContent = "Check against CardTrader";
    updateSendButton();
  }
}

function readFinishLabel(value) {
  const text = (value || "").trim();
  if (!text) return "—";
  const lower = text.toLowerCase();
  if (lower === "normal" || lower === "regular") return "Regular";
  return text;
}

function renderCardTraderRows() {
  const money = (value) => (typeof value === "number" ? `$${value.toFixed(2)}` : "—");
  const cell = (text, className) => { const td = document.createElement("td"); td.textContent = text; if (className) td.className = className; return td; };
  $("ct-body").replaceChildren(...ctExport.rows.map((row) => {
    const tr = document.createElement("tr");
    const pick = document.createElement("td");
    if (row.ready && !row.done) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = row.checked;
      box.dataset.id = row.id;
      box.setAttribute("aria-label", `List ${row.name}`);
      pick.append(box);
    }
    const card = row.card || {};
    const label = [card.setIdentifier || card.setNumber, card.collectorNumber, row.name].filter(Boolean).join(" · ");
    tr.append(
      pick,
      cell(label),
      cell(row.ready ? row.cardTraderName : "—"),
      cell(row.ready ? row.condition : card.condition || "—"),
      cell(card.finish ? readFinishLabel(card.finish) : (row.ready ? (row.foil ? "Foil" : "Regular") : "—")),
      cell(String(row.ready ? row.quantity : card.qty ?? "—")),
      cell(money(row.ready ? row.price : card.marketPriceUsd)),
      cell(row.note || (row.ready ? "Ready" : row.reason), row.done === "listed" ? "flash" : row.ready && !row.note ? "" : "warn"),
    );
    return tr;
  }));
  updateSendButton();
}

function selectedRows() {
  const picked = new Set([...document.querySelectorAll("#ct-body input[type=checkbox]:checked")].map((box) => box.dataset.id));
  return ctExport.rows.filter((row) => row.ready && !row.done && picked.has(row.id));
}

function updateSendButton() {
  const rows = selectedRows();
  const total = rows.reduce((sum, row) => sum + row.price * row.quantity, 0);
  const button = $("ct-send");
  button.disabled = ctExport.busy || !ctExport.canSend || rows.length === 0;
  button.textContent = rows.length ? `List ${rows.length} card${rows.length === 1 ? "" : "s"} on CardTrader ($${total.toFixed(2)})` : "List on CardTrader";
}

async function sendCardTrader() {
  const rows = selectedRows();
  if (ctExport.busy || rows.length === 0) return;
  const total = rows.reduce((sum, row) => sum + row.price * row.quantity, 0);
  if (!window.confirm(`Put ${rows.length} card${rows.length === 1 ? "" : "s"} up for sale on CardTrader, $${total.toFixed(2)} in total at the prices shown?`)) return;
  // Remember the choices, so a re-render keeps unticked rows unticked.
  const picked = new Set(rows.map((row) => row.id));
  for (const row of ctExport.rows) row.checked = picked.has(row.id);
  ctExport.busy = true;
  $("ct-error").textContent = "";
  updateSendButton();
  let listed = 0, failed = 0;
  try {
    for (let offset = 0; offset < rows.length; offset += EXPORT_PAGE) {
      $("ct-result").textContent = `Listing ${offset}/${rows.length}…`;
      const page = rows.slice(offset, offset + EXPORT_PAGE);
      const { response, data } = await api("/api/export/cardtrader/send", { method: "POST", body: JSON.stringify({ recordIds: page.map((row) => row.id) }) });
      if (!response.ok) throw new Error(data.error || "Could not list on CardTrader.");
      for (const result of data.results || []) {
        const row = ctExport.rows.find((item) => item.id === result.id);
        if (!row) continue;
        if (result.listed) { listed++; row.done = "listed"; row.note = result.warning || `Listed (${result.listingId})`; }
        else { failed++; row.done = "failed"; row.note = result.reason || "Not listed."; }
      }
      renderCardTraderRows();
    }
    $("ct-result").textContent = `Listed ${listed} card${listed === 1 ? "" : "s"} on CardTrader and moved ${listed === 1 ? "it" : "them"} to Listed${failed ? ` · ${failed} not listed, see the Check column` : ""}.`;
  } catch (error) {
    $("ct-error").textContent = `${error.message || error} Listed ${listed} before stopping.`;
  } finally {
    ctExport.busy = false;
    renderCardTraderRows();
    if (listed) await refreshAll(); // listed cards have moved from Waitlist to Listed
  }
}
