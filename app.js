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

function commit() { saveState(); render(); }

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
    const groups = groupsOf(p.id).map(g => `<span class="chip">${esc(g.name)}</span>`).join('') || '<span class="muted">—</span>';
    const exempt = p.interestExempt ? '<span class="chip exempt">no interest</span>' : '';

    return `<tr class="row">
      <td><button class="person-name" data-action="open-person" data-id="${p.id}">${esc(p.name)}</button> ${exempt}</td>
      <td class="col-groups">${groups}</td>
      <td class="num"><span class="money ${moneyClass(principal)}">${fmtMoney(principal, p.currency)}</span></td>
      <td class="num"><span class="money interest">${interest > 0.005 ? '+' + fmtMoney(interest, p.currency) : '—'}</span></td>
      <td class="num"><span class="money ${moneyClass(total)}">${fmtMoney(total, p.currency)}</span></td>
      <td>
        <div class="quick-add">
          <input type="number" step="any" min="0" placeholder="amount" id="qa-${p.id}">
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
      <td><button class="person-name" data-action="open-person" data-id="${p.id}">${esc(p.name)}</button></td>
      <td class="num"><span class="money ${moneyClass(total)}">${fmtMoney(total, p.currency)}</span></td>
      <td>
        <div class="quick-add">
          <input type="number" step="any" min="0" placeholder="amount" id="qa-${p.id}">
          <button class="btn small plus" data-action="quick-add" data-id="${p.id}" data-sign="1" data-group="${g.id}">+ lent</button>
          <button class="btn small minus" data-action="quick-add" data-id="${p.id}" data-sign="-1" data-group="${g.id}">− paid</button>
        </div>
      </td>
      <td><button class="del-x" data-action="remove-member" data-id="${p.id}" data-group="${g.id}" title="Remove from group">✕</button></td>
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
      <thead><tr><th>Member</th><th class="num">Total owed (global)</th><th>Quick entry (tagged to this group)</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">No members yet.</td></tr>'}</tbody>
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
      ${activity ? `<table class="txn-table"><thead><tr><th>Date</th><th>Person</th><th>Note</th><th class="num">Amount</th></tr></thead><tbody>${activity}</tbody></table>`
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
    </div>

  `;
}

/* ---------- settings view ---------- */

function renderSettings() {
  return `
    <h2 class="section-title">Settings</h2>
    <p class="section-sub">Interest rules, currency, and your data — which never leaves this browser unless you export it.</p>

    ${interestRulesPanel()}

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
      ${txRows ? `<table class="txn-table"><thead><tr><th>Date</th><th>Group</th><th>Note</th><th class="num">Amount</th><th></th></tr></thead><tbody>${txRows}</tbody></table>`
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
      addTransaction({ personId: id, groupId: group || null, amount: amt * Number(sign) });
      commit();
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
        settleUp(id); commit();
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
      addTransaction({
        personId: form.dataset.person,
        groupId: fd.get('groupId') || null,
        amount: amt * Number(fd.get('sign')),
        note: fd.get('note') || '',
        date: dateStr ? new Date(dateStr + 'T12:00:00').toISOString() : null,
      });
      commit();
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
render();
