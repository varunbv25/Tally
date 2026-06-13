/* =========================================================
   TALLY — UI layer
   Renders views from store.js state; all mutations go
   through store functions, then saveState() + render().
   ========================================================= */

const ui = {
  tab: 'ledger',
  openGroupId: null,
  modalPersonId: null,
  search: '',
  historySearch: '',
  renamingGroup: false,
};

/* ---------- helpers ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function moneyClass(n) {
  if (n > 0.005) return 'pos';
  if (n < -0.005) return 'neg';
  return 'zero';
}

function currencyOptions(selected) {
  return CURRENCIES.map(c =>
    `<option value="${c.code}" ${c.code === selected ? 'selected' : ''}>${c.code} — ${c.name}</option>`
  ).join('');
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function commit() { saveState(); render(); runNotificationCheck(); }

/* ---------- notifications plumbing ---------- */

/* Checks read-modify-write the shared notifLog; run them one at a
   time or concurrent calls (e.g. enable toggle: commit + permission
   grant) both see the stale log and double-notify. */
let notifCheckChain = Promise.resolve();
function runNotificationCheck() {
  notifCheckChain = notifCheckChain.then(doNotificationCheck);
  return notifCheckChain;
}

async function doNotificationCheck() {
  await pushSyncDown();           // merge server-delivered keys before reading the log
  updateBadge();
  const ns = notifSettings(state);
  if (!ns.enabled || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const logJson = await idbGet('notifLog');
    const log = logJson ? JSON.parse(logJson) : { fired: {}, lastNudge: 0 };
    const due = evaluateNotifications(state, log, Date.now());
    if (due.length && 'serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      due.forEach(n => reg.showNotification(n.title, {
        body: n.body, icon: './icons/icon-192.png', tag: n.key,
      }));
    }
    await idbSet('notifLog', JSON.stringify(log));
    schedulePushUpload();         // refresh the server's schedule
  } catch { /* notifications must never break the app */ }
}

function updateBadge() {
  if (!('setAppBadge' in navigator)) return;
  const ns = notifSettings(state);
  const c = ns.enabled ? badgeCount(state) : 0;
  (c ? navigator.setAppBadge(c) : navigator.clearAppBadge()).catch(() => {});
}

function maybeCelebrate(personId, beforeTotal) {
  const p = getPerson(personId);
  if (!p) return;
  if (Math.abs(beforeTotal) > 0.005 && Math.abs(totalOf(p)) <= 0.005) {
    showToast(`All square with ${p.name} 🎉`);
  }
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 3500);
}

async function enableNotifications() {
  if (!('Notification' in window)) return;
  await Notification.requestPermission();
  await subscribePush();
  render();                       // reflect granted/denied state
  runNotificationCheck();
  registerPeriodicSync();
}

async function disableNotifications() {
  await unsubscribePush();
  if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {});
  try {
    const reg = await navigator.serviceWorker.ready;
    if ('periodicSync' in reg) await reg.periodicSync.unregister('tally-check');
  } catch { /* unsupported — nothing to undo */ }
}

async function registerPeriodicSync() {
  if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if ('periodicSync' in reg) {
      await reg.periodicSync.register('tally-check', { minInterval: 12 * 60 * 60 * 1000 });
    }
  } catch { /* iOS / desktop tab: foreground path covers it */ }
}

/* ---------- masthead stamps ---------- */

function renderStamps() {
  const { perCurrency } = netSummary();
  const el = document.getElementById('net-stamps');
  const stamps = [];
  for (const [code, amt] of Object.entries(perCurrency)) {
    if (Math.abs(amt) < 0.005) continue;
    stamps.push(amt > 0
      ? `<span class="stamp owed-to-you">Owed to you · ${fmtMoney(amt, code)}</span>`
      : `<span class="stamp you-owe">You owe · ${fmtMoney(-amt, code)}</span>`);
  }
  el.innerHTML = stamps.join('') || '<span class="stamp grand">All square</span>';
}

/* ---------- ledger view ---------- */

function renderLedger() {
  const q = ui.search.trim().toLowerCase();
  const people = state.people
    .filter(p => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => totalOf(b) - totalOf(a));

  const rows = people.map(p => {
    const principal = principalOf(p.id);
    const interest = accruedInterest(p);
    const total = principal + interest;
    const groups = groupsOf(p.id).map(g => `<span class="chip">${esc(g.name)}</span>`).join('');
    const exempt = p.interestExempt ? '<span class="chip exempt">no interest</span>' : '';

    return `<tr class="row">
      <td class="col-person"><button class="person-name" data-action="open-person" data-id="${p.id}">${esc(p.name)}</button> ${exempt}</td>
      <td class="col-groups">${groups}</td>
      <td class="num" data-label="Principal"><span class="money ${moneyClass(principal)}">${fmtMoney(principal, p.currency)}</span></td>
      <td class="num" data-label="Interest"><span class="money interest">${interest > 0.005 ? '+' + fmtMoney(interest, p.currency) : '—'}</span></td>
      <td class="num" data-label="Total"><span class="money ${moneyClass(total)}">${fmtMoney(total, p.currency)}</span></td>
      <td class="col-quick">
        <div class="quick-add">
          <input type="number" step="any" min="0" placeholder="amount" id="qa-${p.id}">
          <input class="qa-reason" placeholder="reason" id="qr-${p.id}" maxlength="80">
          <button class="btn small plus" data-action="quick-add" data-id="${p.id}" data-sign="1" title="They borrowed / you lent">+ lent</button>
          <button class="btn small minus" data-action="quick-add" data-id="${p.id}" data-sign="-1" title="They paid you back">− paid</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  return `
    <h2 class="section-title">The Ledger</h2>
    <p class="section-sub">Every person, every balance — across all groups. Positive means they owe you. Type an amount and hit <em>+ lent</em> or <em>− paid</em>, just like a spreadsheet row.</p>

    <div class="panel">
      <h3>Add a person</h3>
      <form data-form="add-person" class="form-row tight">
        <input name="name" placeholder="Name" required>
        <button class="btn" type="submit">Add to ledger</button>
      </form>
    </div>

    <div class="form-row">
      <input id="search-box" placeholder="Search people…" value="${esc(ui.search)}">
    </div>

    ${people.length ? `
    <table class="ledger-table">
      <thead><tr>
        <th>Person</th><th class="col-groups">Groups</th>
        <th class="num">Principal</th><th class="num">Interest</th><th class="num">Total</th>
        <th>Quick entry</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>` : `<div class="empty-state">The ledger is blank. Add a person above — or live a debt-free life, your call.</div>`}
  `;
}

/* ---------- groups view ---------- */

function groupNetLine(g) {
  return Object.entries(groupDebtSummary(g))
    .filter(([, s]) => Math.abs(s.net) > 0.005)
    .map(([code, s]) => `${s.net >= 0 ? 'net owed to you' : 'net you owe'} ${fmtMoney(Math.abs(s.net), code)}`)
    .join(' · ') || 'all square';
}

function groupDebtStrip(g) {
  const entries = Object.entries(groupDebtSummary(g));
  if (!entries.length) return '';
  return entries.map(([code, s]) => `
    <div class="balance-strip">
      <span>They owe you<b class="money pos">${fmtMoney(s.owedToYou, code)}</b></span>
      <span>You owe them<b class="money neg">${fmtMoney(s.youOwe, code)}</b></span>
      <span>Total debt<b class="money ${moneyClass(s.net)}">${fmtMoney(s.net, code)}</b></span>
    </div>`).join('');
}

function renderGroups() {
  if (ui.openGroupId) return renderGroupDetail();

  const cards = state.groups.map(g => {
    const names = g.memberIds.map(id => getPerson(id)?.name).filter(Boolean).join(', ');
    return `<button class="group-card" data-action="open-group" data-id="${g.id}">
      <h3>${esc(g.name)}</h3>
      <div class="members">${esc(names) || 'No members yet'}</div>
      <span class="muted">${groupNetLine(g)}</span>
    </button>`;
  }).join('');

  const memberChecks = state.people.map(p =>
    `<label><input type="checkbox" name="member" value="${p.id}"> ${esc(p.name)}</label>`
  ).join('');

  return `
    <h2 class="section-title">Groups</h2>
    <p class="section-sub">People can live in many groups at once. Balances are global — record a payment in one group and it shows up in every other group instantly.</p>

    <div class="panel">
      <h3>Create a group</h3>
      <form data-form="add-group">
        <div class="form-row"><input name="name" placeholder="Group name (e.g. Goa Trip)" required></div>
        <div class="form-row">${memberChecks || '<span class="muted">Add people on the Ledger tab first.</span>'}</div>
        <div class="form-row tight"><button class="btn" type="submit">Create group</button></div>
      </form>
    </div>

    ${state.groups.length ? `<div class="group-grid">${cards}</div>`
      : '<div class="empty-state">No groups yet. Trips, flatmates, that one fantasy league — they all start here.</div>'}
  `;
}

function renderGroupDetail() {
  const g = getGroup(ui.openGroupId);
  if (!g) { ui.openGroupId = null; return renderGroups(); }

  const members = g.memberIds.map(getPerson).filter(Boolean);

  const rows = members.map(p => {
    const total = totalOf(p);
    return `<tr class="row">
      <td class="col-person"><button class="person-name" data-action="open-person" data-id="${p.id}">${esc(p.name)}</button>
        <button class="del-x row-remove" data-action="remove-member" data-id="${p.id}" data-group="${g.id}" title="Remove from group">✕</button></td>
      <td class="num" data-label="Total owed"><span class="money ${moneyClass(total)}">${fmtMoney(total, p.currency)}</span></td>
      <td class="col-quick">
        <div class="quick-add">
          <input type="number" step="any" min="0" placeholder="amount" id="qa-${p.id}">
          <input class="qa-reason" placeholder="reason" id="qr-${p.id}" maxlength="80">
          <button class="btn small plus" data-action="quick-add" data-id="${p.id}" data-sign="1" data-group="${g.id}">+ lent</button>
          <button class="btn small minus" data-action="quick-add" data-id="${p.id}" data-sign="-1" data-group="${g.id}">− paid</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  const nonMembers = state.people.filter(p => !g.memberIds.includes(p.id));
  const addMemberOptions = nonMembers.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');

  const activity = state.transactions
    .filter(t => t.groupId === g.id)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 30)
    .map(t => {
      const p = getPerson(t.personId);
      if (!p) return '';
      return `<tr>
        <td>${fmtDate(t.date)}</td>
        <td>${esc(p.name)}</td>
        <td>${esc(t.note) || '<span class="muted">—</span>'}</td>
        <td class="num"><span class="money ${moneyClass(t.amount)}">${fmtMoney(t.amount, p.currency)}</span></td>
      </tr>`;
    }).join('');

  return `
    <button class="back-link" data-action="close-group">← All groups</button>
    ${ui.renamingGroup ? `
    <form data-form="rename-group" data-group="${g.id}" class="form-row">
      <input name="name" value="${esc(g.name)}" required maxlength="60" autofocus>
      <button class="btn small" type="submit">Save</button>
      <button class="btn small ghost" type="button" data-action="cancel-rename">Cancel</button>
    </form>` : `
    <h2 class="section-title">${esc(g.name)}
      <button class="btn small ghost" data-action="rename-group" data-id="${g.id}">Rename</button>
    </h2>`}
    <div class="banner">Balances here are <strong>global</strong>. A payment recorded in ${esc(g.name)} updates this person everywhere — every other group sees it too.</div>

    ${groupDebtStrip(g)}

    <table class="ledger-table">
      <thead><tr><th>Member</th><th class="num">Total owed (global)</th><th>Quick entry (tagged to this group)</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3" class="muted">No members yet.</td></tr>'}</tbody>
    </table>

    <div class="panel" style="margin-top:24px">
      <h3>Add member</h3>
      <form data-form="add-member" class="form-row tight" data-group="${g.id}">
        <select name="personId">${addMemberOptions || '<option value="">Everyone is already here</option>'}</select>
        <button class="btn" type="submit" ${nonMembers.length ? '' : 'disabled'}>Add to group</button>
      </form>
    </div>

    <div class="panel">
      <h3>Group activity</h3>
      ${activity ? `<div class="table-wrap"><table class="txn-table"><thead><tr><th>Date</th><th>Person</th><th>Note</th><th class="num">Amount</th></tr></thead><tbody>${activity}</tbody></table></div>`
        : '<span class="muted">No transactions tagged to this group yet.</span>'}
    </div>

    <button class="btn danger" data-action="delete-group" data-id="${g.id}">Delete group</button>
    <span class="muted" style="margin-left:10px">People and their balances are kept — only the grouping disappears.</span>
  `;
}

/* ---------- rules view ---------- */

function describeInterestRule(r) {
  const cap = r.capPeriods ? ` for at most <span class="hl">${r.capPeriods} ${r.periodUnit}${r.capPeriods > 1 ? 's' : ''}</span>` : '';
  let scope = '';
  if (r.groupId) {
    const g = getGroup(r.groupId);
    scope = g ? ` and they're in <span class="hl">${esc(g.name)}</span>`
              : ' and they\'re in <span class="hl">a deleted group (rule inactive)</span>';
  }
  return `<span class="rule-name">${esc(r.name)}</span> — if balance <span class="hl">${r.op} ${r.value}</span>${scope},
    charge <span class="hl">${r.rate}%</span> <span class="hl">${r.type}</span> interest per <span class="hl">${r.periodUnit}</span>${cap}.`;
}

function interestRulesPanel() {
  const interestCards = state.interestRules.map(r => `
    <div class="rule-card ${r.enabled ? '' : 'disabled'}">
      <span class="rule-sentence">${describeInterestRule(r)}</span>
      <span>
        <button class="btn small ghost" data-action="toggle-rule" data-id="${r.id}">${r.enabled ? 'Disable' : 'Enable'}</button>
        <button class="btn small danger" data-action="delete-rule" data-id="${r.id}">Delete</button>
      </span>
    </div>`).join('');

  return `
    <div class="panel">
      <h3>Interest rules <span class="muted">(evaluated top-down, first match wins)</span></h3>
      <p class="muted" style="margin-bottom:12px">Interest is charged in full-period steps: the first charge lands one day after a rule's condition is met, then one charge per period after that.</p>
      ${interestCards || '<span class="muted">No interest rules. Debts sit politely at face value.</span>'}
      <form data-form="add-interest-rule" style="margin-top:16px">
        <div class="form-row">
          <input name="name" placeholder="Rule name" required style="width:180px">
          <label>if balance
            <select name="op">${OPS.map(o => `<option ${o === '>' ? 'selected' : ''}>${o}</option>`).join('')}</select>
            <input name="value" type="number" step="any" required placeholder="1000">
          </label>
          <label>applies to <select name="groupId">
            <option value="">everyone</option>
            ${state.groups.map(g => `<option value="${g.id}">members of ${esc(g.name)}</option>`).join('')}
          </select></label>
        </div>
        <div class="form-row">
          <label>then charge <input name="rate" type="number" step="any" min="0" required placeholder="5" style="width:70px">%</label>
          <select name="type"><option value="compound">compound</option><option value="simple">simple</option></select>
          <label>per <select name="periodUnit">
            <option value="month" selected>month</option><option value="day">day</option>
            <option value="week">week</option><option value="year">year</option>
          </select></label>
          <label>cap (optional) <input name="capPeriods" type="number" step="any" min="0" placeholder="∞" style="width:70px"> periods</label>
        </div>
        <div class="form-row tight"><button class="btn" type="submit">Add interest rule</button></div>
      </form>
      <div class="form-row tight" style="margin-top:14px; padding-top:12px; border-top:1px solid var(--line)">
        <label><input type="checkbox" id="reset-interest-drop" ${state.settings.resetInterestOnDrop ? 'checked' : ''}>
          Reset accrued interest when the balance falls below the rule's condition</label>
      </div>
    </div>

  `;
}

/* ---------- settings view ---------- */

function notificationsPanel() {
  const ns = notifSettings(state);
  const supported = 'Notification' in window;
  const blocked = supported && ns.enabled && Notification.permission === 'denied';
  const dis = ns.enabled ? '' : 'disabled';

  const row = (key, label, control) => `
    <div class="notif-row ${ns.enabled ? '' : 'off'}">
      <label><input type="checkbox" data-notif-toggle="${key}" ${ns[key].enabled ? 'checked' : ''} ${dis}> ${label}</label>
      ${control}
    </div>`;
  const num = (key, field, suffix, attrs) => `
    <label class="notif-value"><input type="number" ${attrs} data-notif-value="${key}" data-field="${field}" value="${ns[key][field]}" ${dis}> ${suffix}</label>`;

  return `
    <div class="panel">
      <h3>Notifications</h3>
      <div class="form-row">
        <label><input type="checkbox" id="notif-master" ${ns.enabled ? 'checked' : ''} ${supported ? '' : 'disabled'}> Enable notifications</label>
      </div>
      ${ns.enabled ? `<p class="muted">Background push: ${
        !PUSH_SERVER || !VAPID_PUBLIC_KEY ? 'not configured' :
        pushStatus === 'active' ? 'active on this device' :
        pushStatus === 'unavailable' ? 'unavailable on this device' : 'connecting…'}</p>` : ''}
      ${supported ? '' : '<p class="muted">This browser does not support notifications.</p>'}
      ${blocked ? '<div class="banner">Notifications are blocked in your browser settings. Allow them for this site to receive alerts.</div>' : ''}
      ${row('agingDebt', 'Aging debt — no repayment for', num('agingDebt', 'days', 'days', 'min="1" step="1"'))}
      ${row('recurringNudge', 'Recurring reminder of who owes you', `
        <select data-notif-value="recurringNudge" data-field="cadence" ${dis}>
          <option value="weekly" ${ns.recurringNudge.cadence === 'weekly' ? 'selected' : ''}>weekly</option>
          <option value="monthly" ${ns.recurringNudge.cadence === 'monthly' ? 'selected' : ''}>monthly</option>
        </select>`)}
      ${row('balanceThreshold', 'Someone’s total crosses', num('balanceThreshold', 'amount', '', 'min="0" step="any"'))}
      ${row('settleUpNudge', 'You’ve owed someone for', num('settleUpNudge', 'days', 'days', 'min="1" step="1"'))}
      ${row('interestMilestone', 'Accrued interest reaches', num('interestMilestone', 'amount', '', 'min="0" step="any"'))}
      ${row('capitalizeSuggest', 'Interest exceeds', num('capitalizeSuggest', 'percent', '% of principal', 'min="1" step="1"'))}
      <p class="muted">Computed on this device — amounts compare in each person’s own currency. Background alerts work where Tally is installed as an app (Android/Chrome); elsewhere you’re notified when you open Tally.</p>
    </div>`;
}

/* ---------- history view ---------- */

function renderHistory() {
  const q = ui.historySearch.trim().toLowerCase();

  const entries = state.transactions
    .map(t => ({ t, p: getPerson(t.personId), g: t.groupId ? getGroup(t.groupId) : null }))
    .filter(x => x.p)                                          // skip orphaned entries
    .sort((a, b) => new Date(b.t.date) - new Date(a.t.date));  // newest first

  const matches = entries.filter(({ t, p, g }) => {
    if (!q) return true;
    const kind = t.isInterest ? 'interest' : (t.amount >= 0 ? 'lent borrowed' : 'paid back');
    const hay = [
      p.name,
      t.note,
      g ? g.name : 'personal',
      Math.abs(t.amount),
      fmtMoney(t.amount, p.currency),
      fmtDate(t.date),
      t.date.slice(0, 10),
      kind,
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });

  const rows = matches.map(({ t, p, g }) => {
    const tag = t.isInterest
      ? '<span class="interest-tag">INTEREST</span>'
      : (t.amount >= 0 ? '<span class="hist-tag lent">lent</span>' : '<span class="hist-tag paid">paid</span>');
    return `<tr class="row">
      <td class="col-person">
        <button class="person-name" data-action="open-person" data-id="${p.id}">${esc(p.name)}</button>
        <span class="money ${moneyClass(t.amount)} hist-amount">${fmtMoney(t.amount, p.currency)}</span>
      </td>
      <td data-label="Date">${fmtDate(t.date)}</td>
      <td data-label="Type">${tag}</td>
      <td data-label="Group">${g ? `<span class="chip">${esc(g.name)}</span>` : '<span class="muted">personal</span>'}</td>
      <td data-label="Reason">${esc(t.note) || '<span class="muted">—</span>'}</td>
      <td class="num" data-label="Amount"><span class="money ${moneyClass(t.amount)}">${fmtMoney(t.amount, p.currency)}</span></td>
    </tr>`;
  }).join('');

  return `
    <h2 class="section-title">History</h2>
    <p class="section-sub">Every entry across everyone — lent, paid, and interest. Search by person, reason, amount, or date.</p>

    <div class="form-row">
      <input id="history-search" placeholder="Search person, reason, amount, date…" value="${esc(ui.historySearch)}" style="flex:1">
    </div>

    ${entries.length ? (matches.length ? `
    <p class="muted" style="margin-bottom:10px">${matches.length} ${matches.length === 1 ? 'entry' : 'entries'}${q ? ' matching' : ''}</p>
    <table class="ledger-table history-table">
      <thead><tr>
        <th>Person</th><th>Date</th><th>Type</th><th>Group</th><th>Reason</th><th class="num">Amount</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`
      : `<div class="empty-state">No entries match “${esc(ui.historySearch)}”.</div>`)
      : `<div class="empty-state">No transactions yet. Record some lending or repayments on the Ledger.</div>`}
  `;
}

function renderSettings() {
  return `
    <h2 class="section-title">Settings</h2>
    <p class="section-sub">Interest rules, currency, and your data — which never leaves this browser unless you export it.</p>

    ${interestRulesPanel()}

    ${notificationsPanel()}

    <div class="panel">
      <h3>Currency</h3>
      <div class="form-row">
        <label>Currency for new people <select id="base-currency">${currencyOptions(state.settings.baseCurrency)}</select></label>
      </div>
      <p class="muted">Each person keeps their own currency (changeable in their profile). Totals in the header are shown per currency — nothing is converted.</p>
    </div>

    <div class="panel">
      <h3>Data</h3>
      <div class="form-row">
        <button class="btn ghost" data-action="export-data">Export backup (JSON)</button>
        <label class="btn ghost" style="display:inline-block">Import backup
          <input type="file" id="import-file" accept=".json,application/json" style="display:none">
        </label>
      </div>
      <div class="form-row tight">
        <button class="btn danger" data-action="reset-data">Erase everything</button>
      </div>
    </div>
  `;
}

/* ---------- person modal ---------- */

function renderModal() {
  const root = document.getElementById('modal-root');
  if (!ui.modalPersonId) { root.innerHTML = ''; return; }
  const p = getPerson(ui.modalPersonId);
  if (!p) { ui.modalPersonId = null; root.innerHTML = ''; return; }

  const principal = principalOf(p.id);
  const detail = accruedInterestDetail(p);
  const total = principal + detail.total;
  const ruleNames = Object.keys(detail.byRule)
    .map(id => state.interestRules.find(r => r.id === id)?.name).filter(Boolean).join(', ');

  const txRows = personTxns(p.id).slice().reverse().map(t => {
    const g = t.groupId ? getGroup(t.groupId) : null;
    return `<tr>
      <td>${fmtDate(t.date)}</td>
      <td>${g ? `<span class="chip">${esc(g.name)}</span>` : '<span class="muted">personal</span>'}</td>
      <td>${esc(t.note) || '<span class="muted">—</span>'} ${t.isInterest ? '<span class="interest-tag">INTEREST</span>' : ''}</td>
      <td class="num"><span class="money ${moneyClass(t.amount)}">${fmtMoney(t.amount, p.currency)}</span></td>
      <td><button class="del-x" data-action="delete-txn" data-id="${t.id}" title="Delete entry">✕</button></td>
    </tr>`;
  }).join('');

  const groupOptions = ['<option value="">No group (personal)</option>']
    .concat(groupsOf(p.id).map(g => `<option value="${g.id}">${esc(g.name)}</option>`)).join('');

  root.innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal">
      <div class="modal-head">
        <h2>${esc(p.name)}</h2>
        <button class="modal-close" data-action="close-modal">✕</button>
      </div>
      <div class="form-row">
        <label>Currency <select id="person-currency">${currencyOptions(p.currency)}</select></label>
        <label><input type="checkbox" id="person-exempt" ${p.interestExempt ? 'checked' : ''}> interest exempt</label>
      </div>

      <div class="balance-strip">
        <span>Principal<b class="money ${moneyClass(principal)}">${fmtMoney(principal, p.currency)}</b></span>
        <span>Accrued interest<b class="money interest">${detail.total > 0.005 ? '+' + fmtMoney(detail.total, p.currency) : '—'}</b></span>
        <span>Total<b class="money ${moneyClass(total)}">${fmtMoney(total, p.currency)}</b></span>
      </div>
      ${ruleNames ? `<p class="muted" style="margin:-8px 0 14px">Interest from rule: <em>${esc(ruleNames)}</em></p>` : ''}

      <div class="form-row">
        <button class="btn ghost" data-action="capitalize" data-id="${p.id}" ${detail.total > 0.005 ? '' : 'disabled'}>Capitalize interest</button>
        <button class="btn" data-action="settle" data-id="${p.id}" ${Math.abs(total) > 0.005 ? '' : 'disabled'}>Settle up</button>
        <button class="btn danger" data-action="delete-person" data-id="${p.id}">Delete person</button>
      </div>

      <div class="panel" style="margin-top:16px">
        <h3>New entry</h3>
        <form data-form="add-txn" data-person="${p.id}">
          <div class="form-row">
            <select name="sign">
              <option value="1">They borrowed (+)</option>
              <option value="-1">They paid back (−)</option>
            </select>
            <input name="amount" type="number" step="any" min="0.01" required placeholder="amount">
            <input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}">
          </div>
          <div class="form-row">
            <select name="groupId">${groupOptions}</select>
            <input name="note" placeholder="note (optional)" style="flex:1">
            <button class="btn" type="submit">Record</button>
          </div>
        </form>
      </div>

      <h3 style="font-family:var(--display);color:var(--green-deep);margin-bottom:8px">History</h3>
      ${txRows ? `<div class="table-wrap"><table class="txn-table"><thead><tr><th>Date</th><th>Group</th><th>Note</th><th class="num">Amount</th><th></th></tr></thead><tbody>${txRows}</tbody></table></div>`
        : '<span class="muted">No entries yet.</span>'}
    </div>
  </div>`;
}

/* ---------- render root ---------- */

function render() {
  renderStamps();

  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === ui.tab));

  const view = document.getElementById('view');
  switch (ui.tab) {
    case 'ledger':   view.innerHTML = renderLedger(); break;
    case 'groups':   view.innerHTML = renderGroups(); break;
    case 'history':  view.innerHTML = renderHistory(); break;
    case 'settings': view.innerHTML = renderSettings(); break;
  }
  renderModal();
}

/* ---------- event wiring (delegated) ---------- */

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');

  if (e.target.id === 'modal-overlay') { ui.modalPersonId = null; render(); return; }
  if (!btn) return;

  const { action, id, sign, group } = btn.dataset;

  switch (action) {
    case 'open-person': ui.modalPersonId = id; render(); break;
    case 'close-modal': ui.modalPersonId = null; render(); break;
    case 'open-group': ui.openGroupId = id; ui.tab = 'groups'; ui.renamingGroup = false; render(); break;
    case 'close-group': ui.openGroupId = null; ui.renamingGroup = false; render(); break;
    case 'rename-group': ui.renamingGroup = true; render(); document.querySelector('[data-form="rename-group"] input')?.focus(); break;
    case 'cancel-rename': ui.renamingGroup = false; render(); break;

    case 'quick-add': {
      const input = document.getElementById(`qa-${id}`);
      const amt = parseFloat(input?.value);
      if (!Number.isFinite(amt) || amt <= 0) { input?.focus(); return; }
      const before = totalOf(getPerson(id));
      const note = document.getElementById(`qr-${id}`)?.value.trim() || '';
      addTransaction({ personId: id, groupId: group || null, amount: amt * Number(sign), note });
      commit();
      maybeCelebrate(id, before);
      break;
    }

    case 'remove-member': {
      const g = getGroup(group);
      if (g) g.memberIds = g.memberIds.filter(m => m !== id);
      commit();
      break;
    }

    case 'delete-group':
      if (confirm('Delete this group? People and their balances are kept.')) {
        deleteGroup(id); ui.openGroupId = null; commit();
      }
      break;

    case 'delete-person': {
      const p = getPerson(id);
      if (p && confirm(`Delete ${p.name} and ALL their transactions? This cannot be undone.`)) {
        deletePerson(id); ui.modalPersonId = null; commit();
      }
      break;
    }

    case 'capitalize': capitalizeInterest(id); commit(); break;

    case 'settle':
      if (confirm('Settle up? Outstanding interest is added, then the balance is zeroed.')) {
        const before = totalOf(getPerson(id));
        settleUp(id); commit();
        maybeCelebrate(id, before);
      }
      break;

    case 'delete-txn':
      if (confirm('Delete this entry?')) { deleteTransaction(id); commit(); }
      break;

    case 'toggle-rule': {
      const r = state.interestRules.find(x => x.id === id);
      if (r) r.enabled = !r.enabled;
      commit();
      break;
    }

    case 'delete-rule':
      state.interestRules = state.interestRules.filter(r => r.id !== id);
      commit();
      break;

    case 'export-data': {
      const blob = new Blob([exportJSON()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tally-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      break;
    }

    case 'reset-data':
      if (confirm('Erase ALL data? This cannot be undone.')) {
        localStorage.removeItem(LS_KEY);
        loadState();
        render();
      }
      break;
  }
});

document.addEventListener('submit', e => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);

  switch (form.dataset.form) {
    case 'add-person': {
      const name = fd.get('name').trim();
      if (!name) return;
      addPerson(name, state.settings.baseCurrency);
      commit();
      break;
    }

    case 'add-group': {
      const name = fd.get('name').trim();
      if (!name) return;
      addGroup(name, fd.getAll('member'));
      commit();
      break;
    }

    case 'rename-group': {
      const g = getGroup(form.dataset.group);
      const name = fd.get('name').trim();
      if (g && name) { g.name = name; ui.renamingGroup = false; commit(); }
      break;
    }

    case 'add-member': {
      const g = getGroup(form.dataset.group);
      const pid = fd.get('personId');
      if (g && pid && !g.memberIds.includes(pid)) g.memberIds.push(pid);
      commit();
      break;
    }

    case 'add-txn': {
      const amt = parseFloat(fd.get('amount'));
      if (!Number.isFinite(amt) || amt <= 0) return;
      const dateStr = fd.get('date');
      const pid = form.dataset.person;
      const before = totalOf(getPerson(pid));
      addTransaction({
        personId: pid,
        groupId: fd.get('groupId') || null,
        amount: amt * Number(fd.get('sign')),
        note: fd.get('note') || '',
        date: dateStr ? new Date(dateStr + 'T12:00:00').toISOString() : null,
      });
      commit();
      maybeCelebrate(pid, before);
      break;
    }

    case 'add-interest-rule': {
      const cap = parseFloat(fd.get('capPeriods'));
      state.interestRules.push({
        id: uid(),
        name: fd.get('name').trim() || 'Untitled rule',
        enabled: true,
        op: fd.get('op'),
        value: parseFloat(fd.get('value')),
        type: fd.get('type'),
        rate: parseFloat(fd.get('rate')),
        periodUnit: fd.get('periodUnit'),
        capPeriods: Number.isFinite(cap) && cap > 0 ? cap : null,
        groupId: fd.get('groupId') || null,
      });
      commit();
      break;
    }

  }
});

document.addEventListener('change', e => {
  if (e.target.id === 'base-currency') {
    state.settings.baseCurrency = e.target.value;
    commit();
  }
  if (e.target.id === 'reset-interest-drop') {
    state.settings.resetInterestOnDrop = e.target.checked;
    commit();
  }
  if (e.target.id === 'person-currency' && ui.modalPersonId) {
    const p = getPerson(ui.modalPersonId);
    if (p) { p.currency = e.target.value; commit(); }
  }
  if (e.target.id === 'person-exempt' && ui.modalPersonId) {
    const p = getPerson(ui.modalPersonId);
    if (p) { p.interestExempt = e.target.checked; commit(); }
  }
  if (e.target.id === 'import-file') {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then(text => {
      try { importJSON(text); render(); alert('Backup imported.'); }
      catch (err) { alert('Import failed: ' + err.message); }
    });
  }
  if (e.target.id === 'notif-master') {
    const ns = notifSettings(state);
    ns.enabled = e.target.checked;
    commit();
    if (ns.enabled) enableNotifications(); else disableNotifications();
  }
  if (e.target.dataset.notifToggle) {
    notifSettings(state)[e.target.dataset.notifToggle].enabled = e.target.checked;
    commit();
  }
  if (e.target.dataset.notifValue) {
    const ns = notifSettings(state);
    const { notifValue: key, field } = e.target.dataset;
    ns[key][field] = field === 'cadence'
      ? e.target.value
      : Math.max(0, parseFloat(e.target.value) || 0);
    commit();
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'search-box') {
    ui.search = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const box = document.getElementById('search-box');
    box.focus();
    box.setSelectionRange(pos, pos);
  }
  if (e.target.id === 'history-search') {
    ui.historySearch = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const box = document.getElementById('history-search');
    box.focus();
    box.setSelectionRange(pos, pos);
  }
});

document.getElementById('tabs').addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  ui.tab = tab.dataset.tab;
  ui.openGroupId = null;
  ui.renamingGroup = false;
  render();
});

/* interest accrues with time — refresh the numbers every minute */
setInterval(render, 60_000);

/* ---------- boot ---------- */

loadState();
saveState();            // ensure the IDB mirror exists even before the first edit
render();
runNotificationCheck();
registerPeriodicSync();
