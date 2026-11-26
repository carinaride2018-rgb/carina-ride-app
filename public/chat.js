/*
 * Website chat for a limo company on LimoRelay.
 * On the company's own website, add before </body>:
 *   <script src="https://<booking address>/chat.js" data-company="<company slug>" async></script>
 * The assistant answers questions and gives prices. It books rides when the company allows it.
 */
(function () {
  'use strict';
  if (window.__lrChat) return;
  window.__lrChat = true;
  var me = document.currentScript || document.getElementById('lr-chat-js');
  if (!me) return;
  var slug = me.getAttribute('data-company') || '';
  var color = me.getAttribute('data-color') || '#565252';
  var spa = me.getAttribute('data-spa') === '1';
  var base = new URL(me.src, location.href).origin;
  var KEY = 'lr-chat-' + slug;
  var mem = { session: '', msgs: [], open: false, book: '' };
  function load() { try { var j = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (j && j.session) mem = j; } catch (e) { /* storage is off: the chat still works on this page */ } }
  function keep() { try { sessionStorage.setItem(KEY, JSON.stringify({ session: mem.session, msgs: mem.msgs.slice(-40), open: mem.open, book: mem.book })); } catch (e) { /* ignore */ } }
  function rid() { var a = new Uint8Array(16); (window.crypto || window.msCrypto).getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  load();
  if (!mem.session) mem.session = rid();

  var css = '' +
    '.lrc-btn{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;align-items:center;gap:8px;padding:12px 18px;border:0;border-radius:999px;background:' + color + ';color:#fff;font:600 15px/1 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;cursor:pointer;box-shadow:0 8px 22px rgba(0,0,0,.28)}' +
    '.lrc-btn svg{width:20px;height:20px}' +
    '.lrc-btn.up{bottom:88px}' +
    '.lrc-box{position:fixed;right:18px;bottom:18px;z-index:2147483001;width:370px;max-width:calc(100vw - 24px);height:540px;max-height:calc(100vh - 36px);display:none;flex-direction:column;background:#fff;color:#000;border:1px solid #d9dce3;border-radius:18px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.3);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Arial,sans-serif}' +
    '.lrc-box.on{display:flex}' +
    '.lrc-head{display:flex;align-items:center;gap:10px;padding:12px 14px;background:' + color + ';color:#fff}' +
    '.lrc-head b{font-size:15px;display:block}.lrc-head span{font-size:12px;opacity:.9}' +
    '.lrc-head div{flex:1;min-width:0}' +
    '.lrc-x{background:none;border:0;color:#fff;font-size:24px;line-height:1;cursor:pointer;padding:4px 8px}' +
    '.lrc-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f6f6f6}' +
    '.lrc-m{max-width:86%;padding:9px 12px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere}' +
    '.lrc-m.a{align-self:flex-start;background:#fff;border:1px solid #d9dce3}' +
    '.lrc-m.u{align-self:flex-end;background:' + color + ';color:#fff}' +
    '.lrc-m a{color:inherit!important;text-decoration:underline!important}' +
    '.lrc-m.t{align-self:flex-start;color:#555;font-style:italic;background:none;padding:0 4px}' +
    '.lrc-book[hidden]{display:none!important}.lrc-book{display:block;margin:10px 14px 0;padding:10px;border-radius:999px;background:#000!important;color:#fff!important;text-align:center;text-decoration:none;font-weight:600;font-size:14px}' +
    '.lrc-form{display:flex;gap:8px;padding:12px 14px}' +
    '.lrc-form input{flex:1;min-width:0;padding:11px 12px;border:1px solid #d9dce3;border-radius:999px;font:inherit;font-size:16px;color:#000!important;background:#fff!important;box-shadow:none;height:auto}' +
    '.lrc-form button{padding:0 16px;border:0;border-radius:999px;background:' + color + ';color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer}' +
    '.lrc-form button:disabled{opacity:.5;cursor:default}' +
    '.lrc-note{padding:0 14px 10px;font-size:11px;color:#555;text-align:center}' +
    '@media(max-width:480px){.lrc-box{right:0;bottom:0;width:100vw;max-width:100vw;height:100vh;height:100dvh;max-height:none;border-radius:0;border:0}}' +
    '@media print{.lrc-btn,.lrc-box{display:none!important}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'lrc-btn'; btn.setAttribute('aria-label', 'Open chat');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z"/></svg><span>Chat with us</span>';
  var box = document.createElement('div');
  box.className = 'lrc-box'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Chat');
  box.innerHTML = '<div class="lrc-head"><div><b>Chat with us</b><span>AI assistant. Answers questions and gives prices.</span></div><button type="button" class="lrc-x" aria-label="Close chat">&times;</button></div>' +
    '<div class="lrc-msgs" aria-live="polite"></div><a class="lrc-book" target="_blank" rel="noopener" hidden>Book online</a>' +
    '<form class="lrc-form"><input type="text" maxlength="600" placeholder="Type your question" aria-label="Your message" autocomplete="off"><button type="submit">Send</button></form>' +
    '<div class="lrc-note">Answers come from an AI assistant and can be wrong. Your booking confirmation shows the final price.</div>';
  var list = box.querySelector('.lrc-msgs'), form = box.querySelector('form'), input = box.querySelector('input'), sendBtn = form.querySelector('button'), book = box.querySelector('.lrc-book');

  function bubble(who, text) {
    var d = document.createElement('div'); d.className = 'lrc-m ' + who;
    // Plain text only; web addresses become links.
    String(text).split(/(https?:\/\/[^\s]+)/g).forEach(function (part) {
      if (/^https?:\/\//.test(part)) { var tail = (part.match(/[.,;:!?)]+$/) || [''])[0], href = tail ? part.slice(0, -tail.length) : part; var a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = href; d.appendChild(a); if (tail) d.appendChild(document.createTextNode(tail)); }
      else if (part) d.appendChild(document.createTextNode(part));
    });
    list.appendChild(d); list.scrollTop = list.scrollHeight; return d;
  }
  function showBook() { if (mem.book) { book.href = mem.book; book.hidden = false; } }
  function draw() {
    list.innerHTML = '';
    bubble('a', 'Hi! I can answer questions about our rides and give you a price. Where would you like to go?');
    mem.msgs.forEach(function (m) { bubble(m.w, m.t); });
    showBook();
  }
  function open(on) {
    mem.open = on; keep();
    box.classList.toggle('on', on); btn.style.display = on ? 'none' : '';
    if (on) { draw(); try { input.focus(); } catch (e) { /* ignore */ } }
  }
  btn.onclick = function () { open(true); };
  box.querySelector('.lrc-x').onclick = function () { open(false); };
  var busy = false;
  form.onsubmit = function (ev) {
    ev.preventDefault();
    var text = input.value.replace(/\s+/g, ' ').trim();
    if (!text || busy) return;
    input.value = ''; busy = true; sendBtn.disabled = true;
    mem.msgs.push({ w: 'u', t: text }); keep(); bubble('u', text);
    var wait = bubble('t', 'Typing…');
    var done = function (reply) { if (wait.parentNode) wait.parentNode.removeChild(wait); mem.msgs.push({ w: 'a', t: reply }); keep(); bubble('a', reply); busy = false; sendBtn.disabled = false; };
    fetch(base + '/chat/turn?c=' + encodeURIComponent(slug), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: mem.session, text: text }) })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.bookUrl) { mem.book = j.bookUrl; showBook(); }
        if (j && j.off) return done('The chat is not available right now. Please use the booking page or call us.');
        done((j && (j.reply || j.error)) || 'Sorry, something went wrong. Please try again.');
      })
      .catch(function () { done('Sorry, I could not connect. Please check your internet and try again.'); });
  };

  function place() {
    // Keep clear of a floating call button on the page, if there is one.
    var fc = document.querySelector('.float-call');
    btn.classList.toggle('up', !!fc && getComputedStyle(fc).display !== 'none');
    if (spa) { var ok = /^#?$|^#(book|request|quote|signup|login|inv|track|ride)/.test(location.hash || ''); btn.style.display = ok && !mem.open ? '' : 'none'; if (!ok) box.classList.remove('on'); else if (mem.open) box.classList.add('on'); }
  }
  function mount() { document.body.appendChild(btn); document.body.appendChild(box); place(); if (mem.open) open(true); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  window.addEventListener('resize', place); window.addEventListener('hashchange', place);
})();
