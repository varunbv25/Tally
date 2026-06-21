/* =========================================================
   EmptyState — a placeholder block shown when a list is empty
   or a search matches nothing. `inner` is raw HTML; pass an
   extra class for richer states (e.g. the onboarding
   empty-ledger card uses 'empty-onboard').
   ========================================================= */

function EmptyState(inner, extraCls) {
  return `<div class="empty-state${extraCls ? ' ' + extraCls : ''}">${inner}</div>`;
}
