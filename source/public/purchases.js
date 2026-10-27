const $ = (id) => document.getElementById(id);
const state = { draft: null, savedTwice: false };

document.addEventListener("DOMContentLoaded", () => {
  $("logout").addEventListener("click", () => { if (document.documentElement.dataset.preview === "1") return; signOut(); });
  $("login-signout").addEventListener("click", signOut);
  $("save").addEventListener("click", save);
  $("receive-btn").addEventListener("click", receive);
  boot();
});

function show(name) {
  $("boot").hidden = name !== "boot";
  $("login-view").hidden = name !== "login";
  $("purchase-view").hidden = name !== "purchase";
}

function money(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return "—";
  return (Number(cents) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function srId() {
  return new URLSearchParams(location.search).get("sr") || "";
}

async function boot() {
  if (document.documentElement.dataset.preview === "1") {
    $("tenant-name").textContent = "Fixture ledger";
    $("logout").hidden = true;
    show("purchase");
    await load();
    return;
  }
  let clerk;
  try { clerk = await loadClerk(); } catch (error) { show("login"); $("login-error").textContent = error.message || "Could not load sign-in."; return; }
  if (!clerk.user) { show("login"); clerk.mountSignIn($("clerk-mount"), { forceRedirectUrl: location.pathname + location.search }); return; }
  $("login-signout").hidden = false;
  const session = await api("/api/session");
  if (!session.response.ok) { show("login"); $("login-error").textContent = session.data.error || "Could not open this purchase."; return; }
  $("tenant-name").textContent = session.data.tenant || "";
  show("purchase");
  await load();
}

async function load() {
  $("purchase-error").textContent = "";
  const id = srId();
  if (!id) {
    $("purchase-error").textContent = "Add the sell request id, for example /purchases/new?sr=rec…";
    return;
  }
  const { response, data } = await api(`/api/purchases/draft?sr=${encodeURIComponent(id)}`);
  if (!response.ok) { $("purchase-error").textContent = data.error || "Could not open that sell request."; return; }
  state.draft = data;
  render();
}

function linesOf(data) {
  return data.purchase?.lines || data.preview?.lines || data.lines || [];
}

function render() {
  const data = state.draft;
  const request = data.request;
  const lines = linesOf(data);
  $("sr-ref").textContent = request.ref || "—";
  const payment = request.paymentType === "store_credit" || request.payout === "Store Credit" ? "Store credit" : "Cash";
  $("sr-meta").textContent = `${request.game || "Cards"} · payout ${request.payout} · seller contact stays in Airtable, not shown here`;
  $("pay-type").value = payment;
  $("offer").value = money(request.offerCents);
  const rates = [...new Set(lines.map((line) => line.ratePercent).filter((rate) => rate != null))];
  $("rate").value = rates.length ? rates.map((rate) => `${rate}%`).join(" · ") + (payment === "Store credit" ? " credit" : " cash") : "—";
  const purchase = data.purchase;
  $("sr-status").textContent = purchase ? statusLabel(purchase.status) : "Accepted · not saved";
  $("lines").replaceChildren();
  $("line-cards").replaceChildren();
  for (const line of lines) {
    $("lines").appendChild(renderLine(line));
    $("line-cards").appendChild(renderCard(line));
  }
  const offerSum = lines.reduce((sum, line) => sum + (line.offerCents || 0), 0);
  const cash = lines.reduce((sum, line) => sum + (line.cashCents || 0), 0);
  const credit = lines.reduce((sum, line) => sum + (line.creditCents || 0), 0);
  $("totals").textContent = lines.some((line) => line.offerCents != null)
    ? `Cash paid ${money(cash)} · Store credit ${money(credit)} · Split ${lines.map((line) => money(line.offerCents)).join(" + ")} = ${money(offerSum)}`
    : "";
  $("split-note").textContent = data.error
    ? data.error
    : "The offer is split by each line's market ref at offer time. A line with no market ref blocks the save. MP, HP, and DMG are not bought.";
  $("save").disabled = Boolean(data.error) || (purchase && purchase.status !== "accepted");
  $("save").textContent = purchase ? "Save again" : "Save as accepted";
  renderReceive(lines, purchase);
}

function statusLabel(status) {
  if (status === "received") return "Received";
  if (status === "partial") return "Partly received";
  if (status === "cancelled") return "Returned";
  return "Accepted · not received";
}

function renderLine(line) {
  const tr = document.createElement("tr");
  const want = line.wantQty == null ? "blank → not tracked" : line.wantAfter != null ? `${line.wantQty} → ${line.wantAfter}${line.wantStatusAfter === "Filled" ? " · Filled" : ""}` : String(line.wantQty);
  const over = line.overstockQty ? ` +${line.overstockQty} overstock` : "";
  const cells = [
    String(line.lineNo),
    line.item || line.raw,
    line.buyListId ? (line.buyListStatus || "Matched") : "no row",
    line.finish || "—",
    line.receivedCondition || line.condition || "—",
    line.qty ? String(line.qty) : "—",
    line.marketRefCents == null ? "needed" : `${money(line.marketRefCents)}`,
    line.ratePercent == null ? "—" : `${line.ratePercent}%`,
    line.offerCents == null ? "—" : money(line.offerCents),
    line.unitCostCents == null ? "—" : money(line.unitCostCents),
    want + over,
    line.status === "rejected" ? "returned" : line.onHand == null ? "new row" : String(line.onHand),
  ];
  for (const value of cells) {
    const td = document.createElement("td");
    td.textContent = value;
    tr.appendChild(td);
  }
  if (line.marketRefSource) tr.lastChild.title = line.marketRefSource;
  return tr;
}

function renderCard(line) {
  const article = document.createElement("article");
  article.className = "line-card";
  const title = document.createElement("h3");
  title.textContent = `${line.lineNo}. ${line.item || line.raw}`;
  const meta = document.createElement("p");
  const want = line.wantQty == null ? "Want Qty blank" : line.wantAfter != null ? `Want ${line.wantQty} → ${line.wantAfter}${line.wantStatusAfter === "Filled" ? " · Filled" : ""}` : `Want ${line.wantQty}`;
  const over = line.overstockQty ? ` · +${line.overstockQty} overstock` : "";
  const hand = line.status === "rejected" ? "returned" : line.onHand == null ? "new row" : `${line.onHand} in hand`;
  meta.textContent = `${line.buyListId ? (line.buyListLabel || line.buyListStatus || "Matched") : "No buy-list row"} · ${line.finish || "—"} · ${line.receivedCondition || line.condition || "—"} · qty ${line.qty || "—"}`;
  const amounts = document.createElement("p");
  amounts.textContent = `Market ${line.marketRefCents == null ? "needed" : money(line.marketRefCents)} · ${line.ratePercent == null ? "—" : `${line.ratePercent}%`} · offer ${line.offerCents == null ? "—" : money(line.offerCents)} · ${money(line.unitCostCents)}/unit`;
  const foot = document.createElement("p");
  foot.textContent = `${want}${over} · ${hand}`;
  article.append(title, meta, amounts, foot);
  return article;
}

function renderReceive(lines, purchase) {
  const host = $("receive-lines");
  host.replaceChildren();
  const ready = Boolean(purchase);
  $("receive-btn").disabled = !ready || purchase.status !== "accepted";
  $("receive-note").textContent = ready
    ? "Confirm the condition in hand. A worse grade is returned: no stock, no Want Qty change, no new offer, no store credit."
    : "Save the accepted offer first. Saving does not change stock or Want Qty.";
  if (!ready) return;
  for (const line of lines) {
    if (line.status !== "accepted") {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = `Line ${line.lineNo} · ${line.item} · ${line.status}${line.receivedCondition ? " · " + line.receivedCondition : ""}`;
      host.appendChild(p);
      continue;
    }
    const label = document.createElement("label");
    label.className = "receive-line";
    const name = document.createElement("span");
    name.textContent = `${line.lineNo}. ${line.item} · offered ${line.condition}`;
    const select = document.createElement("select");
    select.dataset.lineNo = String(line.lineNo);
    select.setAttribute("aria-label", `Condition in hand for line ${line.lineNo}`);
    for (const grade of ["NM", "LP", "MP", "HP", "DMG"]) {
      const option = document.createElement("option");
      option.value = grade;
      option.textContent = grade;
      if (grade === line.condition) option.selected = true;
      select.appendChild(option);
    }
    label.appendChild(name);
    label.appendChild(select);
    host.appendChild(label);
  }
}

async function save() {
  $("purchase-error").textContent = "";
  const { response, data } = await api("/api/purchases", { method: "POST", body: JSON.stringify({ sellRequestId: srId() }) });
  if (!response.ok) { $("purchase-error").textContent = data.error || "Could not save."; return; }
  state.savedTwice = Boolean(state.draft?.purchase);
  $("purchase-note").textContent = data.created
    ? "Saved. One purchase. Stock and Want Qty are unchanged."
    : "Saved again. Still one purchase. Stock and Want Qty are unchanged.";
  await load();
}

async function receive() {
  $("purchase-error").textContent = "";
  const lines = [...document.querySelectorAll("#receive-lines select")].map((select) => ({
    lineNo: Number(select.dataset.lineNo),
    condition: select.value,
  }));
  const { response, data } = await api("/api/purchases/receive", {
    method: "POST",
    body: JSON.stringify({ sellRequestId: srId(), receivedOn: $("received-on").value, lines }),
  });
  if (!response.ok) { $("purchase-error").textContent = data.error || "Could not receive."; return; }
  const moved = data.movementsInserted ?? 0;
  const credited = data.creditsInserted ?? 0;
  const returned = (data.purchase?.lines || []).filter((line) => line.status === "rejected").length;
  $("receive-result").textContent = moved === 0 && credited === 0
    ? "Already received. No second movement and no second credit row."
    : `Received. ${moved} movement${moved === 1 ? "" : "s"}, ${credited} store-credit row${credited === 1 ? "" : "s"}.${returned ? " A worse line was returned and did not change stock." : ""}`;
  await load();
}
