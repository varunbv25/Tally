/* =========================================================
   Panel — the boxed content section used throughout Settings,
   group detail and the person modal. Pass `title` for the
   default <h3>, or `head` to supply a custom header (e.g. one
   with extra controls). `style` sets an inline style string.
     title — heading text for the default <h3>
     head  — custom header HTML (overrides title)
     body  — panel content HTML
     style — optional inline style string */
function Panel({ title, body, head, style }) {
  const styleAttr = style ? ` style="${style}"` : '';
  const header = head != null ? head : (title != null ? `<h3>${title}</h3>` : '');
  return `<div class="panel"${styleAttr}>${header}${body}</div>`;
}
