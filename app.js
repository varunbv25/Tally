/* =========================================================
   TALLY — UI layer
   Renders views from store.js state; all mutations go
   through store functions, then saveState() + render().
   ========================================================= */

const ui = {
  tab: 'ledger',
  openGroupId: null,
  modalPersonId: null,
  indirectOpen: false,      // indirect-payment popup open
  splitOpen: false,         // split-expense popup open
  splitDraft: null,         // in-progress split (survives re-render when adding a person)
  shareGroupId: null,       // group share-picker popup open (which group)
  sharePeopleOpen: false,   // ledger share-picker popup open (pick who to share)
  search: '',
  historySearch: '',
  renamingGroup: false,
  creatingGroup: false,     // group-create panel revealed
  selectMode: false,        // history multi-select for deletion
  selected: new Set(),      // selected transaction ids
  confirmDelete: false,     // delete-confirmation overlay open
  memberSelect: false,      // group-member multi-select for removal
  selectedMembers: new Set(), // selected member ids
  confirmRemoveMembers: false, // remove-members confirmation overlay open
  personSelect: false,      // ledger person multi-select for deletion
  selectedPeople: new Set(), // selected person ids
  confirmDeletePeople: false, // delete-people confirmation overlay open
  confirmClearDebt: null,   // person id whose clear-debt confirmation overlay is open
  cloudPromptOpen: false,   // first-run "sync across devices?" popup open
};

/* ---------- helpers ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/* Turn a date-picker value into a timestamp. For today we record the real
   clock time so entries order naturally (newest last); for a backdated day
   there's no real time to capture, so we use noon — far from the day's edges
   so the calendar date never drifts across timezones (search keys off the UTC
   date). Empty input means "now". */
function entryDate(dateStr) {
  if (!dateStr) return new Date();
  const today = new Date().toISOString().slice(0, 10);
  return dateStr === today ? new Date() : new Date(dateStr + 'T12:00:00');
}

function commit() { saveState(); render(); runNotificationCheck(); }

/* ---------- theme ----------
   The user's choice ('light' | 'dark' | 'device') lives in settings.
   We resolve it to a concrete light/dark value, stamp <html data-theme>
   (styles.css overrides the palette tokens for "dark"), and keep the
   address-bar/status-bar colour in step. On "device" we follow the OS
   and update live when it flips. */
const THEME_BAR_COLOR = { light: '#1e5b3f', dark: '#1e1e1e' };

function prefersDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function resolvedTheme() {
  const pref = (state && state.settings && state.settings.theme) || 'device';
  if (pref === 'light' || pref === 'dark') return pref;
  return prefersDark() ? 'dark' : 'light';
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_BAR_COLOR[theme]);
}

if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (((state && state.settings && state.settings.theme) || 'device') === 'device') applyTheme();
  });
}

/* ---------- back-button / gesture navigation ----------
   Each drill-in (tab switch, group detail, person modal) pushes a
   history entry encoding the nav state. Close buttons call goBack(),
   so the OS back button/gesture and on-screen close behave identically;
   popstate replays the previous nav state. From the root, back exits. */

/* Depth above the Ledger floor (entry 0). Stored in each history entry so
   popstate can restore it; lets a tap on the Ledger tab collapse the whole
   stack back to the floor, so the next OS-back exits the app. */
let navDepth = 0;

function navState() {
  return { tally: true, depth: navDepth, tab: ui.tab, openGroupId: ui.openGroupId, modalPersonId: ui.modalPersonId, indirectOpen: ui.indirectOpen, splitOpen: ui.splitOpen, shareGroupId: ui.shareGroupId, sharePeopleOpen: ui.sharePeopleOpen, selectMode: ui.selectMode, memberSelect: ui.memberSelect, personSelect: ui.personSelect };
}

function pushNav() {
  navDepth++;
  history.pushState(navState(), '');
}

function applyNav(s) {
  ui.tab = s && s.tab ? s.tab : 'ledger';
  ui.openGroupId = (s && s.openGroupId) || null;
  ui.modalPersonId = (s && s.modalPersonId) || null;
  ui.indirectOpen = !!(s && s.indirectOpen);
  ui.splitOpen = !!(s && s.splitOpen);
  ui.shareGroupId = (s && s.shareGroupId) || null;
  ui.sharePeopleOpen = !!(s && s.sharePeopleOpen);
  ui.renamingGroup = false;
  ui.selectMode = !!(s && s.selectMode);
  if (!ui.selectMode) { ui.selected = new Set(); ui.confirmDelete = false; }
  ui.memberSelect = !!(s && s.memberSelect);
  if (!ui.memberSelect) { ui.selectedMembers = new Set(); ui.confirmRemoveMembers = false; }
  ui.personSelect = !!(s && s.personSelect);
  if (!ui.personSelect) { ui.selectedPeople = new Set(); ui.confirmDeletePeople = false; }
}

function goBack() { history.back(); }

window.addEventListener('popstate', e => {
  const s = e.state && e.state.tally ? e.state : { tab: 'ledger', depth: 0 };
  navDepth = s.depth || 0;
  applyNav(s);
  render();
});

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

/* showToast, the SHARE_SVG icon (now Icons.share) and rowActions live in
   components/toast.js, components/icons.js and components/row-actions.js. */

/* ---------- sharing ---------- */

/* Open the native share sheet; fall back to the clipboard where the Web
   Share API is missing (most desktops) or fails for any reason other
   than the user dismissing the sheet. */
async function shareText(title, text) {
  try {
    if (navigator.share) { await navigator.share({ title, text }); return; }
  } catch (err) {
    if (err && err.name === 'AbortError') return;   // user dismissed the sheet
    /* any other share failure falls through to the clipboard */
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard');
  } catch {
    showToast('Sharing isn’t supported on this device');
  }
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

/* Connectivity indicator. Tally is local-first — every view always renders from
   localStorage and never blocks on the network — so "offline" never hides data;
   this badge just tells the user the figures they're seeing are the locally
   saved copy (and, when signed into cloud sync, that mirroring is paused). */
function connectionDown() {
  const navOff = typeof navigator !== 'undefined' && navigator.onLine === false;
  const syncOff = typeof cloudAuth === 'object' && cloudAuth && cloudAuth.offline;
  return !!(navOff || syncOff);
}

function updateConnectivity() {
  const el = document.getElementById('offline-flag');
  if (el) el.hidden = !connectionDown();
}

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
  const query = ui.search.trim();
  const people = state.people
    .filter(p => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const exactMatch = state.people.some(p => p.name.toLowerCase() === q);
  const showAdd = query.length > 0 && !exactMatch;

  /* The "add a new person" prompt. When the search matches existing people it
     sits *below* the matches (the existing names come first); only when nothing
     matches does it become the first/only option. */
  const addPersonBlock = showAdd ? `
      <div class="add-person-quick">
        <div class="add-person-quick-head">
          <span class="add-suggestion-plus" aria-hidden="true">+</span>
          <span>Add “<b>${esc(query)}</b>” as a new person</span>
        </div>
        ${QuickAdd({ idSuffix: 'new', action: 'add-person-entry', titles: true })}
        <span class="add-person-quick-hint">Leave the amount blank to just add the name.</span>
      </div>` : '';

  const rows = people.map(p => {
    const { principal, interest, total } = balanceDisplay(p);
    const groups = groupsOf(p.id).map(g => Chip(esc(g.name))).join('');
    const exempt = p.interestExempt ? Chip('no interest', 'exempt') : '';
    const isSel = ui.selectedPeople.has(p.id);
    const selCls = ui.personSelect ? (isSel ? ' selected' : '') : '';
    const check = ui.personSelect ? `<span class="sel-check${isSel ? ' on' : ''}" aria-hidden="true"></span>` : '';

    return `<tr class="row${selCls}" data-person-id="${p.id}">
      <td class="col-person">${check}${PersonName(p.id, p.name, 'Tap to open · long-press to select &amp; delete')} ${exempt} ${rowActions(p.name, p.id, total)}</td>
      <td class="col-groups">${groups}</td>
      <td class="num" data-label="Principal">${Money(principal, p.currency)}</td>
      <td class="num" data-label="Interest"><span class="money interest">${interest > 0.005 ? '+' + fmtMoney(interest, p.currency) : '—'}</span></td>
      <td class="num" data-label="Total">${Money(total, p.currency)}</td>
      <td class="col-quick">
        ${QuickAdd({ idSuffix: p.id, action: 'quick-add', dataId: p.id, titles: true })}
      </td>
    </tr>`;
  }).join('');

  const selCount = ui.selectedPeople.size;
  const selectBar = ui.personSelect ? SelectBar({
    count: selCount,
    cancelAction: 'exit-person-select',
    deleteAction: 'open-delete-people-confirm',
    deleteLabel: 'Delete selected people',
  }) : '';

  const confirmOverlay = ui.confirmDeletePeople ? ConfirmOverlay({
    id: 'person-confirm-overlay',
    closeAction: 'cancel-delete-people',
    inner: `
        <h3>Delete ${selCount} ${selCount === 1 ? 'person' : 'people'}?</h3>
        <p class="muted">They'll be removed along with ALL of their transactions, and taken out of every group. This cannot be undone.</p>
        <button class="btn danger block" data-action="confirm-delete-people">Delete ${selCount === 1 ? 'person' : 'people'}</button>
        <button class="btn ghost block" data-action="cancel-delete-people">Cancel</button>`,
  }) : '';

  const clearTarget = ui.confirmClearDebt ? getPerson(ui.confirmClearDebt) : null;
  const clearOverlay = clearTarget ? ConfirmOverlay({
    id: 'clear-debt-overlay',
    closeAction: 'cancel-clear-debt',
    inner: `
        <h3>Clear ${esc(clearTarget.name)}'s debt?</h3>
        <p class="muted">Any outstanding interest is added, then the balance is zeroed and recorded in History as a repayment.</p>
        <button class="btn block" data-action="confirm-clear-debt" data-id="${clearTarget.id}">Clear debt</button>
        <button class="btn ghost block" data-action="cancel-clear-debt">Cancel</button>`,
  }) : '';

  return `
    ${selectBar}
    ${confirmOverlay}
    ${clearOverlay}
    <div class="detail-head">
      <h2 class="section-title">The Ledger</h2>
      <div class="head-side">
        <div class="head-actions">
          <button class="btn ghost head-action" data-action="open-split" ${state.people.length < 2 ? 'disabled title="Add at least two people first"' : ''}>÷ Split expense</button>
          <button class="btn ghost head-action" data-action="open-indirect" ${state.people.length < 2 ? 'disabled title="Add at least two people first"' : ''}>⇄ Indirect payment</button>
        </div>
      </div>
    </div>
    <p class="section-sub">Every person, every balance — across all groups. Positive means they owe you. Type an amount and hit <em>+ paid</em> or <em>− repaid</em>, just like a spreadsheet row. Tap <em>Clear</em> beside a name to settle their debt to zero. Long-press a name to select people, then tap the bin to delete.</p>

    <form id="person-search" data-form="person-search" class="people-search" role="search">
      <span class="people-search-icon" aria-hidden="true">${Icons.search()}</span>
      <input id="search-box" name="q" placeholder="Search people, or type a new name to add…" value="${esc(ui.search)}" autocomplete="off">
      ${query ? `<button type="button" class="people-search-clear" data-action="clear-search" aria-label="Clear search">×</button>` : ''}
    </form>
    ${people.length ? '' : addPersonBlock}

    ${people.length ? `
    <div class="list-share">
      ${ShareButton({ cls: 'btn ghost head-action head-share', action: 'open-share-people', extra: state.people.length < 1 ? 'disabled title="Add someone first"' : '' })}
    </div>
    <table class="ledger-table">
      <thead><tr>
        <th>Person</th><th class="col-groups">Groups</th>
        <th class="num">Principal</th><th class="num">Interest</th><th class="num">Total</th>
        <th>Quick entry</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${addPersonBlock}` : (state.people.length === 0
      ? EmptyState(`
          <div class="empty-mark" aria-hidden="true">${Icons.ledgerMark()}</div>
          <h3 class="empty-title">Your ledger is empty</h3>
          <p class="empty-copy">Add the first person you’ve lent to or borrowed from. Everything stays in this browser — nothing is uploaded.</p>
          <button class="btn" data-action="focus-search">+ Add your first person</button>`, 'empty-onboard')
      : EmptyState(`No one matches “${esc(query)}”.${showAdd ? ' Add them with the button above.' : ''}`))}
  `;
}

/* ---------- groups view ---------- */

function groupNetLine(g) {
  const parts = Object.entries(groupDebtSummary(g))
    .filter(([, s]) => Math.abs(s.net) > 0.005)
    .map(([code, s]) => {
      const cls = s.net >= 0 ? 'pos' : 'neg';
      const label = s.net >= 0 ? 'net owed to you' : 'net you owe';
      return `${label} <span class="money ${cls}">${fmtMoney(Math.abs(s.net), code)}</span>`;
    });
  return parts.length ? parts.join(' · ') : '<span class="net-square">all square</span>';
}

function groupDebtStrip(g) {
  const entries = Object.entries(groupDebtSummary(g));
  if (!entries.length) return '';
  return entries.map(([code, s]) => `
    <div class="balance-strip">
      <span>They owe you${Money(s.owedToYou, code, { tag: 'b', cls: 'pos' })}</span>
      <span>You owe them${Money(s.youOwe, code, { tag: 'b', cls: 'neg' })}</span>
      <span>Total debt${Money(s.net, code, { tag: 'b' })}</span>
    </div>`).join('');
}

function renderGroups() {
  if (ui.openGroupId) return renderGroupDetail();

  const cards = state.groups.map(g => {
    const names = g.memberIds.map(id => getPerson(id)?.name).filter(Boolean).join(', ');
    const count = g.memberIds.length;
    return `<button class="group-card" data-action="open-group" data-id="${g.id}">
      <div class="group-card-head">
        <h3>${esc(g.name)}</h3>
        ${Chip(`${count} ${count === 1 ? 'person' : 'people'}`)}
      </div>
      <div class="members">${esc(names) || 'No members yet'}</div>
      <span class="group-net">${groupNetLine(g)}</span>
    </button>`;
  }).join('');

  const memberChecks = state.people.map(p =>
    `<label><input type="checkbox" name="member" value="${p.id}"> ${esc(p.name)}</label>`
  ).join('');

  // The create form takes the prime slot only when there's nothing else to show
  // or the user explicitly opens it; otherwise existing groups lead.
  const showCreate = ui.creatingGroup || state.groups.length === 0;
  const createPanel = Panel({
    head: `
      <div class="panel-head">
        <h3>Create a group</h3>
        ${state.groups.length ? '<button class="modal-close" data-action="cancel-create-group" aria-label="Close">×</button>' : ''}
      </div>`,
    body: `
      <form data-form="add-group">
        <div class="form-row"><input name="name" placeholder="Group name (e.g. Goa Trip)" required></div>
        <div class="form-row">${memberChecks || '<span class="muted">Add people on the Ledger tab first.</span>'}</div>
        <div class="form-row tight"><button class="btn" type="submit">Create group</button></div>
      </form>`,
  });

  return `
    <div class="detail-head">
      <h2 class="section-title">Groups</h2>
      ${state.groups.length && !showCreate
        ? '<button class="btn ghost head-action" data-action="new-group">+ New group</button>' : ''}
    </div>
    <p class="section-sub">People can live in many groups at once. Balances are global — record a payment in one group and it shows up in every other group instantly.</p>

    ${showCreate ? createPanel : ''}

    ${state.groups.length ? `<div class="group-grid">${cards}</div>`
      : (ui.creatingGroup ? '' : EmptyState('No groups yet. Trips, flatmates, that one fantasy league — they all start here.'))}
  `;
}

function renderGroupDetail() {
  const g = getGroup(ui.openGroupId);
  if (!g) { ui.openGroupId = null; return renderGroups(); }

  const members = g.memberIds.map(getPerson).filter(Boolean);

  const rows = members.map(p => {
    const total = totalOf(p);
    const isSel = ui.selectedMembers.has(p.id);
    const selCls = ui.memberSelect ? (isSel ? ' selected' : '') : '';
    const check = ui.memberSelect ? `<span class="sel-check${isSel ? ' on' : ''}" aria-hidden="true"></span>` : '';
    return `<tr class="row${selCls}" data-member-id="${p.id}">
      <td class="col-person">${check}${PersonName(p.id, p.name)}
        ${rowActions(p.name, p.id, total)}</td>
      <td class="num" data-label="Total owed">${Money(total, p.currency)}</td>
      <td class="col-quick">
        ${QuickAdd({ idSuffix: p.id, action: 'quick-add', dataId: p.id, group: g.id, titles: false })}
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
        <td class="num">${Money(t.amount, p.currency)}</td>
      </tr>`;
    }).join('');

  const selCount = ui.selectedMembers.size;
  const selectBar = ui.memberSelect ? SelectBar({
    count: selCount,
    cancelAction: 'exit-member-select',
    deleteAction: 'open-remove-members-confirm',
    deleteLabel: 'Remove selected from group',
  }) : '';

  const confirmOverlay = ui.confirmRemoveMembers ? ConfirmOverlay({
    id: 'member-confirm-overlay',
    closeAction: 'cancel-remove-members',
    inner: `
        <h3>Remove ${selCount} ${selCount === 1 ? 'person' : 'people'}?</h3>
        <p class="muted">They'll be taken out of ${esc(g.name)}. Balances and history stay exactly the same — only the grouping changes.</p>
        <button class="btn danger block" data-action="confirm-remove-members">Remove from group</button>
        <button class="btn ghost block" data-action="cancel-remove-members">Cancel</button>`,
  }) : '';

  return `
    ${selectBar}
    ${confirmOverlay}
    ${BackLink('close-group', 'All groups')}
    ${ui.renamingGroup ? `
    <form data-form="rename-group" data-group="${g.id}" class="form-row">
      <input name="name" value="${esc(g.name)}" required maxlength="60" autofocus>
      <button class="btn small" type="submit">Save</button>
      <button class="btn small ghost" type="button" data-action="cancel-rename">Cancel</button>
    </form>` : `
    <div class="detail-head">
      <h2 class="section-title">${esc(g.name)}
        <button class="btn small ghost" data-action="rename-group" data-id="${g.id}">Rename</button>
      </h2>
    </div>`}
    <div class="banner">Balances here are <strong>global</strong>. A payment recorded in ${esc(g.name)} updates this person everywhere — every other group sees it too.</div>

    ${groupDebtStrip(g)}

    <div class="list-share">
      ${ShareButton({ cls: 'btn small ghost share-group-btn', action: 'share-group', dataId: g.id })}
    </div>
    <table class="ledger-table">
      <thead><tr><th>Member</th><th class="num">Total owed (global)</th><th>Quick entry (tagged to this group)</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3" class="muted">No members yet.</td></tr>'}</tbody>
    </table>
    ${members.length ? '<p class="muted" style="margin-top:8px">Long-press a member to start selecting, tap others to add, then tap the bin to remove them from the group.</p>' : ''}

    ${Panel({
      title: 'Add member',
      style: 'margin-top:24px',
      body: `
      <form data-form="add-member" class="form-row tight" data-group="${g.id}">
        <select name="personId">${addMemberOptions || '<option value="">Everyone is already here</option>'}</select>
        <button class="btn" type="submit" ${nonMembers.length ? '' : 'disabled'}>Add to group</button>
      </form>`,
    })}

    ${Panel({
      title: 'Group activity',
      body: activity ? `<div class="table-wrap"><table class="txn-table"><thead><tr><th>Date</th><th>Person</th><th>Note</th><th class="num">Amount</th></tr></thead><tbody>${activity}</tbody></table></div>`
        : '<span class="muted">No transactions tagged to this group yet.</span>',
    })}

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

  return Panel({
    head: '<h3>Interest rules <span class="muted">(evaluated top-down, first match wins)</span></h3>',
    body: `
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
      <p class="muted" style="margin-top:14px; padding-top:12px; border-top:1px solid var(--line)">
        When a repayment drops the balance below a rule's condition, the accrued interest is rolled into the principal and the interest column goes blank. It stays part of the principal — so the next time the balance crosses a condition, fresh interest accrues on that larger principal.</p>`,
  });
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

  return Panel({
    title: 'Notifications',
    body: `
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
      <p class="muted">Computed on this device — amounts compare in each person’s own currency. Background alerts work where Tally is installed as an app (Android/Chrome); elsewhere you’re notified when you open Tally.</p>`,
  });
}

/* Opt-in email cloud sync. Mirrors notificationsPanel()'s shape: a single
   Panel whose body switches on cloudAuth.status (idle → code-sent → signed-in).
   All the heavy lifting lives in cloud.js; this is purely presentation. */
function cloudSyncPanel() {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const err = cloudAuth.error ? `<div class="banner">${esc(cloudAuth.error)}</div>` : '';
  const busy = cloudAuth.busy;

  let body;
  if (!cloudConfigured()) {
    body = `<p class="muted">Cloud sync isn’t set up for this deployment. It’s an
      optional self-hosted service — see the Worker setup in the project README.</p>`;
  } else if (cloudAuth.status === 'signed-in') {
    const last = cloudAuth.lastSync
      ? `Last synced ${fmtDate(new Date(cloudAuth.lastSync).toISOString())} at ${new Date(cloudAuth.lastSync).toLocaleTimeString()}`
      : 'Not synced yet this session';
    const offline = connectionDown()
      ? `<div class="banner">Offline — you're seeing the copy saved on this device. Changes will mirror to the cloud automatically once you're back online.</div>`
      : '';
    body = `
      ${err}
      ${offline}
      <p class="muted">Signed in as <strong>${esc(cloudAuth.email)}</strong>. Your ledger
        is mirrored to the cloud after every change, so signing in with the same email on
        another device pulls it down.</p>
      <p class="muted">${last}</p>
      <div class="form-row tight" style="margin-top:12px">
        <button class="btn" data-action="cloud-sync-now" ${busy ? 'disabled' : ''}>${busy ? 'Syncing…' : 'Sync now'}</button>
        <button class="btn ghost" data-action="cloud-signout" ${busy ? 'disabled' : ''}>Sign out</button>
      </div>
      <p class="muted">Signing out leaves this device’s ledger untouched — it just stops mirroring.</p>`;
  } else if (cloudAuth.status === 'code-sent') {
    body = `
      ${err}
      <p class="muted">We emailed a 6-digit code to <strong>${esc(cloudAuth.email)}</strong>. Enter it below — it expires in 10 minutes.</p>
      <div class="form-row">
        <label>Sign-in code
          <input type="text" id="cloud-code" inputmode="numeric" autocomplete="one-time-code"
                 maxlength="6" placeholder="123456" ${busy ? 'disabled' : ''}>
        </label>
      </div>
      <div class="form-row tight">
        <button class="btn" data-action="cloud-verify" ${busy ? 'disabled' : ''}>${busy ? 'Verifying…' : 'Verify & sign in'}</button>
        <button class="btn ghost" data-action="cloud-reset-email" ${busy ? 'disabled' : ''}>Use a different email</button>
      </div>`;
  } else {
    const google = typeof googleConfigured === 'function' && googleConfigured();
    const googleBlock = google ? `
      <div id="google-signin-btn" class="google-signin"></div>
      <div class="auth-divider"><span>or use email</span></div>` : '';
    body = `
      ${err}
      <p class="muted">Mirror your ledger to the cloud so you can pick it up on another
        device. ${google
          ? 'Sign in with Google, or get a one-time code by email.'
          : 'Sign in with just your email — we’ll send a one-time code. No password, no phone number.'}</p>
      ${googleBlock}
      <div class="form-row">
        <label>Email
          <input type="email" id="cloud-email" inputmode="email" autocomplete="email"
                 placeholder="you@example.com" ${busy ? 'disabled' : ''}>
        </label>
      </div>
      <div class="form-row tight">
        <button class="btn" data-action="cloud-send-code" ${busy ? 'disabled' : ''}>${busy ? 'Sending…' : 'Send sign-in code'}</button>
      </div>
      <p class="muted">Opt-in and off by default — until you sign in, nothing leaves this browser.</p>`;
  }

  return Panel({ id: 'cloud-sync-panel', title: 'Cloud sync', body });
}

/* First-run onboarding popup: offered once (see cloudShouldPrompt in cloud.js),
   it asks whether to set up cloud sync. Either choice marks the prompt seen, so
   returning users never see it again — for them sync just sits in Settings.
   "Set up cloud sync" drops the user onto the Account → Cloud sync panel. */
function renderCloudPrompt() {
  const root = document.getElementById('cloud-prompt-root');
  if (!root) return;
  if (!ui.cloudPromptOpen) { root.innerHTML = ''; return; }

  root.innerHTML = Modal({
    overlayId: 'cloud-prompt-overlay',
    modalCls: 'modal-cloud-prompt',
    title: 'Sync across devices?',
    closeAction: 'cloud-prompt-dismiss',
    body: `
      <p class="muted">Tally keeps your ledger in this browser. Sign in with just your
        email and we’ll mirror it to the cloud, so you can pick it up on another device.
        No password, no phone number — and it stays opt-in.</p>
      <div class="form-row tight" style="margin-top:18px">
        <button class="btn" data-action="cloud-prompt-signin">Set up cloud sync</button>
        <button class="btn ghost" data-action="cloud-prompt-dismiss">Not now</button>
      </div>
      <p class="muted" style="margin-top:12px">You can always turn this on later from Account → Cloud sync.</p>`,
  });
}

/* Close the first-run popup and remember it was offered, so it never reappears. */
function dismissCloudPrompt() {
  ui.cloudPromptOpen = false;
  if (typeof markCloudPromptSeen === 'function') markCloudPromptSeen();
  render();
}

/* Jump to Settings and bring the Cloud sync panel into view + briefly highlight
   it, so "Set up cloud sync" lands the user exactly where they can sign in. */
function openCloudSyncSettings() {
  ui.tab = 'account';
  pushNav();
  render();
  requestAnimationFrame(() => {
    const panel = document.getElementById('cloud-sync-panel');
    if (!panel) return;
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    panel.classList.add('panel-flash');
    setTimeout(() => panel.classList.remove('panel-flash'), 1600);
    document.getElementById('cloud-email')?.focus({ preventScroll: true });
  });
}

/* ---------- history view ---------- */

function renderHistory() {
  const q = ui.historySearch.trim().toLowerCase();

  const realEntries = state.transactions
    .map((t, i) => ({ t, i, p: getPerson(t.personId), g: t.groupId ? getGroup(t.groupId) : null }))
    .filter(x => (x.p || x.t.self) && !x.t.archived);          // skip orphaned + hidden entries (keep your own split shares)

  /* Interest that has accrued day-by-day but hasn't been capitalized yet is
     shown as virtual, dated rows — so "interest adding up per day" is visible in
     History without writing anything to the ledger. These carry no real txn id,
     so they can't be selected or deleted; capitalizing turns them into one real
     entry. */
  const virtualEntries = [];
  state.people.forEach(p => {
    accruedInterestDetail(p).schedule.forEach((s, k) => {
      virtualEntries.push({
        t: {
          id: `virt-${p.id}-${k}`, personId: p.id, groupId: null,
          amount: s.amount, note: 'Interest', date: s.date,
          isInterest: true, virtual: true,
        },
        i: -1, p, g: null,
      });
    });
  });

  // newest first; date-picked entries all land at noon, so ties fall back to
  // insertion order (later-added = more recent) instead of drifting to the bottom
  const entries = realEntries.concat(virtualEntries)
    .sort((a, b) => (new Date(b.t.date) - new Date(a.t.date)) || (b.i - a.i));

  const matches = entries.filter(({ t, p, g }) => {
    if (!q) return true;
    const kind = t.isInterest ? 'interest'
      : t.indirect ? 'indirect transfer'
      : t.split ? (t.self ? 'split expense your share' : 'split expense paid gave lent')
      : (t.amount >= 0 ? 'paid gave lent borrowed' : 'repaid paid back');
    const counterparty = t.indirect && t.counterpartyId ? (getPerson(t.counterpartyId)?.name || '') : '';
    const name = p ? p.name : 'Me';
    const cur = p ? p.currency : state.settings.baseCurrency;
    const hay = [
      name,
      t.note,
      counterparty,
      g ? g.name : 'personal',
      Math.abs(t.amount),
      fmtMoney(t.amount, cur),
      fmtDate(t.date),
      t.date.slice(0, 10),
      kind,
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });

  const rows = matches.map(({ t, p, g }) => {
    /* Virtual interest charge — display only, no selection/delete affordances. */
    if (t.virtual) {
      const cur = p ? p.currency : state.settings.baseCurrency;
      return `<tr class="row virtual-interest">
        <td class="col-person">
          ${PersonName(p.id, p.name)}
          ${Money(t.amount, cur, { cls: 'pos hist-amount', sign: true })}
        </td>
        <td data-label="Date">${fmtDate(t.date)}</td>
        <td data-label="Type"><span class="interest-tag">INTEREST</span></td>
        <td data-label="Group"><span class="muted">accrued</span></td>
        <td data-label="Reason"><span class="muted">accrued, not yet capitalized</span></td>
        <td class="num" data-label="Amount">${Money(t.amount, cur, { cls: 'pos', sign: true })}</td>
      </tr>`;
    }
    const via = t.indirect && t.counterpartyId
      ? `<span class="muted xfer-via">via ${esc(getPerson(t.counterpartyId)?.name || '—')}</span>` : '';
    const tag = t.isInterest
      ? '<span class="interest-tag">INTEREST</span>'
      : t.indirect
        ? '<span class="hist-tag indirect">indirect</span>'
        : t.split
          ? '<span class="hist-tag split">split</span>'
          : (t.amount >= 0 ? '<span class="hist-tag lent">paid</span>' : '<span class="hist-tag paid">repaid</span>');
    const isSel = ui.selected.has(t.id);
    const selCls = ui.selectMode ? (isSel ? ' selected' : '') : '';
    const check = ui.selectMode ? `<span class="sel-check${isSel ? ' on' : ''}" aria-hidden="true"></span>` : '';
    /* `self` legs (your own share of a split) have no person — they're a record,
       not a debt — so show "Me", use your base currency, and keep the amount
       colour-neutral rather than the green/red used for who-owes-whom. */
    const cur = p ? p.currency : state.settings.baseCurrency;
    const amtClass = t.self ? 'zero' : moneyClass(t.amount);
    const personBtn = p
      ? PersonName(p.id, p.name)
      : `<span class="person-name">Me</span>`;
    const reason = t.self
      ? `${esc(t.note) ? esc(t.note) + ' ' : ''}<span class="muted">your share</span>`
      : `${esc(t.note) || (via ? '' : '<span class="muted">—</span>')} ${via}`;
    return `<tr class="row${selCls}" data-txn-id="${t.id}">
      <td class="col-person">
        ${check}
        ${personBtn}
        ${Money(t.amount, cur, { cls: `${amtClass} hist-amount` })}
      </td>
      <td data-label="Date">${fmtDate(t.date)}</td>
      <td data-label="Type">${tag}</td>
      <td data-label="Group">${g ? Chip(esc(g.name)) : '<span class="muted">personal</span>'}</td>
      <td data-label="Reason">${reason}</td>
      <td class="num" data-label="Amount">${Money(t.amount, cur, { cls: amtClass })}</td>
    </tr>`;
  }).join('');

  const selCount = ui.selected.size;
  const selectBar = ui.selectMode ? SelectBar({
    count: selCount,
    cancelAction: 'exit-select',
    deleteAction: 'open-delete-confirm',
    deleteLabel: 'Delete selected',
  }) : '';

  const confirmOverlay = ui.confirmDelete ? ConfirmOverlay({
    id: 'confirm-overlay',
    closeAction: 'cancel-confirm',
    inner: `
        <h3>Delete ${selCount} ${selCount === 1 ? 'entry' : 'entries'}?</h3>
        <p class="muted">Choose how these should be removed:</p>
        <button class="btn danger block" data-action="confirm-delete" data-mode="adjust">
          Delete &amp; adjust balances
        </button>
        <p class="confirm-hint">Removes the entries and updates each person's balance by those amounts.</p>
        <button class="btn block" data-action="confirm-delete" data-mode="archive">
          Remove from history only
        </button>
        <p class="confirm-hint">Hides them from history. Everyone's balance stays exactly the same.</p>
        <button class="btn ghost block" data-action="cancel-confirm">Cancel</button>`,
  }) : '';

  return `
    ${selectBar}
    ${confirmOverlay}
    <h2 class="section-title">History</h2>
    <p class="section-sub">Every entry across everyone — lent, paid, and interest. Search by person, reason, amount, or date. Long-press an entry to start selecting, tap others to add, then tap the bin to delete.</p>

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
      : EmptyState(`No entries match “${esc(ui.historySearch)}”.`))
      : EmptyState('No transactions yet. Record some lending or repayments on the Ledger.')}
  `;
}

function enterSelectMode(txnId) {
  if (ui.selectMode) {
    toggleSelected(txnId);
    return;
  }
  ui.selectMode = true;
  ui.selected = new Set([txnId]);
  pushNav();
  render();
}

function toggleSelected(txnId) {
  if (ui.selected.has(txnId)) ui.selected.delete(txnId);
  else ui.selected.add(txnId);
  render();
}

/* mode: 'adjust' removes the entries and changes balances;
   'archive' hides them from history but keeps balances unchanged. */
function performDelete(mode) {
  const ids = new Set(ui.selected);
  if (!ids.size) return;
  // an indirect payment is two linked legs — act on its sibling too so balances stay consistent
  [...ids].forEach(id => {
    const t = state.transactions.find(x => x.id === id);
    if (t && t.indirect && t.linkId) {
      state.transactions.forEach(x => { if (x.linkId === t.linkId) ids.add(x.id); });
    }
  });
  ids.forEach(id => {
    if (mode === 'adjust') {
      deleteTransaction(id);
    } else {
      const t = state.transactions.find(x => x.id === id);
      if (t) t.archived = true;
    }
  });
  saveState();
  runNotificationCheck();
  const n = ids.size;
  ui.confirmDelete = false;
  goBack();   // pops the select-mode entry; popstate clears selection and re-renders
  showToast(`${n} ${n === 1 ? 'entry' : 'entries'} ${mode === 'adjust' ? 'deleted' : 'removed from history'}`);
}

/* ---------- group-member multi-select removal ---------- */
function enterMemberSelectMode(memberId) {
  if (ui.memberSelect) {
    toggleMemberSelected(memberId);
    return;
  }
  ui.memberSelect = true;
  ui.selectedMembers = new Set([memberId]);
  pushNav();
  render();
}

function toggleMemberSelected(memberId) {
  if (ui.selectedMembers.has(memberId)) ui.selectedMembers.delete(memberId);
  else ui.selectedMembers.add(memberId);
  render();
}

function performRemoveMembers() {
  const g = getGroup(ui.openGroupId);
  if (!g) return;
  const ids = new Set(ui.selectedMembers);
  if (!ids.size) return;
  g.memberIds = g.memberIds.filter(m => !ids.has(m));
  saveState();
  runNotificationCheck();
  const n = ids.size;
  ui.confirmRemoveMembers = false;
  goBack();   // pops the member-select entry; popstate clears selection and re-renders
  showToast(`${n} ${n === 1 ? 'person' : 'people'} removed from ${g.name}`);
}

/* ---------- ledger person multi-select deletion ---------- */
function enterPersonSelectMode(personId) {
  if (ui.personSelect) {
    togglePersonSelected(personId);
    return;
  }
  ui.personSelect = true;
  ui.selectedPeople = new Set([personId]);
  pushNav();
  render();
}

function togglePersonSelected(personId) {
  if (ui.selectedPeople.has(personId)) ui.selectedPeople.delete(personId);
  else ui.selectedPeople.add(personId);
  render();
}

function performDeletePeople() {
  const ids = new Set(ui.selectedPeople);
  if (!ids.size) return;
  ids.forEach(id => deletePerson(id));   // also drops their transactions and group memberships
  saveState();
  runNotificationCheck();
  const n = ids.size;
  ui.confirmDeletePeople = false;
  goBack();   // pops the person-select entry; popstate clears selection and re-renders
  showToast(`${n} ${n === 1 ? 'person' : 'people'} deleted`);
}

/* ---------- indirect payments view ---------- */

function balancePhrase(n, currency) {
  if (n > 0.005) return `owes you ${fmtMoney(n, currency)}`;
  if (n < -0.005) return `you owe ${fmtMoney(-n, currency)}`;
  return 'settled';
}

function transferPreviewHTML(lenderId, receiverId, amt) {
  if (!lenderId || !receiverId || !Number.isFinite(amt) || amt <= 0) {
    return '<span class="muted">Pick both people and an amount to preview the effect.</span>';
  }
  if (lenderId === receiverId) return '<span class="xfer-warn">Pick two different people.</span>';
  const lender = getPerson(lenderId), receiver = getPerson(receiverId);
  if (!lender || !receiver) return '';
  const lBefore = totalOf(lender), rBefore = totalOf(receiver);
  const mismatch = lender.currency !== receiver.currency
    ? `<div class="xfer-warn">${esc(lender.name)} is in ${lender.currency} and ${esc(receiver.name)} is in ${receiver.currency} — the amount is applied in each person's own currency, nothing is converted.</div>`
    : '';
  return `
    <div class="xfer-line">
      <span><b>${esc(lender.name)}</b> ${balancePhrase(lBefore, lender.currency)}
      <span class="xfer-arrow">→</span> ${balancePhrase(lBefore - amt, lender.currency)}</span>
      <span class="xfer-delta neg">−${fmtMoney(amt, lender.currency)}</span>
    </div>
    <div class="xfer-line">
      <span><b>${esc(receiver.name)}</b> ${balancePhrase(rBefore, receiver.currency)}
      <span class="xfer-arrow">→</span> ${balancePhrase(rBefore + amt, receiver.currency)}</span>
      <span class="xfer-delta pos">+${fmtMoney(amt, receiver.currency)}</span>
    </div>
    ${mismatch}`;
}

/* The popup speaks in "left <owes|lent> right". Map that to the
   lender (balance with you drops) / receiver (now owes you) the data
   layer expects: with "lent", left lent to right, so left is the lender;
   with "owes", left owes right, so right is the lender. */
function transferRoles(leftId, rightId, rel) {
  return rel === 'owes'
    ? { lenderId: rightId, receiverId: leftId }
    : { lenderId: leftId, receiverId: rightId };
}

function updateTransferPreview() {
  const form = document.querySelector('[data-form="add-transfer"]');
  const node = document.getElementById('xfer-preview');
  if (!form || !node) return;
  const { lenderId, receiverId } = transferRoles(form.leftId.value, form.rightId.value, form.rel.value);
  node.innerHTML = transferPreviewHTML(lenderId, receiverId, parseFloat(form.amount.value));
}

function renderIndirectModal() {
  const root = document.getElementById('indirect-root');
  if (!ui.indirectOpen) { root.innerHTML = ''; return; }

  const people = state.people;
  const opts = sel => people.map(p =>
    `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');

  root.innerHTML = Modal({
    overlayId: 'indirect-overlay',
    title: 'Indirect payment',
    closeAction: 'close-indirect',
    body: `
      <p class="section-sub" style="margin-bottom:18px">Route a debt across people: the lender's balance with you drops, and the person who owed them now owes you instead. Your total is unchanged — it just moves to whoever can actually pay.</p>

      <form data-form="add-transfer">
        <div class="xfer-sentence">
          <select name="leftId">${opts(people[0].id)}</select>
          <select name="rel">
            <option value="lent">lent to</option>
            <option value="owes">owes</option>
          </select>
          <select name="rightId">${opts(people[1].id)}</select>
        </div>
        <div class="form-row">
          <input name="amount" type="number" step="any" min="0.01" placeholder="amount" required>
          <input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}">
          <input name="note" placeholder="reason (optional)" maxlength="80" style="flex:1">
        </div>
        <div id="xfer-preview" class="xfer-preview"></div>
        <div class="form-row tight"><button class="btn" type="submit">Record indirect payment</button></div>
      </form>`,
  });
}

/* ---------- split expense ----------
   A popup over a blurred page: tick who shares the cost, enter the total, and
   a live preview shows each person's exact share before it's recorded. Each
   share becomes its own "they owe you" entry (tagged SPLIT). */

/* ids of people whose split checkbox is currently ticked, in checklist order
   so the remainder cents land on the same people the preview shows. */
function splitSelectedIds() {
  return [...document.querySelectorAll('[data-split-member]')]
    .filter(cb => cb.checked)
    .map(cb => cb.dataset.splitMember);
}

/* The order in which split participants receive the leftover minor units, so
   the same person isn't always the one charged a little extra. Fisher–Yates
   shuffle of the participant indices: when you're in the split you (index 0)
   still absorb the first leftover unit to keep the others' shares clean, then
   the rest go out at random. The order is cached on the draft and only
   reshuffled when the head count (or whether you're included) changes, so the
   live preview matches exactly what's recorded on submit. A new split (fresh
   draft) reshuffles, rotating who gets the bigger share next time. */
function splitOrder(n, includeMe) {
  const draft = ui.splitDraft;
  const sig = `${n}|${includeMe ? 1 : 0}`;
  if (draft && draft.orderSig === sig && draft.order && draft.order.length === n) {
    return draft.order;
  }
  const rest = [];
  for (let i = includeMe ? 1 : 0; i < n; i++) rest.push(i);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const order = includeMe ? [0, ...rest] : rest;
  if (draft) { draft.order = order; draft.orderSig = sig; }
  return order;
}

function splitPreviewHTML(ids, amt, includeMe) {
  const people = ids.map(getPerson).filter(Boolean);
  if (!people.length || !Number.isFinite(amt) || amt <= 0) {
    return '<span class="muted">Tick who is splitting and enter an amount to see each share.</span>';
  }
  const baseCur = state.settings.baseCurrency;
  /* You're the first participant when included, so your share is shares[0]
     (and any leftover cent lands on you, the payer). */
  const n = people.length + (includeMe ? 1 : 0);
  const offset = includeMe ? 1 : 0;
  const shares = splitShares(amt, n, { whole: roundingOn(), order: splitOrder(n, includeMe) });
  const currencies = people.map(p => p.currency);
  if (includeMe) currencies.push(baseCur);
  const multiCurrency = new Set(currencies).size > 1;
  const headCur = includeMe ? baseCur : people[0].currency;
  const head = `<div class="split-head">${n} ${n === 1 ? 'person' : 'people'}${
    multiCurrency ? '' : ` · ${fmtMoney(amt, headCur)} total`}</div>`;
  const meLine = includeMe ? `
    <div class="xfer-line">
      <span><b>Me</b> · your share</span>
      <span class="xfer-delta">${fmtMoney(shares[0], baseCur)}</span>
    </div>` : '';
  const lines = people.map((p, i) => `
    <div class="xfer-line">
      <span><b>${esc(p.name)}</b> owes you</span>
      <span class="xfer-delta pos">+${fmtMoney(shares[i + offset], p.currency)}</span>
    </div>`).join('');
  const mismatch = multiCurrency
    ? `<div class="xfer-warn">Selected people use different currencies — each share is applied in that person's own currency, nothing is converted.</div>`
    : '';
  return head + meLine + lines + mismatch;
}

/* whether "Me" is ticked in the split picker */
function splitIncludesMe() {
  const me = document.querySelector('[data-split-me]');
  return !!(me && me.checked);
}

function updateSplitPreview() {
  const form = document.querySelector('[data-form="add-split"]');
  const node = document.getElementById('split-preview');
  if (!form || !node) return;
  node.innerHTML = splitPreviewHTML(splitSelectedIds(), parseFloat(form.amount.value), splitIncludesMe());
}

/* The split picker is re-rendered when a person is added mid-flow, which would
   otherwise wipe the typed amount/note and the current ticks. We snapshot the
   live form into ui.splitDraft so renderSplitModal can restore it. */
function freshSplitDraft() {
  return {
    selected: new Set(), me: false, amount: '',
    date: new Date().toISOString().slice(0, 10), note: '', newName: '',
  };
}

function syncSplitDraft() {
  if (!ui.splitDraft) ui.splitDraft = freshSplitDraft();
  const form = document.querySelector('[data-form="add-split"]');
  if (form) {
    ui.splitDraft.amount = form.amount.value;
    ui.splitDraft.date = form.date.value;
    ui.splitDraft.note = form.note.value;
    ui.splitDraft.selected = new Set(splitSelectedIds());
    ui.splitDraft.me = splitIncludesMe();
  }
  const ni = document.getElementById('split-new-name');
  if (ni) ui.splitDraft.newName = ni.value;
}

function renderSplitModal() {
  const root = document.getElementById('split-root');
  if (!ui.splitOpen) { root.innerHTML = ''; ui.splitDraft = null; return; }

  const draft = ui.splitDraft || (ui.splitDraft = freshSplitDraft());
  const sel = draft.selected;

  /* "Me" — you can be one of the people sharing the cost. You pay your own
     share, so it only shrinks everyone else's; no debt is recorded for you. */
  const meRow =
    `<label class="share-pick-row">
      <input type="checkbox" data-split-me ${draft.me ? 'checked' : ''}>
      <span class="share-pick-name">Me</span>
      ${Chip(esc(state.settings.baseCurrency))}
    </label>`;

  const rows = state.people.map(p =>
    `<label class="share-pick-row">
      <input type="checkbox" data-split-member="${p.id}" ${sel.has(p.id) ? 'checked' : ''}>
      <span class="share-pick-name">${esc(p.name)}</span>
      ${Chip(p.currency)}
    </label>`).join('');

  /* Add a brand-new person without leaving the split: typing a name and
     hitting + Add creates them, ticks them, and clears the field to repeat. */
  const addRow =
    `<div class="split-add-row">
      <input type="text" id="split-new-name" placeholder="add a new person…" maxlength="40" value="${esc(draft.newName || '')}">
      <button type="button" class="btn ghost" data-action="split-add-person">+ Add</button>
    </div>`;

  root.innerHTML = Modal({
    overlayId: 'split-overlay',
    modalCls: 'modal-split',
    title: 'Split an expense',
    closeAction: 'close-split',
    body: `
      <p class="section-sub split-intro">Pick who shares the cost and enter the total. Tally divides it equally and records each person's share as money they owe you.</p>

      <form data-form="add-split">
        <h3 class="subhead">Split between</h3>
        <div class="share-pick-list split-scroll">${meRow}${rows}${addRow}</div>

        <div class="split-fixed">
          <div class="form-row">
            <input name="amount" type="number" step="any" min="0.01" placeholder="total amount" value="${esc(draft.amount || '')}" required>
            <input name="date" type="date" value="${esc(draft.date || new Date().toISOString().slice(0, 10))}" required>
          </div>
          <div class="form-row">
            <input name="note" placeholder="reason (optional)" maxlength="80" value="${esc(draft.note || '')}" style="flex:1">
          </div>

          <h3 class="subhead" style="margin-top:6px">Each person's share</h3>
          <div id="split-preview" class="xfer-preview"></div>

          <div class="form-row tight"><button class="btn" type="submit">Record split</button></div>
        </div>
      </form>`,
  });
}

/* ---------- share pickers ----------
   A popup over a blurred page: a checklist of people with a live preview of
   exactly what will be shared. Nothing is persisted — the choice is made
   fresh each time. The group picker (below) starts with every member ticked
   and excludes unticked ones; the Ledger picker starts with nobody ticked
   and shares exactly who you choose. */

/* The Ledger share picker: every person, nobody ticked. Tick who to include
   and the preview/share covers exactly that selection. */
function renderSharePeopleModal(root) {
  const people = state.people.slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const rows = people.map(p => {
    const total = totalOf(p);
    const settled = Math.abs(total) <= 0.005;
    return `<label class="share-pick-row">
      <input type="checkbox" data-share-member="${p.id}">
      <span class="share-pick-name">${esc(p.name)}</span>
      ${settled
        ? '<span class="muted">settled</span>'
        : Money(total, p.currency)}
    </label>`;
  }).join('');

  root.innerHTML = Modal({
    overlayId: 'share-overlay',
    overlayCls: 'share-overlay',
    modalCls: 'modal-share',
    title: 'Share balances',
    closeAction: 'close-share',
    body: `
      <p class="section-sub" style="margin-bottom:14px">Tick who to include — only ticked people are shared.</p>
      ${people.length
        ? `<div class="share-pick-list share-scroll">${rows}</div>`
        : '<p class="muted">No people yet.</p>'}
      <div class="share-fixed">
        <h3 class="subhead">Preview</h3>
        <pre class="share-preview" id="share-preview"></pre>
        <div class="form-row tight"><button class="btn" data-action="do-share-people">Share</button></div>
      </div>`,
  });
}

function renderShareModal() {
  const root = document.getElementById('share-root');
  if (ui.sharePeopleOpen) { renderSharePeopleModal(root); return; }
  if (!ui.shareGroupId) { root.innerHTML = ''; return; }
  const g = getGroup(ui.shareGroupId);
  if (!g) { ui.shareGroupId = null; root.innerHTML = ''; return; }

  const members = g.memberIds.map(getPerson).filter(Boolean);
  const rows = members.map(p => {
    const total = totalOf(p);
    const settled = Math.abs(total) <= 0.005;
    return `<label class="share-pick-row">
      <input type="checkbox" data-share-member="${p.id}" checked>
      <span class="share-pick-name">${esc(p.name)}</span>
      ${settled
        ? '<span class="muted">settled</span>'
        : Money(total, p.currency)}
    </label>`;
  }).join('');

  root.innerHTML = Modal({
    overlayId: 'share-overlay',
    overlayCls: 'share-overlay',
    modalCls: 'modal-share',
    title: `Share ${esc(g.name)}`,
    closeAction: 'close-share',
    body: `
      <p class="section-sub" style="margin-bottom:14px">Tick who to include — unticked people are left out of the shared list.</p>
      ${members.length
        ? `<div class="share-pick-list share-scroll">${rows}</div>`
        : '<p class="muted">This group has no members yet.</p>'}
      <div class="share-fixed">
        <h3 class="subhead">Preview</h3>
        <pre class="share-preview" id="share-preview"></pre>
        <div class="form-row tight"><button class="btn" data-action="do-share-group" data-id="${g.id}">Share</button></div>
      </div>`,
  });
}

/* ids of members whose checkbox is currently unticked */
function shareExcludedIds() {
  return [...document.querySelectorAll('[data-share-member]')]
    .filter(cb => !cb.checked)
    .map(cb => cb.dataset.shareMember);
}

/* people whose checkbox is currently ticked (Ledger picker — opt-in) */
function shareIncludedPeople() {
  return [...document.querySelectorAll('[data-share-member]')]
    .filter(cb => cb.checked)
    .map(cb => getPerson(cb.dataset.shareMember))
    .filter(Boolean);
}

function updateSharePreview() {
  const node = document.getElementById('share-preview');
  if (!node) return;
  if (ui.sharePeopleOpen) {
    node.textContent = peopleShareText(shareIncludedPeople());
    return;
  }
  const g = ui.shareGroupId ? getGroup(ui.shareGroupId) : null;
  if (!g) return;
  node.textContent = groupShareText(g, Date.now(), shareExcludedIds());
}

/* ---------- appearance / theme ---------- */
const THEME_OPTIONS = [
  ['light',  'Light'],
  ['dark',   'Dark'],
  ['device', 'Device default'],
];

function appearancePanel() {
  const current = (state.settings && state.settings.theme) || 'device';
  const seg = ([value, label]) =>
    `<button type="button" class="seg${value === current ? ' active' : ''}" data-action="set-theme" data-theme="${value}" aria-pressed="${value === current}">${label}</button>`;
  return Panel({
    title: 'Appearance',
    body: `
      <div class="seg-control" role="group" aria-label="Theme">${THEME_OPTIONS.map(seg).join('')}</div>
      <p class="muted">Pick a fixed look, or follow your device’s light/dark setting.</p>`,
  });
}

function currencyPanel() {
  return Panel({
    title: 'Currency',
    body: `
      <div class="form-row">
        <label>Currency for new people <select id="base-currency">${currencyOptions(state.settings.baseCurrency)}</select></label>
      </div>
      <p class="muted">Each person keeps their own currency (changeable in their profile). Totals in the header are shown per currency — nothing is converted.</p>

      <div class="form-row tight" style="margin-top:14px; padding-top:12px; border-top:1px solid var(--line)">
        <label><input type="checkbox" id="round-whole" ${state.settings.roundWhole ? 'checked' : ''}> Round amounts to whole numbers</label>
      </div>
      <p class="muted">Hides paise/cents everywhere — balances, interest and existing entries all show as whole numbers. New splits divide into whole units too, with any remainder handed out at random so the same person isn't always charged the extra.</p>`,
  });
}

function dataPanel() {
  return Panel({
    title: 'Data',
    body: `
      <p class="muted" style="margin-bottom:12px">Your ledger lives only in this browser. Clearing site data or switching devices wipes it — so keep a backup (or turn on cloud sync above).</p>

      <h4 class="data-subhead">Full backup</h4>
      <div class="form-row">
        <button class="btn" data-action="backup-data">Back up everything (JSON)</button>
        <label class="btn ghost" style="display:inline-block">Restore backup
          <input type="file" id="restore-file" accept=".json,application/json" style="display:none">
        </label>
      </div>
      <p class="muted">A complete snapshot — people, groups, entries, interest rules <em>and</em> settings. Restoring replaces everything on this device with the file’s contents.</p>

      <h4 class="data-subhead">Spreadsheet</h4>
      <div class="form-row">
        <button class="btn ghost" data-action="export-data">Export spreadsheet (CSV)</button>
        <label class="btn ghost" style="display:inline-block">Import spreadsheet
          <input type="file" id="import-file" accept=".csv,text/csv" style="display:none">
        </label>
      </div>
      <p class="muted">Opens in Excel, Google Sheets or Numbers — one row per entry. Importing replaces people, groups and entries; interest rules and settings are <strong>not</strong> in the sheet, so use a full backup if you want those too.</p>

      <div class="form-row tight" style="margin-top:14px; padding-top:12px; border-top:1px solid var(--line)">
        <button class="btn danger" data-action="reset-data">Erase everything</button>
      </div>`,
  });
}

/* Settings is grouped into a few labelled sections rendered as a list of
   tappable cards (like the iPhone Settings app): each card shows an icon tile,
   the section name and a one-line summary of what's inside, so the page opens
   as a short, scannable list rather than one long stack of panels. Each card is
   a collapsible disclosure — tapping it expands just that section. Native
   <details>/<summary> handles the toggling, so the open/closed state survives
   re-renders without any extra wiring. */
function renderSettings() {
  const group = (icon, title, desc, body) => `
    <details class="settings-group">
      <summary class="settings-group-title">
        <span class="settings-group-icon">${icon}</span>
        <span class="settings-group-text">
          <span class="settings-group-name">${title}</span>
          <span class="settings-group-desc">${desc}</span>
        </span>
        <svg class="settings-group-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </summary>
      <div class="settings-group-body">${body}</div>
    </details>`;

  return `
    <h2 class="section-title">Settings</h2>
    <p class="section-sub">Your ledger lives in this browser — nothing leaves it unless you turn on cloud sync (under Account) or export it.</p>

    <div class="settings-list">
      ${group(Icons.sliders(), 'Preferences', 'Theme, currency &amp; rounding', appearancePanel() + currencyPanel())}
      ${group(Icons.bell(), 'Alerts', 'Reminders for what you’re owed', notificationsPanel())}
      ${group(Icons.percent(), 'Interest', 'How balances grow over time', interestRulesPanel())}
      ${group(Icons.database(), 'Your data', 'Back up, export or erase', dataPanel())}
    </div>
  `;
}

/* Account: sign-in and cloud sync, split out of Settings so it has its own
   place in the drawer. The heavy lifting still lives in cloud.js; this is
   just the page wrapper around cloudSyncPanel(). */
function renderAccount() {
  return `
    <h2 class="section-title">Account</h2>
    <p class="section-sub">Sign in to mirror your ledger to the cloud and pick it up on another device. Until you do, everything stays in this browser.</p>

    ${cloudSyncPanel()}
  `;
}

/* ---------- person modal ---------- */

function renderModal() {
  const root = document.getElementById('modal-root');
  if (!ui.modalPersonId) { root.innerHTML = ''; return; }
  const p = getPerson(ui.modalPersonId);
  if (!p) { ui.modalPersonId = null; root.innerHTML = ''; return; }

  const detail = accruedInterestDetail(p);
  const { principal, interest, total } = balanceDisplay(p);
  const ruleNames = Object.keys(detail.byRule)
    .map(id => interestRuleName(id)).filter(Boolean).join(', ');
  const ic = p.interestConfig || defaultPersonInterest();

  /* Real entries plus the day-by-day accrued-interest charges (virtual, not yet
     capitalized), newest first — so a person's interest is shown adding up. */
  const realRows = personTxns(p.id).map(t => ({ ...t, virtual: false }));
  const virtualRows = detail.schedule.map((s, k) => ({
    id: `virt-${p.id}-${k}`, date: s.date, amount: s.amount, virtual: true,
  }));
  const txRows = realRows.concat(virtualRows)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map(t => {
      if (t.virtual) {
        return `<tr class="virtual-interest">
          <td>${fmtDate(t.date)}</td>
          <td><span class="muted">—</span></td>
          <td>Interest accrued <span class="interest-tag">INTEREST</span> <span class="muted">(not yet capitalized)</span></td>
          <td class="num">${Money(t.amount, p.currency, { cls: 'pos', sign: true })}</td>
          <td></td>
        </tr>`;
      }
      const g = t.groupId ? getGroup(t.groupId) : null;
      return `<tr>
        <td>${fmtDate(t.date)}</td>
        <td>${g ? Chip(esc(g.name)) : '<span class="muted">personal</span>'}</td>
        <td>${esc(t.note) || '<span class="muted">—</span>'} ${t.isInterest ? '<span class="interest-tag">INTEREST</span>' : ''}${t.indirect ? `<span class="hist-tag indirect">indirect${t.counterpartyId ? ' · ' + esc(getPerson(t.counterpartyId)?.name || '') : ''}</span>` : ''}${t.split ? '<span class="hist-tag split">split</span>' : ''}</td>
        <td class="num">${Money(t.amount, p.currency)}</td>
        <td><button class="del-x" data-action="delete-txn" data-id="${t.id}" title="Delete entry">✕</button></td>
      </tr>`;
    }).join('');

  const groupOptions = ['<option value="">No group (personal)</option>']
    .concat(groupsOf(p.id).map(g => `<option value="${g.id}">${esc(g.name)}</option>`)).join('');

  const customInterestPanel = Panel({
    style: 'margin-top:16px',
    head: `<h3>Custom interest <span class="muted">(just for ${esc(p.name)})</span></h3>`,
    body: `
        <label><input type="checkbox" id="person-interest-on" ${ic.enabled ? 'checked' : ''}> Charge this person their own interest (overrides the global rules)</label>
        ${ic.enabled ? `
        <form data-form="person-interest" data-person="${p.id}">
          <div class="form-row" style="margin-top:10px">
            <label>if balance
              <select name="op">${OPS.map(o => `<option ${o === ic.op ? 'selected' : ''}>${o}</option>`).join('')}</select>
              <input name="value" type="number" step="any" value="${ic.value}" style="width:90px">
            </label>
          </div>
          <div class="form-row">
            <label>charge <input name="rate" type="number" step="any" min="0" value="${ic.rate}" style="width:70px">%</label>
            <select name="type">
              <option value="compound" ${ic.type === 'compound' ? 'selected' : ''}>compound</option>
              <option value="simple" ${ic.type === 'simple' ? 'selected' : ''}>simple</option>
            </select>
            <label>per <select name="periodUnit">
              ${['day', 'week', 'month', 'year'].map(u => `<option value="${u}" ${ic.periodUnit === u ? 'selected' : ''}>${u}</option>`).join('')}
            </select></label>
            <label>cap (optional) <input name="capPeriods" type="number" step="any" min="0" value="${ic.capPeriods ?? ''}" placeholder="∞" style="width:70px"> periods</label>
          </div>
          <div class="form-row tight"><button class="btn" type="submit">Save interest settings</button></div>
        </form>
        <p class="muted" style="margin-top:6px">Rate, period and type apply only to ${esc(p.name)}.${p.interestExempt ? ' Note: “interest exempt” is on, so nothing accrues until you turn it off.' : ''}</p>`
        : '<p class="muted" style="margin-top:6px">Off — this person follows the shared interest rules.</p>'}`,
  });

  const newEntryPanel = Panel({
    title: 'New entry',
    style: 'margin-top:16px',
    body: `
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
        </form>`,
  });

  root.innerHTML = Modal({
    overlayId: 'modal-overlay',
    title: esc(p.name),
    closeAction: 'close-modal',
    body: `
      <div class="form-row">
        <label>Currency <select id="person-currency">${currencyOptions(p.currency)}</select></label>
        <label><input type="checkbox" id="person-exempt" ${p.interestExempt ? 'checked' : ''}> interest exempt</label>
      </div>

      <div class="balance-strip">
        <span>Principal${Money(principal, p.currency, { tag: 'b' })}</span>
        <span>Accrued interest<b class="money interest">${interest > 0.005 ? '+' + fmtMoney(interest, p.currency) : '—'}</b></span>
        <span>Total${Money(total, p.currency, { tag: 'b' })}</span>
      </div>
      ${ruleNames ? `<p class="muted" style="margin:-8px 0 14px">Interest from rule: <em>${esc(ruleNames)}</em></p>` : ''}

      <div class="form-row">
        <button class="btn ghost" data-action="capitalize" data-id="${p.id}" ${detail.total > 0.005 ? '' : 'disabled'}>Capitalize interest</button>
        <button class="btn" data-action="settle" data-id="${p.id}" ${Math.abs(total) > 0.005 ? '' : 'disabled'}>Settle up</button>
        <button class="btn quiet-danger" data-action="delete-person" data-id="${p.id}">Delete person</button>
      </div>

      ${customInterestPanel}

      ${newEntryPanel}

      <h3 class="subhead">History</h3>
      ${txRows ? `<div class="table-wrap"><table class="txn-table"><thead><tr><th>Date</th><th>Group</th><th>Note</th><th class="num">Amount</th><th></th></tr></thead><tbody>${txRows}</tbody></table></div>`
        : '<span class="muted">No entries yet.</span>'}`,
  });
}

/* ---------- render root ---------- */

function render() {
  renderStamps();
  updateConnectivity();

  document.querySelectorAll('.drawer-item').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === ui.tab));

  const view = document.getElementById('view');
  switch (ui.tab) {
    case 'ledger':   view.innerHTML = renderLedger(); break;
    case 'groups':   view.innerHTML = renderGroups(); break;
    case 'history':  view.innerHTML = renderHistory(); break;
    case 'settings': view.innerHTML = renderSettings(); break;
    case 'account':  view.innerHTML = renderAccount(); break;
  }
  // The Google sign-in button is drawn by the Google Identity script into a
  // placeholder that only exists after the Account view is rendered.
  if (typeof cloudMountGoogleButton === 'function') cloudMountGoogleButton();
  renderModal();
  renderIndirectModal();
  renderSplitModal();
  renderShareModal();
  renderCloudPrompt();
  if (ui.indirectOpen) updateTransferPreview();
  if (ui.splitOpen) updateSplitPreview();
  if (ui.shareGroupId || ui.sharePeopleOpen) updateSharePreview();

  // freeze the page behind any popup so scrolling stays inside the overlay
  const popupOpen = !!document.querySelector('.modal-overlay, .confirm-overlay');
  document.body.classList.toggle('modal-open', popupOpen);
}

/* ---------- event wiring (delegated) ---------- */

document.addEventListener('click', e => {
  if (lpFired) { lpFired = false; return; }   // swallow the click after a long-press

  // in selection mode, tapping a history row toggles its selection
  if (ui.selectMode && !e.target.closest('.select-bar, .confirm-overlay')) {
    const histRow = e.target.closest('.history-table tr[data-txn-id]');
    if (histRow) { toggleSelected(histRow.dataset.txnId); return; }
  }

  // in member-selection mode, tapping a member row toggles its selection
  if (ui.memberSelect && !e.target.closest('.select-bar, .confirm-overlay')) {
    const memRow = e.target.closest('.ledger-table tr[data-member-id]');
    if (memRow) { toggleMemberSelected(memRow.dataset.memberId); return; }
  }

  // in ledger person-selection mode, tapping a person row toggles its selection
  if (ui.personSelect && !e.target.closest('.select-bar, .confirm-overlay')) {
    const personRow = e.target.closest('.ledger-table tr[data-person-id]');
    if (personRow) { togglePersonSelected(personRow.dataset.personId); return; }
  }

  const btn = e.target.closest('[data-action]');

  if (e.target.id === 'modal-overlay') { goBack(); return; }
  if (e.target.id === 'indirect-overlay') { goBack(); return; }
  if (e.target.id === 'split-overlay') { goBack(); return; }
  if (e.target.id === 'share-overlay') { goBack(); return; }
  if (e.target.id === 'confirm-overlay') { ui.confirmDelete = false; render(); return; }
  if (e.target.id === 'member-confirm-overlay') { ui.confirmRemoveMembers = false; render(); return; }
  if (e.target.id === 'person-confirm-overlay') { ui.confirmDeletePeople = false; render(); return; }
  if (e.target.id === 'clear-debt-overlay') { ui.confirmClearDebt = null; render(); return; }
  if (e.target.id === 'cloud-prompt-overlay') { dismissCloudPrompt(); return; }
  if (!btn) return;

  const { action, id, sign, group } = btn.dataset;

  switch (action) {
    case 'open-person': ui.modalPersonId = id; pushNav(); render(); break;
    case 'close-modal': goBack(); break;

    case 'open-share-people':
      if (state.people.length) { ui.sharePeopleOpen = true; pushNav(); render(); }
      break;
    case 'do-share-people': {
      const chosen = shareIncludedPeople();
      if (!chosen.length) { showToast('Pick at least one person to share'); break; }
      const text = peopleShareText(chosen);
      goBack();                   // pop the nav entry the popup pushed, clearing sharePeopleOpen
      shareText('Balances', text);
      break;
    }
    case 'share-group': {
      const g = getGroup(id);
      if (g) { ui.shareGroupId = id; pushNav(); render(); }
      break;
    }
    case 'close-share': goBack(); break;
    case 'do-share-group': {
      const g = getGroup(id);
      if (g) {
        const text = groupShareText(g, Date.now(), shareExcludedIds());
        goBack();                 // pop the nav entry the popup pushed, clearing shareGroupId
        shareText(g.name, text);
      }
      break;
    }

    case 'clear-search': ui.search = ''; render(); document.getElementById('search-box')?.focus(); break;
    case 'focus-search': document.getElementById('search-box')?.focus(); break;

    case 'open-indirect': ui.indirectOpen = true; pushNav(); render(); break;
    case 'close-indirect': goBack(); break;
    case 'open-split': ui.splitOpen = true; ui.splitDraft = freshSplitDraft(); pushNav(); render(); break;
    case 'close-split': goBack(); break;
    case 'split-add-person': {
      const input = document.getElementById('split-new-name');
      const name = ((input && input.value) || '').trim();
      if (!name) { if (input) input.focus(); break; }
      syncSplitDraft();                       // keep typed amount/note + ticks
      const p = addPerson(name);              // base currency by default
      ui.splitDraft.selected.add(p.id);       // newly added → ticked
      ui.splitDraft.newName = '';
      saveState();
      render();
      const next = document.getElementById('split-new-name');
      if (next) next.focus();
      break;
    }
    case 'new-group': ui.creatingGroup = true; render(); document.querySelector('[data-form="add-group"] input')?.focus(); break;
    case 'cancel-create-group': ui.creatingGroup = false; render(); break;
    case 'open-group': ui.openGroupId = id; ui.tab = 'groups'; ui.renamingGroup = false; pushNav(); render(); break;
    case 'close-group': goBack(); break;
    case 'rename-group': ui.renamingGroup = true; render(); document.querySelector('[data-form="rename-group"] input')?.focus(); break;
    case 'cancel-rename': ui.renamingGroup = false; render(); break;

    case 'add-person-entry': {
      const name = ui.search.trim();
      if (!name) { document.getElementById('search-box')?.focus(); return; }
      if (state.people.some(p => p.name.toLowerCase() === name.toLowerCase())) return;
      const person = addPerson(name, state.settings.baseCurrency);
      const amt = parseFloat(document.getElementById('qa-new')?.value);
      // Amount is optional: with one, record the opening entry; without, just add the name.
      if (Number.isFinite(amt) && amt > 0) {
        const note = document.getElementById('qr-new')?.value.trim() || '';
        const signed = amt * Number(sign);
        capitalizeOnDrop(person.id, signed);
        addTransaction({ personId: person.id, amount: signed, note });
        maybeCelebrate(person.id, 0);
      }
      ui.search = '';
      commit();
      document.getElementById('search-box')?.focus();
      break;
    }

    case 'quick-add': {
      const input = document.getElementById(`qa-${id}`);
      const amt = parseFloat(input?.value);
      if (!Number.isFinite(amt) || amt <= 0) { input?.focus(); return; }
      const before = totalOf(getPerson(id));
      const note = document.getElementById(`qr-${id}`)?.value.trim() || '';
      capitalizeOnDrop(id, amt * Number(sign));
      addTransaction({ personId: id, groupId: group || null, amount: amt * Number(sign), note });
      commit();
      maybeCelebrate(id, before);
      break;
    }

    case 'open-remove-members-confirm': if (ui.selectedMembers.size) { ui.confirmRemoveMembers = true; render(); } break;
    case 'cancel-remove-members': ui.confirmRemoveMembers = false; render(); break;
    case 'confirm-remove-members': performRemoveMembers(); break;
    case 'exit-member-select': goBack(); break;

    case 'open-delete-people-confirm': if (ui.selectedPeople.size) { ui.confirmDeletePeople = true; render(); } break;
    case 'cancel-delete-people': ui.confirmDeletePeople = false; render(); break;
    case 'confirm-delete-people': performDeletePeople(); break;
    case 'exit-person-select': goBack(); break;

    case 'delete-group':
      if (confirm('Delete this group? People and their balances are kept.')) {
        deleteGroup(id); saveState(); runNotificationCheck(); goBack();
      }
      break;

    case 'delete-person': {
      const p = getPerson(id);
      if (p && confirm(`Delete ${p.name} and ALL their transactions? This cannot be undone.`)) {
        deletePerson(id); saveState(); runNotificationCheck(); goBack();
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

    case 'clear-debt':
      if (getPerson(id)) { ui.confirmClearDebt = id; render(); }
      break;
    case 'cancel-clear-debt': ui.confirmClearDebt = null; render(); break;
    case 'confirm-clear-debt': {
      const person = getPerson(id);
      ui.confirmClearDebt = null;
      if (person) {
        const before = totalOf(person);
        settleUp(id, 'Debt cleared'); commit();
        maybeCelebrate(id, before);
      } else {
        render();
      }
      break;
    }

    case 'delete-txn': {
      const t = state.transactions.find(x => x.id === id);
      if (t && t.indirect && t.linkId) {
        if (confirm('This is one leg of an indirect payment. Delete both legs and revert both balances?')) {
          deleteIndirectPayment(t.linkId); commit();
        }
      } else if (confirm('Delete this entry?')) {
        deleteTransaction(id); commit();
      }
      break;
    }

    case 'open-delete-confirm': if (ui.selected.size) { ui.confirmDelete = true; render(); } break;
    case 'cancel-confirm': ui.confirmDelete = false; render(); break;
    case 'confirm-delete': performDelete(btn.dataset.mode); break;
    case 'exit-select': goBack(); break;

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
      const blob = new Blob(['﻿' + exportCSV()], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tally-export-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      break;
    }

    case 'backup-data': {
      const blob = new Blob([exportJSON()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tally-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      showToast('Backup saved');
      break;
    }

    case 'reset-data':
      if (confirm('Erase ALL data? This cannot be undone.')) {
        localStorage.removeItem(LS_KEY);
        loadState();
        applyTheme();
        render();
      }
      break;

    case 'set-theme':
      if (state.settings.theme !== btn.dataset.theme) {
        state.settings.theme = btn.dataset.theme;
        applyTheme();
        commit();
      }
      break;

    /* ---- cloud sync (cloud.js owns the async + re-render) ---- */
    case 'cloud-send-code': {
      const email = (document.getElementById('cloud-email')?.value || '').trim();
      if (!email) { showToast('Enter your email first'); break; }
      cloudRequestCode(email);
      break;
    }
    case 'cloud-verify': {
      const code = (document.getElementById('cloud-code')?.value || '').trim();
      if (!code) { showToast('Enter the 6-digit code'); break; }
      cloudVerifyCode(code);
      break;
    }
    case 'cloud-reset-email': cloudResetToEmail(); break;
    case 'cloud-sync-now': cloudSyncNow(); break;
    case 'cloud-signout': doCloudSignOut(); break;

    /* ---- first-run sync prompt ---- */
    case 'cloud-prompt-dismiss': dismissCloudPrompt(); break;
    case 'cloud-prompt-signin':
      dismissCloudPrompt();
      openCloudSyncSettings();
      break;
  }
});

document.addEventListener('submit', e => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);

  switch (form.dataset.form) {
    case 'person-search': {
      const name = (fd.get('q') || '').trim();
      if (!name) return;
      // Enter on a name that already exists just keeps filtering — no duplicate.
      if (state.people.some(p => p.name.toLowerCase() === name.toLowerCase())) return;
      addPerson(name, state.settings.baseCurrency);
      ui.search = '';
      commit();
      document.getElementById('search-box')?.focus();
      break;
    }

    case 'add-group': {
      const name = fd.get('name').trim();
      if (!name) return;
      addGroup(name, fd.getAll('member'));
      ui.creatingGroup = false;
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
      const signed = amt * Number(fd.get('sign'));
      // Capitalize before recording, dating it to the entry itself so a
      // dated/backdated repayment freezes interest at its own date rather
      // than leaving it stranded to re-surface when the balance next crosses.
      const when = entryDate(dateStr);
      capitalizeOnDrop(pid, signed, when.getTime());
      addTransaction({
        personId: pid,
        groupId: fd.get('groupId') || null,
        amount: signed,
        note: fd.get('note') || '',
        date: dateStr ? when.toISOString() : null,
      });
      commit();
      maybeCelebrate(pid, before);
      break;
    }

    case 'add-transfer': {
      const dateStr = fd.get('date');
      const { lenderId, receiverId } = transferRoles(fd.get('leftId'), fd.get('rightId'), fd.get('rel'));
      try {
        addIndirectPayment({
          lenderId,
          receiverId,
          amount: parseFloat(fd.get('amount')),
          note: fd.get('note') || '',
          date: entryDate(dateStr).toISOString(),
        });
        ui.indirectOpen = false;
        goBack();          // pop the nav entry the popup pushed, then commit re-renders
        commit();
        showToast('Indirect payment recorded');
      } catch (err) {
        alert(err.message);
      }
      break;
    }

    case 'add-split': {
      const ids = splitSelectedIds();
      const dateStr = fd.get('date');
      try {
        const includeMe = splitIncludesMe();
        const { txns } = addSplitExpense({
          personIds: ids,
          amount: parseFloat(fd.get('amount')),
          includeMe,
          note: fd.get('note') || '',
          date: entryDate(dateStr).toISOString(),
          order: splitOrder(ids.length + (includeMe ? 1 : 0), includeMe),
        });
        ui.splitOpen = false;
        ui.splitDraft = null;
        goBack();          // pop the nav entry the popup pushed, then commit re-renders
        commit();
        const n = txns.length;
        showToast(`Split recorded across ${n} ${n === 1 ? 'person' : 'people'}`);
      } catch (err) {
        alert(err.message);
      }
      break;
    }

    case 'person-interest': {
      const p = getPerson(form.dataset.person);
      if (p) {
        const cap = parseFloat(fd.get('capPeriods'));
        p.interestConfig = {
          enabled: true,
          op: fd.get('op'),
          value: parseFloat(fd.get('value')) || 0,
          type: fd.get('type'),
          rate: parseFloat(fd.get('rate')) || 0,
          periodUnit: fd.get('periodUnit'),
          capPeriods: Number.isFinite(cap) && cap > 0 ? cap : null,
        };
        commit();
        showToast('Interest settings saved');
      }
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
  if (e.target.id === 'round-whole') {
    state.settings.roundWhole = e.target.checked;
    commit();   // re-renders every view so past amounts and interest round immediately
  }
  if (e.target.id === 'person-currency' && ui.modalPersonId) {
    const p = getPerson(ui.modalPersonId);
    if (p) { p.currency = e.target.value; commit(); }
  }
  if (e.target.id === 'person-exempt' && ui.modalPersonId) {
    const p = getPerson(ui.modalPersonId);
    if (p) { p.interestExempt = e.target.checked; commit(); }
  }
  if (e.target.id === 'person-interest-on' && ui.modalPersonId) {
    const p = getPerson(ui.modalPersonId);
    if (p) {
      p.interestConfig = p.interestConfig || defaultPersonInterest();
      p.interestConfig.enabled = e.target.checked;
      commit();
    }
  }
  if (e.target.id === 'import-file') {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then(text => {
      try {
        importCSV(text);
        ui.selectMode = false; ui.selected = new Set(); ui.confirmDelete = false;
        ui.memberSelect = false; ui.selectedMembers = new Set(); ui.confirmRemoveMembers = false;
        ui.personSelect = false; ui.selectedPeople = new Set(); ui.confirmDeletePeople = false;
        ui.confirmClearDebt = null;
        history.replaceState(navState(), '');
        render();
        showToast('Spreadsheet imported');
      } catch (err) { alert('Import failed: ' + err.message); }
      e.target.value = '';   // allow re-importing the same file
    });
  }
  if (e.target.id === 'restore-file') {
    const file = e.target.files[0];
    if (!file) return;
    const proceed = state.people.length === 0
      || confirm('Restore this backup? It replaces everyone, every entry, your interest rules and settings on this device. This cannot be undone.');
    if (!proceed) { e.target.value = ''; return; }
    file.text().then(text => {
      try {
        importJSON(text);
        ui.selectMode = false; ui.selected = new Set(); ui.confirmDelete = false;
        ui.memberSelect = false; ui.selectedMembers = new Set(); ui.confirmRemoveMembers = false;
        ui.personSelect = false; ui.selectedPeople = new Set(); ui.confirmDeletePeople = false;
        ui.confirmClearDebt = null;
        history.replaceState(navState(), '');
        render();
        runNotificationCheck();
        showToast('Backup restored');
      } catch (err) { alert('Restore failed: ' + err.message); }
      e.target.value = '';   // allow re-restoring the same file
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
  if (e.target.closest('[data-form="add-transfer"]')) updateTransferPreview();
  if (e.target.closest('[data-form="add-split"]')) { syncSplitDraft(); updateSplitPreview(); }
  if (e.target.matches('[data-share-member]')) updateSharePreview();
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
  if (e.target.closest('[data-form="add-transfer"]')) updateTransferPreview();
  if (e.target.closest('[data-form="add-split"]')) { syncSplitDraft(); updateSplitPreview(); }

  // ledger quick-entry: arm the +paid / −repaid buttons once an amount is typed
  const qa = e.target.closest('.quick-add');
  if (qa && e.target.type === 'number') {
    qa.classList.toggle('active', e.target.value.trim() !== '');
  }
});

/* Quick-entry rows aren't a <form> (two submit verbs, +paid / −repaid), so
   Enter is wired by hand: it fires the default "+ paid" action, matching the
   spreadsheet-row feel. Shift+Enter records a repayment instead. */
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;

  // the add-person field lives inside the split form; Enter should add the
  // person, not submit the whole split
  if (e.target.id === 'split-new-name') {
    e.preventDefault();
    const addBtn = document.querySelector('[data-action="split-add-person"]');
    if (addBtn) addBtn.click();
    return;
  }

  const input = e.target.closest('.quick-add input');
  if (!input) return;
  const row = input.closest('.quick-add');
  const sign = e.shiftKey ? '-1' : '1';
  const btn = row.querySelector(`.btn[data-sign="${sign}"]`);
  if (btn) { e.preventDefault(); btn.click(); }
});

/* ---------- navigation drawer (hamburger menu) ---------- */

function openDrawer() {
  const d = document.getElementById('drawer');
  const s = document.getElementById('drawer-scrim');
  s.hidden = false;
  // Two frames so the off-screen start position is painted before we
  // transition in — otherwise the slide/fade is skipped.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    d.classList.add('open'); s.classList.add('open');
  }));
  d.setAttribute('aria-hidden', 'false');
  document.getElementById('menu-toggle').setAttribute('aria-expanded', 'true');
  document.body.classList.add('menu-open');
}

function closeDrawer() {
  const d = document.getElementById('drawer');
  const s = document.getElementById('drawer-scrim');
  if (!d.classList.contains('open')) return;
  d.classList.remove('open'); s.classList.remove('open');
  d.setAttribute('aria-hidden', 'true');
  document.getElementById('menu-toggle').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('menu-open');
  // hide the scrim only after the fade-out so it can't swallow taps mid-close
  setTimeout(() => { if (!d.classList.contains('open')) s.hidden = true; }, 260);
}

/* Switch top-level views. Shared by the drawer items and the wordmark
   (which acts as "home"). Mirrors the old tab-bar behaviour: returning to
   the Ledger floor unwinds the back stack so the next OS-back exits. */
function navigateTab(newTab) {
  const drilledIn = ui.openGroupId || ui.modalPersonId || ui.indirectOpen ||
    ui.splitOpen || ui.shareGroupId || ui.sharePeopleOpen || ui.selectMode ||
    ui.memberSelect || ui.personSelect;
  // already here with nothing drilled in → no-op
  if (newTab === ui.tab && !drilledIn) return;

  if (newTab === 'ledger' && navDepth > 0) { history.go(-navDepth); return; }

  ui.tab = newTab;
  ui.openGroupId = null;
  ui.modalPersonId = null;
  ui.shareGroupId = null;
  ui.sharePeopleOpen = false;
  ui.indirectOpen = false;
  ui.splitOpen = false;
  ui.renamingGroup = false;
  ui.selectMode = false;
  ui.selected = new Set();
  ui.confirmDelete = false;
  ui.memberSelect = false;
  ui.selectedMembers = new Set();
  ui.confirmRemoveMembers = false;
  ui.personSelect = false;
  ui.selectedPeople = new Set();
  ui.confirmDeletePeople = false;
  ui.confirmClearDebt = null;
  pushNav();
  render();
}

document.getElementById('menu-toggle').addEventListener('click', openDrawer);
document.getElementById('menu-close').addEventListener('click', closeDrawer);
document.getElementById('drawer-scrim').addEventListener('click', closeDrawer);

document.getElementById('drawer-nav').addEventListener('click', e => {
  const item = e.target.closest('.drawer-item');
  if (!item) return;
  closeDrawer();
  navigateTab(item.dataset.tab);
});

// Tapping the wordmark returns home to the ledger.
const homeLink = document.getElementById('home-link');
homeLink.addEventListener('click', () => navigateTab('ledger'));
homeLink.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateTab('ledger'); }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDrawer();
});

/* ---------- long-press a history entry to delete it (touch + mouse) ---------- */
let lpTimer = null, lpStart = null, lpRow = null, lpFired = false;

function lpClear() {
  if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
  if (lpRow) { lpRow.classList.remove('lp-pressing'); lpRow = null; }
  lpStart = null;
}

document.addEventListener('pointerdown', e => {
  // Never hijack a press that starts inside a text field — let people type/select freely.
  if (e.target.closest('input, textarea, select')) return;
  const histRow = e.target.closest('.history-table tr[data-txn-id]');
  const memRow = histRow ? null : e.target.closest('.ledger-table tr[data-member-id]');
  // Main-ledger person cells long-press to start a delete selection (group rows carry data-member-id).
  const personCell = (histRow || memRow) ? null : e.target.closest('.ledger-table tr[data-person-id] .col-person');
  const personRow = personCell ? personCell.closest('tr') : null;
  const row = histRow || memRow || personRow;
  if (!row) return;
  lpFired = false;
  lpStart = { x: e.clientX, y: e.clientY };
  lpRow = row;
  row.classList.add('lp-pressing');
  lpTimer = setTimeout(() => {
    lpTimer = null;
    if (lpRow) lpRow.classList.remove('lp-pressing');
    lpFired = true;
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (_) {} }
    if (histRow) enterSelectMode(histRow.dataset.txnId);
    else if (memRow) enterMemberSelectMode(memRow.dataset.memberId);
    else enterPersonSelectMode(personRow.dataset.personId);
  }, 500);
});
document.addEventListener('pointermove', e => {
  if (lpStart && Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > 10) lpClear();
});
document.addEventListener('pointerup', lpClear);
document.addEventListener('pointercancel', lpClear);
document.addEventListener('scroll', lpClear, true);

/* interest accrues with time — refresh the numbers every minute */
setInterval(render, 60_000);

/* ---------- boot ---------- */

loadState();
applyTheme();            // stamp the saved (or OS-default) theme before first paint
recordDeviceTimezone(); // pin interest timing to the device's current timezone
saveState();            // ensure the IDB mirror exists even before the first edit
/* Notice timezone changes when the user reopens the app after travelling, so
   interest going forward re-phases to the new local midnight. */
window.addEventListener('focus', () => { if (recordDeviceTimezone()) render(); });
history.replaceState(navState(), '');   // anchor root so back-navigation has a floor
render();
runNotificationCheck();
registerPeriodicSync();
if (typeof cloudInit === 'function') cloudInit();   // opt-in cloud sync (no-op unless configured + signed in)

/* First-time visitors get a one-time popup offering cloud sync; returning users
   (or deployments without sync) just see the panel waiting in Settings. */
if (typeof cloudShouldPrompt === 'function' && cloudShouldPrompt()) {
  ui.cloudPromptOpen = true;
  render();
}

/* Reflect connectivity changes immediately. The local ledger keeps rendering
   either way; going offline just shows the badge, and coming back online clears
   it and lets cloud sync (if on) catch up on anything edited meanwhile. */
window.addEventListener('offline', updateConnectivity);
window.addEventListener('online', () => {
  if (typeof cloudOnReconnect === 'function') cloudOnReconnect();
  updateConnectivity();
});
updateConnectivity();   // in case we loaded while already offline
