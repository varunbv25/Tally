/* Tally service worker — precache the app shell, serve cache-first,
   runtime-cache everything else (fonts) so the app works fully offline. */

importScripts('./store.js', './notif.js');

const CACHE = 'tally-v54';
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

  const net = await network;
  if (net) return net;

  /* Nothing cached and the network is down. Only a NAVIGATION may fall back to
     the app shell (so deep links still resolve offline). An asset request
     (styles.css, app.js, …) must NOT receive index.html — handing HTML back for
     a stylesheet/script makes the browser fail to parse it and renders the app
     completely unstyled/broken. Fail honestly instead. */
  if (request.mode === 'navigate') {
    return (await cache.match('./index.html')) || Response.error();
  }
  return Response.error();
}

/* The only cross-origin responses that may be cached: the font CDNs, whose
   files are content-addressed and genuinely never change. Everything else
   cross-origin — above all the sync API — must reach the network on every
   call. Caching those by origin is what broke cloud sync: `GET /ledger` is a
   plain cross-origin GET, so the first response was cached and then replayed
   for every later pull. Each device kept re-reading the snapshot it happened
   to fetch first, so a change made on one device never arrived on the other
   however often either of them synced. */
const CACHEABLE_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(request, copy));
  }
  return res;
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const { origin } = new URL(e.request.url);

  if (origin === self.location.origin) {
    /* network-first for app files so users get updates immediately when online,
       but time-boxed so a slow network falls back to the cached shell fast */
    e.respondWith(networkFirstWithTimeout(e.request));
    return;
  }
  if (CACHEABLE_ORIGINS.includes(origin)) {
    e.respondWith(cacheFirst(e.request));
    return;
  }
  /* Anything else (the sync/push API, Google sign-in) is left alone: not
     calling respondWith hands the request straight to the network, so the
     service worker can never answer it with a stale copy. */
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
