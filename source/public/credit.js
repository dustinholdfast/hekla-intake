const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  $("logout").addEventListener("click", () => { if (document.documentElement.dataset.preview === "1") return; signOut(); });
  boot();
});

function show(name) {
  $("boot").hidden = name !== "boot";
  $("login-view").hidden = name !== "login";
  $("credit-view").hidden = name !== "credit";
}

function money(cents) {
  return (Number(cents) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

async function boot() {
  if (document.documentElement.dataset.preview === "1") {
    $("tenant-name").textContent = "Fixture ledger";
    $("logout").hidden = true;
    show("credit");
    await load();
    return;
  }
  let clerk;
  try { clerk = await loadClerk(); } catch (error) { show("login"); $("login-error").textContent = error.message || "Could not load sign-in."; return; }
  if (!clerk.user) { show("login"); clerk.mountSignIn($("clerk-mount"), { forceRedirectUrl: "/credit" }); return; }
  const session = await api("/api/session");
  if (!session.response.ok) { show("login"); $("login-error").textContent = session.data.error || "Could not open the ledger."; return; }
  $("tenant-name").textContent = session.data.tenant || "";
  show("credit");
  await load();
}

async function load() {
  $("credit-error").textContent = "";
  const { response, data } = await api("/api/credit");
  if (!response.ok) { $("credit-error").textContent = data.error || "Could not read the ledger."; return; }
  $("outstanding").textContent = money(data.outstandingCents || 0);
  $("outstanding-note").textContent = `${(data.entries || []).length} rows · names, emails, and phones are not stored`;
  const body = $("entries");
  const cards = $("entry-cards");
  body.replaceChildren();
  cards.replaceChildren();
  const entries = data.entries || [];
  if (!entries.length) {
    $("empty-note").textContent = "Nothing issued yet. Credit is written when a store-credit purchase is received, not when the offer is accepted.";
    return;
  }
  $("empty-note").textContent = "";
  for (const entry of entries) {
    const tr = document.createElement("tr");
    const cells = [
      entry.occurredOn,
      entry.customerRef,
      entry.entryKind,
      money(entry.amountCents),
      money(entry.balanceAfterCents),
      `${entry.sourceKind} ${entry.sourceRef}`,
    ];
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }
    body.appendChild(tr);
    const card = document.createElement("article");
    card.className = "line-card";
    const title = document.createElement("h3");
    title.textContent = `${entry.entryKind} · ${money(entry.amountCents)}`;
    const meta = document.createElement("p");
    meta.textContent = `${entry.occurredOn} · balance ${money(entry.balanceAfterCents)}`;
    const ref = document.createElement("p");
    ref.textContent = entry.customerRef;
    const source = document.createElement("p");
    source.textContent = `${entry.sourceKind} ${entry.sourceRef}`;
    card.append(title, meta, ref, source);
    cards.appendChild(card);
  }
}
