/* Tally service worker — precache the app shell, serve cache-first,
   runtime-cache everything else (fonts) so the app works fully offline. */

importScripts('./store.js', './notif.js');

const CACHE = 'tally-v32';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './store.js',
  './notif.js',
  './push.js',
  './cloud.js',
  './components/icons.js',
  './components/money.js',
  './components/chip.js',
  './components/person-name.js',
  './components/currency-select.js',
  './components/row-actions.js',
  './components/toast.js',
  './components/select-bar.js',
  './components/confirm-overlay.js',
  './components/quick-add.js',
  './components/share-button.js',
  './components/modal.js',
  './components/panel.js',
  './components/back-link.js',
  './components/empty-state.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // Fetch every shell file with cache:'reload' so the precache is filled
      // straight from the network, never from the browser's HTTP cache — that
      // is what stops a stale styles.css/app.js from being baked into a new
      // cache version.
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* How long to wait for the network before falling back to the cached shell.
   Keeps a slow-but-connected network from leaving the user on a blank screen:
   we still prefer a fresh response, but never block the first paint for longer
   than this. */
const NET_TIMEOUT_MS = 2000;

/* Network-first, but time-boxed. Race the network against NET_TIMEOUT_MS:
   - network wins  -> serve it (and it has already refreshed the cache)
   - timer wins     -> serve the cached copy now; the in-flight network request
                       still updates the cache in the background for next time
   - network fails  -> serve the cached copy (offline)
   With no cached copy yet (first visit) we simply wait for the network and fall
   back to the app shell so deep links still resolve offline. */
async function networkFirstWithTimeout(request) {
  const cache = await caches.open(CACHE);

  // Never rejects: resolves to the response (refreshing the cache on the way)
  // or to null if the network is down. Keeps running even after we've already
  // answered from cache, so a slow response still warms the cache.
  const network = fetch(request)
    .then(res => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);

  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) {
    const winner = await Promise.race([
      network,
      new Promise(resolve => setTimeout(() => resolve(null), NET_TIMEOUT_MS)),
    ]);
    return winner || cached;
  }

  return (await network)
    || (await cache.match('./index.html'))
    || Response.error();
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const sameOrigin = new URL(e.request.url).origin === self.location.origin;

  if (sameOrigin) {
    /* network-first for app files so users get updates immediately when online,
       but time-boxed so a slow network falls back to the cached shell fast */
    e.respondWith(networkFirstWithTimeout(e.request));
  } else {
    /* cache-first for cross-origin assets (fonts) — they never change */
    e.respondWith(
      caches.match(e.request).then(hit =>
        hit ||
        fetch(e.request).then(res => {
          if (res.ok || res.type === 'opaque') {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return res;
        })
      )
    );
  }
});

/* ---------- background notifications ---------- */

self.addEventListener('periodicsync', e => {
  if (e.tag === 'tally-check') e.waitUntil(backgroundCheck());
});

async function backgroundCheck() {
  try {
    if (Notification.permission !== 'granted') return;
    const [stateJson, logJson] = await Promise.all([idbGet('state'), idbGet('notifLog')]);
    if (!stateJson) return;
    const st = JSON.parse(stateJson);
    const log = logJson ? JSON.parse(logJson) : { fired: {}, lastNudge: 0 };
    const due = evaluateNotifications(st, log, Date.now());
    for (const n of due) {
      await self.registration.showNotification(n.title, {
        body: n.body, icon: './icons/icon-192.png', tag: n.key,
      });
    }
    if ('setAppBadge' in navigator) {
      const c = badgeCount(st);
      await (c ? navigator.setAppBadge(c) : navigator.clearAppBadge()).catch(() => {});
    }
    await idbSet('notifLog', JSON.stringify(log));
  } catch { /* a failed check must never break the SW */ }
}

self.addEventListener('push', e => {
  if (!e.data) return;
  let n;
  try { n = e.data.json(); } catch { return; }
  e.waitUntil(self.registration.showNotification(n.title || 'Tally', {
    body: n.body || '', icon: './icons/icon-192.png', tag: n.key || undefined,
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => list.length ? list[0].focus() : clients.openWindow('./'))
  );
});
