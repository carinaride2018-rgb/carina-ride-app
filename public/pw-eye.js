// Adds a "show password" eye button to every password box (web and phone app).
'use strict';
(function () {
  const EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.9 10.9 0 0 1 12 19c-7 0-11-7-11-7a19.8 19.8 0 0 1 5.06-5.94M9.9 4.24A10.4 10.4 0 0 1 12 5c7 0 11 7 11 7a19.9 19.9 0 0 1-3.17 4.19M1 1l22 22"/></svg>';
  function wrap(input) {
    if (input.dataset.eye) return;
    input.dataset.eye = '1';
    const box = document.createElement('span');
    box.style.cssText = 'position:relative;display:block;width:100%';
    input.parentNode.insertBefore(box, input);
    box.appendChild(input);
    input.style.paddingRight = '48px';
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', 'Show password');
    b.style.cssText = 'position:absolute;right:6px;top:50%;transform:translateY(-50%);width:40px;height:40px;border:0;background:none;color:#555;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0';
    b.innerHTML = EYE;
    b.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.innerHTML = show ? EYE_OFF : EYE;
      b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      input.focus();
    });
    box.appendChild(b);
  }
  function scan() { document.querySelectorAll('input[type=password]:not([data-eye])').forEach(wrap); }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
