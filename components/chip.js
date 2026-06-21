/* =========================================================
   Chip — a small pill/tag (group names, counts, currency
   codes, the "no interest" badge). Pass already-escaped or
   trusted inner HTML; add a modifier class via the second
   argument (e.g. 'exempt').
   ========================================================= */

function Chip(inner, extraCls) {
  return `<span class="chip${extraCls ? ' ' + extraCls : ''}">${inner}</span>`;
}
