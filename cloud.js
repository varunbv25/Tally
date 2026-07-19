/* =========================================================
   TALLY — opt-in cloud sync (Google + email accounts)
   Local-first: localStorage stays the source of truth. When the user
   signs in (with Google, or a 6-digit code emailed by the Worker), the whole
   ledger blob is mirrored to the cloud so it can be pulled onto another device.
   Both methods key the account by email, so they resolve to one ledger.

   Reconciliation is deliberately simple — whole-blob last-write-wins by
   timestamp. Tally's data is single-user, so the only "conflict" is the
   same person editing two devices while offline; the most recently saved
   device wins. That's predictable and good enough for a personal ledger.

   SYNC_SERVER === '' (or no account) keeps every path below dormant, so
   the app behaves exactly as it always has: nothing leaves the browser.
   Phone sign-in is intentionally not offered — it needs a paid SMS gateway.
   ========================================================= */

/* Reuse the same Worker that serves push. Empty string disables sync. */
const SYNC_SERVER = (typeof PUSH_SERVER === "string" && PUSH_SERVER) || "";

/* Google sign-in (optional, primary auth). Paste your OAuth 2.0 Web client ID
   from the Google Cloud Console here to light up the "Sign in with Google"
   button; the same id must be set as GOOGLE_CLIENT_ID on the Worker so it can
   verify the returned token. Empty string keeps Google sign-in hidden and the
   email one-time-code flow remains the only way in. */
const GOOGLE_CLIENT_ID =
  "140092707856-26nje1kdhnkstr0ko8kqjeseee1b47i9.apps.googleusercontent.com";

const CLOUD_AUTH_KEY = "tally-cloud"; // { token, email }
const CLOUD_UPDATED_KEY = "tally-cloud-updated"; // local ledger version (ms)
const CLOUD_PROMPT_KEY = "tally-cloud-prompt"; // '1' once we've offered sync to a first-time user
const CLOUD_TIMEOUT_MS = 8000; // give up on a slow request and fall back to local data
const CLOUD_AUTH_TIMEOUT_MS = 20000; // sign-in code requests also send an email server-side, so allow longer

/* UI-facing state machine, read by cloudSyncPanel() in app.js. */
let cloudAuth = {
  status: "idle", // 'idle' | 'code-sent' | 'signed-in'
  email: "",
  token: "",
  busy: false,
  error: "",
  lastSync: 0,
  offline: false,
};

let cloudApplying = false; // true while we write a pulled blob (suppresses re-upload)
let cloudPushTimer = null;

function cloudConfigured() {
  return !!SYNC_SERVER;
}
function cloudSignedIn() {
  return cloudAuth.status === "signed-in" && !!cloudAuth.token;
}

/* Google sign-in is available only when both the cloud is configured and a
   client id has been pasted in above. */
function googleConfigured() {
  return cloudConfigured() && !!GOOGLE_CLIENT_ID;
}

/* ---------- Google sign-in ---------- */

let gisLoading = null; // promise for the one-time GIS script load
let gisInited = false; // google.accounts.id.initialize() called once

/* Lazily inject Google's Identity Services library. No-ops (and never adds a
   third-party script) on deployments that haven't set GOOGLE_CLIENT_ID. */
function loadGsi() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisLoading = null;
      reject(new Error("Could not load Google sign-in"));
    };
    document.head.appendChild(s);
  });
  return gisLoading;
}

/* Render Google's official button into the Account view's placeholder. Called
   from app.js render() after each paint, since the container is recreated on
   every re-render. */
function cloudMountGoogleButton() {
  if (!googleConfigured() || cloudSignedIn()) return;
  const host = document.getElementById("google-signin-btn");
  if (!host || host.dataset.rendered === "1") return;
  loadGsi()
    .then(() => {
      if (!gisInited) {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (resp) => cloudGoogleSignIn(resp && resp.credential),
        });
        gisInited = true;
      }
      const el = document.getElementById("google-signin-btn");
      if (!el || el.dataset.rendered === "1") return;
      el.dataset.rendered = "1";
      // Fill the container so the button reads as a real full-width button
      // (GSI caps width at 400px — plenty for the mobile card).
      const width = Math.min(400, Math.round(el.clientWidth)) || undefined;
      window.google.accounts.id.renderButton(el, {
        type: "standard",
        theme: "outline",
        size: "large",
        text: "signin_with",
        shape: "pill",
        logo_alignment: "left",
        width,
      });
    })
    .catch((err) => {
      cloudAuth.error = err.message;
      if (typeof render === "function") render();
    });
}

/* Exchange the Google ID token (credential JWT) for our own bearer token.
   The Worker verifies it and keys the account by email — so the same address
   maps to one ledger whether you came in via Google or the email code. */
async function cloudGoogleSignIn(credential) {
  if (!credential || !cloudConfigured() || cloudAuth.busy) return;
  cloudAuth.busy = true;
  cloudAuth.error = "";
  if (typeof render === "function") render();
  try {
    const { token, email } = await cloudFetch("/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential }),
    });
    cloudAuth.token = token;
    cloudAuth.email = email;
    cloudAuth.status = "signed-in";
    saveCloudSession();
    if (typeof showToast === "function") showToast("Signed in — syncing…");
    await cloudReconcile();
  } catch (err) {
    cloudAuth.error = err.message;
  } finally {
    cloudAuth.busy = false;
    if (typeof render === "function") render();
  }
}

/* The connection is considered down when the browser reports offline OR a sync
   request just failed/timed out (weak signal). The app always keeps rendering
   the locally-stored ledger; this only drives the status indicator + retries. */
function setCloudOffline(off) {
  if (cloudAuth.offline === off) return;
  cloudAuth.offline = off;
  if (typeof updateConnectivity === "function") updateConnectivity();
}

function cloudLocalUpdated() {
  return Number(localStorage.getItem(CLOUD_UPDATED_KEY) || 0);
}
function setCloudLocalUpdated(ms) {
  localStorage.setItem(CLOUD_UPDATED_KEY, String(ms));
}

/* First-run onboarding: offer cloud sync once, then never nag again. The flag is
   set whether the user accepts or declines — returning visitors just find the
   panel waiting in Settings. */
function cloudPromptSeen() {
  return localStorage.getItem(CLOUD_PROMPT_KEY) === "1";
}
function markCloudPromptSeen() {
  localStorage.setItem(CLOUD_PROMPT_KEY, "1");
}

/* Show the one-time "sync across devices?" popup only when sync is actually
   available, the user isn't already signed in, and we've never offered before. */
function cloudShouldPrompt() {
  return cloudConfigured() && !cloudSignedIn() && !cloudPromptSeen();
}

/* ---------- persistence of the session ---------- */

function loadCloudSession() {
  try {
    const raw = localStorage.getItem(CLOUD_AUTH_KEY);
    if (!raw) return;
    const { token, email } = JSON.parse(raw);
    if (token && email) {
      cloudAuth.token = token;
      cloudAuth.email = email;
      cloudAuth.status = "signed-in";
    }
  } catch {
    /* corrupt session — stay signed out */
  }
}

function saveCloudSession() {
  localStorage.setItem(
    CLOUD_AUTH_KEY,
    JSON.stringify({ token: cloudAuth.token, email: cloudAuth.email }),
  );
}

function clearCloudSession() {
  localStorage.removeItem(CLOUD_AUTH_KEY);
  localStorage.removeItem(CLOUD_UPDATED_KEY);
}

/* ---------- network ---------- */

async function cloudFetch(path, opts = {}) {
  const { timeout = CLOUD_TIMEOUT_MS, ...fetchOpts } = opts;
  const headers = {
    "content-type": "application/json",
    ...(fetchOpts.headers || {}),
  };
  if (cloudAuth.token) headers.authorization = `Bearer ${cloudAuth.token}`;

  /* Time-box every call: a weak connection should fail fast and fall back to
     the local copy, never hang the UI on a spinner. */
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(SYNC_SERVER + path, {
      ...fetchOpts,
      headers,
      signal: ctrl.signal,
    });
  } catch (err) {
    /* Don't conflate "this device is offline" with "the request was slow or the
       server hiccuped". navigator.onLine is the only signal the browser gives
       us; when it says we're online, calling it a missing connection is just
       wrong and confusing — surface a timeout/server message instead, and don't
       flip the offline indicator. */
    const reallyOffline =
      typeof navigator !== "undefined" && navigator.onLine === false;
    setCloudOffline(reallyOffline);
    if (reallyOffline)
      throw new Error("No connection — showing the copy saved on this device");
    if (err && err.name === "AbortError")
      throw new Error("The server took too long to respond — please try again");
    throw new Error("Couldn’t reach the sync server — please try again");
  } finally {
    clearTimeout(timer);
  }
  setCloudOffline(false); // we reached the server

  if (res.status === 401 && cloudSignedIn()) {
    // token rejected / expired — drop back to signed-out so the user re-auths
    doCloudSignOut(true);
    throw new Error("Session expired — sign in again");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

/* ---------- auth flow ---------- */

async function cloudRequestCode(email) {
  if (!cloudConfigured() || cloudAuth.busy) return;
  cloudAuth.busy = true;
  cloudAuth.error = "";
  if (typeof render === "function") render();
  try {
    await cloudFetch("/auth/start", {
      method: "POST",
      body: JSON.stringify({ email }),
      timeout: CLOUD_AUTH_TIMEOUT_MS,
    });
    cloudAuth.email = email;
    cloudAuth.status = "code-sent";
  } catch (err) {
    cloudAuth.error = err.message;
  } finally {
    cloudAuth.busy = false;
    if (typeof render === "function") render();
  }
}

async function cloudVerifyCode(code) {
  if (!cloudConfigured() || cloudAuth.busy) return;
  cloudAuth.busy = true;
  cloudAuth.error = "";
  if (typeof render === "function") render();
  try {
    const { token, email } = await cloudFetch("/auth/verify", {
      method: "POST",
      body: JSON.stringify({ email: cloudAuth.email, code }),
    });
    cloudAuth.token = token;
    cloudAuth.email = email;
    cloudAuth.status = "signed-in";
    saveCloudSession();
    if (typeof showToast === "function") showToast("Signed in — syncing…");
    await cloudReconcile();
  } catch (err) {
    cloudAuth.error = err.message;
  } finally {
    cloudAuth.busy = false;
    if (typeof render === "function") render();
  }
}

function doCloudSignOut(silent) {
  cloudAuth = {
    status: "idle",
    email: "",
    token: "",
    busy: false,
    error: "",
    lastSync: 0,
    offline: false,
  };
  clearCloudSession();
  if (!silent && typeof showToast === "function")
    showToast("Signed out — your ledger stays on this device");
  if (typeof render === "function") render();
}

function cloudResetToEmail() {
  cloudAuth.status = "idle";
  cloudAuth.error = "";
  if (typeof render === "function") render();
}

/* ---------- sync ---------- */

/* Replace the whole local ledger with a blob pulled from the cloud,
   without bouncing it straight back up. */
function applyCloudState(newState, updatedAt) {
  cloudApplying = true;
  try {
    /* Hydrate through the exact same path as boot rather than assigning the
       blob straight onto `state`. loadState() merges over defaultState(), so a
       ledger pushed by a device on an older app version (missing `scheduled`,
       `interestRules`, a newer `settings` key…) still lands complete. Assigning
       raw left those keys undefined, which is what broke interest/derived
       totals on the pulling device. */
    localStorage.setItem(LS_KEY, JSON.stringify(newState));
    loadState(); // normalizes + repoints `state`
    recordDeviceTimezone(); // the blob's tz history came from the other device
    saveState(); // mirror the normalized copy to localStorage + the SW's IDB
    setCloudLocalUpdated(updatedAt);
  } finally {
    cloudApplying = false;
  }
}

async function cloudReconcile() {
  if (!cloudSignedIn()) return "idle";
  const remote = await cloudFetch("/ledger", { method: "GET" });
  const localUpdated = cloudLocalUpdated();
  if (remote && remote.state != null && remote.updatedAt > localUpdated) {
    applyCloudState(remote.state, remote.updatedAt);
    cloudAuth.lastSync = Date.now();
    if (typeof render === "function") render();
    return "pulled";
  }
  if (remote && remote.state != null && remote.updatedAt === localUpdated) {
    cloudAuth.lastSync = Date.now();
    return "in-sync";
  }
  await cloudPush(); // local is newer, or the cloud is empty
  return "pushed";
}

async function cloudPush() {
  if (!cloudSignedIn()) return;
  // Don't bother attempting a doomed upload while offline — the edit is safe in
  // localStorage and cloudOnReconnect() will push it once we're back online.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    setCloudOffline(true);
    return;
  }
  const json = localStorage.getItem(LS_KEY);
  if (!json) return;
  const updatedAt = cloudLocalUpdated() || Date.now();
  await cloudFetch("/ledger", {
    method: "PUT",
    body: JSON.stringify({ state: JSON.parse(json), updatedAt }),
  });
  setCloudLocalUpdated(updatedAt);
  cloudAuth.lastSync = Date.now();
}

/* Manual "Sync now" button. */
async function cloudSyncNow() {
  if (!cloudSignedIn() || cloudAuth.busy) return;
  cloudAuth.busy = true;
  cloudAuth.error = "";
  if (typeof render === "function") render();
  try {
    const result = await cloudReconcile();
    if (typeof showToast === "function") {
      showToast(
        result === "pulled"
          ? "Pulled the latest from the cloud"
          : result === "pushed"
            ? "Uploaded this device’s ledger"
            : "Already up to date",
      );
    }
  } catch (err) {
    cloudAuth.error = err.message;
  } finally {
    cloudAuth.busy = false;
    if (typeof render === "function") render();
  }
}

/* Called from store.js saveState() on every local change. Bumps the local
   version and debounces an upload. No-ops unless signed in. */
function cloudOnSave() {
  if (cloudApplying || !cloudSignedIn()) return;
  setCloudLocalUpdated(Date.now());
  clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => {
    cloudPush().catch(() => {});
  }, 3000);
}

/* ---------- boot ---------- */

function cloudInit() {
  if (!cloudConfigured()) return;
  loadCloudSession();
  if (cloudSignedIn()) {
    // pull anything newer that another device may have pushed while we were away
    cloudReconcile().catch(() => {});
  }
  /* Installed as a PWA, the other device is usually resumed from the background
     rather than reloaded — no boot, no 'online' event — so without this it would
     sit on a stale ledger until the user hit "Sync now". Reconciling whenever the
     app comes back to the foreground is what makes two devices agree in practice.
     ponytail: foreground-triggered, not a live socket. If two devices ever need
     to agree while BOTH are on screen, add a poll or SSE here. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") cloudOnForeground();
  });
  window.addEventListener("pageshow", cloudOnForeground);
}

/* Pull on resume, throttled so a burst of focus/visibility events (they fire
   together on some browsers) costs one request. */
let cloudLastForeground = 0;
const CLOUD_FOREGROUND_MIN_MS = 5000;

function cloudOnForeground() {
  if (!cloudSignedIn() || cloudAuth.busy) return;
  const now = Date.now();
  if (now - cloudLastForeground < CLOUD_FOREGROUND_MIN_MS) return;
  cloudLastForeground = now;
  cloudReconcile().catch(() => {});
}

/* Called by app.js when the browser fires 'online'. Clears the offline flag and,
   if signed in, reconciles (which pushes any edits made while we were offline). */
function cloudOnReconnect() {
  setCloudOffline(false);
  if (cloudSignedIn()) cloudReconcile().catch(() => {});
}
