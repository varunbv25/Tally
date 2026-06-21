/* Share-text builder tests. store.js is a classic script using a module
   global `state`; load it into a vm context and set `state` per case
   (same approach as the browser's script tag, plus an in-context assign). */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
for (const file of ['store.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx, { filename: file });
}

/* store.js declares `let state` lexically, so it isn't a property of the
   global object — reassign it by running an assignment inside the context. */
function setState(s) {
  ctx.__state = s;
  vm.runInContext('state = __state', ctx);
}

function person(id, name, currency = 'INR') {
  return { id, name, currency, interestExempt: false, interestAnchor: null, createdAt: '2026-01-01' };
}
function txn(personId, amount) {
  return { id: `${personId}:${amount}:${Math.random()}`, personId, groupId: null, amount, note: '', date: '2026-01-02T12:00:00Z', isInterest: false };
}
function baseState(over = {}) {
  return Object.assign({ people: [], groups: [], transactions: [], interestRules: [], settings: { baseCurrency: 'INR' } }, over);
}

test('shareAmount renders bare numbers with sign, trimming decimals', () => {
  assert.strictEqual(ctx.shareAmount(1200), '1200');
  assert.strictEqual(ctx.shareAmount(-50), '-50');
  assert.strictEqual(ctx.shareAmount(300.5), '300.5');
  assert.strictEqual(ctx.shareAmount(300.555), '300.56');  // round to 2
  assert.strictEqual(ctx.shareAmount(0), '0');
  assert.strictEqual(ctx.shareAmount(-0), '0');             // no "-0"
});

test('personShareText is "Name  amount" with the ledger sign convention', () => {
  const alice = person('a', 'Alice');
  const bob = person('b', 'Bob');
  setState(baseState({
    people: [alice, bob],
    transactions: [txn('a', 1200), txn('b', 200), txn('b', -250)], // Bob net -50 => you owe him
  }));
  assert.strictEqual(ctx.personShareText(alice), 'Alice  1200');
  assert.strictEqual(ctx.personShareText(bob), 'Bob  -50');
});

test('groupShareText lists non-zero members, one per line', () => {
  const a = person('a', 'Alice'), b = person('b', 'Bob'), c = person('c', 'Carol'), d = person('d', 'Dave');
  const g = { id: 'g', name: 'Goa Trip', memberIds: ['a', 'b', 'c', 'd'] };
  setState(baseState({
    people: [a, b, c, d],
    groups: [g],
    transactions: [txn('a', 1200), txn('b', -50), txn('c', 300)], // Dave has no balance
  }));
  assert.strictEqual(ctx.groupShareText(g), 'Alice  1200\nBob  -50\nCarol  300');
});

test('groupShareText reads "All square." when everyone is settled', () => {
  const a = person('a', 'Alice');
  const g = { id: 'g', name: 'Flatmates', memberIds: ['a'] };
  setState(baseState({ people: [a], groups: [g], transactions: [txn('a', 100), txn('a', -100)] }));
  assert.strictEqual(ctx.groupShareText(g), 'All square.');
});

test('groupShareText tags currency codes when the group mixes currencies', () => {
  const a = person('a', 'Alice', 'INR'), b = person('b', 'Bob', 'USD');
  const g = { id: 'g', name: 'Trip', memberIds: ['a', 'b'] };
  setState(baseState({ people: [a, b], groups: [g], transactions: [txn('a', 1200), txn('b', -50)] }));
  assert.strictEqual(ctx.groupShareText(g), 'Alice  1200 INR\nBob  -50 USD');
});

test('groupShareText omits members whose ids are excluded', () => {
  const a = person('a', 'Alice'), b = person('b', 'Bob'), c = person('c', 'Carol');
  const g = { id: 'g', name: 'Goa Trip', memberIds: ['a', 'b', 'c'] };
  setState(baseState({ people: [a, b, c], groups: [g], transactions: [txn('a', 1200), txn('b', -50), txn('c', 300)] }));
  assert.strictEqual(ctx.groupShareText(g, undefined, ['b']), 'Alice  1200\nCarol  300');
  assert.strictEqual(ctx.groupShareText(g, undefined, ['a', 'c']), 'Bob  -50');
  assert.strictEqual(ctx.groupShareText(g, undefined, ['a', 'b', 'c']), 'All square.');
});

test('excluding the only foreign-currency member drops the currency suffix', () => {
  const a = person('a', 'Alice', 'INR'), b = person('b', 'Bob', 'USD');
  const g = { id: 'g', name: 'Trip', memberIds: ['a', 'b'] };
  setState(baseState({ people: [a, b], groups: [g], transactions: [txn('a', 1200), txn('b', -50)] }));
  assert.strictEqual(ctx.groupShareText(g, undefined, ['b']), 'Alice  1200');
});

test('groupShareText skips deleted members gracefully', () => {
  const a = person('a', 'Alice');
  const g = { id: 'g', name: 'Ghosts', memberIds: ['a', 'gone'] };
  setState(baseState({ people: [a], groups: [g], transactions: [txn('a', 500)] }));
  assert.strictEqual(ctx.groupShareText(g), 'Alice  500');
});

test('peopleShareText covers exactly the people passed in, one per line', () => {
  const a = person('a', 'Alice'), b = person('b', 'Bob'), c = person('c', 'Carol');
  setState(baseState({ people: [a, b, c], transactions: [txn('a', 1200), txn('b', -50), txn('c', 300)] }));
  assert.strictEqual(ctx.peopleShareText([a, c]), 'Alice  1200\nCarol  300');
  assert.strictEqual(ctx.peopleShareText([b]), 'Bob  -50');
});

test('peopleShareText omits settled people and reads "All square." when none remain', () => {
  const a = person('a', 'Alice'), b = person('b', 'Bob');
  setState(baseState({ people: [a, b], transactions: [txn('a', 1200), txn('b', 100), txn('b', -100)] }));
  assert.strictEqual(ctx.peopleShareText([a, b]), 'Alice  1200'); // Bob is square
  assert.strictEqual(ctx.peopleShareText([b]), 'All square.');
  assert.strictEqual(ctx.peopleShareText([]), 'All square.');
});

test('peopleShareText tags currency codes only when the selection mixes currencies', () => {
  const a = person('a', 'Alice', 'INR'), b = person('b', 'Bob', 'USD');
  setState(baseState({ people: [a, b], transactions: [txn('a', 1200), txn('b', -50)] }));
  assert.strictEqual(ctx.peopleShareText([a, b]), 'Alice  1200 INR\nBob  -50 USD');
  assert.strictEqual(ctx.peopleShareText([a]), 'Alice  1200'); // single currency → no suffix
});
