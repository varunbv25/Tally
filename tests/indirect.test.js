/* Indirect-payment tests: one lender lends the same amount to several
   recipients at once. store.js is a classic script using a module global
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

function freshState() {
  return {
    people: [
      { id: 'pihu', name: 'Pihu', currency: 'INR', interestExempt: false, interestAnchor: null, createdAt: '2026-01-01' },
      { id: 'uma', name: 'Uma', currency: 'INR', interestExempt: false, interestAnchor: null, createdAt: '2026-01-01' },
      { id: 'rishi', name: 'Rishi', currency: 'INR', interestExempt: false, interestAnchor: null, createdAt: '2026-01-01' },
      { id: 'govind', name: 'Govind', currency: 'INR', interestExempt: false, interestAnchor: null, createdAt: '2026-01-01' },
    ],
    groups: [], transactions: [], interestRules: [],
    settings: { baseCurrency: 'INR', interestTz: -330 },
  };
}

test('one lender to many recipients: each owes +amt, lender drops by the total', () => {
  setState(freshState());
  const { count } = ctx.addIndirectPayments({ lenderId: 'pihu', receiverIds: ['uma', 'rishi', 'govind'], amount: 50 });
  assert.strictEqual(count, 3);
  assert.strictEqual(round2(ctx.principalOf('uma')), 50);
  assert.strictEqual(round2(ctx.principalOf('rishi')), 50);
  assert.strictEqual(round2(ctx.principalOf('govind')), 50);
  assert.strictEqual(round2(ctx.principalOf('pihu')), -150);
  // net position across everyone is unchanged (the debt just moved)
  const net = ['pihu', 'uma', 'rishi', 'govind'].reduce((s, id) => s + ctx.principalOf(id), 0);
  assert.strictEqual(round2(net), 0);
});

test('each recipient becomes its own undoable indirect pair', () => {
  setState(freshState());
  ctx.addIndirectPayments({ lenderId: 'pihu', receiverIds: ['uma', 'rishi'], amount: 50 });
  // two pairs => four legs, all tagged indirect with a linkId
  const legs = ctx.__state.transactions.filter(t => t.indirect);
  assert.strictEqual(legs.length, 4);
  assert.ok(legs.every(t => t.linkId), 'every leg is linked');
  assert.strictEqual(new Set(legs.map(t => t.linkId)).size, 2, 'one linkId per recipient');
});

test('"Me" recipient drops the lender with no new debtor (lender lent you)', () => {
  setState(freshState());
  // Pihu lent Uma 50 and lent you 50: Uma owes +50, you owe Pihu the other 50
  const { count } = ctx.addIndirectPayments({ lenderId: 'pihu', receiverIds: ['uma'], includeMe: true, amount: 50 });
  assert.strictEqual(count, 2);
  assert.strictEqual(round2(ctx.principalOf('uma')), 50);
  assert.strictEqual(round2(ctx.principalOf('pihu')), -100);
  // only Uma's pair is a real debtor leg; the "Me" share is a plain lender leg
  assert.strictEqual(ctx.__state.transactions.filter(t => t.personId === 'uma').length, 1);
});

test('the lender is never charged as their own recipient', () => {
  setState(freshState());
  const { count } = ctx.addIndirectPayments({ lenderId: 'pihu', receiverIds: ['pihu', 'uma'], amount: 50 });
  assert.strictEqual(count, 1, 'lender filtered out of recipients');
  assert.strictEqual(round2(ctx.principalOf('uma')), 50);
  assert.strictEqual(round2(ctx.principalOf('pihu')), -50);
});

test('custom amounts: each recipient owes their own figure, lender drops by the sum', () => {
  setState(freshState());
  const { count, total } = ctx.addIndirectPayments({
    lenderId: 'pihu',
    receiverIds: ['uma', 'rishi', 'govind'],
    amounts: { uma: 70, rishi: 50, govind: 30 },
  });
  assert.strictEqual(count, 3);
  assert.strictEqual(round2(total), 150);
  assert.strictEqual(round2(ctx.principalOf('uma')), 70);
  assert.strictEqual(round2(ctx.principalOf('rishi')), 50);
  assert.strictEqual(round2(ctx.principalOf('govind')), 30);
  assert.strictEqual(round2(ctx.principalOf('pihu')), -150);
  const net = ['pihu', 'uma', 'rishi', 'govind'].reduce((s, id) => s + ctx.principalOf(id), 0);
  assert.strictEqual(round2(net), 0);
});

test('custom amounts: the "Me" share uses meAmount, not the recipient figures', () => {
  setState(freshState());
  const { count } = ctx.addIndirectPayments({
    lenderId: 'pihu',
    receiverIds: ['uma'],
    includeMe: true,
    amounts: { uma: 70 },
    meAmount: 30,
  });
  assert.strictEqual(count, 2);
  assert.strictEqual(round2(ctx.principalOf('uma')), 70);
  assert.strictEqual(round2(ctx.principalOf('pihu')), -100);
});

test('custom amounts: a missing or non-positive share records nothing at all', () => {
  setState(freshState());
  assert.throws(() => ctx.addIndirectPayments({
    lenderId: 'pihu', receiverIds: ['uma', 'rishi'], amounts: { uma: 70 },
  }), /greater than zero/);
  assert.throws(() => ctx.addIndirectPayments({
    lenderId: 'pihu', receiverIds: ['uma', 'rishi'], amounts: { uma: 70, rishi: 0 },
  }), /greater than zero/);
  assert.throws(() => ctx.addIndirectPayments({
    lenderId: 'pihu', receiverIds: ['uma'], includeMe: true, amounts: { uma: 70 },
  }), /greater than zero/);
  // the valid recipient in each rejected call must not have been charged
  assert.strictEqual(ctx.__state.transactions.length, 0);
  assert.strictEqual(round2(ctx.principalOf('uma')), 0);
  assert.strictEqual(round2(ctx.principalOf('pihu')), 0);
});

test('rejects a non-positive amount and an empty recipient set', () => {
  setState(freshState());
  assert.throws(() => ctx.addIndirectPayments({ lenderId: 'pihu', receiverIds: ['uma'], amount: 0 }), /greater than zero/);
  assert.throws(() => ctx.addIndirectPayments({ lenderId: 'pihu', receiverIds: [], amount: 50 }), /at least one recipient/);
  assert.throws(() => ctx.addIndirectPayments({ lenderId: 'ghost', receiverIds: ['uma'], amount: 50 }), /Pick the lender/);
});
