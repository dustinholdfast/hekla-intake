// Settings: the sales-sync connections (CardTrader webhook, starfoil.store secret, alert email).
(() => {
  const $ = (id) => document.getElementById(id);
  const sync = { canManage: false };
  const note = (text, error) => { $("sync-error").textContent = error ? text : ""; $("sync-flash").textContent = error ? "" : text; };
  const since = (s) => new Date(s.connectedAt).toLocaleDateString();

  document.addEventListener("DOMContentLoaded", () => {
    if (document.documentElement.dataset.preview === "1") return;
    $("wh-check").addEventListener("click", checkWebhook);
    $("wh-enable").addEventListener("click", () => enableWebhook(null));
    $("wh-disable").addEventListener("click", disableWebhook);
    $("sf-create").addEventListener("click", createStarfoil);
    $("sf-delete").addEventListener("click", deleteStarfoil);
    $("rs-form").addEventListener("submit", saveResend);
    $("rs-test").addEventListener("click", testResend);
    $("rs-delete").addEventListener("click", deleteResend);
    // settings.js signs in first; wait for its view to show.
    const wait = setInterval(() => { if (!$("settings-view").hidden) { clearInterval(wait); load(); } }, 200);
  });

  async function load() {
    const { response, data } = await api("/api/connections/sales");
    if (!response.ok) { note(data.error || "Could not load sales sync.", true); ["wh-status", "sf-status", "rs-status"].forEach((id) => { $(id).textContent = ""; }); return; }
    Object.assign(sync, data);
    render();
  }

  function render() {
    const m = sync.modes;
    $("sync-modes").textContent = `Now: CardTrader sales ${m.salesMode}${m.decrementFrom ? ` (Hekla lowers Qty from ${new Date(m.decrementFrom).toLocaleString()})` : ""}, stock check ${m.reconcileMode}, daily TCGplayer email ${m.dailyEmail ? "on" : "off"}. These are server settings.`;
    const wh = sync.cardtraderWebhook;
    $("wh-status").textContent = wh.connected ? `On since ${since(wh)}: CardTrader sends orders to ${wh.accountLabel}.` : "Off.";
    $("wh-actions").hidden = !sync.canManage;
    $("wh-enable").hidden = wh.connected; $("wh-disable").hidden = !wh.connected;
    const sf = sync.starfoil;
    $("sf-status").textContent = sf.connected ? `Secret created ${since(sf)}. Address: ${sync.starfoilUrl}` : "Not set up.";
    $("sf-actions").hidden = !sync.canManage;
    $("sf-create").textContent = sf.connected ? "Replace secret" : "Create secret"; $("sf-delete").hidden = !sf.connected;
    const rs = sync.resend;
    $("rs-status").textContent = rs.connected ? `Alerts go to ${rs.to} from ${rs.from}.` : sync.canManage ? "Not set up. Alerts are only logged and shown on the Sales page." : "Not set up. An organization admin can add it.";
    $("rs-form").hidden = !sync.canManage || rs.connected; $("rs-connected").hidden = !sync.canManage || !rs.connected;
  }

  async function checkWebhook() {
    const { response, data } = await api("/api/connections/cardtrader-webhook");
    if (!response.ok) return note(data.error || "Could not ask CardTrader.", true);
    note(data.currentUrl ? (data.pointsAtHekla ? "CardTrader already sends webhooks to Hekla." : `CardTrader currently sends webhooks to ${data.currentUrl}.`) : "CardTrader has no webhook address set.");
  }

  async function enableWebhook(replace) {
    const { response, data } = await api("/api/connections/cardtrader-webhook", { method: "POST", body: JSON.stringify(replace ? { replace } : {}) });
    if (response.status === 409 && data.code === "webhook_in_use") {
      if (window.confirm(`CardTrader already sends webhooks to:\n${data.currentUrl}\n\nReplace it with Hekla? That address will stop getting CardTrader events.`)) return enableWebhook(data.currentUrl);
      return note("Left the existing webhook alone. Hekla still checks orders every 5 minutes.");
    }
    if (!response.ok) return note(data.error || "Could not turn on webhooks.", true);
    sync.cardtraderWebhook = data.cardtraderWebhook;
    note(data.previousUrl ? `Webhooks now go to Hekla (was ${data.previousUrl}).` : "Webhooks now go to Hekla.");
    render();
  }

  async function disableWebhook() {
    if (!window.confirm("Stop CardTrader webhooks to Hekla? Orders are still checked every 5 minutes.")) return;
    const { response, data } = await api("/api/connections/cardtrader-webhook", { method: "DELETE" });
    if (!response.ok) return note(data.error || "Could not turn off webhooks.", true);
    sync.cardtraderWebhook = data.cardtraderWebhook;
    note(data.cleared ? "Webhooks off; CardTrader's webhook address was cleared." : "Webhooks off.");
    render();
  }

  async function createStarfoil() {
    if (sync.starfoil.connected && !window.confirm("Replace the secret? starfoil-lgs stops being accepted until you give it the new one.")) return;
    const { response, data } = await api("/api/connections/starfoil", { method: "POST" });
    if (!response.ok) return note(data.error || "Could not create a secret.", true);
    sync.starfoil = data.starfoil;
    $("sf-url").value = data.url; $("sf-secret").value = data.secret; $("sf-once").hidden = false;
    note("Secret created. Copy it into starfoil-lgs now.");
    render();
  }

  async function deleteStarfoil() {
    if (!window.confirm("Remove the secret? Hekla stops accepting starfoil.store sales until a new one is set.")) return;
    const { response, data } = await api("/api/connections/starfoil", { method: "DELETE" });
    if (!response.ok) return note(data.error || "Could not remove it.", true);
    sync.starfoil = data.starfoil; $("sf-once").hidden = true; note("Removed."); render();
  }

  async function saveResend(event) {
    event.preventDefault();
    const body = { token: $("rs-token").value, to: $("rs-to").value, from: $("rs-from").value };
    const { response, data } = await api("/api/connections/resend", { method: "PUT", body: JSON.stringify(body) });
    $("rs-token").value = "";
    if (!response.ok) return note(data.error || "Could not save.", true);
    sync.resend = data.resend; note("Alert email saved."); render();
  }

  async function testResend() {
    const { response, data } = await api("/api/connections/resend/test", { method: "POST" });
    note(response.ok ? "Test sent." : data.error || "Could not send.", !response.ok);
  }

  async function deleteResend() {
    if (!window.confirm("Remove alert email? Alerts will only be logged.")) return;
    const { response, data } = await api("/api/connections/resend", { method: "DELETE" });
    if (!response.ok) return note(data.error || "Could not remove it.", true);
    sync.resend = data.resend; note("Removed."); render();
  }
})();
