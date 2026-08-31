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

/* One clock the whole test drives by hand, so "later" is something the test
   states rather than something it races the real clock for. The Worker reads
   it too — that is the point of the skew tests below: the server's clock is
   the only one both devices can agree on. */
let NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const advance = ms => { NOW += ms; };

/* Mirrors worker/src/index.js: a PUT older than what's stored is refused, and
   every reply carries the server's own clock. */
function makeServer() {
  const s = { rec: null, puts: 0 };
  s.put = (state, updatedAt) => {
    s.puts++;
    if (s.rec && typeof s.rec.updatedAt === 'number' && s.rec.updatedAt > updatedAt) {
      return { ok: true, updatedAt: s.rec.updatedAt, stale: true, now: NOW };
    }
    s.rec = { state, updatedAt };
    return { ok: true, updatedAt, now: NOW };
  };
  s.get = () => ({ ...(s.rec || { state: null, updatedAt: 0 }), now: NOW });
  return s;
}

/* `clockSkewMs` is how far this device's own clock is off from the server's —
   the phone that's running ten minutes fast. */
function makeDevice(server, tzOffsetMin = -330, clockSkewMs = 0) {
  const ls = new Map();
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(NOW + clockSkewMs);
      else super(...args);
    }
    static now() { return NOW + clockSkewMs; }
    getTimezoneOffset() { return tzOffsetMin; }
  }
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
  vm.runInContext(`loadState(); ensureInterestTimezone();
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
});

test('two devices in different timezones agree on the amount, all day', async () => {
  const server = makeServer();
  const india = makeDevice(server, -330);
  const newYork = makeDevice(server, 300);

  /* An earlier version of this test had no interest rule enabled, so its
     "totals agree" assertion was vacuous and shipped a real disagreement.
     Charge interest daily and compare across a full 24h sweep — the window
     between the two devices' local midnights is exactly where they used to
     differ by a whole day's charge, for ~14 hours out of every 24. */
  const BASE = Date.UTC(2026, 5, 1, 0, 0, 0);
  run(india, `
    const p = addPerson('Ada','INR'); p.id='p1';
    state.interestRules.push({ id:'r1', name:'std', enabled:true, op:'>', value:0,
      type:'compound', rate:10, periodUnit:'day', capPeriods:null, groupId:null });
    addTransaction({ personId:'p1', amount:1000, note:'loan',
                     date: new Date(${BASE}).toISOString() });
    saveState();`);
  await runAsync(india, `await cloudPush();`);
  await runAsync(newYork, `return await cloudReconcile();`);

  const disagreements = [];
  for (let h = 0; h < 24; h++) {
    const now = BASE + 30 * 86400000 + h * 3600000;
    const a = run(india, `totalOf(getPerson('p1'), ${now})`);
    const b = run(newYork, `totalOf(getPerson('p1'), ${now})`);
    if (a !== b) disagreements.push({ hour: h, india: a, newYork: b });
  }
  assert.deepStrictEqual(disagreements, [], 'the two devices never disagree');

  assert.strictEqual(
    run(india, `state.settings.interestTz`),
    run(newYork, `state.settings.interestTz`),
    'both devices phase interest to the same ledger timezone',
  );
});

test('a device carrying a corrupted timezone history is repaired on pull', async () => {
  const server = makeServer();
  const good = makeDevice(server, -330);
  const poisoned = makeDevice(server, -330);

  const BASE = Date.UTC(2026, 5, 1, 0, 0, 0);
  const seed = `
    const p = addPerson('Ada','INR'); p.id='p1';
    state.interestRules.push({ id:'r1', name:'std', enabled:true, op:'>', value:0,
      type:'compound', rate:5, periodUnit:'day', capPeriods:null, groupId:null });
    addTransaction({ personId:'p1', amount:1000, note:'loan',
                     date: new Date(${BASE}).toISOString() });
    saveState();`;
  run(good, seed);

  /* Simulate a device poisoned by the old sync bug: a timezone history full of
     places it was never in, which made it compute a different total from the
     identical ledger even though both devices sit in the same timezone. */
  run(poisoned, seed);
  run(poisoned, `delete state.settings.interestTz;
    state.settings.tzHistory = [{since:0,offsetMin:-330},
      {since:${BASE + 10 * 86400000},offsetMin:300},
      {since:${BASE + 20 * 86400000},offsetMin:-330}];
    saveState();`);

  const now = BASE + 60 * 86400000;

  /* Booting alone must already repair it — that is the path a user hits, and
     it seeds from the earliest segment rather than trusting the bogus ones. */
  run(poisoned, `ensureInterestTimezone();`);
  assert.strictEqual(run(poisoned, `state.settings.tzHistory`), undefined, 'corruption dropped on boot');
  assert.strictEqual(run(poisoned, `state.settings.interestTz`), -330, 'seeded from the original offset');
  assert.strictEqual(
    run(good, `totalOf(getPerson('p1'), ${now})`),
    run(poisoned, `totalOf(getPerson('p1'), ${now})`),
    'repaired on boot, totals match',
  );

  // And a pull carries the ledger's timezone across too.
  // saveState() bumps the version via cloudOnSave, so age it AFTER saving.
  run(poisoned, `delete state.settings.interestTz; saveState(); setCloudLocalUpdated(1);`);
  await runAsync(good, `await cloudPush();`);
  const res = await runAsync(poisoned, `return await cloudReconcile();`);
  assert.strictEqual(res, 'pulled', 'the stale device pulled');
  assert.strictEqual(run(poisoned, `state.settings.tzHistory`), undefined, 'corruption dropped');
  assert.strictEqual(
    run(good, `totalOf(getPerson('p1'), ${now})`),
    run(poisoned, `totalOf(getPerson('p1'), ${now})`),
    'the repaired device now matches',
  );
});

/* Every ledger version is a wall-clock millisecond, and last-write-wins only
   means anything if both devices read those milliseconds off the same clock.
   They don't — a phone a few minutes fast used to stamp every save into the
   future, so the accurate device's uploads were refused as "stale" forever and
   its edits were silently replaced by the fast phone's copy. Both devices now
   stamp in server time, measured from the clock the Worker returns. */
test('a device with a fast clock cannot lock the other one out of the cloud', async () => {
  const server = makeServer();
  const TEN_MIN = 10 * 60 * 1000;
  const fast = makeDevice(server, -330, TEN_MIN);   // ten minutes ahead
  const slow = makeDevice(server, -330, 0);         // in step with the server

  // Boot: both foreground and reconcile, which is where they learn the offset.
  await runAsync(fast, `return await cloudReconcile();`);
  await runAsync(slow, `return await cloudReconcile();`);
  assert.ok(Math.abs(run(fast, `cloudSkewMs`) + TEN_MIN) < 1000, 'fast device measured its skew');
  assert.strictEqual(run(slow, `cloudSkewMs`), 0, 'the accurate device has nothing to correct');

  // The fast phone makes the first edit and uploads it.
  run(fast, `const p = addPerson('Ada','INR'); p.id='p1';
             addTransaction({ personId:'p1', amount:100, note:'from the fast phone' });
             saveState();`);
  await runAsync(fast, `await cloudPush();`);
  assert.ok(
    server.rec.updatedAt <= NOW,
    'the fast phone stamped server time, not its own ten-minutes-ahead clock',
  );

  await runAsync(slow, `return await cloudReconcile();`);
  assert.strictEqual(run(slow, `state.transactions.length`), 1, 'the other device pulled it');

  // A minute later the accurate device makes the next edit. It is genuinely the
  // newest version of the ledger, so it must reach the cloud.
  advance(60_000);
  run(slow, `addTransaction({ personId:'p1', amount:250, note:'from the accurate phone' });
             saveState();`);
  await runAsync(slow, `await cloudPush();`);

  assert.notStrictEqual(server.rec.stale, true);
  assert.strictEqual(server.rec.state.transactions.length, 2, 'the cloud took the newer edit');
  assert.ok(
    server.rec.state.transactions.some(t => t.note === 'from the accurate phone'),
    'the accurate device was not locked out by the fast one',
  );
  assert.strictEqual(run(slow, `state.transactions.length`), 2, 'and kept its own edit');

  // And the fast phone picks it up on its next pull.
  await runAsync(fast, `return await cloudReconcile();`);
  assert.strictEqual(run(fast, `state.transactions.length`), 2, 'the fast phone pulled it back');
});

/* The offset is remembered, so an edit made before the first request of a
   session (or made offline) is still stamped on the shared clock. */
test('the measured clock offset survives a reload', async () => {
  const server = makeServer();
  const fast = makeDevice(server, -330, 10 * 60 * 1000);
  await runAsync(fast, `return await cloudReconcile();`);

  const stored = Number(run(fast, `localStorage.getItem('tally-cloud-skew')`));
  assert.ok(Math.abs(stored + 10 * 60 * 1000) < 1000, 'offset persisted');

  run(fast, `cloudSkewMs = 0; loadCloudSkew();`);
  assert.strictEqual(run(fast, `cloudSkewMs`), stored, 'and is restored at boot');
  assert.ok(Math.abs(run(fast, `cloudNow()`) - NOW) < 1000, 'so versions land on server time');
});

/* The first edits of a session happen before the device has heard from the
   server, so they carry a version stamped on the local clock. A fast phone
   would park the ledger at a timestamp no other device could ever beat. */
test('an edit made before the clock offset is known is still pulled back to server time', async () => {
  const server = makeServer();
  const fast = makeDevice(server, -330, 10 * 60 * 1000);
  const slow = makeDevice(server, -330, 0);

  // Edit first, sign in second: the save is stamped on the uncorrected clock.
  run(fast, `const p = addPerson('Ada','INR'); p.id='p1';
             addTransaction({ personId:'p1', amount:100, note:'before sign-in' }); saveState();`);
  assert.ok(run(fast, `cloudLocalUpdated()`) > NOW, 'stamped in the future, as the device knew no better');

  await runAsync(fast, `return await cloudReconcile();`);
  assert.ok(server.rec.updatedAt <= NOW, 'the upload was pulled back to server time');

  // Which means the accurate device can still take the next turn.
  await runAsync(slow, `return await cloudReconcile();`);
  advance(60_000);
  run(slow, `addTransaction({ personId:'p1', amount:250, note:'later' }); saveState();`);
  await runAsync(slow, `await cloudPush();`);
  assert.strictEqual(server.rec.state.transactions.length, 2, 'the cloud took the newer edit');
});
