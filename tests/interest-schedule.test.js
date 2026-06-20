/* Two new behaviours:
   1. accruedInterestDetail now returns a `schedule` — the chronological list of
      every individual interest charge that has landed since the anchor, so the
      UI can show interest "adding up per day" as dated rows in history.
   2. A person can carry their own interestConfig (rate / period / type), which
      OVERRIDES the global interestRules for that one person.
   store.js is a classic script using a module global `state`; load it into a vm
   context and drive it the same way the other suites do. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'store.js'), 'utf8'), ctx, { filename: 'store.js' });
function setState(s) { ctx.__state = s; vm.runInContext('state = __state', ctx); }

const DAY = 86_400_000;

const GLOBAL_RULE = [{
  id: 'r1', name: '1%/day over 0', enabled: true, op: '>', value: 0,
  type: 'simple', rate: 1, periodUnit: 'day', capPeriods: null, groupId: null,
}];

function baseState(rules, personOverrides = {}) {
  // 1000 lent 10 real-days ago, so several daily charges have landed by now.
  const lentAt = new Date(Date.now() - 10 * DAY).toISOString();
  return {
    people: [Object.assign(
      { id: 'a', name: 'A', currency: 'INR', interestExempt: false, interestAnchor: null, createdAt: '2026-01-01', interestConfig: null },
      personOverrides,
    )],
    groups: [],
    transactions: [{ id: 't1', personId: 'a', groupId: null, amount: 1000, note: '', date: lentAt, isInterest: false }],
    interestRules: rules,
    settings: { baseCurrency: 'INR', tzHistory: [] },
  };
}
const personA = () => ctx.getPerson('a');

test('schedule lists each daily charge and sums to the accrued total', () => {
  setState(baseState(GLOBAL_RULE));
  const d = ctx.accruedInterestDetail(personA());
  assert.ok(d.schedule.length >= 8, 'about one charge per elapsed day');
  // every entry is dated and positive
  d.schedule.forEach(s => {
    assert.ok(s.amount > 0);
    assert.ok(!Number.isNaN(new Date(s.date).getTime()));
  });
  // dates are chronological
  for (let i = 1; i < d.schedule.length; i++) {
    assert.ok(new Date(d.schedule[i].date) >= new Date(d.schedule[i - 1].date));
  }
  const sum = d.schedule.reduce((s, x) => s + x.amount, 0);
  assert.ok(Math.abs(sum - d.total) < 1e-9, 'schedule sums to the total');
  assert.ok(Math.abs(d.total - 1000 * 0.01 * d.schedule.length) < 1e-6, '1%/day simple on 1000');
});

test('a per-person interestConfig overrides the global rules', () => {
  // global rule says 1%/day; the person says 2%/day — the person rule wins.
  setState(baseState(GLOBAL_RULE, {
    interestConfig: { enabled: true, op: '>', value: 0, type: 'simple', rate: 2, periodUnit: 'day', capPeriods: null },
  }));
  const d = ctx.accruedInterestDetail(personA());
  assert.ok(Math.abs(d.total - 1000 * 0.02 * d.schedule.length) < 1e-6, 'charged at the personal 2%/day');
  // and it works even with NO global rules at all
  setState(baseState([], {
    interestConfig: { enabled: true, op: '>', value: 0, type: 'simple', rate: 2, periodUnit: 'day', capPeriods: null },
  }));
  const d2 = ctx.accruedInterestDetail(personA());
  assert.ok(d2.total > 0, 'personal interest accrues with no global rules present');
});

test('a disabled per-person config falls back to the global rules', () => {
  setState(baseState(GLOBAL_RULE, {
    interestConfig: { enabled: false, op: '>', value: 0, type: 'simple', rate: 9, periodUnit: 'day', capPeriods: null },
  }));
  const d = ctx.accruedInterestDetail(personA());
  assert.ok(Math.abs(d.total - 1000 * 0.01 * d.schedule.length) < 1e-6, 'global 1%/day still applies');
});

test('the personal config respects its own condition', () => {
  // condition balance > 5000 is never met at 1000, so nothing accrues
  setState(baseState(GLOBAL_RULE, {
    interestConfig: { enabled: true, op: '>', value: 5000, type: 'simple', rate: 2, periodUnit: 'day', capPeriods: null },
  }));
  const d = ctx.accruedInterestDetail(personA());
  assert.strictEqual(d.total, 0, 'below the personal condition, no interest (global rule is overridden)');
  assert.strictEqual(d.schedule.length, 0);
});
