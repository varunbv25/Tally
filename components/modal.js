/* =========================================================
   Modal — the full-screen popup scaffold: a dimmed overlay, a
   card, and a head with the title and a ✕ close button. Reused
   by the person, split and share popups;
   `body` is each popup's content.
     overlayId   — id on the overlay (drives click-to-close)
     overlayCls  — extra overlay class (e.g. 'share-overlay')
     modalCls    — extra modal class (e.g. 'modal-split')
     title       — heading HTML (escape names before passing)
     closeAction — data-action for the ✕ button
     body        — the modal's inner HTML */
function Modal({ overlayId, overlayCls = '', modalCls = '', title, closeAction, body }) {
  return `
  <div class="modal-overlay${overlayCls ? ' ' + overlayCls : ''}" id="${overlayId}">
    <div class="modal${modalCls ? ' ' + modalCls : ''}" role="dialog" aria-modal="true" aria-labelledby="${overlayId}-title" tabindex="-1">
      <div class="modal-head">
        <h2 id="${overlayId}-title">${title}</h2>
        <button class="modal-close" data-action="${closeAction}" aria-label="Close">✕</button>
      </div>
      ${body}
    </div>
  </div>`;
}
