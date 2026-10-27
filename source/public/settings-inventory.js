// Inventory settings: buy rates, credit cost, payment fees, flag thresholds.
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { view: null, phase2: true, canManage: true };

  document.addEventListener("DOMContentLoaded", () => {
    $("inv-settings-form").addEventListener("submit", save);
    const wait = setInterval(() => {
      if ($("settings-view").hidden) return;
      clearInterval(wait);
      load();
    }, 50);
  });

  async function load() {
    const { response, data } = await api("/api/inventory/settings");
    if (!response.ok) {
      $("inv-settings-error").textContent = data.error || "Could not load inventory settings.";
      return;
    }
    state.view = data;
    state.phase2 = data.phase2 !== false;
    state.canManage = data.canManage !== false;
    render();
  }

  function render() {
    const data = state.view;
    if (!data) return;
    $("credit-rule").textContent = data.creditCostNote || "";
    $("level-note").textContent = data.tcgplayerLevelNote || "";
    $("offer-example").textContent = data.offerPreview || "";
    const locked = !state.canManage || !state.phase2;
    renderRates(data.grades || [], locked);
    renderFees(data.paymentMethods || [], locked);
    renderThresholds(data.settings?.thresholds || {}, locked);
    $("inv-settings-save").disabled = locked;
    if (!state.phase2) {
      $("inv-settings-error").textContent = "Apply migration 0009 before saving. Nothing was written. These are the approved defaults.";
    } else if (!state.canManage) {
      $("inv-settings-error").textContent = "Only an organization admin can change these.";
    } else if (data.stored === false) {
      $("inv-settings-flash").textContent = "Showing the approved defaults. Save once to store them for this account.";
    }
  }

  function renderRates(grades, locked) {
    const list = $("rate-list");
    list.replaceChildren();
    for (const grade of grades) {
      const row = document.createElement("div");
      row.className = "rate-row";
      const name = document.createElement("div");
      name.className = "grade";
      name.textContent = `${grade.grade} · ${grade.label}`;
      row.append(name);
      if (grade.blocked) {
        const note = document.createElement("p");
        note.className = "hint blocked-note";
        note.textContent = "Not bought. No cash or credit rate, and no typed offer.";
        row.append(note);
      } else {
        row.append(rateInput(grade.grade, "cash", "Cash %", grade.cashPercent, locked));
        row.append(rateInput(grade.grade, "credit", "Credit %", grade.creditPercent, locked));
      }
      list.append(row);
    }
  }

  function rateInput(grade, tender, label, value, locked) {
    const field = document.createElement("label");
    field.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "100";
    input.step = "1";
    input.required = true;
    input.inputMode = "numeric";
    input.dataset.grade = grade;
    input.dataset.tender = tender;
    input.value = value == null ? "" : String(value);
    input.disabled = locked;
    input.setAttribute("aria-label", `${grade} ${label}`);
    field.append(input);
    return field;
  }

  function renderFees(methods, locked) {
    const list = $("fee-list");
    list.replaceChildren();
    for (const method of methods) {
      const row = document.createElement("div");
      row.className = "fee-row";
      const name = document.createElement("div");
      name.className = "grade";
      name.textContent = method.label;
      const field = document.createElement("label");
      field.textContent = "Fee USD";
      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "decimal";
      input.placeholder = "Unknown";
      input.autocomplete = "off";
      input.dataset.fee = method.id;
      input.value = method.feeCents == null ? "" : centsToDollars(method.feeCents);
      input.disabled = locked;
      input.setAttribute("aria-label", `${method.label} fee`);
      field.append(input);
      row.append(name, field);
      list.append(row);
    }
  }

  function renderThresholds(thresholds, locked) {
    const list = $("threshold-list");
    list.replaceChildren();
    const fields = [
      ["lowStockOnHand", "Low stock on hand", "0", "0", "100000", "Want Qty is set and on hand is at or under this."],
      ["overstockSkuLimit", "Overstock per SKU", "3", "0", "100000", "Also flags on hand above Want Qty."],
      ["slowMoverDays", "Slow mover days", "45", "1", "3650", "Days in stock with no sale."],
      ["tcgplayerLevel", "TCGplayer level", "1", "1", "4", "Inert. Used by the overstock rule only when it is 1."],
    ];
    for (const [key, label, fallback, min, max, note] of fields) {
      const row = document.createElement("div");
      row.className = "threshold-row";
      const field = document.createElement("label");
      field.textContent = label;
      const input = document.createElement("input");
      input.type = "number";
      input.min = min;
      input.max = max;
      input.step = "1";
      input.required = true;
      input.dataset.threshold = key;
      input.value = thresholds[key] == null ? fallback : String(thresholds[key]);
      input.disabled = locked;
      input.setAttribute("aria-label", label);
      field.append(input);
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = note;
      row.append(field, hint);
      list.append(row);
    }
  }

  function centsToDollars(cents) {
    const dollars = Math.floor(cents / 100);
    const rest = String(Math.abs(cents % 100)).padStart(2, "0");
    return `${dollars}.${rest}`;
  }

  function dollarsToCents(text, label) {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
    if (!match) return { error: `${label} fee must be blank, 0, or a dollar amount like 0.30.` };
    return Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  }

  function payload() {
    const grades = {};
    for (const grade of state.view?.grades || []) {
      if (grade.blocked) {
        grades[grade.grade] = { cashPercent: null, creditPercent: null, blocked: true };
        continue;
      }
      const cash = document.querySelector(`input[data-grade="${grade.grade}"][data-tender="cash"]`);
      const credit = document.querySelector(`input[data-grade="${grade.grade}"][data-tender="credit"]`);
      grades[grade.grade] = { cashPercent: Number(cash.value), creditPercent: Number(credit.value), blocked: false };
    }
    const paymentFees = {};
    for (const input of document.querySelectorAll("input[data-fee]")) {
      const cents = dollarsToCents(input.value, input.getAttribute("aria-label") || "Payment");
      if (cents && typeof cents === "object") return cents;
      paymentFees[input.dataset.fee] = cents;
    }
    const thresholds = {};
    for (const input of document.querySelectorAll("input[data-threshold]")) {
      thresholds[input.dataset.threshold] = Number(input.value);
    }
    return { buyRates: grades, creditCostRule: "face_value", paymentFees, thresholds };
  }

  async function save(event) {
    event.preventDefault();
    $("inv-settings-error").textContent = "";
    $("inv-settings-flash").textContent = "";
    const form = $("inv-settings-form");
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const body = payload();
    if (body.error) {
      $("inv-settings-error").textContent = body.error;
      return;
    }
    const button = $("inv-settings-save");
    button.disabled = true;
    const { response, data } = await api("/api/inventory/settings", { method: "PUT", body: JSON.stringify(body) });
    button.disabled = false;
    if (!response.ok) {
      $("inv-settings-error").textContent = data.error || "Could not save inventory settings.";
      return;
    }
    state.view = data;
    state.phase2 = true;
    state.canManage = true;
    render();
    const where = document.documentElement.dataset.preview === "1" ? "Saved in this preview only. Neon was not written." : "Saved.";
    $("inv-settings-flash").textContent = where;
  }
})();
