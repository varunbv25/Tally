/* =========================================================
   TALLY — push delivery (closed-app notifications)
   The page projects upcoming notifications (deterministic between
   opens — only interest accrues) and uploads the schedule to a
   self-hosted Cloudflare Worker, which Web-Pushes due entries.
   PUSH_SERVER === '' keeps all of this dormant.
   ========================================================= */

/* config — VAPID_PUBLIC_KEY filled in at deployment */
const PUSH_SERVER = 'https://tally.varunbv2505.workers.dev';
const VAPID_PUBLIC_KEY = '';

const PUSH_HORIZON_DAYS = 90;
const PUSH_STEP_MS = 6 * 3600 * 1000;

let pushStatus = 'idle';           // idle | active | unavailable
let pushUploadTimer = null;

/* Simulate the engine forward on a cloned log. t=now is consumed
   (not scheduled) — the local foreground check owns "now". */
function projectSchedule(st, log, now, horizonDays = PUSH_HORIZON_DAYS) {
  const sim = JSON.parse(JSON.stringify(log || { fired: {}, lastNudge: 0 }));
  evaluateNotifications(st, sim, now);
  const out = [];
  const end = now + horizonDays * DAY_MS;
  for (let t = now + PUSH_STEP_MS; t <= end; t += PUSH_STEP_MS) {
    for (const n of evaluateNotifications(st, sim, t)) out.push({ fireAt: t, ...n });
  }
  return out;
}

/* ---------- browser plumbing (no-ops in tests / when unconfigured) ---------- */

function pushSupported() {
  return !!PUSH_SERVER && !!VAPID_PUBLIC_KEY &&
    'serviceWorker' in navigator && 'PushManager' in window;
}

function pushActive() {
  return pushSupported() && notifSettings(state).enabled && Notification.permission === 'granted';
}

function urlB64ToUint8Array(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function subscribePush() {
  if (!pushActive()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    pushStatus = 'active';
    return sub;
  } catch {
    pushStatus = 'unavailable';
    return null;
  }
}

async function unsubscribePush() {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch(PUSH_SERVER + '/subscribe', {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch { /* push must never break the app */ }
  pushStatus = 'idle';
}

/* Merge keys the server already delivered into the local fired-log.
   Runs before the local check (inside the serialized chain). */
async function pushSyncDown() {
  if (!pushActive()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const res = await fetch(PUSH_SERVER + '/sync', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    if (!res.ok) return;               // 404: next upload re-subscribes
    const { sentKeys, lastNudge } = await res.json();
    const logJson = await idbGet('notifLog');
    const log = logJson ? JSON.parse(logJson) : { fired: {}, lastNudge: 0 };
    const now = Date.now();
    (sentKeys || []).forEach(k => {
      if (!k.startsWith('nudge:')) log.fired[k] = log.fired[k] || now;
    });
    log.lastNudge = Math.max(log.lastNudge || 0, lastNudge || 0);
    await idbSet('notifLog', JSON.stringify(log));
  } catch { /* offline / worker down: local path still works */ }
}

function schedulePushUpload() {
  if (!pushActive()) return;
  clearTimeout(pushUploadTimer);
  pushUploadTimer = setTimeout(pushUpload, 5000);
}

async function pushUpload() {
  if (!pushActive()) return;
  try {
    const sub = await subscribePush();
    if (!sub) return;
    const logJson = await idbGet('notifLog');
    const log = logJson ? JSON.parse(logJson) : { fired: {}, lastNudge: 0 };
    const schedule = projectSchedule(state, log, Date.now());
    await fetch(PUSH_SERVER + '/subscribe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), schedule }),
    });
  } catch { /* retried on next save/open */ }
}
