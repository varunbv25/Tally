/* =========================================================
   PersonName — the tappable name that opens a person's
   ledger/profile modal. Reused in the ledger, group detail,
   history and elsewhere. Pass a title for the long-press
   hint shown on the main ledger.
   `esc` lives in app.js (available by render time).
   ========================================================= */

function PersonName(id, name, title) {
  const t = title ? ` title="${title}"` : '';
  return `<button class="person-name" data-action="open-person" data-id="${id}"${t}>${esc(name)}</button>`;
}
