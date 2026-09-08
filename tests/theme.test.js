/* Theme-resolution tests.

   The theme is resolved twice, in two places, on every load: the inline boot
   script in index.html has to stamp it before first paint (so there is no
   flash of the wrong palette, and so Safari reads the right Apple status-bar
   meta), and app.js re-resolves it from loaded state afterwards. Two copies of
   one rule drift — a divergence shows up as a flash on launch rather than as
   anything that throws — so these pin them to the same truth table.

   Both are classic scripts, so each is loaded into a vm realm with the bits of
   the DOM it touches faked out. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const LS_KEY = 'tally-ledger-v1';

/* The truth table both resolvers owe us: an explicit choice pins the theme,
   and everything else — the 'device' default, a stray value, a ledger with no
   settings at all — follows the OS. */
const CASES = [
  { setting: 'light', osDark: false, want: 'light' },
  { setting: 'light', osDark: true,  want: 'light' },
  { setting: 'dark',  osDark: false, want: 'dark'  },
  { setting: 'dark',  osDark: true,  want: 'dark'  },
  { setting: 'device', osDark: false, want: 'light' },
  { setting: 'device', osDark: true,  want: 'dark'  },
  { setting: undefined, osDark: true, want: 'dark' },
  { setting: 'nonsense', osDark: true, want: 'dark' },
];

/* index.html's boot script, run against a fake <html>/<meta> and a stored
   ledger. Returns what it stamped. */
function runBootScript({ stored, osDark, throwOnStorage = false, noMatchMedia = false }) {
  const src = read('index.html').match(/<script>([\s\S]*?)<\/script>/)[1];
  const attrs = { html: {}, 'meta[name="theme-color"]': {}, 'meta[name="apple-mobile-web-app-status-bar-style"]': {} };
  const node = key => ({ setAttribute: (k, v) => { attrs[key][k] = v; } });
  const ctx = {
    localStorage: {
      getItem: k => {
        if (throwOnStorage) throw new Error('storage disabled');
        return k === LS_KEY && stored !== undefined ? JSON.stringify(stored) : null;
      },
    },
    document: {
      documentElement: node('html'),
      querySelector: sel => (sel in attrs ? node(sel) : null),
    },
    window: noMatchMedia ? {} : { matchMedia: q => ({ matches: /dark/.test(q) && osDark }) },
  };
  vm.runInNewContext(src, ctx, { filename: 'index.html boot' });
  return {
    theme: attrs.html['data-theme'],
    barColor: attrs['meta[name="theme-color"]'].content,
    iosBar: attrs['meta[name="apple-mobile-web-app-status-bar-style"]'].content,
  };
}

/* app.js's resolvedTheme(), which needs only `state` and matchMedia — the rest
   of the file is stubbed out to whatever it takes to evaluate. */
function appResolvedTheme({ setting, osDark }) {
  const ctx = vm.createContext({
    window: { matchMedia: q => ({ matches: /dark/.test(q) && osDark }), addEventListener: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  const src = read('app.js');
  const start = src.indexOf('function prefersDark()');
  const end = src.indexOf('function applyTheme()');
  assert.ok(start > 0 && end > start, 'prefersDark/resolvedTheme block not found in app.js');
  vm.runInContext(src.slice(start, end), ctx, { filename: 'app.js theme block' });
  ctx.__state = { settings: { theme: setting } };
  vm.runInContext('state = __state', ctx);
  return vm.runInContext('resolvedTheme()', ctx);
}

for (const { setting, osDark, want } of CASES) {
  const label = `theme '${setting}' on an OS in ${osDark ? 'dark' : 'light'} resolves to ${want}`;

  test(`boot script: ${label}`, () => {
    const stored = setting === undefined ? {} : { settings: { theme: setting } };
    assert.strictEqual(runBootScript({ stored, osDark }).theme, want);
  });

  test(`app.js: ${label}`, () => {
    assert.strictEqual(appResolvedTheme({ setting, osDark }), want);
  });
}

test('boot script stamps the status-bar metas to match the theme it picked', () => {
  const dark = runBootScript({ stored: {}, osDark: true });
  assert.strictEqual(dark.theme, 'dark');
  assert.strictEqual(dark.barColor, '#171917');
  assert.strictEqual(dark.iosBar, 'black-translucent');

  const light = runBootScript({ stored: {}, osDark: false });
  assert.strictEqual(light.theme, 'light');
  assert.strictEqual(light.barColor, '#ffffff');
  assert.strictEqual(light.iosBar, 'default');
});

/* A first paint with no palette stamped at all shows the CSS default over a
   dark app, so the boot script must still land a theme when the pieces it
   reads are missing rather than bailing out of the whole block. */
test('boot script still stamps a theme when localStorage throws', () => {
  assert.strictEqual(runBootScript({ osDark: true, throwOnStorage: true }).theme, 'dark');
  assert.strictEqual(runBootScript({ osDark: false, throwOnStorage: true }).theme, 'light');
});

test('boot script falls back to light where matchMedia is unavailable', () => {
  assert.strictEqual(runBootScript({ stored: {}, osDark: true, noMatchMedia: true }).theme, 'light');
  assert.strictEqual(runBootScript({ stored: { settings: { theme: 'dark' } }, noMatchMedia: true }).theme, 'dark');
});

/* loadState normalises the setting, so resolvedTheme only ever sees the three
   real values in the app — but an explicit choice has to survive that pass. */
test('loadState keeps an explicit theme and normalises anything else to device', () => {
  const cases = [['light', 'light'], ['dark', 'dark'], ['device', 'device'], ['system', 'device'], [undefined, 'device']];
  for (const [stored, want] of cases) {
    const raw = JSON.stringify({ people: [], transactions: [], settings: stored === undefined ? {} : { theme: stored } });
    const ctx = vm.createContext({ localStorage: { getItem: () => raw, setItem: () => {}, removeItem: () => {} } });
    vm.runInContext(read('store.js'), ctx, { filename: 'store.js' });
    vm.runInContext('loadState()', ctx);
    assert.strictEqual(vm.runInContext('state.settings.theme', ctx), want, `stored '${stored}'`);
  }
});
