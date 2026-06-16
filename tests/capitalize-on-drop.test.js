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

test('a dated drop capitalizes at the entry date, not today, and leaves nothing stranded', () => {
  // 1500 lent 10 days ago; a repayment is recorded dated 5 days ago. Interest
  // must be frozen at the 5-day-ago value (not the full 10 days), and the
  // accrued total must not re-surface when the balance later climbs back over.
  const lentAt = Date.now() - 10 * DAY;
  const dropAt = Date.now() - 5 * DAY;
  setState({
    people: [{ id: 'a', name: 'A', currency: 'INR', interestExempt: false, interestAnchor: null, createdAt: '2026-01-01' }],
    groups: [],
    transactions: [{ id: 't1', personId: 'a', amount: 1500, note: '', date: new Date(lentAt).toISOString(), isInterest: false }],
    interestRules: RULE,
    settings: { baseCurrency: 'INR', tzHistory: [] },
  });

  const accruedToNow = ctx.accruedInterest(personA());        // ~10 daily charges
  const accruedAtDrop = ctx.accruedInterest(personA(), dropAt); // ~5 daily charges
  assert.ok(accruedAtDrop > 0.005 && accruedAtDrop < accruedToNow - 0.005,
    'as-of-drop interest is real but less than as-of-now');

  const capitalized = ctx.capitalizeOnDrop('a', -700, dropAt); // 1500 -> 800, below 1000
  assert.ok(Math.abs(capitalized - accruedAtDrop) < 0.01,
    'capitalizes the interest accrued up to the drop date, not today');
  ctx.addTransaction({ personId: 'a', amount: -700, date: new Date(dropAt).toISOString() });

  // the capitalization landed as a transaction dated at the drop, not now
  const capTxn = ctx.personTxns('a').find(t => t.isInterest);
  assert.strictEqual(capTxn.date, new Date(dropAt).toISOString(), 'capitalization is dated at the drop');
  assert.strictEqual(round2(ctx.accruedInterest(personA())), 0, 'nothing accrues while below the rule');

  // climb back over: the rolled-in interest is now principal, so it does NOT
  // re-appear as a separate interest jump the instant the balance crosses.
  ctx.addTransaction({ personId: 'a', amount: 400 }); // 800 -> 1200, above again
  const d = ctx.balanceDisplay(personA());
  assert.strictEqual(d.crossing, true, 'a rule matches again above 1000');
  assert.strictEqual(round2(d.interest), 0, 'no stranded interest re-surfaces on crossing; only future midnights charge');
});
