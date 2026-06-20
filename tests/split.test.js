/* Split-expense tests. store.js is a classic script using a module global
   `state`; load it into a vm context and drive it like the other suites. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'store.js'), 'utf8'), ctx, { filename: 'store.js' });
function setState(s) { ctx.__state = s; vm.runInContext('state = __state', ctx); }

const round2 = n => Math.round(n * 100) / 100;
const sum = arr => round2(arr.reduce((s, n) => s + n, 0));
/* store.js arrays live in the vm realm, so their prototype differs from this
   file's and deepStrictEqual would reject structurally-identical values.
   Compare by serialization instead (same approach as backup.test.js). */
const sameArr = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));

function freshState() {
  return {
    people: [
      { id: 'a', name: 'A', currency: 'INR', interestExempt: false, interestAnchor: null, createdAt: '2026-01-01' },
      { id: 'b', name: 'B', currency: 'INR', interestExempt: false, interestAnchor: null, createdAt: '2026-01-01' },
      { id: 'c', name: 'C', currency: 'USD', interestExempt: false, interestAnchor: null, createdAt: '2026-01-01' },
    ],
    groups: [{ id: 'g1', name: 'Trip', memberIds: ['a', 'b', 'c'] }],
    transactions: [],
    interestRules: [],
    settings: { baseCurrency: 'INR', tzHistory: [] },
  };
}

test('splitShares divides evenly when it divides cleanly', () => {
  setState(freshState());
  sameArr(ctx.splitShares(100, 4), [25, 25, 25, 25]);
});

test('splitShares distributes leftover cents so shares sum to the total', () => {
  setState(freshState());
  const s = ctx.splitShares(100, 3);
  sameArr(s, [33.34, 33.33, 33.33]);
  assert.strictEqual(sum(s), 100);
});

test('splitShares handles tiny amounts without losing or inventing cents', () => {
  setState(freshState());
  const s = ctx.splitShares(0.10, 3);
  sameArr(s, [0.04, 0.03, 0.03]);
  assert.strictEqual(sum(s), 0.10);
});

test('splitShares with an explicit order steers the leftover onto chosen people', () => {
  setState(freshState());
  // 100 ÷ 3 → one extra cent; order [2,0,1] hands it to index 2, not the first.
  const s = ctx.splitShares(100, 3, { order: [2, 0, 1] });
  sameArr(s, [33.33, 33.33, 33.34]);
  assert.strictEqual(sum(s), 100);
});

test('splitShares in whole-number mode divides into whole units, remainder shared', () => {
  setState(freshState());
  const s = ctx.splitShares(100, 3, { whole: true });
  sameArr(s, [34, 33, 33]);
  assert.strictEqual(sum(s), 100);
  // and the whole-unit remainder can be steered like the cent one
  sameArr(ctx.splitShares(100, 3, { whole: true, order: [1, 0, 2] }), [33, 34, 33]);
});

test('splitShares whole-number mode divides cleanly when it divides cleanly', () => {
  setState(freshState());
  sameArr(ctx.splitShares(99, 3, { whole: true }), [33, 33, 33]);
});

test('addSplitExpense rounds shares to whole numbers when roundWhole is on', () => {
  const st = freshState();
  st.settings.roundWhole = true;
  setState(st);
  const { txns } = ctx.addSplitExpense({ personIds: ['a', 'b', 'c'], amount: 100 });
  // every share is a whole number and they still sum to the total
  assert.ok(txns.every(t => Number.isInteger(t.amount)), 'shares are whole numbers');
  assert.strictEqual(sum(txns.map(t => t.amount)), 100);
});

test('addSplitExpense honours a caller-supplied leftover order', () => {
  setState(freshState());
  // order [2,1,0] sends the extra cent to person c (index 2)
  const { txns } = ctx.addSplitExpense({ personIds: ['a', 'b', 'c'], amount: 100, order: [2, 1, 0] });
  const by = Object.fromEntries(txns.map(t => [t.personId, round2(t.amount)]));
  assert.strictEqual(by.a, 33.33);
  assert.strictEqual(by.b, 33.33);
  assert.strictEqual(by.c, 33.34);
});

test('addSplitExpense records one positive entry per person, summing to the total', () => {
  setState(freshState());
  const { txns, splitId } = ctx.addSplitExpense({ personIds: ['a', 'b', 'c'], amount: 100, note: 'Dinner' });
  assert.strictEqual(txns.length, 3);
  assert.ok(txns.every(t => t.amount > 0), 'every share is positive (they owe you)');
  assert.ok(txns.every(t => t.split === true && t.splitId === splitId), 'all legs share the splitId');
  assert.ok(txns.every(t => t.note === 'Dinner'), 'note carried onto each leg');
  assert.strictEqual(sum(txns.map(t => t.amount)), 100);
  // balances reflect each person's share
  assert.strictEqual(round2(ctx.principalOf('a')), 33.34);
  assert.strictEqual(round2(ctx.principalOf('b')), 33.33);
  assert.strictEqual(round2(ctx.principalOf('c')), 33.33);
});

test('addSplitExpense tags the group and date when given', () => {
  setState(freshState());
  const when = '2026-03-01T12:00:00.000Z';
  const { txns } = ctx.addSplitExpense({ personIds: ['a', 'b'], amount: 50, groupId: 'g1', date: when });
  assert.ok(txns.every(t => t.groupId === 'g1'), 'each leg is tagged to the group');
  assert.ok(txns.every(t => t.date === when), 'each leg carries the supplied date');
});

test('addSplitExpense ignores duplicate and unknown people ids', () => {
  setState(freshState());
  const { txns } = ctx.addSplitExpense({ personIds: ['a', 'a', 'nope'], amount: 30 });
  assert.strictEqual(txns.length, 1);
  assert.strictEqual(round2(ctx.principalOf('a')), 30);
});

test('addSplitExpense rejects a non-positive amount', () => {
  setState(freshState());
  assert.throws(() => ctx.addSplitExpense({ personIds: ['a', 'b'], amount: 0 }), /greater than zero/);
  assert.throws(() => ctx.addSplitExpense({ personIds: ['a', 'b'], amount: -5 }), /greater than zero/);
});

test('addSplitExpense rejects an empty selection', () => {
  setState(freshState());
  assert.throws(() => ctx.addSplitExpense({ personIds: [], amount: 50 }), /at least one person/);
  assert.throws(() => ctx.addSplitExpense({ personIds: ['ghost'], amount: 50 }), /at least one person/);
});

test('addSplitExpense with includeMe divides by an extra head but records no debt for you', () => {
  setState(freshState());
  // 90 split between A, B and you → 3 ways of 30 each; only A and B owe you
  const { txns, myShare } = ctx.addSplitExpense({ personIds: ['a', 'b'], amount: 90, includeMe: true });
  assert.strictEqual(txns.length, 2, 'no transaction is recorded for you');
  assert.strictEqual(round2(myShare), 30, 'your own share is reported back');
  assert.strictEqual(round2(ctx.principalOf('a')), 30);
  assert.strictEqual(round2(ctx.principalOf('b')), 30);
});

test('addSplitExpense with includeMe records your own share in history without making it a debt', () => {
  setState(freshState());
  const { myTxn, splitId } = ctx.addSplitExpense({ personIds: ['a', 'b'], amount: 90, includeMe: true, note: 'Dinner' });
  // your share is written as a transaction so the whole split shows in History
  assert.ok(myTxn, 'a self leg is returned');
  assert.strictEqual(myTxn.self, true, 'it is flagged as your own share');
  assert.strictEqual(myTxn.split, true);
  assert.strictEqual(myTxn.splitId, splitId, 'it shares the splitId with the other legs');
  assert.strictEqual(myTxn.personId, null, 'it belongs to no person, so it never counts as a debt');
  assert.strictEqual(round2(myTxn.amount), 30);
  // it lives in state alongside the two real debts (a, b, and you = 3 entries)
  assert.strictEqual(ctx.__state.transactions.length, 3);
  // and it changes nobody's balance
  assert.strictEqual(round2(ctx.principalOf('a')), 30);
  assert.strictEqual(round2(ctx.principalOf('b')), 30);
});

test('addSplitExpense without includeMe records no self leg', () => {
  setState(freshState());
  const { myTxn } = ctx.addSplitExpense({ personIds: ['a', 'b'], amount: 90 });
  assert.strictEqual(myTxn, null, 'no self leg when you are not in the split');
  assert.strictEqual(ctx.__state.transactions.length, 2);
});

test('addSplitExpense with includeMe lands the leftover cent on you, the payer', () => {
  setState(freshState());
  // 100 across A, B and you → your share 33.34, A and B owe a clean 33.33 each
  const { txns, myShare } = ctx.addSplitExpense({ personIds: ['a', 'b'], amount: 100, includeMe: true });
  assert.strictEqual(round2(myShare), 33.34, 'you absorb the extra cent');
  assert.strictEqual(round2(ctx.principalOf('a')), 33.33);
  assert.strictEqual(round2(ctx.principalOf('b')), 33.33);
  // everything still reconciles to the total once your share is added back
  assert.strictEqual(sum(txns.map(t => t.amount).concat(myShare)), 100);
});

test('splitShares whole-number mode rounds the total to the nearest whole first', () => {
  setState(freshState());
  // 100.50 → rounds to 101, then split into whole shares summing to 101
  const s = ctx.splitShares(100.5, 2, { whole: true });
  sameArr(s, [51, 50]);
  assert.strictEqual(sum(s), 101);
});

test('addSplitExpense records whole-number shares (34/33/33) when roundWhole is on', () => {
  const st = freshState();
  st.settings.roundWhole = true;
  setState(st);
  const { txns } = ctx.addSplitExpense({ personIds: ['a', 'b', 'c'], amount: 100 });
  assert.ok(txns.every(t => Number.isInteger(t.amount)), 'each recorded share is whole');
  assert.strictEqual(sum(txns.map(t => t.amount)), 100);
  // shares sum to 100 with one person absorbing the leftover unit
  const amounts = txns.map(t => round2(t.amount)).sort((x, y) => y - x);
  sameArr(amounts, [34, 33, 33]);
});

test('addSplitExpense leaves cents intact when roundWhole is off', () => {
  const st = freshState();
  st.settings.roundWhole = false;
  setState(st);
  const { txns } = ctx.addSplitExpense({ personIds: ['a', 'b', 'c'], amount: 100 });
  assert.strictEqual(round2(ctx.principalOf('a')), 33.34);
  assert.strictEqual(round2(ctx.principalOf('b')), 33.33);
  assert.strictEqual(round2(ctx.principalOf('c')), 33.33);
});
