/* Full JSON backup/restore tests. Same vm-context approach as the other
   suites: store.js is a classic script with a module-global `state`. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({ localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
for (const file of ['store.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx, { filename: file });
}

function setState(s) {
  ctx.__state = s;
  vm.runInContext('state = __state', ctx);
}
function getState() {
  return vm.runInContext('state', ctx);
}
/* store.js objects live in the vm realm, so their prototypes differ from this
   file's — deepStrictEqual would reject structurally-identical values. Compare
   by serialization instead. */
const same = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));

function sampleState() {
  return {
    people: [
      { id: 'p1', name: 'Asha', currency: 'INR', interestExempt: false, interestAnchor: null, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'p2', name: 'Bo', currency: 'USD', interestExempt: true, interestAnchor: null, createdAt: '2026-01-02T00:00:00.000Z' },
    ],
    groups: [{ id: 'g1', name: 'Trip', memberIds: ['p1', 'p2'] }],
    transactions: [
      { id: 't1', personId: 'p1', groupId: 'g1', amount: 500, note: 'lunch', date: '2026-02-01T12:00:00.000Z', isInterest: false },
    ],
    interestRules: [
      { id: 'r1', name: '5% monthly', enabled: true, op: '>', value: 100, type: 'compound', rate: 5, periodUnit: 'month', capPeriods: null, groupId: null },
    ],
    settings: { baseCurrency: 'USD', resetInterestOnDrop: true, theme: 'dark' },
  };
}

test('exportJSON wraps state with app + version metadata', () => {
  setState(sampleState());
  const out = JSON.parse(ctx.exportJSON());
  assert.strictEqual(out.app, 'tally');
  assert.strictEqual(out.version, 1);
  assert.ok(out.exportedAt);
  same(out.state.people, sampleState().people);
});

test('export then import round-trips every field, including rules and settings', () => {
  setState(sampleState());
  const json = ctx.exportJSON();
  setState(ctx.defaultState());            // wipe to defaults
  ctx.importJSON(json);
  const restored = getState();
  same(restored.people, sampleState().people);
  same(restored.groups, sampleState().groups);
  same(restored.transactions, sampleState().transactions);
  same(restored.interestRules, sampleState().interestRules);
  same(restored.settings, sampleState().settings);
});

test('importJSON accepts a bare state object (no wrapper)', () => {
  setState(ctx.defaultState());
  ctx.importJSON(JSON.stringify(sampleState()));
  assert.strictEqual(getState().people.length, 2);
});

test('importJSON fills missing settings keys from defaults', () => {
  setState(ctx.defaultState());
  const partial = { people: [], transactions: [], settings: { baseCurrency: 'EUR' } };
  ctx.importJSON(JSON.stringify(partial));
  const s = getState();
  assert.strictEqual(s.settings.baseCurrency, 'EUR');
  assert.strictEqual(s.settings.resetInterestOnDrop, false);   // default backfilled
});

test('importJSON rejects malformed JSON', () => {
  assert.throws(() => ctx.importJSON('{not json'), /valid Tally backup/);
});

test('importJSON rejects a file with the wrong app marker', () => {
  assert.throws(() => ctx.importJSON(JSON.stringify({ app: 'something-else', state: {} })), /different app/);
});

test('importJSON rejects an object missing the people/transactions arrays', () => {
  assert.throws(() => ctx.importJSON(JSON.stringify({ foo: 1 })), /doesn’t look like a Tally backup/);
});
