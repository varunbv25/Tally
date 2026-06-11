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
    settings: { baseCurrency: 'INR' }, // default currency for new people
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
  localStorage.setItem(LS_KEY, JSON.stringify(state));
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
  Walks the person's transaction history chronologically and accrues
  interest on each time segment where the running balance satisfies a rule.

  Hard exceptions, in order:
    1. Interest NEVER accrues while balance <= 0 (you owe them, or settled).
    2. Person marked interestExempt accrues nothing.
    3. Accrual starts no earlier than person.interestAnchor (set when
       interest is capitalized or debts settled, preventing double-count).
    4. Rules are evaluated top-down; the FIRST matching enabled rule wins
       for that segment (no stacking). A rule scoped to a group only
       applies to current members of that group.
    5. A rule with capPeriods stops accruing after that many cumulative
       periods of accrual under that rule.
*/
function accruedInterestDetail(person, now = Date.now()) {
  const out = { total: 0, byRule: {} };
  if (!person || person.interestExempt) return out;

  const txns = personTxns(person.id);
  if (!txns.length || !state.interestRules.some(r => r.enabled)) return out;

  const anchor = person.interestAnchor ? new Date(person.interestAnchor).getTime() : 0;
  const usedPeriods = {}; // ruleId -> cumulative periods consumed (for caps)
  let balance = 0;

  for (let i = 0; i < txns.length; i++) {
    balance += txns[i].amount;
    const segStart = Math.max(new Date(txns[i].date).getTime(), anchor);
    const segEnd = i + 1 < txns.length ? new Date(txns[i + 1].date).getTime() : now;
    if (segEnd <= segStart) continue;
    if (balance <= 0.005) continue;                    // exception 1

    const rule = firstMatchingInterestRule(balance, person.id);
    if (!rule) continue;

    let periods = (segEnd - segStart) / PERIOD_MS[rule.periodUnit];
    if (rule.capPeriods) {
      const used = usedPeriods[rule.id] || 0;
      periods = Math.max(0, Math.min(periods, rule.capPeriods - used));
      usedPeriods[rule.id] = used + periods;
    }
    if (periods <= 0) continue;

    const r = Number(rule.rate) / 100;
    const interest = rule.type === 'compound'
      ? balance * (Math.pow(1 + r, periods) - 1)
      : balance * r * periods;

    out.total += interest;
    out.byRule[rule.id] = (out.byRule[rule.id] || 0) + interest;
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

/* Net position per currency (no conversion — each currency stands alone). */
function netSummary(now = Date.now()) {
  const perCurrency = {};
  state.people.forEach(p => {
    const t = totalOf(p, now);
    perCurrency[p.currency] = (perCurrency[p.currency] || 0) + t;
  });
  return { perCurrency };
}

/* ---------- export / import ---------- */

function exportJSON() {
  return JSON.stringify(state, null, 2);
}

function importJSON(text) {
  const parsed = JSON.parse(text); // throws on bad input
  if (!parsed || !Array.isArray(parsed.people)) throw new Error('Not a Tally backup file');
  state = Object.assign(defaultState(), parsed);
  saveState();
}

