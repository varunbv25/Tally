/* =========================================================
   TALLY — notifications engine
   Pure evaluation shared by the page and the service worker.
   Uses store.js helpers (totalOf, accruedInterest, principalOf,
   personTxns, fmtMoney); assigns the store's global `state`
   from the snapshot it is given before evaluating.
   Dedupe: once-per-crossing. log = { fired: {key: ts}, lastNudge: ts }.
   A key present in log.fired means "already notified for the current
   crossing"; it is deleted (re-armed) when the condition turns false.
   ========================================================= */

const NOTIF_DEFAULTS = {
  enabled: false,
  agingDebt:         { enabled: true, days: 30 },
  recurringNudge:    { enabled: true, cadence: 'weekly' },   // 'weekly' | 'monthly'
  balanceThreshold:  { enabled: true, amount: 1000 },
  settleUpNudge:     { enabled: true, days: 7 },
  interestMilestone: { enabled: true, amount: 100 },
  capitalizeSuggest: { enabled: true, percent: 10 },
  scheduledDue:      { enabled: true },   // a future-dated (scheduled) debt has reached its day
};

const NUDGE_MS = { weekly: 7 * 86_400_000, monthly: 30 * 86_400_000 };
const DAY_MS = 86_400_000;

/* Merge saved settings with defaults so old backups and future
   scenarios always yield a complete object. Writes the merged
   result back so UI mutations have a stable target. */
function notifSettings(st) {
  const saved = st.settings.notifications || {};
  const merged = { enabled: !!saved.enabled };
  for (const key of Object.keys(NOTIF_DEFAULTS)) {
    if (key === 'enabled') continue;
    merged[key] = Object.assign({}, NOTIF_DEFAULTS[key], saved[key]);
  }
  st.settings.notifications = merged;
  return merged;
}

/* Start of the current debt-aging window: when the balance last went
   positive, or the last repayment while still in debt (a partial
   repayment restarts the clock). null when they don't owe you. */
function agingSince(personId) {
  let bal = 0, since = null;
  for (const t of personTxns(personId)) {
    const was = bal;
    bal += t.amount;
    const ts = new Date(t.date).getTime();
    if (was <= 0.005 && bal > 0.005) since = ts;
    else if (t.amount < 0 && bal > 0.005) since = ts;
  }
  return bal > 0.005 ? since : null;
}

/* When the balance last went negative (you started owing them). */
function owingSince(personId) {
  let bal = 0, since = null;
  for (const t of personTxns(personId)) {
    const was = bal;
    bal += t.amount;
    if (was >= -0.005 && bal < -0.005) since = new Date(t.date).getTime();
  }
  return bal < -0.005 ? since : null;
}

function evaluateNotifications(st, log, now) {
  state = st;                          // store.js helpers read this global
  const ns = notifSettings(st);
  log.fired = log.fired || {};
  const due = [];
  if (!ns.enabled) return due;

  const ids = new Set(st.people.map(p => p.id));
  const schedIds = new Set((st.scheduled || []).map(s => s.id));
  for (const key of Object.keys(log.fired)) {
    // re-arm a scheduled reminder's key only once its debt is gone (confirmed/discarded)
    if (key.startsWith('scheduled:')) {
      if (!schedIds.has(key.slice('scheduled:'.length))) delete log.fired[key];
      continue;
    }
    const pid = key.split(':')[1];
    if (pid && !ids.has(pid)) delete log.fired[key];
  }

  const mark = (cond, key, title, body) => {
    if (cond && !log.fired[key]) { log.fired[key] = now; due.push({ key, title, body }); }
    else if (!cond && log.fired[key]) delete log.fired[key];
  };

  for (const p of st.people) {
    const total = totalOf(p, now);
    const interest = accruedInterest(p, now);
    const principal = principalOf(p.id);

    if (ns.agingDebt.enabled) {
      const since = agingSince(p.id);
      const days = since === null ? 0 : Math.floor((now - since) / DAY_MS);
      mark(since !== null && now - since >= ns.agingDebt.days * DAY_MS,
        `aging:${p.id}`, 'Aging debt',
        `${p.name} has owed you ${fmtMoney(total, p.currency)} for ${days} days.`);
    }

    if (ns.balanceThreshold.enabled) {
      mark(total > ns.balanceThreshold.amount,
        `threshold:${p.id}`, 'Balance threshold crossed',
        `${p.name} now owes you ${fmtMoney(total, p.currency)} — over your ${fmtMoney(ns.balanceThreshold.amount, p.currency)} threshold.`);
    }

    if (ns.settleUpNudge.enabled) {
      const since = owingSince(p.id);
      const days = since === null ? 0 : Math.floor((now - since) / DAY_MS);
      mark(since !== null && now - since >= ns.settleUpNudge.days * DAY_MS,
        `settleup:${p.id}`, `You owe ${p.name}`,
        `You've owed ${p.name} ${fmtMoney(-total, p.currency)} for ${days} days. Time to settle up?`);
    }

    if (ns.interestMilestone.enabled) {
      mark(ns.interestMilestone.amount > 0 && interest >= ns.interestMilestone.amount,
        `milestone:${p.id}`, 'Interest milestone',
        `Accrued interest on ${p.name}'s debt has reached ${fmtMoney(interest, p.currency)}.`);
    }

    if (ns.capitalizeSuggest.enabled) {
      mark(principal > 0.005 && interest > 0.005 &&
           interest >= principal * ns.capitalizeSuggest.percent / 100,
        `capitalize:${p.id}`, 'Capitalize interest?',
        `${p.name}'s accrued interest (${fmtMoney(interest, p.currency)}) is over ${ns.capitalizeSuggest.percent}% of the principal.`);
    }
  }

  if (ns.scheduledDue && ns.scheduledDue.enabled) {
    for (const s of (st.scheduled || [])) {
      const p = st.people.find(x => x.id === s.personId);
      if (!p) continue;
      const owe = s.amount >= 0;
      mark(new Date(s.date).getTime() <= now,
        `scheduled:${s.id}`, 'Scheduled debt due',
        `${s.note ? '“' + s.note + '” — ' : ''}${owe ? p.name + ' owes you' : 'you owe ' + p.name} ${fmtMoney(Math.abs(s.amount), p.currency)}. Open Tally to confirm.`);
    }
  }

  if (ns.recurringNudge.enabled) {
    const debtors = st.people.filter(p => totalOf(p, now) > 0.005);
    if (debtors.length && now - (log.lastNudge || 0) >= NUDGE_MS[ns.recurringNudge.cadence]) {
      const names = debtors.slice(0, 5)
        .map(p => `${p.name} (${fmtMoney(totalOf(p, now), p.currency)})`).join(', ');
      const extra = debtors.length > 5 ? ` and ${debtors.length - 5} more` : '';
      due.push({
        key: `nudge:${now}`, title: 'Tally reminder',
        body: `${names}${extra} still owe${debtors.length === 1 ? 's' : ''} you.`,
      });
      log.lastNudge = now;
    }
  }

  return due;
}

function badgeCount(st, now = Date.now()) {
  state = st;
  return st.people.filter(p => totalOf(p, now) > 0.005).length;
}

/* ---------- IndexedDB mirror ----------
   The service worker can't read localStorage, so the ledger and the
   notification log live (also) in IDB. Works in window and SW. */

const NOTIF_DB = 'tally-db';

function idbStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(NOTIF_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

function idbGet(key) { return idbStore('readonly', s => s.get(key)); }
function idbSet(key, value) { return idbStore('readwrite', s => s.put(value, key)); }
