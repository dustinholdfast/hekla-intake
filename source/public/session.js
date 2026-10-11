// Shared by the intake page and the platform admin page: Clerk loading and the API helper.

let clerkLoading = null;

function loadClerk() {
  clerkLoading ||= startClerk();
  return clerkLoading;
}

async function startClerk() {
  const { data } = await api("/api/config");
  if (!data.clerkPublishableKey || !data.clerkFrontendApi) throw new Error("Sign-in is not configured.");
  const base = `https://${data.clerkFrontendApi}/npm/@clerk`;
  await loadScript(`${base}/ui@1/dist/ui.browser.js`);
  await loadScript(`${base}/clerk-js@6/dist/clerk.browser.js`, data.clerkPublishableKey);
  await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
  return window.Clerk;
}

function loadScript(src, publishableKey) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.crossOrigin = "anonymous";
    if (publishableKey) script.dataset.clerkPublishableKey = publishableKey;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Could not load sign-in."));
    document.head.appendChild(script);
  });
}

async function signOut() {
  await window.Clerk?.signOut();
  location.assign("/");
}

async function api(path, options = {}) {
  const headers = { accept: "application/json" };
  if (options.body) headers["content-type"] = "application/json";
  // The session cookie can go stale in a background tab; getToken() always returns a fresh token.
  const token = await window.Clerk?.session?.getToken().catch(() => null);
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  return { response, data };
}
