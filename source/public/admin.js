const state = { tenants: [], search: "", pending: null };

const $ = (id) => document.getElementById(id);

const views = {
  boot: $("boot"),
  login: $("login-view"),
  admin: $("admin-view"),
};

document.addEventListener("DOMContentLoaded", () => {
  $("logout").addEventListener("click", signOut);
  $("login-signout").addEventListener("click", signOut);
  $("refresh").addEventListener("click", loadTenants);
  $("search").addEventListener("input", (event) => {
    state.search = event.target.value;
    render();
  });
  $("plan-confirm").addEventListener("click", confirmPlan);
  $("plan-cancel").addEventListener("click", () => $("plan-dialog").close());
  $("tenant-body").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tenant]");
    if (button) openPlan(button.dataset.tenant, button.dataset.plan);
  });
  boot();
});

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
    clerk.mountSignIn($("clerk-mount"), { forceRedirectUrl: "/admin" });
    return;
  }
  $("login-signout").hidden = false;
  if (await loadTenants()) show("admin");
}

function show(name) {
  views.boot.hidden = name !== "boot";
  views.login.hidden = name !== "login";
  views.admin.hidden = name !== "admin";
}

async function loadTenants() {
  $("admin-error").textContent = "";
  const { response, data } = await api("/api/admin/tenants");
  if (response.status === 401) {
    location.reload();
    return false;
  }
  if (response.status === 403) {
    show("login");
    $("login-error").textContent = data.error || "Platform admins only.";
    return false;
  }
  if (!response.ok) {
    show("admin");
    $("admin-error").textContent = data.error || "Could not load accounts.";
    return false;
  }
  state.tenants = data.tenants || [];
  render();
  return true;
}

function render() {
  const query = state.search.trim().toLowerCase();
  const shown = state.tenants.filter((tenant) => !query || `${tenant.name} ${tenant.clerkOrgId}`.toLowerCase().includes(query));
  const pro = state.tenants.filter((tenant) => tenant.plan === "pro").length;
  $("admin-meta").textContent = `${state.tenants.length} account${state.tenants.length === 1 ? "" : "s"} · ${pro} on Pro`;
  const body = $("tenant-body");
  body.replaceChildren(...shown.map(row));
  if (shown.length === 0) {
    const empty = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "hint";
    cell.textContent = state.tenants.length ? "No accounts match that search." : "No accounts yet.";
    empty.append(cell);
    body.append(empty);
  }
}

function row(tenant) {
  const tr = document.createElement("tr");

  const account = document.createElement("td");
  const name = document.createElement("strong");
  name.textContent = tenant.name;
  const org = document.createElement("div");
  org.className = "org-id";
  org.textContent = tenant.clerkOrgId;
  account.append(name, org);

  const plan = document.createElement("td");
  const pill = document.createElement("span");
  pill.className = tenant.plan === "pro" ? "rec rec-list" : "status";
  pill.textContent = tenant.plan === "pro" ? (tenant.planSource === "paid" ? "Pro · paid" : "Pro · comp") : "Free";
  plan.append(pill);

  const changed = document.createElement("td");
  changed.textContent = tenant.planChangedAt ? new Date(tenant.planChangedAt).toLocaleString() : "—";
  if (tenant.planChangedBy) changed.title = `By ${tenant.planChangedBy}`;

  const note = document.createElement("td");
  note.textContent = tenant.planNote || "—";

  const action = document.createElement("td");
  if (tenant.planSource !== "paid") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = tenant.plan === "pro" ? "ghost tiny" : "primary tiny";
    button.dataset.tenant = tenant.id;
    button.dataset.plan = tenant.plan === "pro" ? "free" : "pro";
    button.textContent = tenant.plan === "pro" ? "Remove Pro" : "Grant Pro";
    action.append(button);
  }

  tr.append(account, plan, changed, note, action);
  return tr;
}

function openPlan(tenantId, plan) {
  const tenant = state.tenants.find((item) => item.id === tenantId);
  if (!tenant) return;
  state.pending = { tenant, plan };
  const grant = plan === "pro";
  $("plan-title").textContent = grant ? "Grant complimentary Pro" : "Remove complimentary Pro";
  $("plan-text").textContent = grant
    ? `${tenant.name} gets Pro at no charge until you remove it.`
    : `${tenant.name} goes back to Free straight away.`;
  $("plan-confirm").textContent = grant ? "Grant Pro" : "Remove Pro";
  $("plan-note").value = "";
  $("plan-error").textContent = "";
  $("plan-dialog").showModal();
  $("plan-note").focus();
}

async function confirmPlan() {
  const pending = state.pending;
  if (!pending) return;
  $("plan-confirm").disabled = true;
  const { response, data } = await api(`/api/admin/tenants/${encodeURIComponent(pending.tenant.id)}/plan`, {
    method: "POST",
    body: JSON.stringify({ plan: pending.plan, note: $("plan-note").value }),
  });
  $("plan-confirm").disabled = false;
  if (!response.ok) {
    $("plan-error").textContent = data.error || "Could not change the plan.";
    return;
  }
  state.tenants = state.tenants.map((tenant) => (tenant.id === data.tenant.id ? data.tenant : tenant));
  state.pending = null;
  $("plan-dialog").close();
  $("admin-flash").textContent = `${data.tenant.name} is now on ${data.tenant.plan === "pro" ? "complimentary Pro" : "Free"}.`;
  render();
}
