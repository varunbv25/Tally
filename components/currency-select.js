/* =========================================================
   currencyOptions — the <option> list for a currency <select>,
   reused by the Settings base-currency picker and a person's
   profile. `CURRENCIES` lives in store.js.
   ========================================================= */

function currencyOptions(selected) {
  return CURRENCIES.map(c =>
    `<option value="${c.code}" ${c.code === selected ? 'selected' : ''}>${c.code} — ${c.name}</option>`
  ).join('');
}
