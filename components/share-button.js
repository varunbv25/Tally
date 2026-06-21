/* =========================================================
   ShareButton — the share icon + "Share" label. The wrapping
   classes, action and any extra attributes differ per surface
   (ledger header vs group detail), so they're all parameters.
   The icon comes from Icons.share().
     cls    — button classes
     action — data-action
     dataId — optional data-id
     extra  — optional extra attributes (e.g. disabled state) */
function ShareButton({ cls, action, dataId, extra = '' }) {
  const idAttr = dataId != null ? ` data-id="${dataId}"` : '';
  return `<button class="${cls}" data-action="${action}"${idAttr}${extra ? ' ' + extra : ''}>${Icons.share()} Share</button>`;
}
