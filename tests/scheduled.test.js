/* Scheduled (future) debt tests: a debt set up now, dated later, that only
   touches the ledger once confirmed on/after its day. store.js is a classic
   script using a module global `state`; load it into a vm context like the
   other suites. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'store.js'), 'utf8'), ctx, { filename: 'store.js' });
function setState(s) { ctx.__state = s; vm.runInContext('state = __state', ctx); }

const DAY = 86_400_000;
const round2 = n => Math.round(n * 100) / 100;

function freshState() {
  return {
    people: [
      { id: 'a', name: 'A', currency: 'INR', interestExempt: false, interestAnchor: null, createdAt: '2026-01-01' },
      { id: 'b', name: 'B', currency: 'INR', interestExempt: false, interestAnchor: null, createdAt: '2026-01-01' },
    ],
    groups: [],
    transactions: [],
    interestRules: [],
    scheduled: [],
    settings: { baseCurrency: 'INR', interestTz: -330 },
  };
}

test('addScheduledDebt stores a future debt without touching any balance', () => {
  setState(freshState());
  const future = new Date(Date.now() + 5 * DAY).toISOString();
  ctx.addScheduledDebt({ personId: 'a', amount: 500, note: 'bet', date: future });
  assert.strictEqual(ctx.__state.scheduled.length, 1);
  assert.strictEqual(ctx.__state.transactions.length, 0, 'nothing recorded yet');
  assert.strictEqual(round2(ctx.principalOf('a')), 0, 'balance untouched until due');
});

test('addScheduledDebt validates amount, person and date', () => {
  setState(freshState());
  const d = new Date().toISOString();
  assert.throws(() => ctx.addScheduledDebt({ personId: 'a', amount: 0, date: d }), /isn’t zero/);
  assert.throws(() => ctx.addScheduledDebt({ personId: 'ghost', amount: 5, date: d }), /Pick a person/);
  assert.throws(() => ctx.addScheduledDebt({ personId: 'a', amount: 5, date: '' }), /Pick a date/);
});

test('dueScheduled returns only debts whose date has arrived', () => {
  setState(freshState());
  ctx.addScheduledDebt({ personId: 'a', amount: 100, date: new Date(Date.now() - DAY).toISOString() });
  ctx.addScheduledDebt({ personId: 'b', amount: 200, date: new Date(Date.now() + DAY).toISOString() });
  const due = ctx.dueScheduled();
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].personId, 'a');
});

test('confirmScheduled records the debt and removes it from the schedule', () => {
  setState(freshState());
  const past = new Date(Date.now() - DAY).toISOString();
  const s = ctx.addScheduledDebt({ personId: 'a', amount: 750, note: 'lost a bet', date: past });
  const t = ctx.confirmScheduled(s.id);
  assert.ok(t, 'a transaction is returned');
  assert.strictEqual(round2(ctx.principalOf('a')), 750, 'balance now reflects the debt');
  assert.strictEqual(t.date, past, 'recorded at the scheduled date');
  assert.strictEqual(t.note, 'lost a bet');
  assert.strictEqual(ctx.__state.scheduled.length, 0, 'no longer pending');
});

test('cancelScheduled drops a debt without recording it', () => {
  setState(freshState());
  const s = ctx.addScheduledDebt({ personId: 'a', amount: 300, date: new Date(Date.now() - DAY).toISOString() });
  ctx.cancelScheduled(s.id);
  assert.strictEqual(ctx.__state.scheduled.length, 0);
  assert.strictEqual(round2(ctx.principalOf('a')), 0, 'balance never moved');
  assert.strictEqual(ctx.__state.transactions.length, 0);
});

test('a negative scheduled amount means you will owe them', () => {
  setState(freshState());
  const s = ctx.addScheduledDebt({ personId: 'b', amount: -400, date: new Date(Date.now() - DAY).toISOString() });
  ctx.confirmScheduled(s.id);
  assert.strictEqual(round2(ctx.principalOf('b')), -400);
});

test('deleting a person also clears their scheduled debts', () => {
  setState(freshState());
  ctx.addScheduledDebt({ personId: 'a', amount: 100, date: new Date().toISOString() });
  ctx.deletePerson('a');
  assert.strictEqual(ctx.__state.scheduled.length, 0);
});
