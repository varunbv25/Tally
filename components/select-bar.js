/* =========================================================
   SelectBar — the multi-select action toolbar
   (cancel · "N selected" · delete). Reused by History,
   group members and ledger people; only the actions and the
   delete label change. The bin icon comes from Icons.trash().
   ========================================================= */

function SelectBar({ count, cancelAction, deleteAction, deleteLabel, cancelLabel = 'Cancel selection' }) {
  return `
    <div class="select-bar">
      <button class="select-cancel" data-action="${cancelAction}" aria-label="${cancelLabel}">✕</button>
      <span class="select-count">${count} selected</span>
      <button class="select-bin" data-action="${deleteAction}" ${count ? '' : 'disabled'} aria-label="${deleteLabel}">
        ${Icons.trash()}
      </button>
    </div>`;
}
