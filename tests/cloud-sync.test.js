/* Cloud sync tests. Loads store.js + cloud.js into one vm context, the way the
   browser loads them as classic scripts sharing globals. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const store = new Map();
  const ctx = vm.createContext({
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    navigator: { onLine: true },
    console,
  });
  for (const f of ['store.js', 'cloud.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

const run = (ctx, src) => vm.runInContext(src, ctx);

test('a pulled blob is normalized against defaultState', () => {
  const ctx = load();
  /* A ledger from a device on an older app version: no `scheduled`, no
     `interestRules`, and a `settings` missing newer keys. Assigning this raw
     onto `state` (the old behaviour) left those undefined and broke every
     derived total downstream. */
  run(ctx, `applyCloudState({
    people: [{ id: 'p1', name: 'Ada', currency: 'INR' }],
    groups: [],
    transactions: [{ id: 't1', personId: 'p1', groupId: null, amount: 100, note: '', date: '2020-01-01T00:00:00.000Z' }],
    settings: { baseCurrency: 'INR' },
  }, 1234)`);

  assert.ok(Array.isArray(run(ctx, 'state.scheduled')), 'scheduled defaulted');
  assert.ok(Array.isArray(run(ctx, 'state.interestRules')), 'interestRules defaulted');
  assert.strictEqual(typeof run(ctx, 'state.settings.interestTz'), 'number', 'interest timezone seeded');
  assert.strictEqual(run(ctx, 'state.people.length'), 1, 'pulled data survived');
  assert.strictEqual(run(ctx, 'principalOf("p1")'), 100, 'totals compute after a pull');
  assert.strictEqual(run(ctx, 'cloudLocalUpdated()'), 1234, 'local version tracks the remote one');
});

test('applying a pulled blob does not schedule a re-upload', () => {
  const ctx = load();
  /* cloudApplying must suppress cloudOnSave for the whole apply — including the
     saveState() that ensureInterestTimezone() does internally. Otherwise the local
     version gets stamped Date.now() and the device bounces the blob straight
     back up, clobbering the timestamp it just agreed on. */
  run(ctx, `applyCloudState({ people: [], groups: [], transactions: [] }, 999)`);
  assert.strictEqual(run(ctx, 'cloudLocalUpdated()'), 999);
  assert.strictEqual(run(ctx, 'cloudApplying'), false, 'flag released');
});

test('a signed-out device never touches the network on save', () => {
  const ctx = load();
  run(ctx, 'cloudOnSave()');
  assert.strictEqual(run(ctx, 'cloudLocalUpdated()'), 0, 'no version bump while signed out');
});
