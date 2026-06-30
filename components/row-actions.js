/* =========================================================
   rowActions — the per-row action beside a person's name: a
   Settle button when there's a balance to settle. Reused by the
   ledger and group-detail rows. (Sharing lives in the single
   Share button above the list, not per row.) It's a quiet ghost
   button — settling zeroes a real balance, so it should read as
   deliberate, not as a benign field control.
   `esc` lives in app.js (available by render time).
   ========================================================= */

function rowActions(name, id, total) {
  if (Math.abs(total) <= 0.005) return '';
  return `<span class="row-actions"><button class="btn small ghost clear-debt" data-action="clear-debt" data-id="${id}" title="Settle ${esc(name)}'s balance to zero">Settle</button></span>`;
}
