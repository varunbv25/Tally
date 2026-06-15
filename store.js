/* =========================================================
   TALLY — data layer
   State, persistence, interest engine, formatting engine.
   Sign convention: positive amount  => they owe you more
                    negative amount  => they paid you back / you owe them
   A person's balance is GLOBAL. Groups only reference people,
   so a change made anywhere is reflected everywhere.
   ========================================================= */

const LS_KEY = 'tally-ledger-v1';

const CURRENCIES = [
  { code: 'INR', name: 'Indian Rupee' },
  { code: 'USD', name: 'US Dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British Pound' },
  { code: 'JPY', name: 'Japanese Yen' },
  { code: 'AED', name: 'UAE Dirham' },
  { code: 'AUD', name: 'Australian Dollar' },
  { code: 'CAD', name: 'Canadian Dollar' },
  { code: 'SGD', name: 'Singapore Dollar' },
  { code: 'CHF', name: 'Swiss Franc' },
  { code: 'CNY', name: 'Chinese Yuan' },
  { code: 'KRW', name: 'South Korean Won' },
];

const PERIOD_MS = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30.436875 * 86_400_000,   // mean Gregorian month
  year: 365.2425 * 86_400_000,
};

const OPS = ['>', '>=', '<', '<=', '='];

let state = null;

function defaultState() {
  return {
    people: [],        // {id, name, currency, interestExempt, interestAnchor, createdAt}
    groups: [],        // {id, name, memberIds: []}
    transactions: [],  // {id, personId, groupId|null, amount, note, date, isInterest}
    interestRules: [], // {id, name, enabled, op, value, type:'simple'|'compound', rate, periodUnit, capPeriods|null, groupId|null}
                       // groupId null = applies to everyone; otherwise only to members of that group
    settings: {
      baseCurrency: 'INR',        // default currency for new people
      resetInterestOnDrop: false, // wipe accrued interest when balance stops matching any rule
    },
  };
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    state = raw ? Object.assign(defaultState(), JSON.parse(raw)) : null;
  } catch { state = null; }
  if (!state) {
    state = defaultState();
    saveState();
  }
}

function saveState() {
  const json = JSON.stringify(state);
  localStorage.setItem(LS_KEY, json);
  /* mirror for the service worker (it can't read localStorage);
     idbSet lives in notif.js — guard for load order and tests */
  if (typeof idbSet === 'function' && typeof indexedDB !== 'undefined') {
    idbSet('state', json).catch(() => {});
  }
}

/* ---------- CRUD ---------- */

function addPerson(name, currency) {
  const p = {
    id: uid(), name: name.trim(), currency: currency || state.settings.baseCurrency,
    interestExempt: false, interestAnchor: null, createdAt: new Date().toISOString(),
  };
  state.people.push(p);
  return p;
}

function getPerson(id) { return state.people.find(p => p.id === id); }

function deletePerson(id) {
  state.people = state.people.filter(p => p.id !== id);
  state.transactions = state.transactions.filter(t => t.personId !== id);
  state.groups.forEach(g => { g.memberIds = g.memberIds.filter(m => m !== id); });
}

function addGroup(name, memberIds) {
  const g = { id: uid(), name: name.trim(), memberIds: [...new Set(memberIds)] };
  state.groups.push(g);
  return g;
}

function getGroup(id) { return state.groups.find(g => g.id === id); }

function deleteGroup(id) {
  state.groups = state.groups.filter(g => g.id !== id);
  state.transactions.forEach(t => { if (t.groupId === id) t.groupId = null; });
}

function groupsOf(personId) {
  return state.groups.filter(g => g.memberIds.includes(personId));
}

function addTransaction({ personId, groupId = null, amount, note = '', date = null, isInterest = false }) {
  const t = {
    id: uid(), personId, groupId,
    amount: Number(amount),
    note: note.trim(),
    date: date || new Date().toISOString(),
    isInterest,
  };
  state.transactions.push(t);
  return t;
}

function deleteTransaction(id) {
  state.transactions = state.transactions.filter(t => t.id !== id);
}

/* ---------- indirect payments (debt routing) ----------
   When someone who owes you (the LENDER) is themselves owed by a third
   person (the RECEIVER), the debt can be routed onto your ledger:
     - the lender's balance with you DROPS by the amount, and
     - the receiver now owes YOU that same amount.
   Your overall position is unchanged — the debt just moves to whoever
   can actually pay. Recorded as two linked transactions (shared linkId)
   so the pair shows in History and can be undone together. */
function addIndirectPayment({ lenderId, receiverId, amount, note = '', date = null }) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Enter an amount greater than zero.');
  if (!lenderId || !receiverId) throw new Error('Pick both people.');
  if (lenderId === receiverId) throw new Error('Pick two different people.');
  const lender = getPerson(lenderId), receiver = getPerson(receiverId);
  if (!lender || !receiver) throw new Error('Person not found.');

  const linkId = uid();
  const when = date || new Date().toISOString();
  const lenderTxn = addTransaction({ personId: lenderId, amount: -amt, note, date: when });
  const receiverTxn = addTransaction({ personId: receiverId, amount: amt, note, date: when });
  lenderTxn.indirect = receiverTxn.indirect = true;
  lenderTxn.linkId = receiverTxn.linkId = linkId;
  lenderTxn.counterpartyId = receiverId;
  receiverTxn.counterpartyId = lenderId;
  return { linkId, lenderTxn, receiverTxn };
}

/* All recorded indirect payments as {linkId, lender, receiver, amount, note, date},
   newest first. A half-pair (one leg deleted directly) is skipped. */
function indirectPayments() {
  const byLink = {};
  state.transactions.forEach(t => {
    if (!t.indirect || !t.linkId || t.archived) return;
    (byLink[t.linkId] || (byLink[t.linkId] = [])).push(t);
  });
  const pairs = [];
  Object.entries(byLink).forEach(([linkId, legs]) => {
    const lenderTxn = legs.find(t => t.amount < 0);
    const receiverTxn = legs.find(t => t.amount > 0);
    if (!lenderTxn || !receiverTxn) return;
    const lender = getPerson(lenderTxn.personId);
    const receiver = getPerson(receiverTxn.personId);
    if (!lender || !receiver) return;
    pairs.push({
      linkId, lender, receiver,
      amount: Math.abs(lenderTxn.amount),
      note: lenderTxn.note, date: lenderTxn.date,
    });
  });
  return pairs.sort((a, b) => new Date(b.date) - new Date(a.date));
}

/* Remove both legs of an indirect payment, reverting both balances. */
function deleteIndirectPayment(linkId) {
  state.transactions = state.transactions.filter(t => t.linkId !== linkId);
}

function personTxns(personId) {
  return state.transactions
    .filter(t => t.personId === personId)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

/* ---------- balances & interest engine ---------- */

function principalOf(personId) {
  return personTxns(personId).reduce((s, t) => s + t.amount, 0);
}

function cmp(a, op, b) {
  switch (op) {
    case '>':  return a > b;
    case '>=': return a >= b;
    case '<':  return a < b;
    case '<=': return a <= b;
    case '=':  return Math.abs(a - b) < 0.005;
    default:   return false;
  }
}

function ruleAppliesTo(rule, personId) {
  if (!rule.groupId) return true;                    // everyone
  const g = getGroup(rule.groupId);
  return !!g && g.memberIds.includes(personId);      // deleted group -> never matches
}

function firstMatchingInterestRule(balance, personId) {
  return state.interestRules.find(r =>
    r.enabled && ruleAppliesTo(r, personId) && cmp(balance, r.op, Number(r.value))
  ) || null;
}

/*
  Interest is charged in DISCRETE STEPS, not continuously:
    - A rule's clock starts the moment the balance meets its condition.
    - The first FULL period's interest lands at the start of the next
      calendar day (IST midnight, UTC+5:30), all at once.
    - One more full period's interest is added every period after that.
    - Compound rules charge on principal + accrued; simple rules charge
      on principal only.

  Hard exceptions, in order:
    1. Interest NEVER accrues while balance <= 0 (you owe them, or settled).
    2. Person marked interestExempt accrues nothing.
    3. Accrual starts no earlier than person.interestAnchor (set when
       interest is capitalized or debts settled, preventing double-count).
    4. Rules are evaluated top-down; the FIRST matching enabled rule wins
       (no stacking). A rule scoped to a group only applies to current
       members of that group.
    5. A rule with capPeriods stops charging after that many periods.
    6. If settings.resetInterestOnDrop is on, accrued (uncapitalized)
       interest is wiped the moment the balance stops matching any rule.
*/
/* The first charge lands at the start of the next calendar day in Indian
   Standard Time (IST, UTC+5:30) — "each day starts at 12am" — regardless
   of the device's timezone, not a flat 24h after the condition is met.
   IST observes no DST, so a fixed offset is exact. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000; // UTC+5:30
function startOfNextDay(ts) {
  const ist = new Date(ts + IST_OFFSET_MS);            // UTC fields now read as IST wall-clock
  const nextMidnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1);
  return nextMidnight - IST_OFFSET_MS;                 // back to a real UTC instant
}

function accruedInterestDetail(person, now = Date.now()) {
  const out = { total: 0, byRule: {} };
  if (!person || person.interestExempt) return out;

  const txns = personTxns(person.id);
  if (!txns.length || !state.interestRules.some(r => r.enabled)) return out;

  const anchor = person.interestAnchor ? new Date(person.interestAnchor).getTime() : 0;
  const usedPeriods = {}; // ruleId -> periods charged so far (for caps)
  let balance = 0;
  let stretch = null;     // { rule, accrued, nextTick } while a rule's condition holds

  for (let i = 0; i < txns.length; i++) {
    balance += txns[i].amount;
    const eventTime = Math.max(new Date(txns[i].date).getTime(), anchor);
    const segEnd = i + 1 < txns.length
      ? Math.max(new Date(txns[i + 1].date).getTime(), anchor)
      : Math.max(now, anchor);

    const rule = balance > 0.005 ? firstMatchingInterestRule(balance, person.id) : null;

    if (!rule) {
      stretch = null;
      if (state.settings.resetInterestOnDrop) { out.total = 0; out.byRule = {}; }
    } else if (!stretch || stretch.rule.id !== rule.id) {
      stretch = { rule, accrued: 0, nextTick: startOfNextDay(eventTime) };
    }

    if (!stretch) continue;

    const r = Number(stretch.rule.rate) / 100;
    const periodMs = PERIOD_MS[stretch.rule.periodUnit];
    const limit = Math.min(segEnd, now);

    while (stretch.nextTick <= limit) {
      const used = usedPeriods[stretch.rule.id] || 0;
      if (stretch.rule.capPeriods && used >= stretch.rule.capPeriods) break;
      const base = stretch.rule.type === 'compound' ? balance + stretch.accrued : balance;
      const charge = base * r;
      stretch.accrued += charge;
      out.total += charge;
      out.byRule[stretch.rule.id] = (out.byRule[stretch.rule.id] || 0) + charge;
      usedPeriods[stretch.rule.id] = used + 1;
      stretch.nextTick += periodMs;
    }
  }
  return out;
}

function accruedInterest(person, now = Date.now()) {
  return accruedInterestDetail(person, now).total;
}

function totalOf(person, now = Date.now()) {
  return principalOf(person.id) + accruedInterest(person, now);
}

/* Capitalize accrued interest into the ledger as a real transaction,
   then move the anchor so history is not re-charged. */
function capitalizeInterest(personId) {
  const person = getPerson(personId);
  const accrued = accruedInterest(person);
  if (accrued < 0.005) return 0;
  addTransaction({
    personId, amount: round2(accrued),
    note: 'Interest capitalized', isInterest: true,
  });
  person.interestAnchor = new Date().toISOString();
  return accrued;
}

/* Settle everything to zero (capitalizes outstanding interest first). */
function settleUp(personId) {
  const person = getPerson(personId);
  capitalizeInterest(personId);
  const bal = principalOf(personId);
  if (Math.abs(bal) < 0.005) return;
  addTransaction({ personId, amount: round2(-bal), note: 'Settled up' });
  person.interestAnchor = new Date().toISOString();
}

function round2(n) { return Math.round(n * 100) / 100; }

/* ---------- currency ---------- */

function fmtMoney(amount, code) {
  try {
    return new Intl.NumberFormat(code === 'INR' ? 'en-IN' : undefined, {
      style: 'currency', currency: code, maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

/* Per-group totals by currency: what they owe you, what you owe them,
   and net = owedToYou - youOwe (interest included). */
function groupDebtSummary(g, now = Date.now()) {
  const per = {};
  g.memberIds.map(getPerson).filter(Boolean).forEach(p => {
    const t = totalOf(p, now);
    const e = per[p.currency] || (per[p.currency] = { owedToYou: 0, youOwe: 0, net: 0 });
    if (t > 0) e.owedToYou += t; else e.youOwe += -t;
    e.net += t;
  });
  return per;
}

/* ---------- share text ----------
   Plain-text summaries for the native share sheet / clipboard.
   Sign convention is the ledger's own: positive (no sign) => they owe
   you; negative (e.g. -50) => you owe them. Amounts are the on-screen
   Total (principal + accrued interest), formatted as a bare number. */

function shareAmount(n) {
  const v = round2(n) || 0;          // collapse -0 to 0
  return String(v);                  // round2 keeps it to <=2 clean decimals
}

/* "Name  amount" — a single line for one person. */
function personShareText(person, now = Date.now()) {
  return `${person.name}  ${shareAmount(totalOf(person, now))}`;
}

/* One line per member with a non-zero balance. Settled members are
   omitted; if everyone's square the body reads "All square." When the
   group mixes currencies, each line is tagged with its currency code so
   the bare numbers stay unambiguous. People whose ids are in excludeIds
   are left out entirely (the share-time exclusion picker). */
function groupShareText(group, now = Date.now(), excludeIds = []) {
  const excluded = new Set(excludeIds);
  const members = group.memberIds.map(getPerson).filter(Boolean).filter(p => !excluded.has(p.id));
  const multiCurrency = new Set(members.map(p => p.currency)).size > 1;
  const lines = members
    .map(p => ({ p, total: totalOf(p, now) }))
    .filter(({ total }) => Math.abs(total) > 0.005)
    .map(({ p, total }) =>
      `${p.name}  ${shareAmount(total)}${multiCurrency ? ' ' + p.currency : ''}`);
  return lines.length ? lines.join('\n') : 'All square.';
}

/* Net position per currency (no conversion — each currency stands alone). */
function netSummary(now = Date.now()) {
  const perCurrency = {};
  state.people.forEach(p => {
    const t = totalOf(p, now);
    perCurrency[p.currency] = (perCurrency[p.currency] || 0) + t;
  });
  return { perCurrency };
}

/* ---------- export / import (CSV / spreadsheet) ----------
   One row per transaction. Person-level columns (Currency, Member of,
   Interest exempt) repeat per row so people, group memberships, and
   transactions all round-trip. Interest rules and settings aren't
   representable in a flat sheet — they stay on the device. */

const CSV_HEADER = ['Date', 'Person', 'Currency', 'Type', 'Amount', 'Group', 'Reason', 'Member of', 'Interest exempt', 'Hidden'];

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCSV() {
  const memberOf = p => groupsOf(p.id).map(g => g.name).join('; ');
  const txns = state.transactions.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const seen = new Set();
  const rows = [];
  txns.forEach(t => {
    const p = getPerson(t.personId);
    if (!p) return;
    seen.add(p.id);
    const g = t.groupId ? getGroup(t.groupId) : null;
    rows.push([
      t.date, p.name, p.currency,
      t.isInterest ? 'Interest' : (t.indirect ? 'Indirect' : (t.amount >= 0 ? 'Lent' : 'Paid')),
      t.amount, g ? g.name : '', t.note || '',
      memberOf(p), p.interestExempt ? 'yes' : '', t.archived ? 'yes' : '',
    ]);
  });
  // people with no transactions still need a row to preserve them
  state.people.filter(p => !seen.has(p.id)).forEach(p => {
    rows.push(['', p.name, p.currency, '', '', '', '', memberOf(p), p.interestExempt ? 'yes' : '', '']);
  });
  return [CSV_HEADER, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
}

function parseCSV(text) {
  const out = [];
  let row = [], field = '', inQ = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); out.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); out.push(row); }
  return out.filter(r => !(r.length === 1 && r[0].trim() === ''));
}

function importCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 1) throw new Error('The file is empty');
  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = name => header.indexOf(name);
  const ci = {
    date: col('date'), person: col('person'), currency: col('currency'),
    type: col('type'), amount: col('amount'), group: col('group'),
    reason: col('reason'), members: col('member of'),
    exempt: col('interest exempt'), hidden: col('hidden'),
  };
  if (ci.person < 0) throw new Error('CSV must have a "Person" column');

  const people = new Map();   // name -> person
  const groups = new Map();   // name -> group
  const txns = [];
  const get = (row, c) => (c >= 0 && c < row.length ? row[c].trim() : '');

  const ensurePerson = (name, currency, exempt) => {
    let p = people.get(name);
    if (!p) {
      p = { id: uid(), name, currency: currency || state.settings.baseCurrency,
            interestExempt: !!exempt, interestAnchor: null, createdAt: new Date().toISOString() };
      people.set(name, p);
    } else {
      if (currency) p.currency = currency;
      if (exempt) p.interestExempt = true;
    }
    return p;
  };
  const ensureGroup = name => {
    let g = groups.get(name);
    if (!g) { g = { id: uid(), name, memberIds: [] }; groups.set(name, g); }
    return g;
  };
  const addMember = (g, p) => { if (g && p && !g.memberIds.includes(p.id)) g.memberIds.push(p.id); };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = get(row, ci.person);
    if (!name) continue;
    const p = ensurePerson(name, get(row, ci.currency), get(row, ci.exempt).toLowerCase() === 'yes');

    get(row, ci.members).split(';').map(s => s.trim()).filter(Boolean)
      .forEach(gn => addMember(ensureGroup(gn), p));

    const amtStr = get(row, ci.amount);
    if (amtStr !== '') {
      const amount = Number(amtStr.replace(/[^0-9.\-]/g, ''));
      if (Number.isFinite(amount) && amount !== 0) {
        const gName = get(row, ci.group);
        const g = gName ? ensureGroup(gName) : null;
        if (g) addMember(g, p);
        const d = new Date(get(row, ci.date));
        const txn = {
          id: uid(), personId: p.id, groupId: g ? g.id : null,
          amount, note: get(row, ci.reason),
          date: isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(),
          isInterest: get(row, ci.type).toLowerCase() === 'interest',
        };
        if (get(row, ci.hidden).toLowerCase() === 'yes') txn.archived = true;
        txns.push(txn);
      }
    }
  }

  if (!people.size) throw new Error('No people found in the file');

  state = Object.assign(defaultState(), {
    people: [...people.values()],
    groups: [...groups.values()],
    transactions: txns,
    interestRules: state.interestRules,   // kept as-is (not in the sheet)
    settings: state.settings,             // kept as-is (not in the sheet)
  });
  saveState();
}

