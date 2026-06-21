/* =========================================================
   ConfirmOverlay — a centered confirmation card over a dimmed
   page. The overlay + close-button scaffolding is shared; each
   caller supplies its own `inner` (title, copy, action
   buttons), since the choices differ (delete people, clear a
   debt, remove members, delete history entries).
   ========================================================= */

function ConfirmOverlay({ id, closeAction, inner }) {
  return `
    <div class="confirm-overlay" id="${id}">
      <div class="confirm-card">
        <button class="modal-close confirm-close" data-action="${closeAction}" aria-label="Close">✕</button>
        ${inner}
      </div>
    </div>`;
}
