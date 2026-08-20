/* =========================================================
   SelectBar — the multi-select action toolbar
   (cancel · "N selected" · [share] · delete). Reused by
   History, group members and ledger people; only the actions
   and the delete label change. Pass shareAction to add a
   share button beside the bin (the ledger people bar does).
   The icons come from Icons.share() / Icons.trash().
   ========================================================= */

function SelectBar({ count, cancelAction, deleteAction, deleteLabel, shareAction, shareLabel = 'Share selected', cancelLabel = 'Cancel selection' }) {
  const share = shareAction ? `
      <button class="select-share" data-action="${shareAction}" ${count ? '' : 'disabled'} aria-label="${shareLabel}" title="${shareLabel}">
        ${Icons.share()}
      </button>` : '';
  return `
    <div class="select-bar">
      <button class="select-cancel" data-action="${cancelAction}" aria-label="${cancelLabel}">✕</button>
      <span class="select-count">${count} selected</span>${share}
      <button class="select-bin" data-action="${deleteAction}" ${count ? '' : 'disabled'} aria-label="${deleteLabel}">
        ${Icons.trash()}
      </button>
    </div>`;
}
