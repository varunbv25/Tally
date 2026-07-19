/* Two-device cloud sync tests.

   Each "device" is its own vm realm with its own localStorage and its own
   timezone, talking to one in-memory /ledger that mirrors the Worker's PUT
   semantics (including the stale-write guard). These cover the failure mode
   where a device with an empty ledger overwrote a device that had real data. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

/* Mirrors worker/src/index.js: a PUT older than what's stored is refused. */
function makeServer() {
  const s = { rec: null, puts: 0 };
  s.put = (state, updatedAt) => {
    s.puts++;
    if (s.rec && typeof s.rec.updatedAt === 'number' && s.rec.updatedAt > updatedAt) {
      return { ok: true, updatedAt: s.rec.updatedAt, stale: true };
    }
    s.rec = { state, updatedAt };
    return { ok: true, updatedAt };
  };
  s.get = () => s.rec || { state: null, updatedAt: 0 };
  return s;
}

function makeDevice(server, tzOffsetMin = -330) {
  const ls = new Map();
  class FakeDate extends Date { getTimezoneOffset() { return tzOffsetMin; } }
  const ctx = vm.createContext({
    localStorage: {
      getItem: k => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => ls.set(k, String(v)),
      removeItem: k => ls.delete(k),
    },
    navigator: { onLine: true },
    Date: FakeDate,
    setTimeout, clearTimeout, console, AbortController,
    fetch: async (url, opts) => {
      const p = String(url).replace(/^https?:\/\/[^/]+/, '');
      if (p !== '/ledger') return { ok: false, status: 404, json: async () => ({ error: 'nf' }) };
      const body = opts.method === 'PUT'
        ? (({ state, updatedAt }) => server.put(state, updatedAt))(JSON.parse(opts.body))
        : server.get();
      return { ok: true, status: 200, json: async () => body };
    },
  });
  for (const f of ['store.js', 'cloud.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  vm.runInContext(`loadState(); recordDeviceTimezone();
    cloudAuth.status = 'signed-in'; cloudAuth.token = 'tok'; cloudAuth.email = 'a@b.c';`, ctx);
  return ctx;
}

const run = (ctx, src) => vm.runInContext(src, ctx);
const runAsync = (ctx, src) => vm.runInContext(`(async () => { ${src} })()`, ctx);

test('an empty device never overwrites a device that has data', async () => {
  const server = makeServer();
  const withData = makeDevice(server);
  const empty = makeDevice(server);

  // The device with data edits; its upload is still sitting in the 3s debounce.
  run(withData, `const p = addPerson('Bob','INR'); p.id = 'p9';
                 addTransaction({ personId:'p9', amount:700, note:'x' }); saveState();`);
  assert.strictEqual(server.rec, null, 'nothing uploaded yet (debounce pending)');

  // The empty device foregrounds and reconciles into an empty cloud. It must
  // not claim authorship — this is what used to destroy the other device.
  await runAsync(empty, `return await cloudReconcile();`);
  assert.strictEqual(server.rec, null, 'empty device uploaded nothing');
  assert.strictEqual(run(empty, `cloudLocalUpdated()`), 0, 'empty device claimed no version');

  // Now the real upload lands, and the empty device pulls it.
  await runAsync(withData, `await cloudPush();`);
  const result = await runAsync(empty, `return await cloudReconcile();`);
  assert.strictEqual(result, 'pulled');
  assert.strictEqual(run(empty, `state.people.length`), 1, 'empty device received the ledger');
  assert.strictEqual(run(empty, `totalOf(getPerson('p9'))`), 700, 'and computes the same total');
  assert.strictEqual(server.rec.state.people.length, 1, 'the cloud still holds the real ledger');
});

test('the server refuses a write older than what it holds', () => {
  const server = makeServer();
  server.put({ people: ['newer'] }, 2000);
  const res = server.put({ people: [] }, 1000);
  assert.strictEqual(res.stale, true, 'stale write reported');
  assert.strictEqual(server.rec.updatedAt, 2000, 'stored copy untouched');
  assert.deepStrictEqual(server.rec.state.people, ['newer']);
});

test('a device whose push is refused adopts the winning copy', async () => {
  const server = makeServer();
  const a = makeDevice(server);
  const b = makeDevice(server);

  run(a, `const p = addPerson('Ada','INR'); p.id='p1';
          addTransaction({ personId:'p1', amount:100, note:'a' }); saveState();`);
  await runAsync(a, `await cloudPush();`);
  await runAsync(b, `return await cloudReconcile();`);

  // Force b to hold a stale version, then have it try to push over a newer cloud.
  run(a, `addTransaction({ personId:'p1', amount:50, note:'newer' }); saveState();`);
  await runAsync(a, `await cloudPush();`);
  run(b, `setCloudLocalUpdated(cloudLocalUpdated() - 1000);`); // pretend b fell behind
  run(b, `addTransaction({ personId:'p1', amount:999, note:'loser' });`);
  await runAsync(b, `await cloudPush();`);

  assert.strictEqual(server.rec.state.transactions.length, 2, 'cloud kept the newer ledger');
  assert.ok(
    !server.rec.state.transactions.some(t => t.note === 'loser'),
    'the stale device did not overwrite the cloud',
  );
  assert.strictEqual(run(b, `state.transactions.length`), 2, 'stale device adopted the winner');
});

test('idle foreground cycles never mutate the cloud', async () => {
  const server = makeServer();
  const a = makeDevice(server);
  const b = makeDevice(server);

  run(a, `const p = addPerson('Ada','INR'); p.id='p1';
          addTransaction({ personId:'p1', amount:100, note:'a' }); saveState();`);
  await runAsync(a, `await cloudPush();`);
  await runAsync(b, `return await cloudReconcile();`);

  /* The ping-pong this guards against: two devices each deciding the other is
     behind and re-uploading on every resume, rewriting the ledger forever. */
  const writesBefore = server.puts;
  const versionBefore = server.rec.updatedAt;
  for (let i = 0; i < 5; i++) {
    await runAsync(a, `return await cloudReconcile();`);
    await runAsync(b, `return await cloudReconcile();`);
  }
  assert.strictEqual(server.puts, writesBefore, 'no uploads while nothing changed');
  assert.strictEqual(server.rec.updatedAt, versionBefore, 'cloud version stable');
  assert.strictEqual(run(a, `state.settings.tzHistory.length`), 1, 'tz history did not grow');
  assert.strictEqual(run(b, `state.settings.tzHistory.length`), 1, 'tz history did not grow');
});

test('timezone history stays device-local across a pull', async () => {
  const server = makeServer();
  const india = makeDevice(server, -330);
  const newYork = makeDevice(server, 300);

  run(india, `const p = addPerson('Ada','INR'); p.id='p1';
              addTransaction({ personId:'p1', amount:1000, note:'loan' }); saveState();`);
  await runAsync(india, `await cloudPush();`);
  await runAsync(newYork, `return await cloudReconcile();`);

  /* Adopting the sender's tzHistory would re-phase interest to its local
     midnights, so the two devices would disagree on the same ledger. */
  assert.deepStrictEqual(
    JSON.parse(run(newYork, `JSON.stringify(state.settings.tzHistory)`)),
    [{ since: 0, offsetMin: 300 }],
    'puller kept its own timezone history',
  );
  assert.deepStrictEqual(
    JSON.parse(run(india, `JSON.stringify(state.settings.tzHistory)`)),
    [{ since: 0, offsetMin: -330 }],
    'sender unchanged',
  );
  assert.strictEqual(
    run(india, `totalOf(getPerson('p1'))`),
    run(newYork, `totalOf(getPerson('p1'))`),
    'both devices agree on the total',
  );
});
