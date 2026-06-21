/* =========================================================
   showToast — a transient confirmation message. Lazily
   creates the toast stack, animates the toast in, then
   removes it. Reused for "Copied to clipboard", "All square
   with …", and other one-off confirmations.
   ========================================================= */

function showToast(msg) {
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  stack.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 3500);
}
