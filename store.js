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
    people: [],        // {id, name, currency, interestExempt, interestAnchor, createdAt, interestConfig|null}
                       // interestConfig {enabled, op, value, type:'simple'|'compound', rate, periodUnit, capPeriods|null}
                       // when enabled it OVERRIDES the global interestRules for this one person
    groups: [],        // {id, name, memberIds: []}
    transactions: [],  // {id, personId, groupId|null, amount, note, date, isInterest}
    interestRules: [], // {id, name, enabled, op, value, type:'simple'|'compound', rate, periodUnit, capPeriods|null, groupId|null}
                       // groupId null = applies to everyone; otherwise only to members of that group
    settings: {
      baseCurrency: 'INR',        // default currency for new people
      tzHistory: [],              // device-timezone segments {since, offsetMin} for interest timing
      theme: 'device',            // 'light' | 'dark' | 'device' (follow OS preference)
      roundWhole: false,          // show every amount (incl. past entries & interest) as whole numbers
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
    interestConfig: null,
  };
  state.people.push(p);
  return p;
}

/* A fresh, disabled per-person interest config. Defaults mirror the most common
   global rule so flipping it on is immediately sensible. */
function defaultPersonInterest() {
  return { enabled: false, op: '>', value: 0, type: 'compound', rate: 5, periodUnit: 'month', capPeriods: null };
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
  capitalizeOnDrop(lenderId, -amt, new Date(when).getTime());   // routing drops the lender's balance
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

/* ---------- split expense ----------
   Divide one expense equally across several people. Each selected person is
   charged an equal share (positive => they owe you), recorded as its own
   transaction so it can be settled or deleted independently. The legs share a
   splitId so the whole split can be recognised as one event in history. */

/* Equal shares of `amount` across `n` people, with the leftover minor units
   handed out one at a time so the shares sum to the total exactly
   (100 ÷ 3 → 33.34, 33.33, 33.33). The minor unit is a cent by default, or a
   whole unit when `opts.whole` is set (rounding mode): then 100 ÷ 3 → 34, 33, 33.

   By default the first `extra` participants pay one unit more (stable, so the
   live preview and old tests are deterministic). Callers can pass `opts.order`
   — a permutation of [0..n) — to steer the leftover onto chosen or random
   people instead, so the same person isn't always the one charged extra. */
function splitShares(amount, n, opts = {}) {
  const scale = opts.whole ? 1 : 100;
  const units = Math.round(Number(amount) * scale);
  const base = Math.floor(units / n);
  const extra = units - base * n;
  const order = (opts.order && opts.order.length === n)
    ? opts.order
    : Array.from({ length: n }, (_, i) => i);
  const bonus = new Set(order.slice(0, extra));   // these participants pay one unit more
  const out = [];
  for (let i = 0; i < n; i++) out.push((base + (bonus.has(i) ? 1 : 0)) / scale);
  return out;
}

function addSplitExpense({ personIds, amount, groupId = null, note = '', date = null, includeMe = false, order = null }) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Enter an amount greater than zero.');
  const ids = [...new Set(personIds)].filter(id => getPerson(id));
  if (ids.length < 1) throw new Error('Pick at least one person to split with.');

  const splitId = uid();
  const when = date || new Date().toISOString();
  /* If you're also splitting, you count toward the divisor but pay your own
     share — only the others' shares become debts. Your share is the first one,
     so any leftover cent lands on you (the payer), keeping the others' shares
     clean. */
  const n = ids.length + (includeMe ? 1 : 0);
  const offset = includeMe ? 1 : 0;
  const shares = splitShares(amt, n, {
    whole: roundingOn(),
    order: order && order.length === n ? order : null,
  });
  const txns = ids.map((id, i) => {
    const t = addTransaction({ personId: id, groupId, amount: shares[i + offset], note, date: when });
    t.split = true;
    t.splitId = splitId;
    return t;
  });
  /* When you're in the split, record your own share too so the whole expense
     shows in History. This leg carries no personId and is flagged `self`, so it
     never counts toward anyone's balance — it's a record of what you paid for
     yourself, not a debt owed to or by you. */
  let myTxn = null;
  if (includeMe) {
    myTxn = addTransaction({ personId: null, groupId, amount: shares[0], note, date: when });
    myTxn.split = true;
    myTxn.splitId = splitId;
    myTxn.self = true;
  }
  return { splitId, txns, myTxn, shares, myShare: includeMe ? shares[0] : 0 };
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

/* A person's own interest config presented as a rule-shaped object, so the
   engine can treat it exactly like a global rule. Returns null when the person
   has no custom interest (or it's switched off). */
function personInterestRule(person) {
  const c = person && person.interestConfig;
  if (!c || !c.enabled) return null;
  return {
    id: 'person:' + person.id,
    name: 'Custom interest for ' + person.name,
    personal: true,
    enabled: true,
    op: c.op || '>',
    value: Number(c.value) || 0,
    type: c.type === 'simple' ? 'simple' : 'compound',
    rate: Number(c.rate) || 0,
    periodUnit: PERIOD_MS[c.periodUnit] ? c.periodUnit : 'month',
    capPeriods: Number.isFinite(c.capPeriods) && c.capPeriods > 0 ? c.capPeriods : null,
    groupId: null,
  };
}

/* The rule that decides a person's interest at this balance. A person with a
   custom interest config is governed solely by it (the global rules are ignored
   for them); everyone else falls through to the shared, top-down global rules. */
function firstMatchingInterestRule(balance, personId) {
  const person = getPerson(personId);
  const own = personInterestRule(person);
  if (own) return cmp(balance, own.op, Number(own.value)) ? own : null;
  return state.interestRules.find(r =>
    r.enabled && ruleAppliesTo(r, personId) && cmp(balance, r.op, Number(r.value))
  ) || null;
}

/* Look up a rule's display name by id, covering both global rules and the
   synthetic per-person rule ("person:<id>"). */
function interestRuleName(ruleId) {
  if (typeof ruleId === 'string' && ruleId.startsWith('person:')) {
    const p = getPerson(ruleId.slice('person:'.length));
    return p ? personInterestRule(p)?.name || 'Custom interest' : 'Custom interest';
  }
  return state.interestRules.find(r => r.id === ruleId)?.name || null;
}

/*
  Interest is charged in DISCRETE STEPS, not continuously:
    - A rule's clock starts the moment the balance meets its condition.
    - The first FULL period's interest lands at the start of the next
      calendar day (the device's local midnight), all at once.
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
    6. A repayment that pushes the balance below every rule's condition
       capitalizes the accrued interest into the principal first (see
       capitalizeOnDrop), so it is rolled into the balance rather than left as
       separate interest. The fresh, larger principal is what later interest
       accrues on once a rule matches again. The engine itself never wipes
       accrued interest; it only stops accruing while no rule matches.
*/
/* Interest is timed against the device's own clock — "each day starts at
   12am" wherever the user is — not a flat 24h after the condition is met.

   The device timezone is persisted as a history of segments in
   settings.tzHistory: each { since, offsetMin } records the UTC offset
   (Date.getTimezoneOffset() convention: minutes, e.g. -330 for IST) that
   took effect at instant `since`. This lets the engine pin already-accrued
   interest to the timezone it accrued in: past charges are recomputed with
   the offset that was live back then, so they never shift, while a move to a
   new timezone re-phases only the charges dated after the switch. With no
   history recorded yet, we fall back to the device's current offset. */
function deviceOffsetAt(ts) {
  const hist = state && state.settings && state.settings.tzHistory;
  if (!hist || !hist.length) return new Date(ts).getTimezoneOffset();
  let off = hist[0].offsetMin;
  for (const seg of hist) { if (seg.since <= ts) off = seg.offsetMin; else break; }
  return off;
}

/* The next local midnight strictly after `ts`, for a fixed UTC offset. */
function localMidnightAfter(ts, offsetMin) {
  const shift = -offsetMin * 60_000;                   // add to a UTC instant to read wall-clock
  const wall = new Date(ts + shift);
  const next = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1);
  return next - shift;                                 // back to a real UTC instant
}

/* Record a timezone change the moment the app notices one. Earlier segments
   stay frozen, so interest already accrued never re-phases; only charges
   dated after the switch land at the new local midnight. Call on boot (and
   whenever the app regains focus) from a context that knows the live clock. */
function recordDeviceTimezone(now = Date.now()) {
  if (!state) return false;
  if (!state.settings.tzHistory) state.settings.tzHistory = [];
  const hist = state.settings.tzHistory;
  const off = new Date(now).getTimezoneOffset();
  if (!hist.length) { hist.push({ since: 0, offsetMin: off }); saveState(); return false; } // seed past
  if (hist[hist.length - 1].offsetMin === off) return false;          // unchanged → nothing to do
  hist.push({ since: now, offsetMin: off });                          // travelled → new segment
  saveState();
  return true;
}

/* Returns { total, byRule, schedule } where schedule is the chronological list
   of every individual interest charge that has landed since the anchor:
   { date (ISO, the local-midnight it was charged), amount, ruleId }. The
   schedule lets the UI show interest "adding up per day" as real, dated rows in
   history without ever mutating the ledger — these stay virtual until the user
   capitalizes, at which point the anchor moves and they roll into a real entry. */
function accruedInterestDetail(person, now = Date.now()) {
  const out = { total: 0, byRule: {}, schedule: [] };
  if (!person || person.interestExempt) return out;

  const txns = personTxns(person.id);
  const hasRule = !!personInterestRule(person) || state.interestRules.some(r => r.enabled);
  if (!txns.length || !hasRule) return out;

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
      stretch = null;                 // stop accruing; keep what's accrued so far
    } else if (!stretch || stretch.rule.id !== rule.id) {
      const off = deviceOffsetAt(eventTime);
      stretch = { rule, accrued: 0, nextTick: localMidnightAfter(eventTime, off), tzOff: off };
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
      out.schedule.push({
        date: new Date(stretch.nextTick).toISOString(),
        amount: charge,
        ruleId: stretch.rule.id,
      });
      usedPeriods[stretch.rule.id] = used + 1;
      stretch.nextTick += periodMs;
      /* If the device moved timezones before this next charge, re-phase it to
         the new local midnight. Charges already booked above keep their old
         phase; only those dated after the switch shift. */
      const off = deviceOffsetAt(stretch.nextTick);
      if (off !== stretch.tzOff) {
        stretch.nextTick += (off - stretch.tzOff) * 60_000;
        stretch.tzOff = off;
      }
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

/* How a person's balance should be PRESENTED, split into principal and
   interest columns. Accrued interest is shown on its own only while the balance
   still meets an interest rule's condition (i.e. it has "crossed the conditional
   amount"). Below every rule the interest column is blank.

   In normal use a repayment that drops the balance below every rule already
   capitalizes the accrued interest into the principal (see capitalizeOnDrop),
   so there is no separate interest to hide. This helper also folds any residual
   accrued interest into the principal for display in the edge case where the
   balance sits below a condition without a triggering repayment (e.g. a rule's
   threshold was raised after interest had accrued). The total is identical
   either way. */
function balanceDisplay(person, now = Date.now()) {
  const principal = principalOf(person.id);
  const interest = accruedInterest(person, now);
  const crossing = principal > 0.005 && !!firstMatchingInterestRule(principal, person.id);
  return {
    crossing,
    principal: crossing ? principal : principal + interest,
    interest: crossing ? interest : 0,
    total: principal + interest,
  };
}

/* Capitalize accrued interest into the ledger as a real transaction,
   then move the anchor so history is not re-charged. `asOf` is the instant
   to capitalize at: the accrued total is taken as of that moment, and both
   the capitalization transaction and the new anchor are dated there. It
   defaults to now, but a dated/backdated repayment passes the entry's own
   date so interest is frozen at the date the balance actually dropped — not
   at today, which would over-capitalize everything accrued since. */
function capitalizeInterest(personId, asOf = Date.now()) {
  const person = getPerson(personId);
  const accrued = accruedInterest(person, asOf);
  if (accrued < 0.005) return 0;
  const at = new Date(asOf).toISOString();
  addTransaction({
    personId, amount: round2(accrued),
    note: 'Interest capitalized', isInterest: true, date: at,
  });
  person.interestAnchor = at;
  return accrued;
}

/* A repayment that pushes the balance below every interest rule's condition
   would otherwise leave the accrued interest stranded (it stops growing but
   stays as separate interest). Instead, capitalize it into the principal first,
   so the repayment is deducted from the capitalised total and the visible
   interest resets to zero. Because the interest is now genuinely part of the
   principal, when the balance next crosses a rule's condition the fresh
   interest accrues on this larger principal. Pass the SIGNED amount about to be
   recorded and call BEFORE recording it. `asOf` is the date the entry will
   carry (defaults to now); it is forwarded to capitalizeInterest so a dated
   repayment freezes the accrued interest at its own date instead of today.
   Returns the amount capitalized (0 if nothing happened). */
function capitalizeOnDrop(personId, amount, asOf = Date.now()) {
  const before = principalOf(personId);
  const after = before + Number(amount);
  const wasMatching = before > 0.005 && firstMatchingInterestRule(before, personId);
  const nowMatching = after > 0.005 && firstMatchingInterestRule(after, personId);
  if (wasMatching && !nowMatching) return capitalizeInterest(personId, asOf);
  return 0;
}

/* Settle everything to zero (capitalizes outstanding interest first). The
   zeroing entry carries `note` so the caller can label it — the Clear button
   records it as a cleared debt, while the modal uses the default. Returns the
   signed amount recorded (0 if there was nothing to settle). */
function settleUp(personId, note = 'Settled up') {
  const person = getPerson(personId);
  capitalizeInterest(personId);
  const bal = principalOf(personId);
  if (Math.abs(bal) < 0.005) return 0;
  const amount = round2(-bal);
  addTransaction({ personId, amount, note });
  person.interestAnchor = new Date().toISOString();
  return amount;
}

function round2(n) { return Math.round(n * 100) / 100; }

/* ---------- rounding mode ----------
   When settings.roundWhole is on, every amount is presented as a whole number
   — balances, interest and splits alike, retroactively, since the toggle just
   changes how stored values are rounded for display (it never rewrites the
   ledger). roundAmt rounds to the active precision; fmtMoney drops the
   fractional digits to match. */
function roundingOn() {
  return !!(state && state.settings && state.settings.roundWhole);
}

function roundAmt(n) {
  const scale = roundingOn() ? 1 : 100;
  return Math.round(Number(n) * scale) / scale;
}

/* ---------- currency ---------- */

function fmtMoney(amount, code) {
  const digits = roundingOn() ? 0 : 2;
  try {
    return new Intl.NumberFormat(code === 'INR' ? 'en-IN' : undefined, {
      style: 'currency', currency: code, maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${code} ${roundingOn() ? Math.round(amount) : amount.toFixed(2)}`;
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
  const v = roundAmt(n) || 0;        // collapse -0 to 0; whole numbers in rounding mode
  return String(v);                  // roundAmt keeps it to <=2 clean decimals
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

/* Same shape as groupShareText, but over an explicit list of people rather
   than a group's members — the Ledger's share picker starts with nobody
   ticked, so the caller passes exactly who was chosen. Settled people are
   still omitted; everyone square reads "All square." */
function peopleShareText(people, now = Date.now()) {
  const chosen = people.filter(Boolean);
  const multiCurrency = new Set(chosen.map(p => p.currency)).size > 1;
  const lines = chosen
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
    if (!p) return;   // skips your own split shares (self legs) — the JSON backup keeps those
    seen.add(p.id);
    const g = t.groupId ? getGroup(t.groupId) : null;
    rows.push([
      t.date, p.name, p.currency,
      t.isInterest ? 'Interest' : (t.indirect ? 'Indirect' : (t.split ? 'Split' : (t.amount >= 0 ? 'Paid' : 'Repaid'))),
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

/* ---------- full backup / restore (JSON) ----------
   Unlike the CSV, this round-trips EVERYTHING — people, groups,
   transactions, interest rules and settings — so a restored device is
   byte-for-byte the original. This is the safe answer to "clearing my
   browser wiped my ledger": back up to a file, restore it anywhere. */

const BACKUP_VERSION = 1;

function exportJSON() {
  return JSON.stringify({
    app: 'tally',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    state,
  }, null, 2);
}

function importJSON(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('This file isn’t valid Tally backup JSON.'); }

  // Accept either a wrapped backup {app,version,state} or a bare state object.
  const incoming = parsed && parsed.state && typeof parsed.state === 'object'
    ? parsed.state
    : parsed;
  if (parsed && parsed.app && parsed.app !== 'tally') {
    throw new Error('This backup was made by a different app.');
  }
  if (!incoming || !Array.isArray(incoming.people) || !Array.isArray(incoming.transactions)) {
    throw new Error('This file doesn’t look like a Tally backup.');
  }

  // Merge onto a fresh default so any field added in a newer version still
  // has a sane fallback when restoring an older backup.
  state = Object.assign(defaultState(), {
    people: incoming.people,
    groups: Array.isArray(incoming.groups) ? incoming.groups : [],
    transactions: incoming.transactions,
    interestRules: Array.isArray(incoming.interestRules) ? incoming.interestRules : [],
    settings: Object.assign(defaultState().settings, incoming.settings || {}),
  });
  saveState();
}

