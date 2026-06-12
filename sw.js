/* Tally service worker — precache the app shell, serve cache-first,
   runtime-cache everything else (fonts) so the app works fully offline. */

importScripts('./store.js', './notif.js');

const CACHE = 'tally-v5';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './store.js',
  './notif.js',
  './push.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const sameOrigin = new URL(e.request.url).origin === self.location.origin;

  if (sameOrigin) {
    /* network-first for app files: users get updates immediately when
       online; the cache only serves when offline */
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(e.request, { ignoreSearch: true })
            .then(hit => hit || caches.match('./index.html'))
        )
    );
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
