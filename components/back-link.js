/* =========================================================
   BackLink — the in-page back link (chevron + label) used to
   leave a drill-in (e.g. group detail → all groups). The
   chevron comes from Icons.backArrow().
   ========================================================= */

function BackLink(action, label) {
  return `<button class="back-link" data-action="${action}">
      ${Icons.backArrow()}
      ${label}
    </button>`;
}
