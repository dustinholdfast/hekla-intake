const state = { ready: false, canManage: false, cardtrader: { connected: false } };

const $ = (id) => document.getElementById(id);

const views = {
  boot: $("boot"),
  login: $("login-view"),
  settings: $("settings-view"),
};

document.addEventListener("DOMContentLoaded", () => {
  $("logout").addEventListener("click", signOut);
  $("login-signout").addEventListener("click", signOut);
  $("ct-form").addEventListener("submit", connectCardTrader);
  $("ct-disconnect").addEventListener("click", disconnectCardTrader);
  boot();
});

async function boot() {
  if (document.documentElement.dataset.preview === "1") {
    $("tenant-name").textContent = "Fixture ledger";
    $("logout").hidden = true;
    $("connections-panel").hidden = true;
    $("sales-sync-panel").hidden = true;
    show("settings");
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
    clerk.mountSignIn($("clerk-mount"), { forceRedirectUrl: "/settings" });
    return;
  }
  $("login-signout").hidden = false;
  const session = await api("/api/session");
  if (!session.response.ok) {
    // No active organization, or one without a tenant: the intake page handles choosing one.
    show("login");
    $("login-error").textContent = session.data.error || "Could not open settings.";
    return;
  }
  $("tenant-name").textContent = session.data.tenant || "";
  $("platform-tools").hidden = !session.data.platformAdmin;
  const { response, data } = await api("/api/connections");
  show("settings");
  if (!response.ok) {
    $("settings-error").textContent = data.error || "Could not load connections.";
    $("ct-status").textContent = "";
    return;
  }
  Object.assign(state, data);
  render();
}

function show(name) {
  views.boot.hidden = name !== "boot";
  views.login.hidden = name !== "login";
  views.settings.hidden = name !== "settings";
}

function render() {
  const ct = state.cardtrader;
  const status = $("ct-status");
  $("ct-form").hidden = true;
  $("ct-help").hidden = true;
  $("ct-connected").hidden = true;
  if (ct.connected) {
    const id = ct.accountId ? ` (user ${ct.accountId})` : "";
    status.textContent = `Connected as ${ct.accountLabel}${id} since ${new Date(ct.connectedAt).toLocaleDateString()}.`;
    $("ct-connected").hidden = !state.canManage;
    return;
  }
  if (!state.ready) {
    status.textContent = "Connections are not set up on this server yet.";
    return;
  }
  if (!state.canManage) {
    status.textContent = "Not connected. An organization admin can connect CardTrader.";
    return;
  }
  status.textContent = "Not connected.";
  $("ct-form").hidden = false;
  $("ct-help").hidden = false;
}

async function connectCardTrader(event) {
  event.preventDefault();
  const input = $("ct-token");
  const button = $("ct-connect");
  $("settings-error").textContent = "";
  $("settings-flash").textContent = "";
  button.disabled = true;
  button.textContent = "Checking…";
  const { response, data } = await api("/api/connections/cardtrader", { method: "PUT", body: JSON.stringify({ token: input.value }) });
  button.disabled = false;
  button.textContent = "Connect";
  input.value = "";
  if (!response.ok) {
    $("settings-error").textContent = data.error || "Could not connect CardTrader.";
    return;
  }
  state.cardtrader = data.cardtrader;
  $("settings-flash").textContent = "CardTrader connected.";
  render();
}

async function disconnectCardTrader() {
  if (!window.confirm("Disconnect CardTrader? Hekla will forget the token. Nothing on CardTrader changes.")) return;
  $("settings-error").textContent = "";
  $("settings-flash").textContent = "";
  const { response, data } = await api("/api/connections/cardtrader", { method: "DELETE" });
  if (!response.ok) {
    $("settings-error").textContent = data.error || "Could not disconnect CardTrader.";
    return;
  }
  state.cardtrader = data.cardtrader;
  $("settings-flash").textContent = "CardTrader disconnected.";
  render();
}
