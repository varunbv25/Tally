/* Engine unit tests. store.js + notif.js are classic scripts sharing
   globals, so load them into one vm context (same as browser script tags). */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
for (const file of ['store.js', 'notif.js', 'push.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx, { filename: file });
}
/* store.js keeps `state` as a module-scoped binding; assign it the same way
   the engine does internally so tests can drive accruedInterest directly. */
function setState(st) { ctx.__st = st; vm.runInContext('state = __st', ctx); }

const DAY = 86_400_000;
const NOW = new Date('2026-06-12T12:00:00Z').getTime();

function person(id, name = id) {
  return { id, name, currency: 'INR', interestExempt: false, interestAnchor: null, createdAt: '2026-01-01' };
}
function txn(personId, amount, daysAgo, isInterest = false) {
  return {
    id: `${personId}:${daysAgo}:${amount}`, personId, groupId: null, amount,
    note: '', date: new Date(NOW - daysAgo * DAY).toISOString(), isInterest,
  };
}
function makeState({ people = [], transactions = [], interestRules = [], notifications = {} } = {}) {
  return {
    people, groups: [], transactions, interestRules,
    settings: { baseCurrency: 'INR', notifications: Object.assign({ enabled: true }, notifications) },
  };
}
/* lastNudge defaults to NOW so the recurring nudge stays quiet in scenario tests */
function freshLog() { return { fired: {}, lastNudge: NOW }; }
function keys(due, prefix) { return due.filter(d => d.key.startsWith(prefix)); }

const DAILY_1PCT = [{
  id: 'r1', name: '1%/day', enabled: true, op: '>', value: 0,
  type: 'simple', rate: 1, periodUnit: 'day', capPeriods: null, groupId: null,
}];

test('master toggle off silences everything', () => {
  const st = makeState({
    people: [person('a', 'Priya')],
    transactions: [txn('a', 2000, 60)],
    notifications: { enabled: false },
  });
  assert.strictEqual(ctx.evaluateNotifications(st, freshLog(), NOW).length, 0);
});

test('aging debt fires at N days, not before, and dedupes', () => {
  const young = makeState({ people: [person('a', 'Priya')], transactions: [txn('a', 2000, 29)] });
  assert.strictEqual(keys(ctx.evaluateNotifications(young, freshLog(), NOW), 'aging:').length, 0);

  const old = makeState({ people: [person('a', 'Priya')], transactions: [txn('a', 2000, 31)] });
  const log = freshLog();
  const first = keys(ctx.evaluateNotifications(old, log, NOW), 'aging:');
  assert.strictEqual(first.length, 1);
  assert.match(first[0].body, /Priya/);
  /* second run: nothing new */
  assert.strictEqual(keys(ctx.evaluateNotifications(old, log, NOW), 'aging:').length, 0);
});

test('partial repayment resets the aging clock; full repayment re-arms', () => {
  /* borrowed 40d ago, repaid some 10d ago -> clock restarts at 10d -> no aging */
  const repaid = makeState({
    people: [person('a')],
    transactions: [txn('a', 2000, 40), txn('a', -500, 10)],
  });
  assert.strictEqual(keys(ctx.evaluateNotifications(repaid, freshLog(), NOW), 'aging:').length, 0);

  /* condition gone -> fired key is re-armed */
  const log = freshLog();
  log.fired['aging:a'] = NOW - 5 * DAY;
  ctx.evaluateNotifications(repaid, log, NOW);
  assert.strictEqual(log.fired['aging:a'], undefined);
});

test('balance threshold fires on crossing and re-arms when it drops back', () => {
  const st = makeState({ people: [person('a', 'Sam')], transactions: [txn('a', 1500, 1)] });
  const log = freshLog();
  assert.strictEqual(keys(ctx.evaluateNotifications(st, log, NOW), 'threshold:').length, 1);
  assert.strictEqual(keys(ctx.evaluateNotifications(st, log, NOW), 'threshold:').length, 0);

  st.transactions.push(txn('a', -1000, 0));            // drops to 500 -> re-arm
  ctx.evaluateNotifications(st, log, NOW);
  assert.strictEqual(log.fired['threshold:a'], undefined);

  st.transactions.push(txn('a', 1000, 0));             // back to 1500 -> fires again
  assert.strictEqual(keys(ctx.evaluateNotifications(st, log, NOW), 'threshold:').length, 1);
});

test('settle-up nudge when you have owed someone for N days', () => {
  const recent = makeState({ people: [person('a')], transactions: [txn('a', -300, 3)] });
  assert.strictEqual(keys(ctx.evaluateNotifications(recent, freshLog(), NOW), 'settleup:').length, 0);

  const old = makeState({ people: [person('a', 'Lee')], transactions: [txn('a', -300, 8)] });
  const due = keys(ctx.evaluateNotifications(old, freshLog(), NOW), 'settleup:');
  assert.strictEqual(due.length, 1);
  assert.match(due[0].title, /Lee/);
});

test('interest milestone fires when accrued interest reaches the amount', () => {
  /* 10000 at 1%/day simple for 2 days = 200 accrued >= 100 */
  const st = makeState({
    people: [person('a')], transactions: [txn('a', 10000, 2)], interestRules: DAILY_1PCT,
  });
  assert.strictEqual(keys(ctx.evaluateNotifications(st, freshLog(), NOW), 'milestone:').length, 1);

  const small = makeState({
    people: [person('a')], transactions: [txn('a', 100, 2)], interestRules: DAILY_1PCT,
  });
  assert.strictEqual(keys(ctx.evaluateNotifications(small, freshLog(), NOW), 'milestone:').length, 0);
});

test('capitalize suggestion when interest exceeds percent of principal', () => {
  /* 1%/day simple for 15 days = 15% of principal >= 10% */
  const st = makeState({
    people: [person('a')], transactions: [txn('a', 1000, 15)], interestRules: DAILY_1PCT,
    notifications: { interestMilestone: { enabled: false } },   // isolate
  });
  assert.strictEqual(keys(ctx.evaluateNotifications(st, freshLog(), NOW), 'capitalize:').length, 1);

  const early = makeState({
    people: [person('a')], transactions: [txn('a', 1000, 5)], interestRules: DAILY_1PCT,
  });
  assert.strictEqual(keys(ctx.evaluateNotifications(early, freshLog(), NOW), 'capitalize:').length, 0);
});

test('recurring nudge respects cadence and lists debtors', () => {
  const st = makeState({
    people: [person('a', 'Priya'), person('b', 'Sam')],
    transactions: [txn('a', 2000, 5), txn('b', -100, 5)],
  });
  /* nudged 3 days ago, weekly cadence -> quiet */
  const quiet = { fired: {}, lastNudge: NOW - 3 * DAY };
  assert.strictEqual(keys(ctx.evaluateNotifications(st, quiet, NOW), 'nudge:').length, 0);

  /* nudged 8 days ago -> fires, only the debtor is listed, lastNudge updates */
  const log = { fired: {}, lastNudge: NOW - 8 * DAY };
  const due = keys(ctx.evaluateNotifications(st, log, NOW), 'nudge:');
  assert.strictEqual(due.length, 1);
  assert.match(due[0].body, /Priya/);
  assert.doesNotMatch(due[0].body, /Sam/);
  assert.strictEqual(log.lastNudge, NOW);
});

test('disabled scenario stays quiet', () => {
  const st = makeState({
    people: [person('a')], transactions: [txn('a', 2000, 60)],
    notifications: { agingDebt: { enabled: false } },
  });
  assert.strictEqual(keys(ctx.evaluateNotifications(st, freshLog(), NOW), 'aging:').length, 0);
});

test('log entries for deleted people are pruned', () => {
  const st = makeState({ people: [person('a')], transactions: [txn('a', 100, 1)] });
  const log = freshLog();
  log.fired['threshold:ghost'] = NOW - DAY;
  ctx.evaluateNotifications(st, log, NOW);
  assert.strictEqual(log.fired['threshold:ghost'], undefined);
});

test('badgeCount counts only people who owe you', () => {
  const st = makeState({
    people: [person('a'), person('b'), person('c')],
    transactions: [txn('a', 100, 1), txn('b', -50, 1)],
  });
  assert.strictEqual(ctx.badgeCount(st, NOW), 1);
});

/* ---------- projection (push.js) ---------- */

test('projectSchedule predicts a future aging crossing', () => {
  /* borrowed 20 days ago, aging at 30 days -> fires ~10 days out */
  const st = makeState({
    people: [person('a', 'Priya')], transactions: [txn('a', 2000, 20)],
    notifications: { recurringNudge: { enabled: false }, balanceThreshold: { enabled: false } },
  });
  const sched = ctx.projectSchedule(st, freshLog(), NOW);
  const aging = sched.filter(e => e.key === 'aging:a');
  assert.strictEqual(aging.length, 1);
  const expected = NOW + 10 * DAY;
  assert.ok(Math.abs(aging[0].fireAt - expected) <= 6 * 3600 * 1000 + 1,
    `fireAt ${new Date(aging[0].fireAt)} not within a step of ${new Date(expected)}`);
  assert.match(aging[0].body, /Priya/);
});

test('projectSchedule excludes currently-due and already-fired items', () => {
  /* 40-day-old debt: aging + threshold due NOW -> local check owns them */
  const st = makeState({
    people: [person('a')], transactions: [txn('a', 2000, 40)],
    notifications: { recurringNudge: { enabled: false } },
  });
  const sched = ctx.projectSchedule(st, freshLog(), NOW);
  assert.strictEqual(sched.length, 0);

  /* already-fired key (condition still true) stays excluded */
  const log = freshLog();
  log.fired['aging:a'] = NOW - DAY;   // fired yesterday, debt still aging
  log.fired['threshold:a'] = NOW - DAY;
  assert.strictEqual(ctx.projectSchedule(st, log, NOW).length, 0);
});

test('projectSchedule finds interest-driven crossings', () => {
  /* 1000 at 1%/day simple -> interest hits 100 (milestone) after 10 charges.
     The debt is dated at noon UTC (NOW) and the first charge lands at the
     next local midnight, so the 10th charge falls ~9.5 days out (tests run
     in UTC: noon -> midnight is +12h, landing the 10th charge at +9.5d). */
  const st = makeState({
    people: [person('a')], transactions: [txn('a', 1000, 0)], interestRules: DAILY_1PCT,
    notifications: { recurringNudge: { enabled: false }, agingDebt: { enabled: false },
                     balanceThreshold: { enabled: false }, capitalizeSuggest: { enabled: false } },
  });
  const m = ctx.projectSchedule(st, freshLog(), NOW).filter(e => e.key === 'milestone:a');
  assert.strictEqual(m.length, 1);
  assert.ok(Math.abs(m[0].fireAt - (NOW + 9.5 * DAY)) <= 6 * 3600 * 1000 + 1);
});

test('interest is phased by the ledger timezone, not the viewing device', () => {
  /* 1000 at 1%/day simple = 10 per charge. The phasing must come from
     settings.interestTz, which rides along in the synced ledger, so two devices
     reading the same ledger book the same charges at the same instants no
     matter where either of them is standing. Reading the device's own timezone
     is what used to make two phones disagree on what was owed. */
  const IST = -330, EDT = 240;
  const start = Date.parse('2026-01-01T00:00:00Z');
  const p = person('a');
  const t1 = { id: 't1', personId: 'a', groupId: null, amount: 1000, note: '',
               date: new Date(start).toISOString(), isInterest: false };
  const rule = { id: 'r', name: 'r', enabled: true, op: '>', value: 0,
                 type: 'simple', rate: 1, periodUnit: 'day', capPeriods: null, groupId: null };
  const make = interestTz => ({
    people: [p], groups: [], transactions: [t1], interestRules: [rule],
    settings: { baseCurrency: 'INR', interestTz },
  });
  const charges = (tz, t) => { setState(make(tz)); return Math.round(ctx.accruedInterest(p, t) / 10); };

  /* IST (UTC+5:30) ticks at 18:30 UTC; EDT (UTC-4) ticks at 04:00 UTC. Midway
     through Jan 6 UTC the EDT-phased ledger has already booked that day's
     charge and the IST-phased one has not — so the stored offset, and nothing
     else, decides the amount. */
  assert.strictEqual(charges(IST, start + 5.5 * DAY), 5);
  assert.strictEqual(charges(EDT, start + 5.5 * DAY), 6);

  /* Past the IST tick they agree again — the difference is phase, not rate. */
  assert.strictEqual(charges(IST, start + 5.78 * DAY), 6);
  assert.strictEqual(charges(EDT, start + 5.78 * DAY), 6);
});

test('a ledger with no interestTz migrates from the old tzHistory', () => {
  /* Existing ledgers carry tzHistory. The migration must take the EARLIEST
     segment — the offset the ledger was created in, which nearly all of its
     interest was charged at — and must ignore the bogus segments the sync bug
     appended, which is what made two devices disagree in the same timezone. */
  const clean = { settings: { baseCurrency: 'INR', tzHistory: [{ since: 0, offsetMin: -330 }] } };
  const poisoned = { settings: { baseCurrency: 'INR', tzHistory: [
    { since: 0, offsetMin: -330 },
    { since: 1000, offsetMin: 240 },
    { since: 2000, offsetMin: -330 },
  ] } };
  for (const st of [clean, poisoned]) {
    setState(st);
    ctx.ensureInterestTimezone();
    assert.strictEqual(st.settings.interestTz, -330, 'seeded from the original offset');
    assert.strictEqual(st.settings.tzHistory, undefined, 'old history dropped');
  }
});

test('projectSchedule repeats the nudge at its cadence across the horizon', () => {
  const st = makeState({
    people: [person('a', 'Priya')], transactions: [txn('a', 500, 1)],
    notifications: { agingDebt: { enabled: false }, balanceThreshold: { enabled: false },
                     interestMilestone: { enabled: false }, capitalizeSuggest: { enabled: false } },
  });
  const nudges = ctx.projectSchedule(st, freshLog(), NOW).filter(e => e.key.startsWith('nudge:'));
  assert.strictEqual(nudges.length, 12);                      // 7,14,...,84 days
  assert.strictEqual(nudges[0].fireAt, NOW + 7 * DAY);
  assert.strictEqual(nudges[1].fireAt - nudges[0].fireAt, 7 * DAY);
});

test('projectSchedule does not mutate the real log', () => {
  const st = makeState({ people: [person('a')], transactions: [txn('a', 2000, 20)] });
  const log = freshLog();
  ctx.projectSchedule(st, log, NOW);
  assert.strictEqual(Object.keys(log.fired).length, 0);
  assert.strictEqual(log.lastNudge, NOW);
});

test('notifSettings merges defaults into old saved state', () => {
  const st = makeState({});
  delete st.settings.notifications;                    // pre-feature backup
  const ns = ctx.notifSettings(st);
  assert.strictEqual(ns.enabled, false);
  assert.strictEqual(ns.agingDebt.days, 30);
  assert.strictEqual(st.settings.notifications.balanceThreshold.amount, 1000);
});
