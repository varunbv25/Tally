/* =========================================================
   TALLY — UI layer
   Renders views from store.js state; all mutations go
   through store functions, then saveState() + render().
   ========================================================= */

const ui = {
  tab: 'ledger',
  openGroupId: null,
  modalPersonId: null,
  splitOpen: false,         // split-expense popup open
  splitDraft: null,         // in-progress split (survives re-render when adding a person)
  shareGroupId: null,       // group share-picker popup open (which group)
  sharePeopleOpen: false,   // ledger share-picker popup open (pick who to share)
  search: '',
  historySearch: '',
  historyDate: null,        // history calendar: picked day (yyyy-mm-dd) or null for all days
  historyMonth: null,       // history calendar: month in view (yyyy-mm); lazy-set to current month
  calendarOpen: false,      // history calendar collapsed by default so the register leads
  renamingGroup: false,
  creatingGroup: false,     // group-create panel revealed
  addingPerson: false,      // ledger add-a-person panel revealed (the + beside the search)
  addPersonName: '',        // name typed into that panel (survives the re-render a search keystroke causes)
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
  settingsOpen: new Set(),  // keys of the expanded Settings sections (survives re-render)
  scheduledSnoozed: new Set(), // scheduled-debt ids the user said "remind me later" to this session
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

/* Date + time "now" stamp for the Ledger's "Balances as of …" caption. Interest
   is time-based, so a balance is only fully meaningful with an as-of moment. */
function fmtAsOf() {
  return new Date().toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/* The day-key everything keys off: the UTC date, matching how transactions are
   stamped (entryDate anchors backdated entries at local noon → same UTC day)
   and how History search already slices `t.date`. Calendar cells, "today", and
   the selected day all compare these strings, so nothing drifts across zones. */
function dayKey(iso) { return new Date(iso).toISOString().slice(0, 10); }
function todayKey() { return new Date().toISOString().slice(0, 10); }
function monthKey(dayStr) { return dayStr.slice(0, 7); }

/* Human label for a yyyy-mm-dd, read as a UTC day so it never shifts back a day. */
function fmtDayKey(dayStr) {
  return new Date(dayStr + 'T12:00:00Z')
    .toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
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

/* Case-insensitive name comparator. Every list of people is shown in this
   order so names read alphabetically everywhere, matching the Ledger tab. */
function byName(a, b) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/* People sorted alphabetically by name, without mutating state.people. */
function peopleByName() {
  return state.people.slice().sort(byName);
}

/* ---------- theme ----------
   The user's choice ('light' | 'dark') lives in settings, and light is the
   default — the app picks a look rather than inheriting the OS one. We stamp
   it on <html data-theme> (styles.css overrides the palette tokens for
   "dark") and keep the address-bar/status-bar colour in step. */

/* The flat colour the translucent masthead composites to, mirroring the
   --bar-bg token in styles.css (read from there when it's available, so the
   two can't drift). Chrome paints the status bar of the installed app with
   this via the theme-color meta. */
const THEME_BAR_COLOR = { light: '#fdfefd', dark: '#121212' };

/* iOS ignores theme-color entirely and offers only these three status-bar
   styles. 'default' is a white bar with black symbols, which matches the light
   masthead; 'black-translucent' hands the strip to the page, so the masthead's
   safe-area padding paints it #121212 and the symbols turn white. Safari reads
   the meta at load — the boot script in index.html sets it before first paint,
   and writing it here keeps a mid-session theme switch right for the next
   launch. */
const IOS_BAR_STYLE = { light: 'default', dark: 'black-translucent' };

function barColor(theme) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--bar-bg').trim();
    if (v) return v;
  } catch (e) {}
  return THEME_BAR_COLOR[theme];
}

/* Anything that isn't an explicit 'dark' reads as light, so a ledger saved
   under the old 'device' setting simply lands on the light default. */
function resolvedTheme() {
  return (state && state.settings && state.settings.theme) === 'dark' ? 'dark' : 'light';
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.setAttribute('data-theme', theme);
  // data-theme has to land first: barColor() reads the token it selects.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', barColor(theme));
  const iosBar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (iosBar) iosBar.setAttribute('content', IOS_BAR_STYLE[theme]);
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
  return { tally: true, depth: navDepth, tab: ui.tab, openGroupId: ui.openGroupId, modalPersonId: ui.modalPersonId, splitOpen: ui.splitOpen, shareGroupId: ui.shareGroupId, sharePeopleOpen: ui.sharePeopleOpen, selectMode: ui.selectMode, memberSelect: ui.memberSelect, personSelect: ui.personSelect, cloudPromptOpen: ui.cloudPromptOpen, confirmDelete: ui.confirmDelete, confirmRemoveMembers: ui.confirmRemoveMembers, confirmDeletePeople: ui.confirmDeletePeople, confirmClearDebt: ui.confirmClearDebt, calendarOpen: ui.calendarOpen };
}

function pushNav() {
  navDepth++;
  history.pushState(navState(), '');
}

function applyNav(s) {
  ui.tab = s && s.tab ? s.tab : 'ledger';
  ui.openGroupId = (s && s.openGroupId) || null;
  ui.modalPersonId = (s && s.modalPersonId) || null;
  ui.splitOpen = !!(s && s.splitOpen);
  ui.shareGroupId = (s && s.shareGroupId) || null;
  ui.sharePeopleOpen = !!(s && s.sharePeopleOpen);
  ui.renamingGroup = false;
  ui.selectMode = !!(s && s.selectMode);
  if (!ui.selectMode) ui.selected = new Set();
  ui.confirmDelete = !!(s && s.confirmDelete);
  ui.memberSelect = !!(s && s.memberSelect);
  if (!ui.memberSelect) ui.selectedMembers = new Set();
  ui.confirmRemoveMembers = !!(s && s.confirmRemoveMembers);
  ui.personSelect = !!(s && s.personSelect);
  if (!ui.personSelect) ui.selectedPeople = new Set();
  ui.confirmDeletePeople = !!(s && s.confirmDeletePeople);
  ui.confirmClearDebt = (s && s.confirmClearDebt) || null;
  ui.calendarOpen = !!(s && s.calendarOpen);
  ui.cloudPromptOpen = !!(s && s.cloudPromptOpen);
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

/* ---------- masthead status ---------- */

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

/* ---------- ledger view ---------- */

/* Dashboard hero: the headline net position, split into "you are owed"
   (emerald) and "you owe" (coral). Figures are summed in the base currency
   only — other currencies are never converted, so they get a one-line note
   with their own nets instead of being silently folded in. */
function balanceHeroHTML() {
  const code = state.settings.baseCurrency;
  const now = Date.now();
  let owed = 0, owe = 0;
  state.people.forEach(p => {
    if (p.currency !== code) return;
    const t = totalOf(p, now);
    if (t > 0.005) owed += t;
    else if (t < -0.005) owe += -t;
  });
  const net = owed - owe;
  const netCls = Math.abs(net) < 0.005 ? 'zero' : (net > 0 ? 'pos' : 'neg');
  const netLabel = netCls === 'zero' ? 'All square'
    : (net > 0 ? `+${fmtMoney(net, code)}` : `−${fmtMoney(-net, code)}`);

  const { perCurrency } = netSummary(now);
  const others = Object.entries(perCurrency)
    .filter(([c, amt]) => c !== code && Math.abs(amt) > 0.005)
    .map(([c, amt]) => `${c} ${amt > 0 ? '+' : '−'}${fmtMoney(Math.abs(amt), c)}`);

  return `
    <section class="balance-hero" aria-label="Total balance">
      <span class="balance-hero-label">Total balance</span>
      <div class="balance-hero-total ${netCls}">${netLabel}</div>
      <div class="balance-hero-split">
        <div class="hero-pill owed">
          <span class="hero-k">You are owed</span>
          <span class="hero-v">${fmtMoney(owed, code)}</span>
        </div>
        <div class="hero-pill owe">
          <span class="hero-k">You owe</span>
          <span class="hero-v">${fmtMoney(owe, code)}</span>
        </div>
      </div>
      ${others.length ? `<div class="balance-hero-more">Also on the books: ${others.map(esc).join(' · ')}</div>` : ''}
    </section>`;
}

function renderLedger() {
  const q = ui.search.trim().toLowerCase();
  const query = ui.search.trim();
  const people = state.people
    .filter(p => !q || p.name.toLowerCase().includes(q))
    .sort(byName);

  /* Adding someone is its own button — the + beside the search box — rather
     than something the search field quietly doubles as. It opens this panel:
     a name, and optionally the amount that starts them off. */
  const addPersonBlock = ui.addingPerson ? `
      <div class="add-person-quick">
        <div class="add-person-quick-head">
          <span class="add-suggestion-plus" aria-hidden="true">+</span>
          <span>Add a new person</span>
          <button type="button" class="add-person-quick-close" data-action="cancel-add-person" aria-label="Cancel">✕</button>
        </div>
        <input id="new-person-name" class="add-person-name" placeholder="name" maxlength="40"
          value="${esc(ui.addPersonName)}" autocomplete="off">
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

    /* In select mode the tile keeps its full layout — Settle and the
       quick-entry boxes stay put (inert, dimmed via CSS) so entering
       selection never shifts the page; share/delete live in the top bar. */
    return `<tr class="row${selCls}" data-person-id="${p.id}">
      <td class="col-person${ui.personSelect ? ' selecting' : ''}">${check}${PersonName(p.id, p.name, 'Tap to open · long-press or right-click to select, then share or delete')} ${exempt} ${rowActions(p.name, p.id, total)}</td>
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
    shareAction: 'share-selected-people',
    shareLabel: 'Share selected balances',
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
        <h3>Settle ${esc(clearTarget.name)}'s balance?</h3>
        <p class="muted">Any outstanding interest is added, then the balance is zeroed and recorded in History as a repayment.</p>
        <button class="btn block" data-action="confirm-clear-debt" data-id="${clearTarget.id}">Settle balance</button>
        <button class="btn ghost block" data-action="cancel-clear-debt">Cancel</button>`,
  }) : '';

  return `
    ${selectBar}
    ${confirmOverlay}
    ${clearOverlay}
    ${state.people.length ? balanceHeroHTML() : ''}
    <div class="detail-head">
      <h2 class="section-title">The Ledger</h2>
      <div class="head-side">
        <div class="head-actions">
          <button class="btn ghost head-action" data-action="open-split" ${state.people.length < 1 ? 'disabled title="Add a person first"' : ''}>÷ Split expense</button>
        </div>
      </div>
    </div>
    <p class="section-sub">Every person, every balance — across all groups. Positive means they owe you. Type an amount and hit <em>+ lent</em> or <em>− repaid</em>, like a spreadsheet row.</p>

    <div class="people-search-row">
      <form id="person-search" data-form="person-search" class="people-search" role="search">
        <span class="people-search-icon" aria-hidden="true">${Icons.search()}</span>
        <input id="search-box" name="q" placeholder="Search people…" value="${esc(ui.search)}" autocomplete="off">
        ${query ? `<button type="button" class="people-search-clear" data-action="clear-search" aria-label="Clear search">×</button>` : ''}
      </form>
      <button type="button" class="people-add-btn${ui.addingPerson ? ' active' : ''}" data-action="add-person-open"
        aria-label="Add a person" title="Add a person" aria-expanded="${ui.addingPerson}">${Icons.plus()}</button>
    </div>
    ${addPersonBlock}

    ${people.length ? `
    <div class="list-share">
      <span class="as-of" title="Interest accrues continuously, so totals are computed at this moment">Balances as of ${esc(fmtAsOf())}</span>
      <span class="list-tools">
        <button class="btn small ghost" data-action="enter-person-select" title="Select people to share or delete">Select</button>
        ${ShareButton({ cls: 'btn ghost head-action head-share', action: 'open-share-people', extra: state.people.length < 1 ? 'disabled title="Add someone first"' : '' })}
      </span>
    </div>
    <table class="ledger-table">
      <thead><tr>
        <th>Person</th><th class="col-groups">Groups</th>
        <th class="num">Principal</th><th class="num">Interest</th><th class="num">Total</th>
        <th>Quick entry</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
` : (state.people.length === 0
      ? EmptyState(`
          <div class="empty-mark" aria-hidden="true">${Icons.ledgerMark()}</div>
          <h3 class="empty-title">Your ledger is empty</h3>
          <p class="empty-copy">Add the first person you’ve lent to or borrowed from. Everything stays in this browser — nothing is uploaded.</p>
          <button class="btn" data-action="add-person-open">+ Add your first person</button>`, 'empty-onboard')
      : EmptyState(`No one matches “${esc(query)}”. Add them with the + beside the search box.`))}
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
    const names = g.memberIds.map(getPerson).filter(Boolean).sort(byName).map(p => p.name).join(', ');
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

  /* Members are picked by tapping name tiles — the checkbox is hidden and the
     tile shows the same tick circle the ledger's select mode uses. */
  const memberTiles = peopleByName().map(p =>
    `<label class="name-tile"><input type="checkbox" name="member" value="${p.id}"><span class="sel-check" aria-hidden="true"></span><span class="name-tile-name">${esc(p.name)}</span></label>`
  ).join('');

  /* A person can sit in several groups, and each group's net counts their full
     global balance — so the per-group nets overlap and must not be summed. Only
     warn when that overlap actually exists. */
  const overlap = state.people.some(p => groupsOf(p.id).length > 1);
  const overlapNote = overlap
    ? `<p class="section-sub group-overlap-note">Heads up: someone here belongs to more than one group, and each group's net counts their full balance — so the group nets overlap and don't add up to a single total.</p>`
    : '';

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
        <div class="form-row">${memberTiles
          ? `<div class="name-tile-grid" role="group" aria-label="Tap names to pick members">${memberTiles}</div>`
          : '<span class="muted">Add people on the Ledger tab first.</span>'}</div>
        <div class="form-row tight"><button class="btn" type="submit">Create group</button></div>
      </form>`,
  });

  return `
    <div class="detail-head">
      <h2 class="section-title">Groups</h2>
      ${state.groups.length && !showCreate
        ? '<button class="btn ghost head-action" data-action="new-group">+ New group</button>' : ''}
    </div>
    <p class="section-sub">Balances are global — a payment recorded in one group shows up in every other group instantly.</p>
    ${overlapNote}

    ${showCreate ? createPanel : ''}

    ${state.groups.length ? `<div class="group-grid">${cards}</div>`
      : (ui.creatingGroup ? '' : EmptyState('No groups yet. Trips, flatmates, that one fantasy league — they all start here.'))}
  `;
}

function renderGroupDetail() {
  const g = getGroup(ui.openGroupId);
  if (!g) { ui.openGroupId = null; return renderGroups(); }

  const members = g.memberIds.map(getPerson).filter(Boolean).sort(byName);

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

  const nonMembers = state.people.filter(p => !g.memberIds.includes(p.id)).sort(byName);
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
      <span class="list-tools">
        ${members.length && !ui.memberSelect ? '<button class="btn small ghost" data-action="enter-member-select" title="Select members to remove from the group">Select</button>' : ''}
        ${ShareButton({ cls: 'btn small ghost share-group-btn', action: 'share-group', dataId: g.id })}
      </span>
    </div>
    <table class="ledger-table">
      <thead><tr><th>Member</th><th class="num">Total owed (global)</th><th>Quick entry (tagged to this group)</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3" class="muted">No members yet.</td></tr>'}</tbody>
    </table>

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

/* "≈ 26.8% a year" — the effective annual rate of a periodic rule, for display.
   Empty when the period is yearly (the rate already IS the annual figure) or the
   rate is zero, so it only appears where it adds information. */
function fmtEffectiveAnnual(rate, periodUnit, type) {
  if (periodUnit === 'year') return '';
  const ear = effectiveAnnualRate(rate, periodUnit, type);
  if (ear == null) return '';
  return `≈ ${ear.toFixed(ear >= 100 ? 0 : 1)}% a year`;
}

function describeInterestRule(r) {
  const cap = r.capPeriods ? ` for at most <span class="hl">${r.capPeriods} ${r.periodUnit}${r.capPeriods > 1 ? 's' : ''}</span>` : '';
  let scope = '';
  if (r.groupId) {
    const g = getGroup(r.groupId);
    scope = g ? ` and they're in <span class="hl">${esc(g.name)}</span>`
              : ' and they\'re in <span class="hl">a deleted group (rule inactive)</span>';
  }
  const ear = fmtEffectiveAnnual(r.rate, r.periodUnit, r.type);
  const earTag = ear ? ` <span class="rule-ear" title="Effective annual rate">${ear}</span>` : '';
  return `<span class="rule-name">${esc(r.name)}</span> — if balance <span class="hl">${r.op} ${r.value}</span>${scope},
    charge <span class="hl">${r.rate}%</span> <span class="hl">${r.type}</span> interest per <span class="hl">${r.periodUnit}</span>${cap}.${earTag}`;
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

/* Close the first-run popup and remember it was offered, so it never reappears.
   goBack() pops the popup's history entry; popstate clears the flag + re-renders. */
function dismissCloudPrompt() {
  if (typeof markCloudPromptSeen === 'function') markCloudPromptSeen();
  goBack();
}

/* Jump to Settings and bring the Cloud sync panel into view + briefly highlight
   it, so "Set up cloud sync" lands the user exactly where they can sign in. */
function openCloudSyncSettings() {
  // Reached only from the first-run popup, which already owns a history entry —
  // replace it (don't push) so back returns to the ledger, not the popup.
  ui.tab = 'account';
  history.replaceState(navState(), '');
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

  /* The calendar marks every day that has a (search-filtered) entry, so dots
     track the search too. The list below then narrows to the picked day. */
  const dayCounts = {};
  matches.forEach(({ t }) => { const k = dayKey(t.date); dayCounts[k] = (dayCounts[k] || 0) + 1; });
  /* Days that carry a future scheduled debt — marked with a hollow dot so
     upcoming bets/loans are visible at a glance. */
  const schedDays = new Set((state.scheduled || [])
    .filter(s => getPerson(s.personId)).map(s => dayKey(s.date)));
  /* The register is why anyone opens History, so it leads; the month grid is
     tucked behind a toggle. A picked day forces it open so the filter stays
     visible (and undoable). */
  const calOpen = ui.calendarOpen || !!ui.historyDate;
  const calToggle = `
    <button type="button" class="cal-toggle${calOpen ? ' open' : ''}" data-action="cal-toggle" aria-expanded="${calOpen}">
      <span class="cal-toggle-icon" aria-hidden="true">${Icons.calendar()}</span>
      <span>${ui.historyDate ? `Filtered to ${esc(fmtDayKey(ui.historyDate))}` : 'Filter by date'}</span>
      <span class="cal-toggle-chev" aria-hidden="true">${calOpen ? '▾' : '▸'}</span>
    </button>`;
  const calendar = calToggle + (calOpen ? renderHistoryCalendar(dayCounts, schedDays) : '');

  // A future day is picked → show the "schedule a debt" panel instead of the
  // (necessarily empty) entries list for that day.
  const futureDay = ui.historyDate && ui.historyDate > todayKey();
  // Show the calendar whenever there's something to navigate or someone to
  // schedule against, even before any transaction exists.
  const showCal = entries.length || schedDays.size || state.people.length;

  const visible = ui.historyDate
    ? matches.filter(({ t }) => dayKey(t.date) === ui.historyDate)
    : matches;

  const rows = visible.map(({ t, p, g }) => {
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
        <td data-label="Group"><span class="muted">—</span></td>
        <td data-label="Reason"><span class="muted">not yet capitalized</span></td>
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
          : (t.amount >= 0 ? '<span class="hist-tag lent">lent</span>' : '<span class="hist-tag paid">repaid</span>');
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
        <p class="muted">Removes ${selCount === 1 ? 'it' : 'them'} and updates each person's balance by ${selCount === 1 ? 'that amount' : 'those amounts'}.</p>
        <button class="btn danger block" data-action="confirm-delete">Delete</button>
        <button class="btn ghost block" data-action="cancel-confirm">Cancel</button>`,
  }) : '';

  return `
    ${selectBar}
    ${confirmOverlay}
    <h2 class="section-title">History</h2>
    <p class="section-sub">Every entry across everyone — lent, repaid, and interest.</p>

    <div class="form-row">
      <input id="history-search" placeholder="Search person, reason, amount, date…" value="${esc(ui.historySearch)}" style="flex:1">
    </div>

    ${showCal ? calendar : ''}

    ${futureDay ? renderSchedulePanel(ui.historyDate)
      : (entries.length ? (matches.length ? `
    <div class="list-share history-count">
      <span class="muted">${visible.length} ${visible.length === 1 ? 'entry' : 'entries'}${ui.historyDate ? ` on ${esc(fmtDayKey(ui.historyDate))}` : (q ? ' matching' : '')}</span>
      ${visible.length && !ui.selectMode ? '<button class="btn small ghost" data-action="enter-history-select" title="Select entries to delete">Select</button>' : ''}
    </div>
    ${visible.length ? `
    <table class="ledger-table history-table">
      <thead><tr>
        <th>Person</th><th>Date</th><th>Type</th><th>Group</th><th>Reason</th><th class="num">Amount</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`
      : EmptyState(`No entries on ${esc(fmtDayKey(ui.historyDate))}.`)}`
      : EmptyState(`No entries match “${esc(ui.historySearch)}”.`))
      : EmptyState('No transactions yet. Record some lending or repayments on the Ledger.'))}
  `;
}

/* The "schedule a future debt" panel, shown when a future day is picked in the
   calendar. Lists anything already scheduled for that day (each cancellable) and
   offers a small form to add one. Off-ledger until the day arrives — see
   renderScheduledPrompt for the due-day confirmation. */
function renderSchedulePanel(day) {
  const people = peopleByName();
  const items = (state.scheduled || [])
    .filter(s => dayKey(s.date) === day && getPerson(s.personId))
    .map(s => {
      const p = getPerson(s.personId);
      const owe = s.amount >= 0;
      return `<div class="sched-item">
        <span class="sched-item-main">${esc(p.name)} <span class="muted">${owe ? 'will owe you' : 'you will owe'}</span> ${Money(Math.abs(s.amount), p.currency, { tag: 'b', cls: owe ? 'pos' : 'neg' })}${esc(s.note) ? ` · ${esc(s.note)}` : ''}</span>
        <button class="del-x" data-action="cancel-scheduled" data-id="${s.id}" title="Remove this scheduled debt">✕</button>
      </div>`;
    }).join('');

  const personOptions = people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  return `
    <div class="sched-panel">
      <h3 class="subhead">Schedule a debt · ${esc(fmtDayKey(day))}</h3>
      <p class="section-sub" style="margin-bottom:14px">Set up a future debt — a bet, a promised loan. It stays off the ledger until that day, when Tally reminds you and asks whether to add it.</p>
      ${items ? `<div class="sched-list">${items}</div>` : ''}
      ${people.length ? `
      <form data-form="schedule-debt">
        <input type="hidden" name="date" value="${esc(day)}">
        <div class="form-row">
          <select name="personId">${personOptions}</select>
          <select name="sign">
            <option value="1">They’ll owe you (+)</option>
            <option value="-1">You’ll owe them (−)</option>
          </select>
        </div>
        <div class="form-row">
          <input name="amount" type="number" inputmode="decimal" step="any" min="0.01" placeholder="amount" required style="flex:1;min-width:0">
          <input name="note" placeholder="reason (e.g. lost a bet)" maxlength="80" style="flex:1;min-width:0">
        </div>
        <div class="form-row tight"><button class="btn" type="submit">Schedule it</button></div>
      </form>`
      : '<p class="muted">Add a person on the Ledger first, then schedule a debt for them here.</p>'}
    </div>`;
}

/* The due-day reminder: when a scheduled debt's date has arrived, a confirmation
   card asks whether to record it (the bet landed) or drop it. Shown over any tab.
   One at a time; "Remind me later" snoozes it for this session. */
function renderScheduledPrompt() {
  const root = document.getElementById('scheduled-root');
  if (!root) return;
  const due = dueScheduled().filter(s => !ui.scheduledSnoozed.has(s.id));
  if (!due.length) { root.innerHTML = ''; return; }
  const s = due[0];
  const p = getPerson(s.personId);
  const owe = s.amount >= 0;
  root.innerHTML = ConfirmOverlay({
    id: 'scheduled-overlay',
    closeAction: 'snooze-scheduled',
    inner: `
        <h3>A scheduled debt is due</h3>
        <p class="muted">You scheduled this for ${esc(fmtDayKey(dayKey(s.date)))}${s.note ? ` — “${esc(s.note)}”` : ''}:</p>
        <p class="sched-due-amount">${owe ? `${esc(p.name)} owes you` : `You owe ${esc(p.name)}`} <b class="money ${owe ? 'pos' : 'neg'}">${esc(fmtMoney(Math.abs(s.amount), p.currency))}</b></p>
        <p class="muted">Add it to the ledger now?</p>
        <button class="btn block" data-action="confirm-scheduled" data-id="${s.id}">Add it to the ledger</button>
        <button class="btn ghost block" data-action="skip-scheduled" data-id="${s.id}">Don’t add it (discard)</button>
        <button class="btn ghost block" data-action="snooze-scheduled" data-id="${s.id}">Remind me later</button>`,
  });
}

/* Google-Calendar-style month grid for History: pick a day to filter the list
   to that day's entries. Dots mark days that have entries (after search). The
   month in view lives in ui.historyMonth; the picked day in ui.historyDate. */
function renderHistoryCalendar(dayCounts, schedDays = new Set()) {
  const today = todayKey();
  const month = ui.historyMonth || (ui.historyDate ? monthKey(ui.historyDate) : monthKey(today));
  const [y, m] = month.split('-').map(Number);                 // m is 1-12

  // UTC math so day boundaries never drift: first weekday + number of days.
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();   // 0=Sun
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthLabel = new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const dows = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
    .map(d => `<span class="cal-dow">${d}</span>`).join('');

  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += '<span class="cal-cell cal-blank"></span>';
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${month}-${String(d).padStart(2, '0')}`;
    const count = dayCounts[key] || 0;
    const scheduled = schedDays.has(key);
    const cls = ['cal-cell', 'cal-day'];
    if (key === ui.historyDate) cls.push('selected');
    if (key === today) cls.push('today');
    if (count) cls.push('has-entries');
    if (scheduled) cls.push('has-scheduled');
    const title = scheduled
      ? ' title="Scheduled debt — tap to view"'
      : (count ? ` title="${count} ${count === 1 ? 'entry' : 'entries'}"` : '');
    const dot = count ? '<span class="cal-dot" aria-hidden="true"></span>'
      : (scheduled ? '<span class="cal-dot cal-dot-sched" aria-hidden="true"></span>' : '');
    cells += `<button type="button" class="${cls.join(' ')}" data-action="cal-pick" data-date="${key}"${title}>
      <span class="cal-num">${d}</span>${dot}
    </button>`;
  }

  return `
    <div class="cal" role="group" aria-label="Filter history by date">
      <div class="cal-head">
        <button type="button" class="cal-nav" data-action="cal-prev" aria-label="Previous month">‹</button>
        <span class="cal-title">${esc(monthLabel)}</span>
        <button type="button" class="cal-nav" data-action="cal-next" aria-label="Next month">›</button>
      </div>
      <div class="cal-grid cal-dows">${dows}</div>
      <div class="cal-grid cal-days">${cells}</div>
      <div class="cal-foot">
        <button type="button" class="cal-link" data-action="cal-today">Today</button>
        ${ui.historyDate ? `<button type="button" class="cal-link cal-clear" data-action="cal-clear">Clear date · ${esc(fmtDayKey(ui.historyDate))}</button>` : '<span class="muted cal-hint">Tap a day to filter · a future day to schedule</span>'}
      </div>
    </div>`;
}

/* Shift the calendar month by ±1, keeping the yyyy-mm key tidy. */
function shiftHistoryMonth(delta) {
  const base = ui.historyMonth || (ui.historyDate ? monthKey(ui.historyDate) : monthKey(todayKey()));
  let [y, m] = base.split('-').map(Number);
  m += delta;
  if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
  ui.historyMonth = `${y}-${String(m).padStart(2, '0')}`;
}

function enterSelectMode(txnId) {
  if (ui.selectMode) {
    if (txnId) toggleSelected(txnId);
    return;
  }
  ui.selectMode = true;
  ui.selected = new Set(txnId ? [txnId] : []);
  pushNav();
  render();
}

function toggleSelected(txnId) {
  if (ui.selected.has(txnId)) ui.selected.delete(txnId);
  else ui.selected.add(txnId);
  render();
}

/* Removes the entries and adjusts each person's balance accordingly. */
function performDelete() {
  const ids = new Set(ui.selected);
  if (!ids.size) return;
  // an indirect payment is two linked legs — act on its sibling too so balances stay consistent
  [...ids].forEach(id => {
    const t = state.transactions.find(x => x.id === id);
    if (t && t.indirect && t.linkId) {
      state.transactions.forEach(x => { if (x.linkId === t.linkId) ids.add(x.id); });
    }
  });
  ids.forEach(id => deleteTransaction(id));
  saveState();
  runNotificationCheck();
  const n = ids.size;
  history.go(-2);   // pop the confirm + select-mode entries; popstate clears selection and re-renders
  showToast(`${n} ${n === 1 ? 'entry' : 'entries'} deleted`);
}

/* ---------- group-member multi-select removal ---------- */
function enterMemberSelectMode(memberId) {
  if (ui.memberSelect) {
    if (memberId) toggleMemberSelected(memberId);
    return;
  }
  ui.memberSelect = true;
  ui.selectedMembers = new Set(memberId ? [memberId] : []);
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
  history.go(-2);   // pop the confirm + member-select entries; popstate clears selection and re-renders
  showToast(`${n} ${n === 1 ? 'person' : 'people'} removed from ${g.name}`);
}

/* ---------- ledger person multi-select deletion ---------- */
function enterPersonSelectMode(personId) {
  if (ui.personSelect) {
    if (personId) togglePersonSelected(personId);
    return;
  }
  ui.personSelect = true;
  ui.selectedPeople = new Set(personId ? [personId] : []);
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
  history.go(-2);   // pop the confirm + person-select entries; popstate clears selection and re-renders
  showToast(`${n} ${n === 1 ? 'person' : 'people'} deleted`);
}

/* Reads a balance as a phrase for the split preview's before/after lines. */
function balancePhrase(n, currency) {
  if (n > 0.005) return `owes you ${fmtMoney(n, currency)}`;
  if (n < -0.005) return `you owe ${fmtMoney(-n, currency)}`;
  return 'settled';
}

/* ---------- split expense ----------
   A popup over a blurred page: pick who paid, tick who shares the cost, enter
   the total, and a live preview shows each person's exact share before it's
   recorded. Paid by Me: each share becomes its own "they owe you" entry
   (tagged SPLIT). Paid by someone else: each share is routed through you as a
   linked indirect payment (tagged INDIRECT) — the payer's balance drops by
   what they covered for everyone else, the payer's own share is nobody's
   debt, and your share simply raises what you owe the payer. */

/* ids of people whose split checkbox is currently ticked, in checklist order
   so the remainder cents land on the same people the preview shows. */
function splitSelectedIds() {
  return [...document.querySelectorAll('[data-split-member]')]
    .filter(cb => cb.checked)
    .map(cb => cb.dataset.splitMember);
}

/* Leftover minor units are assigned deterministically, not at random: a
   reconciler should be able to predict exactly who pays the odd cent. splitShares
   defaults to handing the leftover to the first participant(s) in listed order —
   and when you're in the split you're index 0, so the leftover lands on you, the
   payer, keeping everyone else's shares clean. Listed order is the order people
   appear in the picker, which is the order the preview shows, so the live preview
   matches what's recorded on submit. */

function splitPreviewHTML(payerId, ids, amt, includeMe, own) {
  const payer = payerId === 'me' ? null : getPerson(payerId);
  const people = ids.map(getPerson).filter(Boolean);
  if (!people.length && !includeMe) {
    return '<span class="muted">Tick who is splitting and enter an amount to see each share.</span>';
  }
  if (!Number.isFinite(amt) || amt <= 0) {
    return '<span class="muted">Enter the total to see each share.</span>';
  }
  const ownMap = own || {};
  const unfilled = Object.keys(ownMap).some(k => !Number.isFinite(ownMap[k]));
  if (unfilled) return '<span class="muted">Enter an amount for everyone on their own figure.</span>';

  const baseCur = state.settings.baseCurrency;
  /* Shares come from the same computation that records them, so this preview
     is exactly what will land in the ledger. */
  const { shares, remainder, sharerCount } = computeSplitShares({
    personIds: people.map(p => p.id), amount: amt, includeMe, own: ownMap,
  });
  const n = people.length + (includeMe ? 1 : 0);
  const currencies = people.map(p => p.currency);
  if (includeMe) currencies.push(baseCur);
  if (payer) currencies.push(payer.currency);
  const multiCurrency = new Set(currencies).size > 1;
  const headCur = includeMe ? baseCur : people[0] ? people[0].currency : baseCur;
  const payerCur = payer ? payer.currency : baseCur;
  const head = `<div class="split-head">${n} ${n === 1 ? 'person' : 'people'}${
    multiCurrency ? '' : ` · ${fmtMoney(amt, headCur)} total`} · paid by ${
    payer ? esc(payer.name) : 'you'}</div>`;
  const ownTag = k => Number.isFinite(ownMap[k]) ? ' <span class="pick-own-tag">own amount</span>' : '';

  /* What the person who paid is out of pocket for everyone else: the shares
     that actually become debts (their own ticked share is nobody's debt). */
  const covered = people.filter(p => !payer || p.id !== payer.id)
    .reduce((s, p) => s + shares[p.id], 0) + (includeMe && payer ? shares.me : 0);

  /* The lender line leads the preview: who put the money in, and what it does
     to their balance with you. Paid by someone else, their balance drops by
     everything they covered — shown before → after. Paid by you, there is no
     single balance to move, so it reads as the total you laid out and the part
     of it coming back to you. Cover nobody but yourself and there is no
     movement to report, so the figure is left off rather than shown as zero. */
  const covers = covered > 0.005;
  const lenderLine = payer ? (() => {
    const before = totalOf(payer);
    return `
    <div class="xfer-line">
      <span><b>${esc(payer.name)}</b> ${multiCurrency ? '' : `paid ${fmtMoney(amt, payerCur)}`}${
        covers ? `${multiCurrency ? '' : ' · '}${balancePhrase(before, payerCur)}
      <span class="xfer-arrow">→</span> ${balancePhrase(before - covered, payerCur)}` : ''}</span>
      ${covers ? `<span class="xfer-delta neg">−${fmtMoney(covered, payerCur)}</span>` : ''}
    </div>`;
  })() : `
    <div class="xfer-line">
      <span><b>Me</b> · you paid ${fmtMoney(amt, baseCur)}</span>
      ${covers ? `<span class="xfer-delta pos">+${fmtMoney(covered, baseCur)} owed to you</span>` : ''}
    </div>`;

  /* Everyone else's share lands as "they owe you" — either directly (you
     paid) or routed through you (someone else paid) — so each recipient reads
     as their balance before → after. The payer's own ticked share counts
     toward the division but is nobody's debt. */
  const lines = people.map(p => {
    if (payer && p.id === payer.id) {
      return `
    <div class="xfer-line">
      <span><b>${esc(p.name)}</b> · their own share${ownTag(p.id)}</span>
      <span class="xfer-delta">${fmtMoney(shares[p.id], p.currency)}</span>
    </div>`;
    }
    const before = totalOf(p);
    return `
    <div class="xfer-line">
      <span><b>${esc(p.name)}</b> ${balancePhrase(before, p.currency)}
      <span class="xfer-arrow">→</span> ${balancePhrase(before + shares[p.id], p.currency)}${ownTag(p.id)}</span>
      <span class="xfer-delta pos">+${fmtMoney(shares[p.id], p.currency)}</span>
    </div>`;
  }).join('');

  /* Your own line. Paid by Me: your share is just what you covered for
     yourself. Paid by someone else: your share is new debt to the payer. */
  const meLine = includeMe ? (payer ? `
    <div class="xfer-line">
      <span><b>Me</b> · ${esc(payer.name)} covered your share${ownTag('me')}</span>
      <span class="xfer-delta neg">you owe +${fmtMoney(shares.me, payerCur)}</span>
    </div>` : `
    <div class="xfer-line">
      <span><b>Me</b> · your share${ownTag('me')}</span>
      <span class="xfer-delta">${fmtMoney(shares.me, baseCur)}</span>
    </div>`) : '';

  /* Individual amounts must fit the total; with everyone on their own figure
     they must reach it exactly, since nobody is left to absorb the remainder. */
  const short = !sharerCount && remainder > 0.005
    ? `<div class="xfer-warn">${fmtMoney(remainder, headCur)} of the total is still unassigned — raise an amount, or put someone back on the equal split.</div>` : '';
  const over = remainder < -0.005
    ? `<div class="xfer-warn">The individual amounts exceed the total by ${fmtMoney(-remainder, headCur)}.</div>` : '';
  const mismatch = multiCurrency
    ? `<div class="xfer-warn">Selected people use different currencies — each share is applied in that person's own currency, nothing is converted.</div>`
    : '';
  return head + lenderLine + lines + meLine + short + over + mismatch;
}

/* whether "Me" is ticked in the split picker */
function splitIncludesMe() {
  const me = document.querySelector('[data-split-me]');
  return !!(me && me.checked);
}

/* How many people are ticked (real participants plus "Me"). Reads the live
   checklist; pass the draft to count from the snapshot instead. */
function splitPickCount(draft) {
  if (draft) {
    const picked = [...draft.selected].filter(getPerson);
    return picked.length + (draft.me ? 1 : 0);
  }
  return splitSelectedIds().length + (splitIncludesMe() ? 1 : 0);
}

/* Custom amounts only mean anything once several people are ticked — with one
   participant the whole total is theirs, so the choice collapses to equal. */
function splitMode(draft) {
  const d = draft || ui.splitDraft;
  if (!d || d.mode !== 'custom') return 'equal';
  return splitPickCount(draft) >= 2 ? 'custom' : 'equal';
}

/* Whether a ticked participant is on their own figure rather than the equal
   division: everybody in custom mode, and anyone long-pressed while equal. */
function splitHasOwn(key, draft) {
  const d = draft || ui.splitDraft;
  return splitMode(draft) === 'custom' || !!(d && d.own && d.own.has(key));
}

/* The individual amounts straight off the live form, keyed 'me'/personId —
   only for participants whose box is visible. Unfilled boxes come back NaN,
   which the preview reports and the store refuses. */
function splitOwnMap() {
  const own = {};
  document.querySelectorAll('#split-root .pick-amt').forEach(box => {
    if (box.hidden) return;
    const key = box.dataset.splitAmount;
    if (key) own[key] = parseFloat(box.value);
  });
  return own;
}

/* Records a split someone else paid for. The division is the same
   computeSplitShares call the preview and the paid-by-Me path use; the shares
   then land as linked indirect payments — each participant's share is added
   to what they owe you and the payer's balance drops by the lot, with your
   own share simply raising what you owe the payer. The payer's own ticked
   share counts toward the division but is nobody's debt, so it's dropped
   before recording (as are explicit zero shares, matching addSplitExpense).
   Returns how many people had a share recorded. */
function recordSplitPaidBy({ payerId, personIds, amount, includeMe, own, note, date }) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Enter an amount greater than zero.');
  const ids = [...new Set(personIds)].filter(id => getPerson(id));
  if (!ids.length && !includeMe) throw new Error('Pick at least one person to split with.');

  const { shares, remainder, sharerCount } = computeSplitShares({
    personIds: ids, amount: amt, includeMe, own,
  });
  if (remainder < -0.005) {
    throw new Error('The individual amounts add up to more than the total.');
  }
  if (!sharerCount && Math.abs(remainder) > 0.005) {
    throw new Error('The amounts must add up to the total — adjust one, or the total itself.');
  }

  const receiverIds = ids.filter(id => id !== payerId && shares[id] > 0.005);
  const meIn = includeMe && shares.me > 0.005;
  const { count } = addIndirectPayments({
    lenderId: payerId, receiverIds, includeMe: meIn,
    amounts: shares, meAmount: shares.me, note, date,
  });
  return count;
}

/* Keeps the form in step with the live ticks without re-rendering (so typing
   and scroll position survive): the equal/custom bar appears once several
   people are ticked, and each row's box is live only for people on an
   individual amount. */
function updateSplitPreview() {
  const form = document.querySelector('[data-form="add-split"]');
  const node = document.getElementById('split-preview');
  if (!form || !node) return;
  const custom = splitMode() === 'custom';
  const count = splitPickCount();

  const modes = form.querySelector('[data-split-modes]');
  if (modes) {
    modes.hidden = count < 2;
    modes.querySelectorAll('.seg').forEach(seg => {
      const on = (seg.dataset.mode === 'custom') === custom;
      seg.classList.toggle('active', on);
      seg.setAttribute('aria-pressed', String(on));
    });
  }

  form.querySelectorAll('.share-pick-row[data-pick-id]').forEach(row => {
    const key = row.dataset.pickId;
    const cb = row.querySelector('input[type="checkbox"]');
    const box = row.querySelector('.pick-amt');
    const tag = row.querySelector('[data-own-tag]');
    const ticked = !!(cb && cb.checked);
    const own = ticked && splitHasOwn(key);
    if (box) { box.hidden = !own; box.disabled = !own; }
    if (tag) tag.hidden = !(own && !custom);   // in custom mode every row has one
    row.classList.toggle('has-own', own);
  });

  const payerId = splitPayerId();
  const ids = splitSelectedIds();
  const me = splitIncludesMe();
  // each collapsed picker shows what it currently holds
  const payerSum = form.querySelector('[data-payer-summary]');
  if (payerSum) payerSum.innerHTML = splitPayerLabel(payerId);
  const memberSum = form.querySelector('[data-members-summary]');
  if (memberSum) memberSum.innerHTML = splitMembersLabel(ids, me);

  node.innerHTML = splitPreviewHTML(payerId, ids, parseFloat(form.amount.value), me, splitOwnMap());
}

/* Long-pressing someone in the split picker hands them their own amount box,
   seeded from their current equal share — everyone else re-splits what's left
   of the total. Pressing again puts them back on the equal division. */
function setSplitIndividualAmount(row) {
  const draft = ui.splitDraft;
  if (!draft || !row) return;
  const key = row.dataset.pickId;
  const cb = row.querySelector('input[type="checkbox"]');
  const box = row.querySelector('.pick-amt');
  if (!key || !cb || !box) return;
  if (!draft.own) draft.own = new Set();

  cb.checked = true;
  // in custom mode everyone already has a box — the press just jumps to it
  if (splitMode() !== 'custom') {
    if (draft.own.has(key)) {
      draft.own.delete(key);
    } else {
      draft.own.add(key);
      // seed with the share they hold right now on the equal division
      if (!box.value) {
        const form = document.querySelector('[data-form="add-split"]');
        const amt = form ? parseFloat(form.amount.value) : NaN;
        if (Number.isFinite(amt) && amt > 0) {
          const { shares } = computeSplitShares({
            personIds: splitSelectedIds(), amount: amt,
            includeMe: splitIncludesMe(), own: splitOwnMap(),
          });
          if (Number.isFinite(shares[key])) box.value = String(shares[key]);
        }
      }
    }
  }
  syncSplitDraft();
  updateSplitPreview();
  if (!box.hidden) { box.focus(); box.select(); }
}

/* The split picker is re-rendered when a person is added mid-flow, which would
   otherwise wipe the typed amount/note and the current ticks. We snapshot the
   live form into ui.splitDraft so renderSplitModal can restore it. */
function freshSplitDraft() {
  return {
    payerId: 'me', selected: new Set(), me: false, amount: '',
    mode: 'equal', amounts: {}, meAmount: '', own: new Set(),
    date: new Date().toISOString().slice(0, 10), note: '', newName: '',
    // which picker is expanded: "paid by" starts closed on its Me default,
    // "split between" open, since ticking people is the point of the flow
    open: { payer: false, members: true },
  };
}

/* Who paid, straight off the live picker. Both pickers are the same tile
   list; the payer's tiles are radios, so only one is ever ticked. */
function splitPayerId() {
  const picked = document.querySelector('[data-split-payer]:checked');
  return picked ? picked.value : 'me';
}

/* The one-line summary each collapsed picker shows, so the choice is readable
   without opening it. */
function splitPayerLabel(payerId) {
  const p = payerId === 'me' ? null : getPerson(payerId);
  return p ? esc(p.name) : 'Me';
}

function splitMembersLabel(ids, includeMe) {
  const names = (includeMe ? ['Me'] : []).concat(ids.map(id => {
    const p = getPerson(id);
    return p ? esc(p.name) : null;
  }).filter(Boolean));
  if (!names.length) return '<span class="muted">nobody yet</span>';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} + ${names.length - 2} more`;
}

function syncSplitDraft() {
  if (!ui.splitDraft) ui.splitDraft = freshSplitDraft();
  const form = document.querySelector('[data-form="add-split"]');
  if (form) {
    ui.splitDraft.payerId = splitPayerId();
    ui.splitDraft.amount = form.amount.value;
    ui.splitDraft.date = form.date.value;
    ui.splitDraft.note = form.note.value;
    ui.splitDraft.selected = new Set(splitSelectedIds());
    ui.splitDraft.me = splitIncludesMe();
    // keep every typed per-person figure, ticked or not, so unticking isn't destructive
    document.querySelectorAll('#split-root [data-split-amount]').forEach(box => {
      if (box.dataset.splitAmount === 'me') ui.splitDraft.meAmount = box.value;
      else ui.splitDraft.amounts[box.dataset.splitAmount] = box.value;
    });
  }
  const ni = document.getElementById('split-new-name');
  if (ni) ui.splitDraft.newName = ni.value;
}

function renderSplitModal() {
  const root = document.getElementById('split-root');
  if (!ui.splitOpen) { root.innerHTML = ''; ui.splitDraft = null; return; }

  const draft = ui.splitDraft || (ui.splitDraft = freshSplitDraft());
  if (!draft.own) draft.own = new Set();
  if (draft.payerId !== 'me' && !getPerson(draft.payerId)) draft.payerId = 'me';
  const sel = draft.selected;
  const custom = splitMode(draft) === 'custom';
  const several = splitPickCount(draft) >= 2;

  /* Every row carries its own amount box so shares don't have to be equal:
     it's revealed for everyone in custom mode, and for just the people you
     long-pressed while splitting equally — everyone else re-splits what's left
     of the total. updateSplitPreview decides which boxes are live, so ticking
     a name never has to re-render the picker. */
  const amountBox = (key, value) =>
    `<input class="pick-amt" type="number" inputmode="decimal" step="any" min="0"
       placeholder="share" data-split-amount="${key}" value="${esc(value || '')}" hidden disabled>`;

  const pickRow = (key, name, checkbox, box, chip) =>
    `<div class="share-pick-row" data-pick-id="${key}" title="Long-press for an individual amount">
      <label class="share-pick-main">
        ${checkbox}
        <span class="sel-check" aria-hidden="true"></span>
        <span class="share-pick-name">${name}</span>
        <span class="pick-own-tag" data-own-tag hidden>own amount</span>
      </label>
      ${box}
      ${chip}
    </div>`;

  /* Both pickers are the same list of name tiles, each folded into a dropdown
     that shows its current choice when closed. The only difference is the
     hidden input behind each tile: radios for the one person who paid,
     checkboxes for the several who share it. */
  const payerRow = (key, name, chip) =>
    `<div class="share-pick-row">
      <label class="share-pick-main">
        <input type="radio" name="payerId" value="${key}" data-split-payer ${draft.payerId === key ? 'checked' : ''}>
        <span class="sel-check" aria-hidden="true"></span>
        <span class="share-pick-name">${name}</span>
      </label>
      ${chip}
    </div>`;

  const picker = (key, label, summary, open, body) => `
    <details class="pick-drop" data-pick-drop="${key}" ${open ? 'open' : ''}>
      <summary class="pick-drop-head">
        <span class="pick-drop-label">${label}</span>
        <span class="pick-drop-value" data-${key}-summary>${summary}</span>
        <svg class="pick-drop-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </summary>
      ${body}
    </details>`;

  /* "Me" — you can be one of the people sharing the cost. You pay your own
     share, so it only shrinks everyone else's; no debt is recorded for you. */
  const meRow = pickRow('me', 'Me',
    `<input type="checkbox" data-split-me ${draft.me ? 'checked' : ''}>`,
    amountBox('me', draft.meAmount),
    Chip(esc(state.settings.baseCurrency)));

  const rows = peopleByName().map(p => pickRow(p.id, esc(p.name),
    `<input type="checkbox" data-split-member="${p.id}" ${sel.has(p.id) ? 'checked' : ''}>`,
    amountBox(p.id, draft.amounts[p.id]),
    Chip(p.currency))).join('');

  /* Nothing to divide until at least two people are ticked, so the equal/custom
     choice only appears then (updateSplitPreview shows and hides it live). */
  const modeBar = `
    <div class="seg-control" role="group" aria-label="How the total is divided" data-split-modes ${several ? '' : 'hidden'}>
      <button type="button" class="seg${custom ? '' : ' active'}" data-action="set-split-mode" data-mode="equal" aria-pressed="${!custom}">Split equally</button>
      <button type="button" class="seg${custom ? ' active' : ''}" data-action="set-split-mode" data-mode="custom" aria-pressed="${custom}">Custom amounts</button>
    </div>`;

  /* Add a brand-new person without leaving the split: typing a name and
     hitting + Add creates them, ticks them, and clears the field to repeat. */
  const addRow =
    `<div class="split-add-row">
      <input type="text" id="split-new-name" placeholder="add a new person…" maxlength="40" value="${esc(draft.newName || '')}">
      <button type="button" class="btn ghost" data-action="split-add-person">+ Add</button>
    </div>`;

  const payerRows = payerRow('me', 'Me', Chip(esc(state.settings.baseCurrency)))
    + peopleByName().map(p => payerRow(p.id, esc(p.name), Chip(p.currency))).join('');

  const openState = draft.open || (draft.open = { payer: false, members: true });

  root.innerHTML = Modal({
    overlayId: 'split-overlay',
    modalCls: 'modal-split',
    title: 'Split an expense',
    closeAction: 'close-split',
    body: `
      <p class="section-sub split-intro">Pick who paid, tick who shares the cost, and enter the total. If you paid, each share is recorded as money they owe you; if someone else paid, the shares are routed through you and the payer's balance drops by what they covered. Long-press anyone for their own amount; the rest re-split what's left.</p>

      <form data-form="add-split">
        ${picker('payer', 'Paid by', splitPayerLabel(draft.payerId), openState.payer,
          `<div class="share-pick-list pick-drop-list">${payerRows}</div>`)}

        ${picker('members', 'Split between',
          splitMembersLabel([...sel].filter(getPerson), draft.me), openState.members,
          `${modeBar}
          <div class="share-pick-list split-scroll">${meRow}${rows}${addRow}</div>`)}

        <div class="split-fixed">
          <div class="form-row">
            <input name="amount" type="number" inputmode="decimal" step="any" min="0.01" placeholder="total amount" value="${esc(draft.amount || '')}" style="flex:1;min-width:8em" required>
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
  const people = peopleByName();
  const rows = people.map(p => {
    const total = totalOf(p);
    const settled = Math.abs(total) <= 0.005;
    return `<label class="share-pick-row">
      <input type="checkbox" data-share-member="${p.id}">
      <span class="sel-check" aria-hidden="true"></span>
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
      <p class="section-sub" style="margin-bottom:14px">Tap names to pick who to include — only picked people are shared.</p>
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

  const members = g.memberIds.map(getPerson).filter(Boolean).sort(byName);
  const rows = members.map(p => {
    const total = totalOf(p);
    const settled = Math.abs(total) <= 0.005;
    return `<label class="share-pick-row">
      <input type="checkbox" data-share-member="${p.id}" checked>
      <span class="sel-check" aria-hidden="true"></span>
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
      <p class="section-sub" style="margin-bottom:14px">Everyone starts picked — tap a name to leave them out of the shared list.</p>
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

/* The shared text = a dated title line, the "Name  amount" body, and a
   per-currency total — the context the bare lines lose the moment they leave
   the app. "All square." (or a single line) stays alone under the title, since
   a total there would just repeat it. */
function composedShareText(title, body, people) {
  const out = [`${title} · ${fmtDate(new Date().toISOString())}`, '', body];
  if (body !== 'All square.' && body.includes('\n')) {
    const per = {};
    people.forEach(p => {
      const t = totalOf(p);
      if (Math.abs(t) > 0.005) per[p.currency] = (per[p.currency] || 0) + t;
    });
    const totals = Object.entries(per);
    if (totals.length) {
      out.push('', ...totals.map(([code, t]) =>
        `total  ${shareAmount(t)}${totals.length > 1 ? ' ' + code : ''}`));
    }
  }
  return out.join('\n');
}

function updateSharePreview() {
  const node = document.getElementById('share-preview');
  if (!node) return;
  if (ui.sharePeopleOpen) {
    const chosen = shareIncludedPeople();
    node.textContent = composedShareText('Balances', peopleShareText(chosen), chosen);
    return;
  }
  const g = ui.shareGroupId ? getGroup(ui.shareGroupId) : null;
  if (!g) return;
  const excluded = new Set(shareExcludedIds());
  const included = g.memberIds.map(getPerson).filter(Boolean).filter(p => !excluded.has(p.id));
  node.textContent = composedShareText(g.name, groupShareText(g, Date.now(), [...excluded]), included);
}

/* ---------- appearance / theme ---------- */
const THEME_OPTIONS = [
  ['light', 'Light'],
  ['dark',  'Dark'],
];

function appearancePanel() {
  const current = resolvedTheme();
  const seg = ([value, label]) =>
    `<button type="button" class="seg${value === current ? ' active' : ''}" data-action="set-theme" data-theme="${value}" aria-pressed="${value === current}">${label}</button>`;
  return Panel({
    title: 'Appearance',
    body: `
      <div class="seg-control" role="group" aria-label="Theme">${THEME_OPTIONS.map(seg).join('')}</div>
      <p class="muted">Tally opens light unless you switch it here — it doesn’t follow your device’s setting.</p>`,
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
      <p class="muted">Hides paise/cents everywhere — balances, interest and existing entries all show as whole numbers. New splits divide into whole units too, with any remainder going to the first person listed — or to you, the payer, when you're in the split.</p>`,
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
   a collapsible disclosure — tapping it expands just that section.

   Which sections are open is app state, not just DOM state: changing a setting
   commits and re-renders the whole view, which would otherwise rebuild every
   <details> closed and snap the section shut under the user mid-adjustment.
   ui.settingsOpen holds the open keys; the toggle listener below keeps it in
   step with what the user opens and closes. */
function renderSettings() {
  const group = (key, icon, title, desc, body) => `
    <details class="settings-group" data-settings-group="${key}" ${ui.settingsOpen.has(key) ? 'open' : ''}>
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
      ${group('preferences', Icons.sliders(), 'Preferences', 'Theme, currency &amp; rounding', appearancePanel() + currencyPanel())}
      ${group('alerts', Icons.bell(), 'Alerts', 'Reminders for what you’re owed', notificationsPanel())}
      ${group('interest', Icons.percent(), 'Interest', 'How balances grow over time', interestRulesPanel())}
      ${group('data', Icons.database(), 'Your data', 'Back up, export or erase', dataPanel())}
    </div>
  `;
}

/* Account: sign-in and cloud sync, split out of Settings so it has its own
   menu — the user button in the masthead's top-right corner. The heavy
   lifting still lives in cloud.js; this is just the page wrapper around
   cloudSyncPanel(). */
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
    .map(id => {
      const name = interestRuleName(id);
      if (!name) return null;
      const r = interestRuleById(id);
      const ear = r ? fmtEffectiveAnnual(r.rate, r.periodUnit, r.type) : '';
      return ear ? `${esc(name)} <span class="rule-ear">${ear}</span>` : esc(name);
    }).filter(Boolean).join(', ');
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
          <td><span class="interest-tag">INTEREST</span> <span class="muted">not yet capitalized</span></td>
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
            <input name="amount" type="number" inputmode="decimal" step="any" min="0.01" required placeholder="amount">
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
      ${ruleNames ? `<p class="muted" style="margin:-8px 0 14px">Interest from rule: <em>${ruleNames}</em></p>` : ''}

      <div class="form-row">
        <button class="btn ghost" data-action="capitalize" data-id="${p.id}" ${detail.total > 0.005 ? '' : 'disabled'}>Capitalize interest</button>
        <button class="btn" data-action="settle" data-id="${p.id}" ${Math.abs(total) > 0.005 ? '' : 'disabled'}>Settle up</button>
        <button class="btn ghost head-action" data-action="share-statement" data-id="${p.id}" title="Share ${esc(p.name)}'s statement — balance and entries, as text">${Icons.share()} Statement</button>
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
  updateConnectivity();

  document.querySelectorAll('.tab-btn, .bnav-item, .nav-icon-btn').forEach(t => {
    const on = t.dataset.tab === ui.tab;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });

  const view = document.getElementById('view');
  // Select mode keeps the full ledger layout in place (so nothing jumps) and
  // instead marks the view; CSS dims + disarms the per-row controls.
  view.classList.toggle('selecting-people', ui.tab === 'ledger' && ui.personSelect);
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
  renderSplitModal();
  renderShareModal();
  renderCloudPrompt();
  renderScheduledPrompt();
  if (ui.splitOpen) updateSplitPreview();
  if (ui.shareGroupId || ui.sharePeopleOpen) updateSharePreview();

  // freeze the page behind any popup so scrolling stays inside the overlay
  const popupOpen = !!document.querySelector('.modal-overlay, .confirm-overlay');
  document.body.classList.toggle('modal-open', popupOpen);

  // a popup just opened → move focus into it (keyboard/screen-reader parity
  // with the visual overlay; Tab is kept inside by the trap below)
  if (popupOpen && !ui.popupWasOpen) {
    const dlg = topDialog();
    if (dlg) dlg.focus();
  }
  ui.popupWasOpen = popupOpen;
}

/* The dialog that owns the keyboard right now: a confirm card sits above any
   modal (z-index 200 vs 50), so it wins while both are open. */
function topDialog() {
  return document.querySelector('.confirm-card') || document.querySelector('.modal-overlay .modal');
}

/* ---------- event wiring (delegated) ---------- */

document.addEventListener('click', e => {
  if (lpFired) {           // swallow the click after a long-press
    lpFired = false;
    // picker tiles are labels: without this the press would also flip the tick
    if (e.target.closest('.share-pick-row')) e.preventDefault();
    return;
  }

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
  if (e.target.id === 'split-overlay') { goBack(); return; }
  if (e.target.id === 'share-overlay') { goBack(); return; }
  if (e.target.id === 'confirm-overlay') { goBack(); return; }
  if (e.target.id === 'member-confirm-overlay') { goBack(); return; }
  if (e.target.id === 'person-confirm-overlay') { goBack(); return; }
  if (e.target.id === 'clear-debt-overlay') { goBack(); return; }
  if (e.target.id === 'scheduled-overlay') {   // tap-away = remind me later (keep the scheduled debt)
    const id = e.target.querySelector('[data-action="snooze-scheduled"]')?.dataset.id;
    if (id) ui.scheduledSnoozed.add(id);
    render();
    return;
  }
  if (e.target.id === 'cloud-prompt-overlay') { dismissCloudPrompt(); return; }
  if (!btn) {
    /* The whole ledger tile opens the person, not just the name. Clicks on the
       tile's own controls (quick entry, Settle) keep their behaviour via the
       data-action path above; anything else on the card counts as "open". */
    const tile = e.target.closest('.ledger-table tr[data-person-id]');
    if (tile && !e.target.closest('button, input, select, label, a, .col-quick, .row-actions')) {
      ui.modalPersonId = tile.dataset.personId;
      pushNav();
      render();
    }
    return;
  }

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
      const text = composedShareText('Balances', peopleShareText(chosen), chosen);
      goBack();                   // pop the nav entry the popup pushed, clearing sharePeopleOpen
      shareText('Balances', text);
      break;
    }
    case 'share-selected-people': {   // select-mode top bar: share whoever's ticked
      const chosen = peopleByName().filter(p => ui.selectedPeople.has(p.id));
      if (!chosen.length) { showToast('Pick at least one person to share'); break; }
      shareText('Balances', composedShareText('Balances', peopleShareText(chosen), chosen));
      break;
    }
    case 'share-statement': {
      const p = getPerson(id);
      if (p) shareText(`${p.name} — Tally statement`, personStatementText(p));
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
        const excluded = new Set(shareExcludedIds());
        const included = g.memberIds.map(getPerson).filter(Boolean).filter(p => !excluded.has(p.id));
        const text = composedShareText(g.name, groupShareText(g, Date.now(), [...excluded]), included);
        goBack();                 // pop the nav entry the popup pushed, clearing shareGroupId
        shareText(g.name, text);
      }
      break;
    }

    case 'clear-search': ui.search = ''; render(); document.getElementById('search-box')?.focus(); break;

    case 'add-person-open':
      ui.addingPerson = true;
      render();
      document.getElementById('new-person-name')?.focus();
      break;
    case 'cancel-add-person':
      ui.addingPerson = false;
      ui.addPersonName = '';
      render();
      break;

    /* History calendar: collapse/expand, pick a day to filter, page months,
       jump to today, clear. */
    case 'cal-toggle':
      if (ui.calendarOpen) goBack();                             // pop the calendar entry
      else { ui.calendarOpen = true; pushNav(); render(); }       // so back collapses it
      break;
    case 'cal-pick': {
      const d = btn.dataset.date;
      ui.historyDate = ui.historyDate === d ? null : d;   // tap the picked day again to clear
      ui.historyMonth = monthKey(d);
      render();
      break;
    }
    case 'cal-prev': shiftHistoryMonth(-1); render(); break;
    case 'cal-next': shiftHistoryMonth(1); render(); break;
    case 'cal-today': {
      const t = todayKey();
      ui.historyDate = t;
      ui.historyMonth = monthKey(t);
      render();
      break;
    }
    case 'cal-clear': ui.historyDate = null; render(); break;

    /* Scheduled (future) debts. */
    case 'cancel-scheduled':       // remove an upcoming one from the schedule panel
      if (getScheduled(id)) { cancelScheduled(id); commit(); showToast('Scheduled debt removed'); }
      break;
    case 'confirm-scheduled': {     // due-day reminder: record it onto the ledger
      const s = getScheduled(id);
      if (s) {
        const before = totalOf(getPerson(s.personId));
        confirmScheduled(id);
        ui.scheduledSnoozed.delete(id);
        commit();
        maybeCelebrate(s.personId, before);
        showToast('Added to the ledger');
      }
      break;
    }
    case 'skip-scheduled':          // due-day reminder: discard without recording
      if (getScheduled(id)) { cancelScheduled(id); ui.scheduledSnoozed.delete(id); commit(); showToast('Scheduled debt discarded'); }
      break;
    case 'snooze-scheduled':        // due-day reminder: remind me again next time
      ui.scheduledSnoozed.add(id); render();
      break;

    /* Equal ⇄ custom amounts. Switching to custom seeds every ticked person
       with the equal figure, so an uneven split is edited from the even one
       rather than typed out from scratch. */
    case 'set-split-mode': {
      syncSplitDraft();
      const draft = ui.splitDraft || (ui.splitDraft = freshSplitDraft());
      const mode = btn.dataset.mode === 'custom' ? 'custom' : 'equal';
      if (mode === 'custom' && draft.mode !== 'custom') {
        // seed every empty box with the share that person holds right now,
        // so an uneven split is edited from the even one, not typed from scratch
        const amt = parseFloat(draft.amount);
        if (Number.isFinite(amt) && amt > 0) {
          const ids = peopleByName().filter(p => draft.selected.has(p.id)).map(p => p.id);
          const own = {};
          draft.own.forEach(k => {
            const v = parseFloat(k === 'me' ? draft.meAmount : draft.amounts[k]);
            if (Number.isFinite(v)) own[k] = v;
          });
          const { shares } = computeSplitShares({ personIds: ids, amount: amt, includeMe: draft.me, own });
          ids.forEach(id => { if (!draft.amounts[id] && Number.isFinite(shares[id])) draft.amounts[id] = String(shares[id]); });
          if (draft.me && !draft.meAmount && Number.isFinite(shares.me)) draft.meAmount = String(shares.me);
        }
      }
      // back to equal puts everyone on the equal division, long-presses included
      if (mode === 'equal' && draft.own) draft.own.clear();
      draft.mode = mode;
      render();
      break;
    }
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
      const field = document.getElementById('new-person-name');
      const name = (field?.value ?? ui.addPersonName).trim();
      if (!name) { field?.focus(); return; }
      if (state.people.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        alert(`${name} is already on the ledger.`);
        field?.focus();
        return;
      }
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
      // stay open, cleared, so several people can be added in a row
      ui.addPersonName = '';
      commit();
      document.getElementById('new-person-name')?.focus();
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

    case 'open-remove-members-confirm': if (ui.selectedMembers.size) { ui.confirmRemoveMembers = true; pushNav(); render(); } break;
    case 'cancel-remove-members': goBack(); break;
    case 'confirm-remove-members': performRemoveMembers(); break;
    case 'exit-member-select': goBack(); break;

    case 'open-delete-people-confirm': if (ui.selectedPeople.size) { ui.confirmDeletePeople = true; pushNav(); render(); } break;
    case 'cancel-delete-people': goBack(); break;
    case 'confirm-delete-people': performDeletePeople(); break;
    case 'exit-person-select': goBack(); break;
    case 'enter-person-select': enterPersonSelectMode(); break;
    case 'enter-history-select': enterSelectMode(); break;
    case 'enter-member-select': enterMemberSelectMode(); break;

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
      if (getPerson(id)) { ui.confirmClearDebt = id; pushNav(); render(); }
      break;
    case 'cancel-clear-debt': goBack(); break;
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
      goBack();   // pop the now-closed confirm entry so history stays in sync
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

    case 'open-delete-confirm': if (ui.selected.size) { ui.confirmDelete = true; pushNav(); render(); } break;
    case 'cancel-confirm': goBack(); break;
    case 'confirm-delete': performDelete(); break;
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
      if (typeof markCloudPromptSeen === 'function') markCloudPromptSeen();
      ui.cloudPromptOpen = false;
      openCloudSyncSettings();   // replaces the popup's history entry with the Account view
      break;
  }
});

document.addEventListener('submit', e => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);

  switch (form.dataset.form) {
    /* Search only filters — adding someone is the + button beside it, so
       Enter here can't quietly create a person you were only looking for. */
    case 'person-search':
      document.getElementById('search-box')?.blur();
      break;

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

    case 'schedule-debt': {
      const amt = parseFloat(fd.get('amount'));
      if (!Number.isFinite(amt) || amt <= 0) return;
      try {
        // noon on the chosen day, matching how dated entries are stamped, so the
        // calendar day never drifts across timezones.
        const iso = entryDate(fd.get('date')).toISOString();
        addScheduledDebt({
          personId: fd.get('personId'),
          amount: amt * Number(fd.get('sign')),
          note: fd.get('note') || '',
          date: iso,
        });
        commit();
        showToast('Debt scheduled');
      } catch (err) {
        alert(err.message);
      }
      break;
    }

    case 'add-split': {
      const ids = splitSelectedIds();
      const dateStr = fd.get('date');
      const payerId = fd.get('payerId') || 'me';
      try {
        const includeMe = splitIncludesMe();
        let n;
        if (payerId === 'me') {
          const { txns } = addSplitExpense({
            personIds: ids,
            amount: parseFloat(fd.get('amount')),
            includeMe,
            own: splitOwnMap(),
            note: fd.get('note') || '',
            date: entryDate(dateStr).toISOString(),
          });
          n = txns.length;
        } else {
          n = recordSplitPaidBy({
            payerId,
            personIds: ids,
            amount: parseFloat(fd.get('amount')),
            includeMe,
            own: splitOwnMap(),
            note: fd.get('note') || '',
            date: entryDate(dateStr).toISOString(),
          });
        }
        ui.splitOpen = false;
        ui.splitDraft = null;
        goBack();          // pop the nav entry the popup pushed, then commit re-renders
        commit();
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
  /* Only one person can have paid, so picking one is the end of that
     question — the dropdown folds back up the way a native select would. */
  if (e.target.matches('[data-split-payer]')) {
    const drop = e.target.closest('details.pick-drop');
    if (drop) drop.open = false;
  }
  if (e.target.closest('[data-form="add-split"]')) { syncSplitDraft(); updateSplitPreview(); }
  if (e.target.matches('[data-share-member]')) updateSharePreview();
});

/* Remember which disclosures are expanded. `toggle` doesn't bubble, so this
   listens in the capture phase — the document still sees it on its way down to
   the <details>.

   Settings: everything that changes a setting re-renders the view, and
   renderSettings reopens exactly what's in ui.settingsOpen, so a section never
   shuts itself while the user is still adjusting it. The split pickers are the
   same story — adding a person mid-flow re-renders the modal. */
document.addEventListener('toggle', e => {
  const d = e.target;
  if (!d.matches) return;
  if (d.matches('details.settings-group[data-settings-group]')) {
    if (d.open) ui.settingsOpen.add(d.dataset.settingsGroup);
    else ui.settingsOpen.delete(d.dataset.settingsGroup);
  } else if (d.matches('details.pick-drop[data-pick-drop]') && ui.splitDraft) {
    if (!ui.splitDraft.open) ui.splitDraft.open = {};
    ui.splitDraft.open[d.dataset.pickDrop] = d.open;
  }
}, true);

document.addEventListener('input', e => {
  // held in ui so a search keystroke's re-render doesn't wipe a half-typed name
  if (e.target.id === 'new-person-name') ui.addPersonName = e.target.value;
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

  // Enter on the ledger's new-person name adds them, with whatever amount is
  // typed beside it — same verb as the "+ lent" button the panel leads with.
  if (e.target.id === 'new-person-name') {
    e.preventDefault();
    document.querySelector('[data-action="add-person-entry"][data-sign="1"]')?.click();
    return;
  }

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

/* ---------- top-level navigation ---------- */

/* Switch top-level views. Shared by the tab bars, the two corner menus
   (Account top-right, Settings bottom-right) and the wordmark (which acts as
   "home"): returning to the Ledger floor unwinds the back stack so the next
   OS-back exits. */
function navigateTab(newTab) {
  const drilledIn = ui.openGroupId || ui.modalPersonId ||
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
  ui.splitOpen = false;
  ui.renamingGroup = false;
  ui.addingPerson = false;
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
  ui.calendarOpen = false;
  pushNav();
  render();
}

/* The two corner menus are plain destinations, not a shared drawer: Account
   in the masthead's top-right corner, Settings in the bottom-right one (the
   gear here on wide screens, the last slot of the bottom bar on the phone). */
document.querySelectorAll('.nav-icon-btn[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => navigateTab(btn.dataset.tab));
});

// Top tab bar: the everyday views (Ledger/Groups/History) switch from here.
document.getElementById('tabbar').addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  navigateTab(btn.dataset.tab);
});

// Phone bottom bar: the same views within thumb reach, with Settings in the
// last slot — the bottom-right corner the gear button holds on wide screens.
document.getElementById('bottom-nav').addEventListener('click', e => {
  const btn = e.target.closest('.bnav-item[data-tab]');
  if (btn) navigateTab(btn.dataset.tab);
});

// Tapping the wordmark returns home to the ledger.
const homeLink = document.getElementById('home-link');
homeLink.addEventListener('click', () => navigateTab('ledger'));
homeLink.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateTab('ledger'); }
});

/* Escape dismisses whatever popup is on top, exactly the way tapping its
   scrim does (so the scheduled-debt reminder snoozes and the cloud prompt
   records its dismissal rather than reappearing). */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const sched = document.getElementById('scheduled-overlay');
  if (sched) {
    const id = sched.querySelector('[data-action="snooze-scheduled"]')?.dataset.id;
    if (id) ui.scheduledSnoozed.add(id);
    render();
    return;
  }
  if (document.getElementById('cloud-prompt-overlay')) { dismissCloudPrompt(); return; }
  if (document.querySelector('.modal-overlay, .confirm-overlay')) goBack();
});

/* Keep Tab inside the open popup: the page behind it is visually inert, so the
   keyboard shouldn't wander into it either. */
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  const dlg = topDialog();
  if (!dlg) return;
  const focusables = [...dlg.querySelectorAll(
    'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
  )].filter(el => !el.disabled && !el.hidden && el.offsetParent !== null);
  if (!focusables.length) { e.preventDefault(); return; }
  const first = focusables[0], last = focusables[focusables.length - 1];
  const inside = dlg.contains(document.activeElement);
  if (!inside) { e.preventDefault(); first.focus(); return; }
  if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
});

/* ---------- long-press: delete a history entry, select people, or give
   someone in the split picker their own amount (touch + mouse) ---------- */
let lpTimer = null, lpStart = null, lpRow = null, lpFired = false;

function lpClear() {
  if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
  if (lpRow) { lpRow.classList.remove('lp-pressing'); lpRow = null; }
  lpStart = null;
}

/* Remembered so the contextmenu handler can tell a real mouse right-click from
   the synthetic contextmenu some platforms fire on a touch long-press. */
let lastPointerType = '';

document.addEventListener('pointerdown', e => {
  lastPointerType = e.pointerType || '';
  /* A new press voids any pending swallow: the swallowed click always arrives
     between the long-press's pointerup and the next pointerdown. Without this,
     a long-press whose render replaced the pressed row (so its click never
     fired) leaves lpFired stuck true — and silently eats the next tap. */
  lpFired = false;
  // Never hijack a press that starts inside a text field — let people type/select freely.
  if (e.target.closest('input, textarea, select')) return;
  // A tile in the split picker long-presses to an individual amount.
  const pickRow = e.target.closest('#split-root .share-pick-row[data-pick-id]');
  const histRow = pickRow ? null : e.target.closest('.history-table tr[data-txn-id]');
  const memRow = (pickRow || histRow) ? null : e.target.closest('.ledger-table tr[data-member-id]');
  /* Main-ledger person tiles long-press to start a selection (group rows carry
     data-member-id). The WHOLE tile is the press target — not just the name —
     so holding anywhere on the card works; presses starting in the quick-entry
     fields were already excluded by the input guard above. */
  const personRow = (pickRow || histRow || memRow) ? null : e.target.closest('.ledger-table tr[data-person-id]');
  const row = pickRow || histRow || memRow || personRow;
  if (!row) return;
  lpStart = { x: e.clientX, y: e.clientY };
  lpRow = row;
  row.classList.add('lp-pressing');
  lpTimer = setTimeout(() => {
    lpTimer = null;
    if (lpRow) lpRow.classList.remove('lp-pressing');
    lpFired = true;
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (_) {} }
    if (pickRow) setSplitIndividualAmount(pickRow);
    else if (histRow) enterSelectMode(histRow.dataset.txnId);
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

/* One long-press = ONE buzz. Android fires its own haptic when the native
   long-press action (context menu / text selection) kicks in, which stacked a
   second vibration on top of ours. Suppressing contextmenu on the rows we
   handle ourselves leaves just the single navigator.vibrate(15) above.
   Text fields keep their native menu (paste!) via the same guard as above. */
document.addEventListener('contextmenu', e => {
  if (e.target.closest('input, textarea, select')) return;
  /* With a mouse connected, right-clicking a ledger person tile starts (or
     toggles within) selection — the desktop counterpart of the touch
     long-press. The lastPointerType guard keeps the synthetic contextmenu some
     platforms fire during a touch long-press from double-toggling the row the
     long-press just selected. */
  const personRow = e.target.closest('.ledger-table tr[data-person-id]');
  if (personRow && lastPointerType === 'mouse') {
    e.preventDefault();
    lpClear();                       // cancel any pending long-press on this row
    enterPersonSelectMode(personRow.dataset.personId);
    return;
  }
  if (e.target.closest(
    '.share-pick-row[data-pick-id], .history-table tr[data-txn-id], ' +
    '.ledger-table tr[data-member-id], .ledger-table tr[data-person-id]'
  )) e.preventDefault();
});

/* interest accrues with time — refresh the numbers every minute */
setInterval(render, 60_000);

/* ---------- boot ---------- */

loadState();
applyTheme();            // stamp the saved (or OS-default) theme before first paint
ensureInterestTimezone(); // seed the ledger's interest timezone (migrates old tzHistory)
saveState();            // ensure the IDB mirror exists even before the first edit
history.replaceState(navState(), '');   // anchor root so back-navigation has a floor
render();
runNotificationCheck();
registerPeriodicSync();
if (typeof cloudInit === 'function') cloudInit();   // opt-in cloud sync (no-op unless configured + signed in)

/* First-time visitors get a one-time popup offering cloud sync; returning users
   (or deployments without sync) just see the panel waiting in Settings. */
if (typeof cloudShouldPrompt === 'function' && cloudShouldPrompt()) {
  ui.cloudPromptOpen = true;
  pushNav();   // so the OS back button/gesture dismisses the popup
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
