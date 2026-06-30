/* effectiveAnnualRate: the honest "cost per year" a periodic interest rule
   implies. Compound grows on the running balance; simple just scales by
   periods/year. store.js is a classic script using a module global `state`;
   load it into a vm context like the other suites. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'store.js'), 'utf8'), ctx, { filename: 'store.js' });

test('2%/month compound is ~26.8% effective annual', () => {
  const ear = ctx.effectiveAnnualRate(2, 'month', 'compound');
  assert.ok(Math.abs(ear - 26.82) < 0.05, `expected ~26.82, got ${ear}`);
});

test('simple interest scales linearly by periods per year', () => {
  assert.strictEqual(ctx.effectiveAnnualRate(1, 'day', 'simple'), 365);
  assert.strictEqual(ctx.effectiveAnnualRate(5, 'month', 'simple'), 60);
});

test('a yearly rate is its own effective annual rate', () => {
  assert.ok(Math.abs(ctx.effectiveAnnualRate(10, 'year', 'compound') - 10) < 1e-9);
});

test('returns null for a zero rate or an unknown period', () => {
  assert.strictEqual(ctx.effectiveAnnualRate(0, 'month', 'compound'), null);
  assert.strictEqual(ctx.effectiveAnnualRate(5, 'fortnight', 'compound'), null);
});
