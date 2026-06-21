/* =========================================================
   Money — the signed-amount colour class and the standard
   coloured money chip reused across every view.
   `fmtMoney` / `roundingOn` live in store.js.
   ========================================================= */

/* pos / neg / zero, with a small epsilon so rounding noise reads as
   settled. Drives the green-ink / red-ink / muted colours. */
function moneyClass(n) {
  if (n > 0.005) return 'pos';
  if (n < -0.005) return 'neg';
  return 'zero';
}

/* Render an amount as a coloured money element.
   opts.cls   — force the colour/extra classes (default: moneyClass(amount))
   opts.sign  — prefix a "+" on positive amounts (interest/credit rows)
   opts.tag   — element tag, e.g. 'b' for the bold balance-strip variant */
function Money(amount, currency, opts = {}) {
  const cls = opts.cls || moneyClass(amount);
  const tag = opts.tag || 'span';
  const prefix = opts.sign && amount > 0.005 ? '+' : '';
  return `<${tag} class="money ${cls}">${prefix}${fmtMoney(amount, currency)}</${tag}>`;
}
