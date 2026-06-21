/* =========================================================
   rowActions — the per-row action beside a person's name: a
   Clear button when there's a balance to settle. Reused by the
   ledger and group-detail rows. (Sharing lives in the single
   Share button above the list, not per row.)
   `esc` lives in app.js (available by render time).
   ========================================================= */

function rowActions(name, id, total) {
  if (Math.abs(total) <= 0.005) return '';
  return `<span class="row-actions"><button class="btn small clear-debt" data-action="clear-debt" data-id="${id}" title="Clear ${esc(name)}'s debt — settle the balance to zero">Clear</button></span>`;
}
