/* Service-worker routing tests.

   The regression these exist for: sw.js used to route *every* cross-origin GET
   through a cache-first branch written for the font CDNs. `GET /ledger` on the
   sync API is a plain cross-origin GET, so the first pull was cached and then
   replayed for every later one — each device kept re-reading the snapshot it
   happened to fetch first, and a change made on one device never reached the
   other however often either of them synced.

   sw.js is a classic worker script, so load it into a vm realm with a fake
   `self`/`caches`/`fetch` and dispatch fetch events at the listener it
   registers. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SITE = 'https://tally.example.workers.dev';
const API = 'https://tally-api.example.workers.dev';

const req = (url, extra) => ({ url, method: 'GET', mode: 'cors', ...extra });
const keyOf = r => (typeof r === 'string' ? new URL(r, SITE + '/').href : r.url);

function loadSw() {
  const stored = new Map(); // cache key -> response
  const cache = {
    put: async (r, res) => { stored.set(keyOf(r), res); },
    match: async r => stored.get(keyOf(r)),
    addAll: async () => {},
  };
  const caches = {
    open: async () => cache,
    match: async r => cache.match(r),
    keys: async () => [],
    delete: async () => true,
  };

  const listeners = {};
  const swSelf = {
    addEventListener: (type, fn) => { (listeners[type] || (listeners[type] = [])).push(fn); },
    location: { origin: SITE },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };

  const net = { calls: [], respond: url => ({ ok: true, url, clone: () => ({ ok: true, url }) }) };

  const ctx = vm.createContext({
    self: swSelf,
    caches,
    URL,
    Response: { error: () => ({ ok: false, error: true }) },
    setTimeout,
    clearTimeout,
    console,
    importScripts: () => {},          // store.js/notif.js aren't needed for routing
    fetch: async request => {
      net.calls.push(keyOf(request));
      return net.respond(keyOf(request));
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), ctx, { filename: 'sw.js' });

  /* Dispatch one fetch event and report whether the worker answered it. */
  const dispatch = request => {
    let answered = null;
    const event = { request, respondWith: p => { answered = p; } };
    for (const fn of listeners.fetch || []) fn(event);
    return { handled: answered !== null, response: answered };
  };

  return { dispatch, stored, net };
}

test('the sync API is never answered from the service-worker cache', async () => {
  const { dispatch, stored } = loadSw();

  const first = dispatch(req(API + '/ledger'));
  assert.strictEqual(first.handled, false, 'the worker leaves API calls to the network');
  assert.strictEqual(stored.size, 0, 'and stores nothing that could be replayed later');

  // The other API routes the app GETs are equally live data.
  assert.strictEqual(dispatch(req(API + '/sync')).handled, false);
});

test('fonts are still served cache-first, and survive going offline', async () => {
  const { dispatch, stored, net } = loadSw();
  const FONT = 'https://fonts.gstatic.com/s/manrope/v1/font.woff2';

  const first = dispatch(req(FONT));
  assert.strictEqual(first.handled, true, 'font requests are handled by the worker');
  await first.response;
  assert.strictEqual(stored.size, 1, 'the font was cached');

  net.respond = () => { throw new Error('offline'); };
  const second = dispatch(req(FONT));
  const res = await second.response;
  assert.strictEqual(res.url, FONT, 'served from the cache without touching the network');
});

test('same-origin app files stay network-first', async () => {
  const { dispatch, net } = loadSw();
  const hit = dispatch(req(SITE + '/app.js'));
  assert.strictEqual(hit.handled, true);
  const res = await hit.response;
  assert.strictEqual(res.url, SITE + '/app.js');
  assert.ok(net.calls.includes(SITE + '/app.js'), 'the network was asked first');
});
