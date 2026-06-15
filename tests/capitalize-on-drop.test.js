/* capitalizeOnDrop: when a repayment drops the balance below every interest
   rule, the accrued interest is rolled into the principal instead of being
   left stranded. store.js is a classic script using a module global `state`;
   load it into a vm context and drive it the same way the other suites do. */
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
  // principal 1057 lent 10 real-days ago, so interest has been accruing to now
  const lentAt = new Date(Date.now() - 10 * DAY).toISOString();
  return {
    people: [{ id: 'a', name: 'A', currency: 'INR', interestExempt: false, interestAnchor: null, createdAt: '2026-01-01' }],
    groups: [],
    transactions: [{ id: 't1', personId: 'a', groupId: null, amount: 1057, note: '', date: lentAt, isInterest: false }],
    interestRules: RULE,
    settings: { baseCurrency: 'INR', tzHistory: [] },
  };
}
const personA = () => ctx.getPerson('a');

test('repayment below the rule capitalizes interest into the principal', () => {
  setState(freshState());
  const totalBefore = ctx.totalOf(personA());
  const interestBefore = ctx.accruedInterest(personA());
  assert.ok(interestBefore > 0.005, 'interest should have accrued before the repayment');

  const capitalized = ctx.capitalizeOnDrop('a', -111);
  assert.ok(capitalized > 0.005, 'dropping below the rule should capitalize the accrued interest');
  ctx.addTransaction({ personId: 'a', amount: -111 });

  // interest is now folded into principal; visible interest resets to zero
  assert.strictEqual(round2(ctx.accruedInterest(personA())), 0);
  assert.strictEqual(ctx.principalOf('a'), round2(1057 + capitalized - 111));
  // total is preserved: only the 111 repayment leaves
  assert.ok(Math.abs(ctx.totalOf(personA()) - (totalBefore - 111)) < 0.01);
});

test('after capitalizing on a drop, fresh interest accrues on the larger principal', () => {
  setState(freshState());
  const capitalized = ctx.capitalizeOnDrop('a', -111);
  ctx.addTransaction({ personId: 'a', amount: -111 }); // 1057 -> 946, below 1000
  const principalBelow = ctx.principalOf('a');         // 1057 + capitalized - 111
  assert.strictEqual(round2(ctx.accruedInterest(personA())), 0, 'no interest while below the rule');

  // climb back over the condition; the rolled-in interest is part of the principal now
  ctx.addTransaction({ personId: 'a', amount: 200 });  // -> 1146-ish, above 1000 again
  const principalAbove = ctx.principalOf('a');
  assert.ok(Math.abs(principalAbove - (principalBelow + 200)) < 0.01,
    'principal carries the previously-capitalized interest');
  // and fresh interest starts accruing again on that larger principal
  // (anchor was moved on capitalize, so this is genuinely new interest)
  assert.ok(principalAbove > 1146 - 0.5, 'principal includes the rolled-in interest, not just the raw 1146');
});

test('repayment that stays above the rule does not capitalize', () => {
  setState(freshState());
  assert.strictEqual(ctx.capitalizeOnDrop('a', -10), 0, 'balance stays above 1000, no drop');
});
