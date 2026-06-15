/* balanceDisplay: accrued interest is shown as a separate column only while the
   balance still meets an interest rule's condition. Once a repayment drops the
   balance below every rule the interest is folded into the principal and the
   interest column goes blank, until the balance crosses the condition again.
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
const round2 = n => Math.round(n * 100) / 100;

// balance > 1000 -> 1%/day simple; so 1057 has accrued interest, 946 does not.
const RULE = [{
  id: 'r1', name: '1%/day over 1000', enabled: true, op: '>', value: 1000,
  type: 'simple', rate: 1, periodUnit: 'day', capPeriods: null, groupId: null,
}];

function freshState() {
  // principal 1057 lent 10 real-days ago, so interest has been accruing to now.
  // reset stays OFF so the accrued interest is never actually capitalized — the
  // display rule is what folds it in and out.
  const lentAt = new Date(Date.now() - 10 * DAY).toISOString();
  return {
    people: [{ id: 'a', name: 'A', currency: 'INR', interestExempt: false, interestAnchor: null, createdAt: '2026-01-01' }],
    groups: [],
    transactions: [{ id: 't1', personId: 'a', groupId: null, amount: 1057, note: '', date: lentAt, isInterest: false }],
    interestRules: RULE,
    settings: { baseCurrency: 'INR', resetInterestOnDrop: false, tzHistory: [] },
  };
}
const personA = () => ctx.getPerson('a');

test('above the condition: interest is shown as a separate column', () => {
  setState(freshState());
  const d = ctx.balanceDisplay(personA());
  assert.strictEqual(d.crossing, true);
  assert.strictEqual(d.principal, 1057, 'principal is the raw principal');
  assert.ok(d.interest > 0.005, 'accrued interest is surfaced separately');
  assert.ok(Math.abs(d.total - (d.principal + d.interest)) < 0.01);
});

test('dropped below the condition: interest folds into principal, column blanks', () => {
  setState(freshState());
  const totalBefore = ctx.totalOf(personA());
  ctx.addTransaction({ personId: 'a', amount: -111 }); // 1057 -> 946, below 1000

  const d = ctx.balanceDisplay(personA());
  assert.strictEqual(d.crossing, false, 'no rule matches at 946');
  assert.strictEqual(round2(d.interest), 0, 'interest column is blank below the condition');
  // the previously-accrued interest is still alive in the engine...
  assert.ok(ctx.accruedInterest(personA()) > 0.005, 'engine preserves the accrued interest');
  // ...but it is now shown rolled into the principal, and the total is preserved
  assert.ok(d.principal > 946, 'accrued interest is folded into the displayed principal');
  assert.ok(Math.abs(d.total - (totalBefore - 111)) < 0.01, 'total only drops by the repayment');
  assert.ok(Math.abs(d.principal - d.total) < 0.01, 'principal column carries the whole balance');
});

test('crossing the condition again brings the interest column back', () => {
  setState(freshState());
  ctx.addTransaction({ personId: 'a', amount: -111 }); // below
  ctx.addTransaction({ personId: 'a', amount: 200 });  // 946 -> 1146, above again

  const d = ctx.balanceDisplay(personA());
  assert.strictEqual(d.crossing, true, 'a rule matches again at 1146');
  assert.ok(d.interest > 0.005, 'interest is shown separately once more');
});
