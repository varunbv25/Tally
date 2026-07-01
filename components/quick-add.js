/* =========================================================
   QuickAdd — the spreadsheet-style quick-entry widget
   (amount + "+ paid" / "− repaid" + reason). Reused by the
   ledger rows, the group-detail rows and the add-a-new-person
   shortcut. The inputs are keyed by `idSuffix` (qa-…/qr-…);
   the buttons' action, ids and group tag vary per surface.
     idSuffix — suffix for the amount/reason input ids
     action   — data-action for the +/- buttons
     dataId   — optional data-id on the buttons
     group    — optional data-group tag for the entry
     titles   — show the hover hints (off in group detail) */
function QuickAdd({ idSuffix, action, dataId, group, titles }) {
  const idAttr = dataId != null ? ` data-id="${dataId}"` : '';
  const groupAttr = group != null ? ` data-group="${group}"` : '';
  const plusTitle = titles ? ' title="You paid for them / they borrowed"' : '';
  const minusTitle = titles ? ' title="They paid you back"' : '';
  return `<div class="quick-add">
          <div class="quick-add-main">
            <input type="number" inputmode="decimal" step="any" min="0" placeholder="amount" id="qa-${idSuffix}">
            <button class="btn small plus" data-action="${action}"${idAttr}${groupAttr} data-sign="1"${plusTitle}>+ paid</button>
            <button class="btn small minus" data-action="${action}"${idAttr}${groupAttr} data-sign="-1"${minusTitle}>− repaid</button>
          </div>
          <input class="qa-reason" placeholder="reason" id="qr-${idSuffix}" maxlength="80">
        </div>`;
}
