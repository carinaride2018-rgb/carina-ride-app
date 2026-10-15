/*
 * Livery web app: customer booking, driver app, dispatch board, owner admin.
 * Plain JavaScript, no build step. Talks to the server at /api/<method>, or,
 * when window.LIMO_DEMO is set, runs core.js in the browser with
 * localStorage so the whole thing works as a self-contained demo.
 */
(function () {
  'use strict';

  const PLATFORM = 'LimoRelay';
  // The demo build inlines the logo files; the live site loads them from icons/.
  const LOGO = window.LIMO_LOGOS || { light: 'icons/logo-light.svg', dark: 'icons/logo-dark.svg' };
  const DEMO = !!window.LIMO_DEMO;
  const C = window.LimoCore;

  // ---- Small helpers --------------------------------------------------------
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money0 = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const minsLeft = (iso) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 60000));
  const fmtYMD = (ymd) => new Date(String(ymd).slice(0, 10) + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtDate = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtDT = (iso) => `${fmtDate(iso)}, ${fmtTime(iso)}`;
  // "2026-10-19", "2026-10-21" -> "Mon, Oct 19 – Wed, Oct 21" (local calendar days)
  const fmtDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtDays = (from, to) => (to && to !== from ? `${fmtDay(from)} – ${fmtDay(to)}` : fmtDay(from));
  const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  // Chauffeur photo: the picture when there is one, otherwise their initials.
  const face = (name, photo, cls = '') => photo ? `<img class="face ${cls}" src="${esc(photo)}" alt="">` : `<span class="face ${cls}">${esc(initials(name))}</span>`;
  const carLine = (v) => v ? [v.color, v.year, v.name].filter(Boolean).join(' ') : '';
  // What a passenger sees once a chauffeur is set: face, name, car and plate.
  const chauffeurCard = (d, v, note = '') => `<div class="chauffeur">${face(d.name, d.photo)}<div class="stack" style="gap:2px"><span class="small muted">Your chauffeur${d.partner ? ` · ${esc(d.partner)}` : ''}</span><b>${esc(d.name)}</b>${v ? `<span class="small">${esc(carLine(v))}${v.plate ? ` · <span class="mono">${esc(v.plate)}</span>` : ''}</span>` : ''}${note ? `<span class="small muted">${note}</span>` : ''}</div></div>`;
  // A chosen picture, cropped square and shrunk in the browser so only a small
  // JPEG is sent and stored.
  function photoFrom(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) return reject(new Error('Choose a photo (JPEG or PNG).'));
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const n = Math.min(img.naturalWidth, img.naturalHeight), size = 240, c = document.createElement('canvas');
        c.width = c.height = size;
        c.getContext('2d').drawImage(img, (img.naturalWidth - n) / 2, (img.naturalHeight - n) / 2, n, n, 0, 0, size, size);
        URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file couldn\'t be read as a photo.')); };
      img.src = url;
    });
  }
  // Photo picker block used by the driver app and the office.
  const photoField = (name, photo, id) => `<div class="photofield">${face(name, photo, 'lg')}<div class="stack" style="gap:6px"><span class="small muted">Passengers see this photo with the car and plate once the trip is theirs.</span><div class="row"><label class="btn sm"><input type="file" id="${id}" accept="image/jpeg,image/png,image/webp" hidden>${photo ? 'Change photo' : 'Add photo'}</label>${photo ? `<button class="btn sm" type="button" id="${id}-rm">Remove</button>` : ''}</div></div></div>`;
  function wirePhoto(host, id, save) {
    const f = $('#' + id, host), rm = $('#' + id + '-rm', host);
    if (f) f.onchange = async () => { try { await save(await photoFrom(f.files[0])); toast('Photo saved.'); } catch (e) { toast(e.message, true); } };
    if (rm) rm.onclick = async () => { try { await save(''); toast('Photo removed.'); } catch (e) { toast(e.message, true); } };
  }
  const pill = (t) => `<span class="pill s-${t.status}">${esc(t.statusLabel || C.STATUS_LABELS[t.status])}</span>`;
  // Card on file: what the card has done or will do for this trip.
  const cardName = (k) => k ? `${k.brand || 'Card'} ending ${k.last4}` : '';
  const cardPill = (t) => { const p = t.pay; if (!p) return ''; if (p.failed) return '<span class="pill s-cancelled">Card declined</span>'; if (t.status === 'cancelled') return p.paid > 0 ? `<span class="pill paid">Fee ${esc(money(p.paid))} charged</span>` : ''; if (p.needsCard) return '<span class="pill unpaid">Needs a card</span>'; if (t.payment.status === 'paid') return '<span class="pill paid">Paid · card</span>'; if (p.fareCharged) return `<span class="pill unpaid">${esc(money(p.balance))} extras due</span>`; return '<span class="pill s-accepted">Card on file</span>'; };
  function cardLine(t, who) {
    const p = t.pay; if (!p) return '';
    const card = cardName(t.card), when = fmtDT(p.chargeAt), you = who === 'customer';
    if (p.failed) return `${you ? 'Your card' : card || 'The card'}${you && t.card ? ` ending ${esc(t.card.last4)}` : ''} was declined for ${money(p.failed.amount)}.${you ? ' Please add another card.' : ' The passenger was texted a link to add another card.'}`;
    if (t.status === 'cancelled') return p.paid > 0 ? `${money(p.paid)} fee charged to ${esc(card)}${p.charges.some((x) => x.kind === 'refund' && x.status === 'paid') ? ', the rest refunded' : ''}.` : p.charges.some((x) => x.kind === 'refund') ? `Refunded in full to ${esc(card)}.` : '';
    if (p.needsCard) return `${you ? 'Add a card for this ride.' : 'No card on file yet.'} Nothing is charged until ${esc(when)}.`;
    if (p.pending) return `Charging ${esc(card)} now.`;
    if (t.payment.status === 'paid') return `${money(p.paid)} charged to ${esc(card)}.`;
    if (p.fareCharged) return `${money(p.paid)} charged to ${esc(card)}. ${t.status === 'completed' ? `Extras of ${money(p.balance)} go on the card shortly.` : `${money(p.balance)} more (changes or extras) goes on the card after the ride.`}`;
    return `${esc(card)} on file. The fare is charged ${esc(when)}${p.chargeHours ? ` (${p.chargeHours} hours before pickup)` : ''}, extras like waiting time or added stops after the ride.`;
  }
  // The office's view of a card-on-file trip: state, every charge and refund, and what it can do.
  function cardBox(t) {
    const p = t.pay, open = !['completed', 'cancelled'].includes(t.status);
    const lbl = { fare: 'Fare', extra: 'Extras', fee: 'Fee', refund: 'Refund' };
    const what = p.balance < -0.004 ? `Refund ${money(-p.balance)}` : p.failed ? `Try ${money(p.balance)} again` : t.status === 'cancelled' ? `Charge ${money(p.balance)} fee` : p.fareCharged ? `Charge ${money(p.balance)} extras now` : `Charge ${money(p.balance)} now`;
    const canCharge = !p.pending && ((p.balance > 0.004 && t.card) || p.balance < -0.004);
    return `<div class="stack" style="gap:6px"><div class="spread"><span>${cardPill(t)}</span>${t.card ? `<span class="small muted">${esc(cardName(t.card))}</span>` : ''}</div>
      <p class="small ${p.failed ? 'err-text' : 'muted'}" style="margin:0">${cardLine(t, 'staff')}</p>
      ${p.charges.length ? `<ul class="paylist">${p.charges.map((x) => `<li><span>${esc(fmtDT(x.at))} · ${lbl[x.kind] || x.kind}${x.status === 'failed' ? ` · <span class="err-text">${esc(x.error || 'failed')}</span>${x.retired ? ' (replaced)' : ''}` : x.status === 'pending' ? ' · going through' : ''}</span><span class="num">${x.kind === 'refund' ? '−' : ''}${money(x.amount)}</span></li>`).join('')}</ul>` : ''}
      <div class="row">${canCharge ? `<button class="btn sm" type="button" id="te-charge">${what}</button>` : ''}${(open || p.failed) && (p.needsCard || p.failed || open) ? `<button class="btn sm" type="button" id="te-cardlink">${p.needsCard || p.failed ? 'Text card link' : 'Text link to change card'}</button>` : ''}
        ${t.payment.status !== 'paid' && t.status !== 'cancelled' ? '<button class="btn sm" type="button" data-pay="cash">Paid in cash</button>' : ''}</div></div>`;
  }
  const payPill = (t) => t.pay ? cardPill(t) : t.status === 'cancelled' ? '' : t.payment.status !== 'paid' && t.payment.method === 'account' ? '<span class="pill s-accepted">On account</span>' : t.payment.status !== 'paid' && t.payment.deposit ? `<span class="pill s-assigned">Deposit ${esc(money(t.payment.deposit))} paid</span>` : `<span class="pill ${t.payment.status}">${t.payment.status === 'paid' ? 'Paid' + (t.payment.method ? ' · ' + esc(t.payment.method) : '') : 'Unpaid'}</span>`;
  const toLocalInput = (d) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); };
  const defaultPickup = () => { const d = new Date(Date.now() + 3 * 3600e3); d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0); return toLocalInput(d); };
  const mapsLink = (addr) => 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(addr);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
  };

  // ---- Backend --------------------------------------------------------------
  let core = null;
  if (DEMO) {
    const KEY = 'livery-demo-db-v2';
    // Bump DEMO_DATA when the sample data changes (new demo logins, new seed
    // rows): visitors who saved an older copy get the fresh sample data.
    const DEMO_DATA = '42';
    if (store.get('livery-demo-data') !== DEMO_DATA) { store.set(KEY, null); store.set('livery-session', null); store.set('livery-demo-data', DEMO_DATA); }
    const mem = { db: null };
    const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    core = C.createCore({
      reloadEachCall: true,
      load() { try { const s = localStorage.getItem(KEY); if (s) return JSON.parse(s); } catch (e) { /* fall back */ } return mem.db ? JSON.parse(mem.db) : null; },
      save(db) { mem.db = db ? JSON.stringify(db) : null; store.set(KEY, mem.db); },
      async hash(pw, salt) {
        try {
          const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pw));
          return hex(new Uint8Array(buf));
        } catch (e) {
          let h = 5381; const s = salt + ':' + pw; for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
          return 'f' + (h >>> 0).toString(16);
        }
      },
      randomId(n) { const a = new Uint8Array(n || 16); crypto.getRandomValues(a); return hex(a); },
    });
  }

  let session = null;
  try { session = JSON.parse(store.get('livery-session') || 'null'); } catch (e) { session = null; }
  let seenInit = false, feedBusy = false, pushSynced = '';
  const setSession = (s) => { session = s; seenInit = false; pushSynced = ''; store.set('livery-session', s ? JSON.stringify(s) : null); };

  async function api(method, args) {
    const token = session && session.token;
    try {
      if (DEMO) return await core.call(token, method, args || {});
      const res = await fetch('/api/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(args || {}),
      });
      const body = await res.json().catch(() => ({ ok: false, error: 'The server sent an unreadable reply.' }));
      if (!body.ok) { const e = new Error(body.error || 'Something went wrong.'); e.status = res.status; throw e; }
      return body.data;
    } catch (e) {
      if (e.status === 401 && !method.startsWith('auth.')) {
        setSession(null); go('signin'); toast('Your session ended. Please sign in again.', true);
      }
      throw e;
    }
  }

  // Card payments and Stripe connection go through the server's /pay/ routes.
  async function payApi(path, args) {
    const token = session && session.token;
    const res = await fetch('/pay/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(args || {}) });
    const body = await res.json().catch(() => ({ ok: false, error: 'The server sent an unreadable reply.' }));
    if (!body.ok) throw new Error(body.error || 'Something went wrong.');
    return body.data;
  }
  // Which outside services are real on this server (texts, email, cards...).
  let liveInfo = null;
  const getLive = async () => { if (!liveInfo) { try { liveInfo = await api('public.info'); } catch (e) { liveInfo = { live: {}, payMode: 'demo' }; } } return liveInfo; };

  // ---- UI primitives --------------------------------------------------------
  let toastTimer = null;
  const HIST_LABELS = { paid: 'Charged', refunded: 'Refunded', card_failed: 'Card declined', card_saved: 'Card saved', card_link: 'Card link sent', no_show: 'No-show', pickup_moved: 'Pickup moved', flight_cancelled: 'Flight cancelled', declined: 'Declined', edited: 'Edited', unassigned: 'Unassigned', no_answer: 'No answer in time', farm_offered: 'Offered to partner', farm_accepted: 'Partner accepted', farm_declined: 'Partner declined', farm_cancelled: 'Taken back from partner', farm_returned: 'Partner handed it back', farm_expired: 'Partner offer expired', farm_completed: 'Partner completed', auto_farm_none: 'Automatic farm-out stopped' };
  function toast(text, bad, ms) {
    let el = $('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = text; el.classList.toggle('bad', !!bad); el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms || 3200);
  }

  let modalEl = null;
  function openModal({ title, body, footer, wide, onClose }) {
    closeModal();
    modalEl = document.createElement('div');
    modalEl.className = 'overlay';
    modalEl.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header><h2>${esc(title)}</h2><button class="x" type="button" aria-label="Close">×</button></header>
      <div class="body">${body}</div>${footer ? `<footer>${footer}</footer>` : ''}</div>`;
    modalEl._onClose = onClose;
    modalEl.addEventListener('mousedown', (e) => { if (e.target === modalEl) closeModal(); });
    $('.x', modalEl).onclick = closeModal;
    document.body.appendChild(modalEl);
    const first = $('input, select, textarea, button.btn', $('.body', modalEl));
    if (first) first.focus();
    return modalEl;
  }
  function closeModal() {
    if (!modalEl) return;
    const cb = modalEl._onClose; modalEl.remove(); modalEl = null;
    if (cb) cb();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  function showErr(el, e) { if (el) { el.innerHTML = `<div class="err">${esc(e.message || e)}</div>`; } else toast(e.message || String(e), true); }
  function formData(form) {
    const o = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') o[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
      else o[el.name] = el.value;
    }
    return o;
  }
  async function busy(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); } finally { if (btn) btn.disabled = false; }
  }

  // ---- Shell and routing ----------------------------------------------------
  const app = document.getElementById('app');
  // On a phone, tables show each row as a card. Copy every column heading onto
  // its cells so the card can label each value.
  const labelTables = () => {
    for (const tb of document.querySelectorAll('.tablewrap table:not([data-labeled])')) {
      const heads = [...tb.querySelectorAll('thead th')].map((th) => th.textContent.trim());
      if (!heads.length) continue;
      tb.dataset.labeled = '1';
      for (const tr of tb.querySelectorAll('tbody tr, tfoot tr')) {
        let i = 0;
        for (const td of tr.children) { if (!td.hasAttribute('colspan') && !td.hasAttribute('data-label')) td.setAttribute('data-label', heads[i] || ''); i += +(td.getAttribute('colspan') || 1); }
      }
    }
  };
  let labelQueued = false;
  new MutationObserver(() => { if (!labelQueued) { labelQueued = true; requestAnimationFrame(() => { labelQueued = false; labelTables(); }); } }).observe(document.body, { childList: true, subtree: true });
  let current = null; // { name, refresh, poll }

  const HOME = { customer: 'customer', driver: 'driver', admin: 'dispatch', dispatcher: 'dispatch', owner: 'owner' };
  const DEMO_LOGINS = [
    { key: 'customer', label: 'Customer', email: 'jane@demo.com', who: 'Jane Porter', what: 'Books rides with Carina Ride, pays and follows her trips.' },
    { key: 'driver', label: 'Driver', email: 'marcus@carina.demo', who: 'Marcus Bell', what: 'Accepts trips and moves them from pickup to drop-off on his phone.' },
    { key: 'dispatch', label: 'Dispatch', email: 'dispatch@carina.demo', who: 'Nadia Hassan, Carina Ride', what: 'Runs the board, assigns drivers and vehicles, takes phone bookings.' },
    { key: 'agent', label: 'Travel agent', email: 'sofia@travel.demo', who: 'Sofia Reyes, Emerald City Travel', what: 'Books rides for her clients, picks who pays, and tracks her commission.' },
    { key: 'partner', label: 'Partner company', email: 'dispatch@pugetsound.demo', who: 'Grace Lin, Puget Sound Executive Cars', what: 'Another company on the network. Takes trips Carina Ride sends over and sends its own.' },
    { key: 'owner', label: 'Platform owner', email: 'owner@demo.com', who: 'You', what: 'Adds limo companies to the platform and bills them monthly.' },
  ];

  function go(route) { if (location.hash.slice(1) === route) render(); else location.hash = route; }
  window.addEventListener('hashchange', render);

  function shell({ tabs, active, onTab, wide, narrow }) {
    const co = session && session.company;
    const brand = co ? co.color : null;
    document.documentElement.style.setProperty('--brand', brand || '#3d4f7c');
    setAppIdentity(co, session && session.user);
    const u = session && session.user;
    const roleName = u ? ({ customer: 'Customer', driver: 'Driver', admin: 'Company admin', dispatcher: 'Dispatcher', owner: 'Platform owner' }[u.role]) : '';
    const demoKey = u ? (u.role === 'admin' || u.role === 'dispatcher' ? 'dispatch' : u.role) : '';
    app.innerHTML = `
      <header class="topbar">
        ${co ? `<div class="wordmark"><span class="seal">${esc(initials(co.name))}</span>
          <div>${esc(co.name)}<small>on ${PLATFORM}</small></div></div>` : `<div class="wordmark brandlogo"><img class="logo-l" src="${LOGO.light}" alt="${PLATFORM}" width="160" height="34"><img class="logo-d" src="${LOGO.dark}" alt="${PLATFORM}" width="160" height="34"></div>`}
        <div class="navrow"><nav class="tabs" aria-label="Sections">${(tabs || []).map((t) => `<button type="button" data-tab="${t.key}" aria-current="${t.key === active}">${esc(t.label)}</button>`).join('')}</nav>
          ${tabs && tabs.length > 4 ? `<button type="button" class="tabmore" aria-haspopup="true" aria-expanded="false" hidden>More<span aria-hidden="true"> ▾</span></button>
          <div class="tabmenu" role="menu" hidden>${tabs.map((t) => `<button type="button" role="menuitem" data-go="${t.key}" aria-current="${t.key === active}">${esc(t.label)}</button>`).join('')}</div>` : ''}</div>
        ${u ? `<div class="who"><span class="whoname" title="${esc(roleName)}">${esc(u.name)}${u.name.toLowerCase().includes(roleName.toLowerCase()) ? '' : `<small>${esc(roleName)}</small>`}</span><button class="btn sm" type="button" id="appbtn">${pwa.standalone ? 'Notifications' : 'Get the app'}</button><button class="btn sm" type="button" id="signout">Sign out</button></div>` : ''}
      </header>
      ${DEMO ? `<div class="demobar"><span class="label">Demo</span>Switch login:
        ${DEMO_LOGINS.map((d) => `<button type="button" data-demo="${d.key}" aria-pressed="${d.key === demoKey}">${esc(d.label)}</button>`).join('')}
        <span class="sp"></span><button type="button" id="demo-reset" title="Restore the sample companies, trips and logins">Reset demo data</button></div>` : ''}
      <main id="view" class="${wide ? 'wide' : ''} ${narrow ? 'narrow' : ''}"></main>
      ${session && session.user ? `<footer class="appfoot">${footLinks()}</footer>` : ''}`;
    $$('.tabs button', app).forEach((b) => { b.onclick = () => onTab && onTab(b.dataset.tab); });
    const ab = $('#appbtn', app); if (ab) ab.onclick = appModal;
    const hdr = $('.topbar', app); if (hdr && tabs && tabs.length && tabs.length <= 4) hdr.classList.add('fewtabs');
    if (hdr && tabs && tabs.length > 6) hdr.classList.add('manytabs');
    fitTabs();
    const so = $('#signout', app);
    if (so) so.onclick = async () => { try { await api('auth.logout', { pushEndpoint: await pushEndpoint() }); } catch (e) { /* already gone */ } setSession(null); go('signin'); };
    if (DEMO) {
      $$('[data-demo]', app).forEach((b) => { b.onclick = () => demoLogin(b.dataset.demo); });
      const r = $('#demo-reset', app);
      r.onclick = () => {
        if (r.dataset.armed) { r.disabled = true; core.reset().then(() => { setSession(null); toast('Demo data restored.'); demoLogin(demoKey || 'dispatch'); }); return; }
        r.dataset.armed = '1'; r.textContent = 'Click again to reset';
        setTimeout(() => { if (r.isConnected) { delete r.dataset.armed; r.textContent = 'Reset demo data'; } }, 4000);
      };
    }
    return $('#view', app);
  }

  // A long tab list scrolls sideways; when it doesn't fit, the edges fade and a
  // More menu lists every section so nothing is hidden off-screen.
  function fitTabs() {
    const nav = $('.topbar .tabs', app), more = $('.tabmore', app), menu = $('.tabmenu', app);
    if (!nav || !more) return;
    const cur = $('button[aria-current="true"]', nav);
    if (cur) nav.scrollLeft = Math.max(0, cur.offsetLeft - nav.clientWidth / 2 + cur.offsetWidth / 2);
    const edges = () => {
      const over = nav.scrollWidth > nav.clientWidth + 2;
      more.hidden = !over;
      nav.classList.toggle('fade-r', over && nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2);
      nav.classList.toggle('fade-l', over && nav.scrollLeft > 2);
    };
    edges();
    nav.onscroll = edges;
    more.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', String(!menu.hidden)); };
    $$('[data-go]', menu).forEach((b) => { b.onclick = () => { closeTabMenu(); const t = $(`button[data-tab="${b.dataset.go}"]`, nav); if (t) t.click(); }; });
    if (!fitTabs.bound) {
      fitTabs.bound = true;
      addEventListener('resize', () => fitTabs());
      document.addEventListener('click', (e) => { const m = $('.tabmenu', app); if (m && !m.hidden && !m.contains(e.target)) closeTabMenu(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTabMenu(); });
    }
  }
  function closeTabMenu() {
    const m = $('.tabmenu', app), b = $('.tabmore', app);
    if (m) m.hidden = true; if (b) b.setAttribute('aria-expanded', 'false');
  }

  // Ride calendar: month and week views of every ride, shared by dispatch (all
  // rides, filter by driver) and the driver app (their own rides). load(from, to)
  // returns trips with pickups in [from, to); open(trip) shows one.
  function rideCalendar(host, { load, open, drivers, key }) {
    const saved = store.get(key) || '';
    const st = { view: saved === 'week' ? 'week' : 'month', at: new Date(), driver: '', cancelled: false };
    st.at.setHours(0, 0, 0, 0);
    const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const monday = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
    const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
    const shortPlace = (s) => (s || '').split(',')[0];
    let seq = 0;
    const range = () => {
      if (st.view === 'week') { const from = monday(st.at); return { from, to: addDays(from, 7) }; }
      const first = new Date(st.at.getFullYear(), st.at.getMonth(), 1);
      const from = monday(first);
      const days = new Date(st.at.getFullYear(), st.at.getMonth() + 1, 0).getDate();
      const rows = Math.ceil((((first.getDay() + 6) % 7) + days) / 7);
      return { from, to: addDays(from, rows * 7) };
    };
    const title = (r) => st.view === 'month'
      ? st.at.toLocaleDateString([], { month: 'long', year: 'numeric' })
      : `${r.from.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${addDays(r.to, -1).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
    async function draw() {
      const r = range(), my = ++seq;
      host.innerHTML = `<div class="calbar">
          <div class="row"><button class="btn sm" type="button" data-cal="prev" aria-label="Previous">‹</button><button class="btn sm" type="button" data-cal="today">Today</button><button class="btn sm" type="button" data-cal="next" aria-label="Next">›</button>
            <h2 class="caltitle">${esc(title(r))}</h2></div>
          <div class="row">
            ${drivers ? `<select class="input" style="width:auto" id="cal-driver"><option value="">All drivers</option><option value="none" ${st.driver === 'none' ? 'selected' : ''}>Unassigned</option>${drivers.map((d) => `<option value="${d.id}" ${st.driver === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>` : ''}
            <label class="check small"><input type="checkbox" id="cal-cx" ${st.cancelled ? 'checked' : ''}> <span>Show cancelled</span></label>
            <div class="seg">${[['month', 'Month'], ['week', 'Week']].map(([k, l]) => `<button type="button" data-view="${k}" aria-pressed="${st.view === k}">${l}</button>`).join('')}</div>
          </div></div>
        <div id="cal-body"><p class="faint">Loading…</p></div>`;
      $$('[data-cal]', host).forEach((b) => { b.onclick = () => {
        const k = b.dataset.cal;
        if (k === 'today') { st.at = new Date(); st.at.setHours(0, 0, 0, 0); }
        else if (st.view === 'week') st.at = addDays(st.at, k === 'next' ? 7 : -7);
        else st.at = new Date(st.at.getFullYear(), st.at.getMonth() + (k === 'next' ? 1 : -1), 1);
        draw();
      }; });
      $$('[data-view]', host).forEach((b) => { b.onclick = () => { st.view = b.dataset.view; store.set(key, st.view); draw(); }; });
      const ds = $('#cal-driver', host); if (ds) ds.onchange = (e) => { st.driver = e.target.value; draw(); };
      $('#cal-cx', host).onchange = (e) => { st.cancelled = e.target.checked; draw(); };
      let trips;
      try { trips = await load(r.from.toISOString(), r.to.toISOString()); } catch (e) { if (my === seq) showErr($('#cal-body', host), e); return; }
      if (my !== seq) return;
      trips = trips.filter((t) => (st.cancelled || t.status !== 'cancelled')
        && (!st.driver || (st.driver === 'none' ? !t.driver : t.driver && t.driver.id === st.driver)))
        .sort((x, y) => x.pickupAt.localeCompare(y.pickupAt));
      const byDay = {};
      for (const t of trips) (byDay[dayKey(new Date(t.pickupAt))] = byDay[dayKey(new Date(t.pickupAt))] || []).push(t);
      const today = dayKey(new Date());
      const live = trips.filter((t) => t.status !== 'cancelled');
      const soon = Date.now() - 3600e3, open2 = live.filter((t) => !t.driver && t.status !== 'completed' && new Date(t.pickupAt).getTime() >= soon).length;
      const sumLine = `<p class="small muted calsum">${live.length} ride${live.length === 1 ? '' : 's'} · ${money0(live.reduce((s, t) => s + (t.price ? t.price.total : 0), 0))}${drivers && open2 ? ` · <span class="warntext">${open2} without a driver</span>` : ''}</p>`;
      const chip = (t) => `<button type="button" class="calchip s-${t.status}" data-trip="${t.id}" title="${esc(`${fmtTime(t.pickupAt)} ${t.passengerName || ''}, ${shortPlace(t.pickup)}${t.dropoff ? ' to ' + shortPlace(t.dropoff) : ''}`)}"><b>${esc(fmtTime(t.pickupAt))}</b> ${esc(t.passengerName || t.ref)}</button>`;
      let html = '';
      if (st.view === 'month') {
        const heads = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="calhead">${d}</div>`).join('');
        const cells = [];
        for (let d = new Date(r.from); d < r.to; d = addDays(d, 1)) {
          const k = dayKey(d), list = byDay[k] || [], out = d.getMonth() !== st.at.getMonth();
          cells.push(`<div class="calcell${out ? ' out' : ''}${k === today ? ' today' : ''}">
            <button type="button" class="calday" data-day="${k}" aria-label="${esc(d.toDateString())}, ${list.length} rides">${d.getDate()}${list.length ? `<span class="calcount">${list.length}</span>` : ''}</button>
            <div class="calchips">${list.slice(0, 3).map(chip).join('')}${list.length > 3 ? `<button type="button" class="calmore" data-day="${k}">+${list.length - 3} more</button>` : ''}</div></div>`);
        }
        html = `<div class="calmonth">${heads}${cells.join('')}</div>`;
      } else {
        const cols = [];
        for (let d = new Date(r.from); d < r.to; d = addDays(d, 1)) {
          const k = dayKey(d), list = byDay[k] || [];
          cols.push(`<div class="calcol${k === today ? ' today' : ''}"><div class="calcolhead"><b>${esc(d.toLocaleDateString([], { weekday: 'short' }))} ${d.getDate()}</b><span class="small faint">${list.length ? `${list.length} ride${list.length === 1 ? '' : 's'}` : 'No rides'}</span></div>
            ${list.map((t) => `<button type="button" class="calcard s-${t.status}" data-trip="${t.id}"><span class="spread"><b>${esc(fmtTime(t.pickupAt))}</b><span class="small">${esc(t.statusLabel || C.STATUS_LABELS[t.status])}</span></span>
              <span class="calname">${esc(t.passengerName || t.ref)}</span>
              <span class="small">${esc(shortPlace(t.pickup))}${t.dropoff ? ` → ${esc(shortPlace(t.dropoff))}` : ` · ${t.hours} h`}</span>
              ${drivers ? `<span class="small">${t.driver ? esc(t.driver.name) : '<span class="warntext">Unassigned</span>'} · ${esc(t.vehicle ? t.vehicle.name : t.vehicleType)}</span>` : `<span class="small">${esc(t.ref)}</span>`}</button>`).join('')}</div>`);
        }
        html = `<div class="calweek">${cols.join('')}</div>`;
      }
      $('#cal-body', host).innerHTML = sumLine + html;
      const byId = Object.fromEntries(trips.map((t) => [t.id, t]));
      $$('[data-trip]', host).forEach((b) => { b.onclick = () => open(byId[b.dataset.trip], draw); });
      $$('[data-day]', host).forEach((b) => { b.onclick = () => { const [y, m, dd] = b.dataset.day.split('-').map(Number); st.at = new Date(y, m - 1, dd); st.view = 'week'; store.set(key, 'week'); draw(); }; });
    }
    draw();
    return { refresh: draw };
  }

  // Privacy policy and account links. The policy page lives on the real site.
  const privacyLink = () => (DEMO ? '<span class="faint">Privacy policy (on your live site)</span>' : '<a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a>');
  const footLinks = () => `<p class="small footlinks"><a href="#account">My account</a> · ${privacyLink()}</p>`;
  // iPhone app: Apple doesn't allow buying the software itself in the app.
  const IOS_APP = !!(window.LiveryNative && window.LiveryNative.platform === 'ios');

  // ---- My account (also the web address the app stores ask for) -------------
  function viewAccount() {
    current = null;
    const u = session.user, co = session.company;
    const v = shell({ narrow: true });
    const roleName = { customer: 'Customer', driver: 'Chauffeur', admin: 'Company admin', dispatcher: 'Dispatcher', owner: 'Platform owner' }[u.role] || u.role;
    v.innerHTML = `<div class="stack">
      <div><a class="linkbtn small" href="#${HOME[u.role]}">← Back</a><h1 style="margin-top:6px">My account</h1></div>
      <section class="panel"><dl class="kv"><dt>Name</dt><dd>${esc(u.name)}</dd><dt>Email</dt><dd>${esc(u.email)}</dd>${u.phone ? `<dt>Mobile</dt><dd>${esc(u.phone)}</dd>` : ''}<dt>Account</dt><dd>${esc(roleName)}${co ? ` · ${esc(co.name)}` : ''}</dd></dl></section>
      <section class="panel stack"><h2>Your privacy</h2><p class="small muted">What we keep and why is in the ${privacyLink()}. To change your name or number, ${u.role === 'customer' ? `call ${esc((co && co.name) || 'the company')}` : 'ask your office'}.</p></section>
      ${u.role === 'owner' ? '' : `<section class="panel stack danger-zone"><h2>Delete my account</h2>
        <p class="small muted">${u.role === 'customer' ? 'This removes your login, saved card and contact details. Past rides stay on the company\'s books for tax records, with your name removed. You can\'t undo this.' : 'This switches off your login and removes your name, contact details and photo. Past trips and pay records stay on the company\'s books without your name. You can\'t undo this.'}</p>
        <button class="btn danger" type="button" id="acct-del">Delete my account</button></section>`}
    </div>`;
    const del = $('#acct-del', v);
    if (del) del.onclick = () => {
      const m = openModal({
        title: 'Delete your account?',
        body: `<form id="del-form" class="stack" novalidate><p>${esc(u.email)} will be deleted and you will be signed out. This can't be undone.</p>
          <label class="field"><span>Enter your password to confirm</span><input id="del-pass" name="password" type="password" autocomplete="current-password"></label><div id="del-err"></div></form>`,
        footer: '<button class="btn" type="button" data-close>Keep my account</button><button class="btn danger" type="button" id="del-go">Delete my account</button>',
      });
      $('[data-close]', m).onclick = closeModal;
      $('#del-go', m).onclick = (e) => busy(e.currentTarget, async () => {
        try {
          const ep = await pushEndpoint();
          await api('auth.deleteAccount', { password: $('#del-pass', m).value });
          if (NATIVE && ep) { /* the server already dropped this phone's notifications */ }
          closeModal(); setSession(null); go('signin'); toast('Your account is deleted.');
        } catch (err) { showErr($('#del-err', m), err); }
      });
    };
  }

  async function demoLogin(key) {
    const d = DEMO_LOGINS.find((x) => x.key === key);
    try {
      const res = await api('auth.login', { email: d.email, password: 'demo1234' });
      setSession(res); go(HOME[res.user.role]);
    } catch (e) { toast(e.message, true); }
  }

  function render() {
    closeModal();
    const route = location.hash.slice(1) || '';
    if (route.startsWith('book.')) return viewBook(route.slice(5));
    if (route.startsWith('track.')) return viewTrack(route.slice(6));
    if (route.startsWith('review.')) return viewReview(route.slice(7));
    if (route.startsWith('card.')) return viewCard(route.slice(5));
    if (route.startsWith('request.')) return viewRequest(route.slice(8));
    if (route.startsWith('quote.')) return viewQuote(route.slice(6));
    if (route.startsWith('agent.')) return viewAgentSignup(route.slice(6));
    if (!session) return viewSignin();
    if (!seenInit) { watchFeed(); syncPush(); }
    if (route === 'account') return viewAccount();
    const home = HOME[session.user.role];
    if (route === 'signin' || route === '' || route !== home) {
      if (route !== home) { history.replaceState(null, '', '#' + home); }
    }
    ({ customer: viewCustomer, driver: viewDriver, dispatch: viewDispatch, owner: viewOwner })[home]();
  }

  // ---- Phone app: install, offline, notifications ---------------------------
  // Inside the App Store or Google Play app, native.js provides the phone's own
  // notifications; in a browser NATIVE is null and Web Push is used.
  const NATIVE = window.LiveryNative || null;
  const pwa = {
    deferred: null,
    standalone: !!NATIVE || (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true,
    ios: /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    canPush: !!NATIVE || 'Notification' in window,
    reg: null,
    nativePerm: 'default',
  };
  if (NATIVE) {
    NATIVE.permission().then((p) => { pwa.nativePerm = p; syncPush(); }).catch(() => {});
    NATIVE.onOpen((hash) => { if (hash) { const h = hash.replace(/^#/, ''); if (location.hash.slice(1) === h) render(); else location.hash = h; } });
    NATIVE.onShow((n) => showNote({ key: 'native-' + Date.now(), title: n.title, body: n.body, hash: n.hash }));
  } else if (!DEMO && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').then((r) => { pwa.reg = r; syncPush(); }).catch(() => { /* app still works without it */ });
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); pwa.deferred = e; });
  window.addEventListener('appinstalled', () => { pwa.deferred = null; toast('App installed. Open it from your home screen.'); });
  // The installed app is named after the limo company; drivers and staff open on their own screen.
  function setAppIdentity(co, u) {
    const link = document.getElementById('manifest');
    if (link && co && co.slug) link.href = `manifest.webmanifest?c=${encodeURIComponent(co.slug)}${u && u.role !== 'customer' ? '&r=' + (u.role === 'driver' ? 'driver' : 'staff') : ''}`;
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = (co && co.color) || '#15171c';
  }
  const noteKey = () => session && session.user ? 'livery-notify-' + session.user.id : '';
  const notesOn = () => !!noteKey() && store.get(noteKey()) === '1';
  const permission = () => (NATIVE ? pwa.nativePerm : pwa.canPush ? Notification.permission : 'unsupported');
  function appModal() {
    const p = permission();
    const install = pwa.standalone ? '<p>You are using the installed app.</p>'
      : DEMO ? '<p class="muted">This preview can\'t be installed. On your live site, people get an <b>Install</b> button here (Android and computers) or the steps below (iPhone).</p>'
      : pwa.deferred ? '<p>Put the app on your home screen. It opens full screen, like any other app.</p><button class="btn primary" type="button" id="pwa-install">Install app</button>'
      : pwa.ios ? ''
      : '<p class="muted">Open your browser menu and choose <b>Install app</b> or <b>Add to Home screen</b>.</p>';
    const iosSteps = !pwa.standalone && (pwa.ios || DEMO) ? `<ol class="steps-list"><li>Open this page in <b>Safari</b>.</li><li>Tap the <b>Share</b> button (the square with an arrow).</li><li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open the app from your home screen and turn on notifications.</li></ol>` : '';
    const what = { customer: 'when your chauffeur is confirmed, on the way and arrived, and if your pickup moves', driver: 'for new trips to accept, pickup changes and cancellations', admin: 'for new bookings, trips that need a driver, cancellations and partner offers', dispatcher: 'for new bookings, trips that need a driver, cancellations and partner offers' }[session.user.role] || 'about your trips';
    const m = openModal({
      title: pwa.standalone ? 'Notifications' : 'Get the app',
      body: `<div class="stack">
        ${pwa.standalone ? '' : `<div class="stack"><h3 style="margin:0">Install on your phone</h3>${install}${iosSteps}</div>`}
        <div class="stack"><h3 style="margin:0">Notifications</h3><p class="small muted">Get a notification ${what}.</p>
          <label class="switch"><input type="checkbox" id="pwa-notes" ${notesOn() ? 'checked' : ''}><span>Notify me on this device</span></label>
          <p class="small faint" id="pwa-note-state">${p === 'unsupported' || DEMO ? 'Here, alerts show inside the app while it is open. The installed app shows them as phone notifications.' : p === 'denied' ? 'Notifications are blocked for this site. Allow them in your browser or phone settings, then try again.' : pwa.ios && !pwa.standalone ? 'On iPhone, notifications work after you add the app to your home screen.' : ''}</p>
          <button class="btn sm" type="button" id="pwa-test">Send a test notification</button></div>
      </div>`,
      footer: `<a class="btn" href="#account" data-acct>My account</a><button class="btn" type="button" data-close>Done</button>`,
    });
    $('[data-close]', m).onclick = closeModal;
    $('[data-acct]', m).onclick = () => closeModal();
    const ib = $('#pwa-install', m);
    if (ib) ib.onclick = async () => { const d = pwa.deferred; if (!d) return; d.prompt(); const r = await d.userChoice.catch(() => null); pwa.deferred = null; if (r && r.outcome === 'accepted') closeModal(); };
    $('#pwa-notes', m).onchange = async (e) => {
      if (e.target.checked) {
        if (NATIVE && pwa.nativePerm !== 'granted') { try { pwa.nativePerm = await NATIVE.askPermission(); } catch (err) { /* not allowed */ } }
        else if (pwa.canPush && !DEMO && !NATIVE && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (err) { /* older browsers */ } }
        store.set(noteKey(), '1'); seenInit = false; watchFeed();
        const closed = await syncPush();
        toast(permission() !== 'granted' ? 'Alerts on. You will see them in the app while it is open.' : closed ? 'Notifications on, even when the app is closed.' : 'Notifications on.');
      } else { store.set(noteKey(), '0'); syncPush(); toast('Notifications off.'); }
    };
    $('#pwa-test', m).onclick = () => showNote({ key: 'test-' + Date.now(), title: session.company ? session.company.name : PLATFORM, body: 'Notifications are working on this device.', hash: '' }, true);
  }
  function showNote(n, force) {
    // In the store apps the phone shows notifications itself; on screen we use the banner.
    const sys = !DEMO && !NATIVE && permission() === 'granted' && (document.visibilityState === 'hidden' || force);
    if (sys) {
      const opts = { body: n.body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: n.key, data: { hash: n.hash } };
      if (pwa.reg && pwa.reg.showNotification) { pwa.reg.showNotification(n.title, opts); return; }
      try { const x = new Notification(n.title, opts); x.onclick = () => { window.focus(); if (n.hash) location.hash = n.hash.slice(1); x.close(); }; return; } catch (e) { /* fall through to the banner */ }
    }
    let el = $('.notebanner');
    if (!el) { el = document.createElement('button'); el.type = 'button'; el.className = 'notebanner'; document.body.appendChild(el); }
    el.innerHTML = `<b>${esc(n.title)}</b><span>${esc(n.body)}</span>`;
    el.hidden = false; el.onclick = () => { el.hidden = true; if (n.hash) { const h = n.hash.slice(1); if (location.hash.slice(1) === h) render(); else location.hash = h; } };
    clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 8000);
  }
  // Checks for news every 15 seconds (browsers slow this down when the app is in the background).
  // The first check after sign-in only records what's already there, so old events don't pop up.
  async function watchFeed() {
    if (!notesOn() || feedBusy || !session) return;
    feedBusy = true;
    try {
      const items = await api('notify.feed');
      const k = 'livery-seen-' + session.user.id;
      let seen = []; try { seen = JSON.parse(store.get(k) || '[]'); } catch (e) { seen = []; }
      const fresh = items.filter((n) => !seen.includes(n.key));
      if (seenInit) fresh.slice(0, 3).reverse().forEach((n) => showNote(n));
      seenInit = true;
      store.set(k, JSON.stringify([...fresh.map((n) => n.key), ...seen].slice(0, 300)));
    } catch (e) { /* signed out or offline; try again next time */ }
    feedBusy = false;
  }
  setInterval(watchFeed, 15000);
  // Web Push: lets the server reach this phone while the app is closed.
  // Returns true when this device is subscribed.
  const keyBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  const sameKey = (buf, bytes) => { const a = buf ? new Uint8Array(buf) : null; return !!a && a.length === bytes.length && a.every((x, i) => x === bytes[i]); };
  async function syncPush() {
    if (NATIVE) {
      if (!session || permission() !== 'granted') return false;
      try {
        const ep = await NATIVE.pushEndpoint();
        if (!ep) return false;
        if (!notesOn()) { await api('push.unsubscribe', { endpoint: ep }).catch(() => {}); pushSynced = ''; return false; }
        const mark = session.user.id + ' ' + ep;
        if (pushSynced !== mark) { await api('push.subscribe', { native: ep }); pushSynced = mark; }
        return true;
      } catch (e) { return false; }
    }
    if (DEMO || !session || !pwa.reg || !pwa.reg.pushManager || permission() !== 'granted') return false;
    try {
      const info = await getLive();
      if (!info.pushKey) return false;
      let sub = await pwa.reg.pushManager.getSubscription();
      if (!notesOn()) {
        if (sub) { await api('push.unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
        pushSynced = '';
        return false;
      }
      const key = keyBytes(info.pushKey);
      // A subscription made for an older server key can't be used any more.
      if (sub && sub.options && sub.options.applicationServerKey && !sameKey(sub.options.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
      if (!sub) sub = await pwa.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const mark = session.user.id + ' ' + sub.endpoint;
      if (pushSynced !== mark) { await api('push.subscribe', { subscription: sub.toJSON() }); pushSynced = mark; }
      return true;
    } catch (e) { return false; /* browser said no, or offline; the in-app alerts still work */ }
  }
  async function pushEndpoint() {
    if (NATIVE) { try { return await NATIVE.pushEndpoint(); } catch (e) { return ''; } }
    try { const sub = pwa.reg && pwa.reg.pushManager && await pwa.reg.pushManager.getSubscription(); return sub ? sub.endpoint : ''; } catch (e) { return ''; }
  }

  // Live refresh: views re-fetch every few seconds unless the person is typing.
  setInterval(() => {
    if (!current || !current.poll || modalEl || document.hidden) return;
    const a = document.activeElement;
    if (a && /INPUT|SELECT|TEXTAREA/.test(a.tagName) && $('#view') && $('#view').contains(a)) return;
    current.refresh(true);
  }, 5000);

  // ---- Live tracking map ------------------------------------------------------
  // Draws the route from where the driver set off to the pickup, with the car's
  // current spot. A schematic until Google Maps is connected; same data then.
  function trackMap(live, label) {
    if (!live) return '';
    const W = 600, H = 220, pad = 44;
    const gps = live.source === 'gps';
    const pts = [live.to, live.pos].concat(gps ? [] : [live.from, live.ctrl]);
    const k = Math.cos(live.to.lat * Math.PI / 180);
    const xs = pts.map((p) => p.lng * k), ys = pts.map((p) => p.lat);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const span = Math.max((maxX - minX) / (W - 2 * pad), (maxY - minY) / (H - 2 * pad), 1e-6);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const P = (p) => [W / 2 + (p.lng * k - cx) / span, H / 2 - (p.lat - cy) / span].map((n) => Math.round(n * 10) / 10);
    const [tx, ty] = P(live.to), [px, py] = P(live.pos);
    let route = '';
    if (gps || live.arrived) route = `<line x1="${px}" y1="${py}" x2="${tx}" y2="${ty}" class="tm-route" />`;
    else { const [fx, fy] = P(live.from), [qx, qy] = P(live.ctrl); route = `<path d="M${fx} ${fy} Q${qx} ${qy} ${tx} ${ty}" class="tm-route" /><circle cx="${fx}" cy="${fy}" r="4" class="tm-start" />`; }
    const ago = Math.max(0, Math.round((Date.now() - new Date(live.updatedAt).getTime()) / 1000));
    return `<div class="trackmap" role="img" aria-label="${esc(live.arrived ? 'Chauffeur has arrived at the pickup' : `Chauffeur about ${live.etaMin} minutes away`)}">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        ${route}
        <g transform="translate(${tx} ${ty})"><path d="M0 0C-7-9-10-13-10-18a10 10 0 0 1 20 0c0 5-3 9-10 18z" class="tm-pin" /><circle cy="-18" r="3.5" class="tm-pinhole" /></g>
        ${live.arrived ? '' : `<g transform="translate(${px} ${py})"><circle r="16" class="tm-pulse" /><circle r="8" class="tm-car" /></g>`}
      </svg>
      <div class="tm-info"><b>${live.arrived ? 'Arrived at the pickup' : `About ${live.etaMin} min away`}</b><span class="small muted">${live.arrived ? esc(label || '') : `${live.milesLeft} mi to ${esc(label || 'pickup')}`}</span>
        <span class="small faint">${gps ? `Live GPS · updated ${ago < 60 ? ago + ' s' : Math.round(ago / 60) + ' min'} ago` : 'Estimated position'}</span></div>
    </div>`;
  }

  // ---- Passenger tracking page (#track.<token>) ------------------------------
  async function viewTrack(token) {
    const load = async () => {
      let d;
      try { d = await api('public.track', { token }); } catch (e) { const v = shell({}); v.innerHTML = `<div class="panel stack"><h2>Tracking unavailable</h2><p class="muted">${esc(e.message)}</p></div>`; current = null; return; }
      const keep = session; session = { company: d.company, user: null };
      const v = $('#view') && $('#view').dataset.track === token ? $('#view') : shell({ narrow: true });
      session = keep; v.dataset.track = token;
      const done = ['on_board', 'completed', 'cancelled'].includes(d.status);
      v.innerHTML = `<div class="stack">
        <div class="spread"><div><h1 style="font-size:24px">${d.live && !d.live.arrived ? 'Your car is on the way' : d.status === 'arrived' ? 'Your car is here' : esc(d.statusLabel)}</h1><p class="muted small">${esc(d.company.name)} · ${esc(d.ref)}</p></div>${pill(d)}</div>
        ${d.live ? trackMap(d.live, d.pickup) : `<div class="panel muted">${done ? (d.status === 'cancelled' ? 'This trip was cancelled.' : 'Your chauffeur has picked you up. Enjoy the ride.') : 'Tracking starts when your chauffeur sets off.'}</div>`}
        ${d.driver ? `<div class="panel">${chauffeurCard(d.driver, d.vehicle)}</div>` : ''}
        <div class="panel"><dl class="kv">${!d.driver && d.vehicle ? `<dt>Vehicle</dt><dd>${esc(carLine(d.vehicle))}</dd>${d.vehicle.plate ? `<dt>Plate</dt><dd class="mono">${esc(d.vehicle.plate)}</dd>` : ''}` : ''}
          <dt>Pickup</dt><dd>${esc(d.pickup)}</dd><dt>Time</dt><dd>${esc(fmtDT(d.pickupAt))}</dd></dl></div>
        ${d.company.phone ? `<a class="btn" href="tel:${esc(d.company.phone.replace(/[^\d+]/g, ''))}">Call ${esc(d.company.name)}</a>` : ''}
      </div>`;
    };
    current = { poll: true, refresh: load };
    await load();
  }

  // ---- Passenger review page (#review.<token>) ------------------------------
  async function viewReview(token) {
    current = null;
    let d;
    try { d = await api('public.review', { token }); } catch (e) { const v = shell({}); v.innerHTML = `<div class="panel stack"><h2>Review link not found</h2><p class="muted">${esc(e.message)}</p></div>`; return; }
    const keep = session; session = { company: d.company, user: null };
    const v = shell({ narrow: true });
    session = keep;
    const thanks = (n) => `<div class="panel stack" style="text-align:center"><span class="stars" style="font-size:32px">${stars(n)}</span><h2>Thank you${d.passengerName ? ', ' + esc(d.passengerName) : ''}!</h2><p class="muted">Your feedback goes straight to the ${esc(d.company.name)} team.</p></div>`;
    v.innerHTML = `<div class="stack">
      <div><h1 style="font-size:24px">How was your ride?</h1><p class="muted small">${esc(d.company.name)} · ${esc(d.ref)} · ${esc(fmtDT(d.pickupAt))}</p></div>
      <div class="panel small"><dl class="kv"><dt>From</dt><dd>${esc(d.pickup)}</dd>${d.dropoff ? `<dt>To</dt><dd>${esc(d.dropoff)}</dd>` : ''}${d.driver ? `<dt>Chauffeur</dt><dd>${esc(d.driver.name)}</dd>` : ''}</dl></div>
      <div id="rv">${d.rating ? thanks(d.rating.stars) : `<form class="panel stack" id="rv-form" novalidate>
        <span class="label">Tap the stars</span>
        <div class="stars rate big" id="rv-stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div>
        <label class="field"><span>Anything to tell us? (optional)</span><textarea name="comment" maxlength="400" placeholder="${d.driver ? `What did ${esc(d.driver.name)} do well?` : 'Your comments'}"></textarea></label>
        <div id="rv-err"></div>
        <button class="btn primary big" type="submit">Send review</button></form>`}</div>
    </div>`;
    const f = $('#rv-form', v);
    if (!f) return;
    let picked = 0;
    const paint = () => $$('#rv-stars button', v).forEach((b) => b.classList.toggle('on', +b.dataset.n <= picked));
    $$('#rv-stars button', v).forEach((b) => { b.onclick = () => { picked = +b.dataset.n; paint(); }; });
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!picked) return showErr($('#rv-err', v), new Error('Tap 1 to 5 stars first.'));
      await busy($('button[type=submit]', f), async () => {
        try { await api('public.rate', { token, stars: picked, comment: f.comment.value }); $('#rv', v).innerHTML = thanks(picked); } catch (err) { showErr($('#rv-err', v), err); }
      });
    };
  }

  // ---- Card link (#card.<token>) ---------------------------------------------
  // The passenger adds or replaces the card for one ride, no login needed.
  async function viewCard(token) {
    current = null;
    let d;
    try { d = await api('public.cardInfo', { token }); } catch (e) { const v = shell({}); v.innerHTML = `<div class="panel stack"><h2>Card link not found</h2><p class="muted">${esc(e.message)}</p></div>`; return; }
    const keep = session; session = { company: d.company, user: null };
    const v = shell({ narrow: true });
    session = keep;
    document.documentElement.style.setProperty('--brand', d.company.color);
    const draw = (msg) => {
      const stripe = d.company.payMode === 'stripe';
      const state = d.failed ? `<div class="note warn">Your card ending ${esc(d.card ? d.card.last4 : '')} was declined for ${money(d.failed.amount)}. Add another card and we'll try again straight away.</div>`
        : d.closed ? `<div class="note">This ride is closed${d.paid > 0 ? `. ${money(d.paid)} was charged to ${esc(cardName(d.card))}` : ''}.</div>`
        : d.card ? `<div class="note ok">${esc(cardName(d.card))} is on file for this ride. ${d.fareCharged ? `${money(d.paid)} has been charged.` : `The fare is charged ${esc(fmtDT(d.chargeAt))}.`}</div>` : '';
      v.innerHTML = `<div class="stack">
        <div><h1 style="font-size:24px">${d.card && !d.failed ? 'Your card for this ride' : 'Add a card for your ride'}</h1><p class="muted small">${esc(d.company.name)} · ${esc(d.ref)} · ${esc(fmtDT(d.pickupAt))}</p></div>
        ${msg ? `<div class="note ok">${esc(msg)}</div>` : ''}
        <div class="panel small"><dl class="kv"><dt>Passenger</dt><dd>${esc(d.passengerName || '')}</dd><dt>From</dt><dd>${esc(d.pickup)}</dd>${d.dropoff ? `<dt>To</dt><dd>${esc(d.dropoff)}</dd>` : ''}<dt>Ride</dt><dd>${esc(d.service)}, ${esc(d.vehicleType)}</dd><dt>Fare</dt><dd class="num">${money(d.total)}</dd></dl></div>
        ${state}
        ${d.closed ? '' : `<form class="panel stack" id="cd-form" novalidate>
          <p class="small muted">${d.fareCharged ? 'The fare is already paid.' : new Date(d.chargeAt).getTime() <= Date.now() ? `Pickup is less than ${d.chargeHours} hours away, so the ${money(d.balance > 0 ? d.balance : d.total)} fare is charged as soon as you save the card.` : `Nothing is charged now. The fare goes on this card ${d.chargeHours} hours before pickup (${esc(fmtDT(d.chargeAt))}).`} Extras like waiting time, an added stop or a new destination go on the same card after the ride.</p>
          ${stripe ? '<p class="small muted">You\'ll enter your card on a secure Stripe page, then come straight back here.</p>' : `
          <label class="field"><span>Card number</span><input name="number" class="mono" inputmode="numeric" autocomplete="cc-number" value="4242 4242 4242 4242"></label>
          <label class="field"><span>Expiry (MM/YY)</span><input name="exp" class="mono" autocomplete="cc-exp" value="12/30"></label>
          ${d.company.payMode === 'demo' ? '<p class="small faint">Demo: no real card is charged; a card ending 0341 shows a decline.</p>' : ''}`}
          <div id="cd-err"></div>
          <button class="btn brand big" type="submit">${d.card ? 'Save new card' : 'Save card'}</button></form>`}
      </div>`;
      const f = $('#cd-form', v);
      if (!f) return;
      f.onsubmit = async (e) => {
        e.preventDefault();
        await busy($('button[type=submit]', f), async () => {
          try {
            if (stripe) { const r = await payApi('checkout', { kind: 'card', token }); location.href = r.url; await new Promise(() => {}); }
            d = await api('public.saveCard', { token, card: formData(f) });
            draw(d.failed ? '' : `Card saved.${d.fareCharged ? ` ${money(d.paid)} charged.` : ''}`);
          } catch (err) { showErr($('#cd-err', v), err); }
        });
      };
    };
    draw('');
  }

  // ---- Sign-in --------------------------------------------------------------
  // Home page: what a limo company sees before signing in. Sign-in sits in
  // the hero so drivers and staff are one tap from their screens.
  const LP_FEATURES = [
    ['Online booking page', 'Your own branded page for transfers and hourly rides, with instant quotes, flight numbers, extra stops, child seats and meet & greet.'],
    ['Live dispatch board', 'Every ride for the day by chauffeur, with drag-and-drop assigning, alerts for anything unassigned and a live map of your cars.'],
    ['Driver app', 'Chauffeurs accept trips, see the passenger and flight, move each ride from on the way to drop-off and share GPS with dispatch.'],
    ['Passenger updates', 'Automatic confirmation, 24-hour reminder, "your chauffeur is on the way" with live tracking, and a review request after the ride.'],
    ['Card on file payments', 'The card is saved at booking and charged 24 hours before pickup. Waiting time and extra stops are charged after the ride. No cash.'],
    ['Flight tracking', 'Airport pickups follow the flight. Delays move the pickup time and the chauffeur is told.'],
    ['Farm-out network', 'Send rides you can’t cover to trusted partner companies and take theirs, with balances settled in one place.'],
    ['Corporate accounts and travel agents', 'Company accounts with monthly invoices, PO numbers and bookers, plus a travel agent login with commission tracking.'],
    ['Reports and team access', 'Sales, drivers, vehicles and customers at a glance, QuickBooks export, and access levels for every dispatcher.'],
  ];
  const LP_FAQ = [
    ['Is there a setup fee?', `Founding members pay no setup fee. On Standard and Fleet it is $${C.PLANS.standard.setup}, and it is waived when you pay yearly.`],
    ['What happens after the free trial?', 'You choose a plan and add a card. Nothing is charged during the 30 days, and you keep all your rides, drivers and customers.'],
    ['Do my drivers and passengers need to download anything?', 'No. Everything works in the phone’s browser and can be added to the home screen like an app.'],
    ['What if I run out of texts?', 'Each plan includes a monthly text allowance. Extra texts are $15 for 500, and emails are always free.'],
    ['Can I bring my existing rides?', 'Yes. Upcoming rides can be imported from a spreadsheet, so you can switch without losing bookings.'],
  ];
  async function viewSignin() {
    current = null;
    const v = shell({});
    let companies = [], sample = true;
    try { [companies, { sample }] = await Promise.all([api('public.companies'), api('public.info')]); } catch (e) { /* listing optional */ }
    const P = C.PLANS, yearly = (k) => P[k].monthly * 10;
    const plan = (k, blurb, items, featured) => `<div class="lp-plan${featured ? ' featured' : ''}">
        ${featured ? '<span class="lp-flag">Best for new companies</span>' : ''}
        <h3>${esc(P[k].label)}</h3><p class="small muted">${blurb}</p>
        <div class="lp-price"><b>$${P[k].monthly}</b><span>/month</span></div>
        <p class="small faint">or $${yearly(k).toLocaleString()} a year (2 months free)</p>
        <ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>
        <button class="btn ${featured ? 'brand' : ''}" type="button" data-scroll="lp-trial">Start free trial</button></div>`;
    v.innerHTML = `<div class="lp">
      <section class="signin lp-hero">
        <div class="stack" style="gap:18px">
          <span class="label">Limo booking &amp; dispatch software</span>
          <h1>Run your limo company from one screen.</h1>
          <p class="lede">${PLATFORM} gives chauffeured transportation companies an online booking page, a live dispatch board, a driver app and automatic passenger updates. Every ride is booked, assigned, tracked and paid in one place.</p>
          <div class="row"><button class="btn brand lp-cta" type="button" data-scroll="lp-trial">Start your 30-day free trial</button><button class="btn lp-cta" type="button" data-scroll="lp-pricing">See pricing</button></div>
          <ul class="lp-ticks small"><li>No card needed for the trial</li><li>Dispatch, driver and passenger apps included</li><li>Your brand on every page and message</li></ul>
        </div>
        <form class="panel stack" id="signin-form" novalidate>
          <h2>Sign in</h2>
          <label class="field"><span>Email</span><input id="si-email" name="email" type="email" autocomplete="username" required></label>
          <label class="field"><span>Password</span><input id="si-password" name="password" type="password" autocomplete="current-password" required></label>
          <div id="si-err"></div>
          <button class="btn primary big" type="submit">Sign in</button>
          <p class="small faint">One sign-in for company owners, dispatchers, chauffeurs and customers. Each person lands on their own screen.</p>
        </form>
      </section>
      ${sample ? `<section class="stack lp-sec">
        <span class="label">Try it with sample logins${DEMO ? '' : ' <span class="pwhint">· password demo1234</span>'}</span>
        <div class="roles">${DEMO_LOGINS.map((d) => `<button type="button" class="role" data-demo="${d.key}"><b>${esc(d.label)}</b><span>${esc(d.who)}. ${esc(d.what)}</span><span class="mono">${esc(d.email)}</span></button>`).join('')}</div>
      </section>` : ''}
      ${companies.length && sample ? `<section class="stack lp-sec"><span class="label">Public booking pages</span><div class="row">${companies.map((c) => `<a class="btn" href="#book.${esc(c.slug)}"><span class="seal" style="width:10px;height:10px;border-radius:50%;background:${esc(c.color)}"></span>${esc(c.name)}</a>`).join('')}</div></section>` : ''}
      <section class="lp-sec" id="lp-features">
        <div class="lp-head"><h2>Everything a chauffeur business needs</h2><p class="muted">Made for airport transfers, hourly charters, weddings, corporate travel and group events.</p></div>
        <div class="lp-grid">${LP_FEATURES.map(([t, d]) => `<div class="lp-card"><h3>${esc(t)}</h3><p class="small muted">${esc(d)}</p></div>`).join('')}</div>
      </section>
      <section class="lp-sec">
        <div class="lp-head"><h2>Up and running in a day</h2></div>
        <ol class="lp-steps">
          <li><b>Set up your company</b><span class="small muted">Add your rates, vehicles, logo and colors. We help you import upcoming rides.</span></li>
          <li><b>Add your chauffeurs</b><span class="small muted">Each driver gets their own login and signs in to the driver app on their phone.</span></li>
          <li><b>Share your booking link</b><span class="small muted">Put it on your website, Google profile and emails. Bookings land on your dispatch board.</span></li>
        </ol>
      </section>
      <section class="lp-sec" id="lp-pricing">
        <div class="lp-head"><h2>Simple pricing</h2><p class="muted">Every plan includes the dispatch board, the driver app and the passenger app. Try any plan free for 30 days.</p></div>
        <div class="lp-plans">
          ${plan('founding', `For the first ${P.founding.limit} companies. Price locked for 2 years.`, ['All features', `${P.founding.texts.toLocaleString()} passenger texts a month`, 'No setup fee', 'Unlimited bookings'], true)}
          ${plan('standard', 'For growing companies.', ['All features', `${P.standard.texts.toLocaleString()} passenger texts a month`, `$${P.standard.setup} setup, waived on yearly billing`, 'Unlimited bookings'])}
          ${plan('fleet', 'For larger fleets and busy offices.', ['All features', `${P.fleet.texts.toLocaleString()} passenger texts a month`, `$${P.fleet.setup} setup, waived on yearly billing`, 'Unlimited bookings'])}
        </div>
        <p class="small faint" style="margin-top:12px">Extra texts are $15 for 500. Card processing is billed by Stripe directly to your company; ${PLATFORM} takes no share of your fares.</p>
      </section>
      <section class="lp-sec lp-trial" id="lp-trial">
        <div class="stack" style="gap:8px"><h2>Start your 30-day free trial</h2><p class="muted">Tell us about your company and we’ll set up your account, usually the same day. No card needed.</p></div>
        <form id="tr-form" class="stack" novalidate>
          <div class="grid2"><label class="field"><span>Your name</span><input id="tr-name" name="name" autocomplete="name"></label><label class="field"><span>Company name</span><input id="tr-company" name="company" autocomplete="organization"></label></div>
          <div class="grid2"><label class="field"><span>Email</span><input id="tr-email" name="email" type="email" autocomplete="email"></label><label class="field"><span>Phone</span><input id="tr-phone" name="phone" type="tel" autocomplete="tel"></label></div>
          <div class="grid2"><label class="field"><span>City</span><input id="tr-city" name="city"></label><label class="field"><span>Vehicles in your fleet</span><select id="tr-fleet" name="fleet"><option value="">Choose</option><option>1-3</option><option>4-10</option><option>11-25</option><option>26+</option></select></label></div>
          <label class="field"><span>Anything we should know? (optional)</span><textarea id="tr-note" name="note" placeholder="The software you use today, when you want to start"></textarea></label>
          <div id="tr-err"></div>
          <div><button class="btn brand" type="submit" id="tr-go">Request my free trial</button></div>
        </form>
      </section>
      <section class="lp-sec">
        <div class="lp-head"><h2>Questions</h2></div>
        <div class="lp-faq">${LP_FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p class="small muted">${esc(a)}</p></details>`).join('')}</div>
      </section>
      <footer class="lp-foot small"><span>© ${new Date().getFullYear()} ${PLATFORM}. Limo booking and dispatch software.</span><span>${privacyLink()} · <button class="linkbtn" type="button" data-scroll="signin-form">Sign in</button></span></footer>
    </div>`;
    $$('[data-demo]', v).forEach((b) => { b.onclick = () => demoLogin(b.dataset.demo); });
    $$('[data-scroll]', v).forEach((b) => { b.onclick = () => { const t = document.getElementById(b.dataset.scroll); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); const f = t.querySelector('input'); if (f) setTimeout(() => f.focus({ preventScroll: true }), 400); } }; });
    $('#signin-form', v).onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      await busy($('button[type=submit]', e.target), async () => {
        try { const res = await api('auth.login', f); setSession(res); go(HOME[res.user.role]); }
        catch (err) { showErr($('#si-err', v), err); }
      });
    };
    $('#tr-form', v).onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      await busy($('#tr-go', v), async () => {
        try {
          await api('public.requestTrial', f);
          $('#tr-form', v).outerHTML = `<div class="note ok" id="tr-done"><b>Thank you, ${esc(f.name.split(' ')[0])}.</b> We’ve got your request for ${esc(f.company)} and will be in touch at ${esc(f.email)} to set up your free trial.</div>`;
        } catch (err) { showErr($('#tr-err', v), err); }
      });
    };
  }

  // ---- Booking form (shared by customer, public page and dispatch) ----------
  const FLIGHT_TONE = { cancelled: 's-cancelled', landed: 's-completed', departed: 's-completed', in_air: 's-en_route', scheduled: 's-accepted' };
  function flightPill(f) {
    if (!f) return '';
    const tone = f.status === 'scheduled' && f.delayMin ? 's-assigned' : FLIGHT_TONE[f.status];
    return `<span class="pill ${tone}">${esc(f.label)}${f.delayMin && f.status !== 'cancelled' ? ` +${f.delayMin} min` : ''}</span>`;
  }
  function flightBox(f, opts) {
    if (!f) return '';
    if (f.error) return `<div class="note">${esc(f.error)}</div>`;
    const arr = f.kind === 'arrival';
    return `<div class="flightbox">
      <div class="spread"><span><b class="mono">${esc(f.flight)}</b> <span class="muted small">${esc(f.airline)}</span></span>${flightPill(f)}</div>
      <dl class="kv small"><dt>${arr ? 'Lands' : 'Departs'}${f.airport ? ' ' + esc(f.airport) : ''}</dt><dd>${f.delayMin ? `<s class="faint">${esc(fmtTime(f.scheduled))}</s> ` : ''}<b>${esc(fmtTime(f.estimated))}</b> ${esc(fmtDate(f.estimated))}</dd>
        <dt>Terminal</dt><dd>${esc(f.terminal)}${f.claim ? ` · baggage claim ${f.claim}` : ''}</dd></dl>
      ${opts && opts.note ? `<p class="small faint">${esc(opts.note)}</p>` : ''}</div>`;
  }
  function quoteLines(q) {
    return q.lines.map((l) => `<div class="qline ${l.kind === 'discount' ? 'disc' : ''}"><span>${esc(l.label)}</span><span class="num">${l.amount == null ? '' : (l.amount < 0 ? '−' + money(-l.amount) : money(l.amount))}</span></div>`).join('');
  }
  // Address autofill. Suggestions come from places.suggest (simulated today,
  // Google Places later). Picking one fills the field and fires 'input'.
  const AC_ICON = { airport: '✈', recent: '↺', place: '●', street: '⌖' };
  let acSeq = 0;
  function addressAutocomplete(input, slug) {
    if (!input || input.readOnly || input.disabled) return;
    const wrap = input.parentElement; wrap.classList.add('acwrap');
    const list = document.createElement('ul');
    list.className = 'ac'; list.id = 'ac-' + (++acSeq); list.setAttribute('role', 'listbox'); list.hidden = true;
    wrap.appendChild(list);
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', list.id); input.setAttribute('aria-expanded', 'false');
    let items = [], active = -1, timer = null, n = 0;
    const close = () => { list.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
    const mark = () => {
      $$('li', list).forEach((li, i) => li.setAttribute('aria-selected', i === active ? 'true' : 'false'));
      if (active >= 0) { input.setAttribute('aria-activedescendant', `${list.id}-${active}`); const el = list.children[active]; if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); }
    };
    const pick = (i) => {
      const it = items[i]; if (!it) return;
      input.value = it.address; close();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const render = () => {
      if (!items.length || document.activeElement !== input) return close();
      const q = input.value.trim();
      const head = !q && items.some((x) => x.kind === 'recent') ? '<li class="achead" role="presentation">Recent and airports</li>' : '';
      list.innerHTML = head + items.map((it, i) => `<li id="${list.id}-${i}" role="option" data-i="${i}" aria-selected="false"><span class="acico ac-${it.kind}" aria-hidden="true">${AC_ICON[it.kind] || '●'}</span><span class="actext"><b>${esc(it.label)}</b>${it.sub ? `<span>${esc(it.sub)}</span>` : ''}</span>${it.kind === 'street' ? '<span class="actag">Use this address</span>' : ''}</li>`).join('');
      list.hidden = false; input.setAttribute('aria-expanded', 'true'); active = -1;
      $$('li[data-i]', list).forEach((li) => { li.onmousedown = (e) => { e.preventDefault(); pick(+li.dataset.i); }; });
    };
    const load = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const k = ++n;
        try { const r = await api('places.suggest', { slug, q: input.value }); if (k !== n) return; items = r; render(); } catch (e) { close(); }
      }, 120);
    };
    input.addEventListener('input', (e) => { if (e.constructor !== Event) load(); });
    input.addEventListener('focus', load);
    input.addEventListener('blur', () => setTimeout(close, 100));
    input.addEventListener('keydown', (e) => {
      if (list.hidden) { if (e.key === 'ArrowDown') { load(); e.preventDefault(); } return; }
      const opts = items.length;
      if (e.key === 'ArrowDown') { active = (active + 1) % opts; mark(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = active <= 0 ? opts - 1 : active - 1; mark(); e.preventDefault(); }
      else if (e.key === 'Enter' && active >= 0) { pick(active); e.preventDefault(); }
      else if (e.key === 'Escape') { close(); e.stopPropagation(); }
      else if (e.key === 'Tab' && active >= 0) pick(active);
    });
  }

  // ---- Event quotes: shared ride editor -----------------------------------
  // One card per ride: when, where, which vehicle and how many. Staff also see
  // a price per vehicle with the suggested price from the normal rates.
  const QPILL = { new: 's-confirmed', sent: 's-assigned', accepted: 's-on_board', declined: 's-cancelled', expired: 'off', cancelled: 'off' };
  const qPill = (q) => `<span class="pill ${QPILL[q.status] || ''}">${esc(q.statusLabel)}</span>`;
  const blankRide = (prev) => {
    const d = prev ? new Date(new Date(prev.pickupAt).getTime() + 2 * 3600e3) : (() => { const x = new Date(Date.now() + 14 * 864e5); x.setHours(17, 0, 0, 0); return x; })();
    return { service: 'transfer', pickupAt: d.toISOString(), pickup: prev ? (prev.dropoff || prev.pickup) : '', dropoff: '', hours: 4, vehicleType: prev ? prev.vehicleType : '', count: prev ? prev.count : 1, passengers: prev ? prev.passengers : 2, notes: '', unitPrice: null };
  };
  function rideEditor(host, opts) {
    // opts: { lines, vehicleTypes:[{type,capacity}], slug, staff, locked, onChange }
    let lines = (opts.lines && opts.lines.length ? opts.lines : [blankRide()]).map((l) => ({ ...l }));
    const vts = opts.vehicleTypes;
    const sug = {};
    let sugTimer = null;
    const total = () => lines.reduce((s, l) => s + (Number(l.unitPrice) || 0) * (Number(l.count) || 0), 0);
    const draw = () => {
      host.innerHTML = lines.map((l, i) => {
        const hourly = l.service === 'hourly';
        const dis = opts.locked ? 'disabled' : '';
        return `<fieldset class="ride" data-i="${i}">
          <div class="spread"><b>Ride ${i + 1}</b>${!opts.locked && lines.length > 1 ? `<button type="button" class="linkbtn" data-rm="${i}">Remove</button>` : ''}</div>
          <div class="grid3">
            <label class="field"><span>Type of ride</span><select data-k="service" ${dis}><option value="transfer" ${!hourly ? 'selected' : ''}>Point to point</option><option value="hourly" ${hourly ? 'selected' : ''}>By the hour</option></select></label>
            <label class="field"><span>Date and pickup time</span><input type="datetime-local" data-k="pickupAt" value="${esc(l.pickupAt ? toLocalInput(new Date(l.pickupAt)) : '')}" ${dis}></label>
            <label class="field"><span>Vehicle</span><select data-k="vehicleType" ${dis}>${vts.map((v) => `<option value="${esc(v.type)}" ${l.vehicleType === v.type ? 'selected' : ''}>${esc(v.type)} (up to ${v.capacity})</option>`).join('')}</select></label>
          </div>
          <div class="grid2">
            <label class="field"><span>Pickup address</span><input data-k="pickup" value="${esc(l.pickup || '')}" autocomplete="off" ${dis}></label>
            ${hourly ? `<label class="field"><span>Hours</span><input type="number" min="1" max="24" data-k="hours" value="${esc(l.hours || 4)}" ${dis}></label>`
              : `<label class="field"><span>Drop-off address</span><input data-k="dropoff" value="${esc(l.dropoff || '')}" autocomplete="off" ${dis}></label>`}
          </div>
          <label class="field" data-flightf ${C.isAirport(l.pickup || '') ? '' : 'hidden'}><span>Flight number (required for airport pickups)</span><input data-k="flight" class="mono" placeholder="AS 331" value="${esc(l.flight || '')}" autocomplete="off" ${dis}></label>
          <div class="grid2">
            <label class="field"><span>How many vehicles</span><input type="number" min="1" max="20" data-k="count" value="${esc(l.count || 1)}" ${dis}></label>
            <label class="field"><span>Passengers in total</span><input type="number" min="1" max="400" data-k="passengers" value="${esc(l.passengers || 1)}" ${dis}></label>
          </div>
          <div class="grid2">
            <label class="field"><span>Note for this ride</span><input data-k="notes" value="${esc(l.notes || '')}" maxlength="200" placeholder="${hourly ? 'Stops, music, drinks' : 'Who rides in this one'}" ${dis}></label>
            <label class="field"><span>Phone for this ride (optional)</span><input type="tel" data-k="phone" value="${esc(l.phone || '')}" maxlength="30" autocomplete="off" placeholder="Who the chauffeur should call" ${dis}></label>
          </div>
          ${opts.staff ? `<div class="ridepay">
            <label class="field"><span>Price per vehicle, all-in</span><input type="number" min="0" step="5" data-k="unitPrice" value="${l.unitPrice == null ? '' : esc(l.unitPrice)}" placeholder="0" ${dis}></label>
            <div class="small"><span class="muted" data-sug="${i}">${sug[i] != null ? `Your rates: ${money(sug[i])}` : ''}</span>${!opts.locked ? ` <button type="button" class="linkbtn" data-use="${i}" ${sug[i] == null ? 'hidden' : ''}>Use this price</button>` : ''}</div>
            <div class="r"><span class="label">Ride total</span><b class="num" data-lt="${i}">${money((Number(l.unitPrice) || 0) * (Number(l.count) || 0))}</b></div>
          </div>${l.warning ? `<div class="warnbox small">${esc(l.warning)}</div>` : ''}` : ''}
        </fieldset>`;
      }).join('') + (opts.locked ? '' : `<button type="button" class="btn" data-add>Add another ride</button>`);
      $$('[data-k]', host).forEach((el) => {
        const i = +el.closest('[data-i]').dataset.i, k = el.dataset.k;
        el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
          const l = lines[i];
          if (k === 'pickupAt') l.pickupAt = el.value ? new Date(el.value).toISOString() : '';
          else if (k === 'unitPrice') l.unitPrice = el.value === '' ? null : Number(el.value);
          else l[k] = el.value;
          if (k === 'service') { draw(); }
          if (k === 'pickup') { const ff = $('[data-flightf]', el.closest('[data-i]')); if (ff) ff.hidden = !C.isAirport(el.value); }
          if (opts.staff) { const lt = $(`[data-lt="${i}"]`, host); if (lt) lt.textContent = money((Number(l.unitPrice) || 0) * (Number(l.count) || 0)); if (k !== 'unitPrice' && k !== 'notes' && k !== 'phone') suggest(); }
          if (opts.onChange) opts.onChange();
        });
      });
      $$('input[data-k=pickup], input[data-k=dropoff]', host).forEach((el) => addressAutocomplete(el, opts.slug));
      $$('[data-rm]', host).forEach((b) => { b.onclick = () => { lines.splice(+b.dataset.rm, 1); draw(); suggest(); if (opts.onChange) opts.onChange(); }; });
      $$('[data-use]', host).forEach((b) => { b.onclick = () => { const i = +b.dataset.use; lines[i].unitPrice = Math.round(sug[i] / 5) * 5; draw(); if (opts.onChange) opts.onChange(); }; });
      const add = $('[data-add]', host); if (add) add.onclick = () => { lines.push(blankRide(lines[lines.length - 1])); draw(); suggest(); if (opts.onChange) opts.onChange(); };
    };
    // Price one vehicle of each ride with the normal booking rates.
    function suggest() {
      if (!opts.staff) return;
      clearTimeout(sugTimer);
      sugTimer = setTimeout(() => lines.forEach(async (l, i) => {
        const per = Math.max(1, Math.ceil((Number(l.passengers) || 1) / (Number(l.count) || 1)));
        try { const r = await api('dispatch.quote', { booking: { ...l, passengers: per, flight: '' } }); sug[i] = r.total; } catch (e) { sug[i] = null; }
        const el = $(`[data-sug="${i}"]`, host); if (el) el.textContent = sug[i] != null ? `Your rates: ${money(sug[i])}` : '';
        const ub = $(`[data-use="${i}"]`, host); if (ub) ub.hidden = sug[i] == null;
      }), 250);
    }
    draw(); suggest();
    return { get: () => lines.map((l) => ({ ...l, vehicleType: l.vehicleType || (vts[0] && vts[0].type) })), total };
  }

  // ---- Quote request page (#request.<slug>) ---------------------------------
  async function viewRequest(slug) {
    current = null;
    let info;
    try { info = await api('public.company', { slug }); }
    catch (e) { const v = shell({}); v.innerHTML = `<div class="panel stack"><h2>Page unavailable</h2><p class="muted">${esc(e.message)}</p><a class="btn" href="#signin">Back</a></div>`; return; }
    const signedHere = session && session.user.role === 'customer' && session.user.companyId === info.company.id;
    const keep = session;
    if (!signedHere) session = { company: info.company, user: null };
    const v = shell({});
    session = keep;
    document.documentElement.style.setProperty('--brand', info.company.color);
    const me = signedHere ? session.user : {};
    v.innerHTML = `
      <div class="brandhead"><div class="stack" style="gap:6px"><h1>Request a quote</h1><p>${esc(info.company.name)} · weddings, proms, corporate events and groups</p></div>
        <div class="small" style="opacity:.9">${esc(info.company.phone || '')} · <a href="#book.${esc(slug)}" style="color:#fff">Book a single ride instead</a></div></div>
      <form id="rq" class="stack" novalidate style="max-width:860px">
        <section class="panel stack"><h2>Your event</h2>
          <div class="grid2"><label class="field"><span>Type of event</span><select name="eventType">${C.EVENT_TYPES.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
            <label class="field"><span>Event name (optional)</span><input name="eventName" maxlength="100" placeholder="Smith wedding"></label></div>
        </section>
        <section class="panel stack"><h2>Rides</h2><p class="muted small">Add each ride: for example the bridal party to the ceremony, then guests to the reception. Give the total passengers and we'll work out the vehicles.</p><div id="rq-rides" class="stack"></div></section>
        <section class="panel stack"><h2>Your details</h2>
          <div class="grid2"><label class="field"><span>Your name</span><input name="name" value="${esc(me.name || '')}" autocomplete="name"></label>
            <label class="field"><span>Mobile</span><input name="phone" type="tel" value="${esc(me.phone || '')}" autocomplete="tel" placeholder="(206) 555-0100"></label></div>
          <div class="grid2"><label class="field"><span>Email</span><input name="email" type="email" value="${esc(me.email || '')}" autocomplete="email"></label>
            <label class="field"><span>Company or school (optional)</span><input name="org" maxlength="80"></label></div>
          <label class="field"><span>Anything else we should know?</span><textarea name="notes" maxlength="800" placeholder="Timings, special requests, a particular car"></textarea></label>
        </section>
        <div id="rq-err"></div>
        <div class="row"><button class="btn brand big" type="submit">Send quote request</button><span class="small muted">No payment now. We'll send you a price to review.</span></div>
      </form>`;
    const rides = rideEditor($('#rq-rides', v), { vehicleTypes: info.vehicleTypes, slug, lines: [{ ...blankRide(), vehicleType: (info.vehicleTypes.find((x) => x.type === 'SUV') || info.vehicleTypes[0] || {}).type }] });
    $('#rq', v).onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      await busy($('button[type=submit]', e.target), async () => {
        try {
          const r = await api('public.requestQuote', { slug, eventType: f.eventType, eventName: f.eventName, notes: f.notes, contact: { name: f.name, phone: f.phone, email: f.email, org: f.org }, lines: rides.get() });
          $('#rq', v).outerHTML = `<div class="panel stack" style="max-width:640px;text-align:center"><h2>Thank you, we've got your request</h2><p>Your reference is <b class="mono">${esc(r.number)}</b>.</p><p class="muted">${esc(info.company.name)} will price it and send you a link by ${f.email && f.phone ? 'text and email' : f.email ? 'email' : 'text'} to review and book.${signedHere ? ' It will also show on your My trips page.' : ''}</p><div class="row" style="justify-content:center"><a class="btn" href="#book.${esc(slug)}">Back to booking</a>${signedHere ? '<a class="btn brand" href="#customer">My trips</a>' : ''}</div></div>`;
          window.scrollTo(0, 0);
        } catch (err) { showErr($('#rq-err', v), err); }
      });
    };
  }

  // ---- Customer quote page (#quote.<token>) ---------------------------------
  async function viewQuote(token) {
    current = null;
    let q;
    try { q = await api('public.viewQuote', { token }); } catch (e) { const v = shell({}); v.innerHTML = `<div class="panel stack"><h2>Quote not found</h2><p class="muted">${esc(e.message)}</p></div>`; return; }
    const keep = session; session = { company: q.company, user: null };
    const v = shell({ narrow: true });
    session = keep;
    document.documentElement.style.setProperty('--brand', q.company.color);
    const draw = () => {
      const what = [q.eventType, q.eventName].filter(Boolean).join(': ');
      const open = q.status === 'sent';
      const cardOn = q.cards !== false && q.company.cards !== false, stripeCard = cardOn && q.company.payMode === 'stripe';
      const cardHow = `No deposit. Nothing is charged now: each ride goes on your card ${q.chargeHours || 24} hours before its pickup, and extras like waiting time or an added stop after the ride.`;
      const cardFields = stripeCard ? `<p class="small muted">${cardHow} You'll save your card on a secure Stripe page, then come straight back here.</p>`
        : `<div class="grid2"><label class="field"><span>Card number</span><input name="number" class="mono" inputmode="numeric" autocomplete="cc-number" value="4242 4242 4242 4242"></label><label class="field"><span>Expiry (MM/YY)</span><input name="exp" class="mono" autocomplete="cc-exp" value="12/30"></label></div>
          <p class="small muted">${cardHow}${q.company.payMode === 'demo' ? ' Demo: no real card is charged.' : ''}</p>`;
      v.innerHTML = `<div class="stack">
        <div class="spread"><div><h1 style="font-size:24px">${q.status === 'accepted' ? 'You’re booked' : 'Your quote'}</h1><p class="muted small">${esc(q.company.name)} · ${esc(q.number)}${what ? ' · ' + esc(what) : ''}</p></div>${qPill(q)}</div>
        ${q.status === 'new' ? `<div class="panel muted">We're pricing your request now. You'll get a text or email with the price.</div>` : `
        <div class="panel stack">
          ${q.lines.map((l, i) => `<div class="qride"><div class="spread"><b>${esc(fmtDT(l.pickupAt))}</b><b class="num">${money(l.lineTotal)}</b></div>
            <div class="small">${esc(l.pickup)}${l.service === 'hourly' ? ` · ${l.hours} hours` : ` to ${esc(l.dropoff)}`}</div>
            <div class="small muted">${l.count} × ${esc(l.vehicleType)} at ${money(l.unitPrice)} each · ${l.passengers} passengers${l.notes ? ' · ' + esc(l.notes) : ''}${l.phone ? ' · ' + esc(l.phone) : ''}</div></div>`).join('')}
          <div class="qline"><span>Total, including gratuity and taxes</span><b class="num">${money(q.total)}</b></div>
          ${q.depositPaid ? `<div class="qline"><span>Deposit paid</span><b class="num">${money(q.depositPaid.amount)}</b></div>` : ''}
          ${q.message ? `<div class="note">${esc(q.message)}</div>` : ''}
          ${open && q.validUntil ? `<p class="small muted">This price is held until ${esc(fmtDate(q.validUntil + 'T12:00:00'))}.</p>` : ''}
        </div>`}
        ${q.status === 'accepted' ? `<div class="panel stack"><p>Thank you${q.contact && q.contact.name ? ', ' + esc(q.contact.name.split(' ')[0]) : ''}. ${q.trips.length} vehicle${q.trips.length === 1 ? ' is' : 's are'} booked. We'll send each chauffeur's details on the day.</p><div class="small mono muted">${q.trips.map((t) => esc(t.ref)).join(' · ')}</div>
          ${q.card ? `<p class="small muted">${esc(cardName(q.card))} is on file. Each ride is charged ${q.chargeHours || 24} hours before its pickup.</p>` : ''}</div>
          ${q.needsCard ? `<form class="panel stack" id="qc" novalidate><h2>Add a card for the rides</h2>${cardFields}<div id="qc-err"></div><button class="btn brand big" type="submit">Save card</button></form>` : ''}` : ''}
        ${q.status === 'declined' ? `<div class="panel muted">You turned this quote down. Call us if you'd like a new one.</div>` : ''}
        ${q.status === 'expired' ? `<div class="panel muted">This quote expired on ${esc(fmtDate(q.validUntil + 'T12:00:00'))}. Call us for an updated price.</div>` : ''}
        ${q.status === 'cancelled' ? `<div class="panel muted">This quote was withdrawn. Call us if you still need cars.</div>` : ''}
        ${open ? `<form class="panel stack" id="qa" novalidate><h2>Book it</h2>
          <div class="grid2"><label class="field"><span>Your name</span><input name="name" value="${esc((q.contact && q.contact.name) || '')}" autocomplete="name"></label>
            <label class="field"><span>Mobile</span><input name="phone" type="tel" value="${esc((q.contact && q.contact.phone) || '')}" autocomplete="tel" placeholder="(206) 555-0100"><span class="hint">Your chauffeur texts or calls this number on the day.</span></label></div>
          ${cardOn ? `<span class="label">Card on file</span>${cardFields}` : ''}
          ${q.terms ? `<label class="check small"><input type="checkbox" name="agreeTerms"> <span>I agree to ${esc(q.company.name)}'s <a href="#" id="qa-terms">booking terms</a></span></label>` : ''}
          <div id="qa-err"></div>
          <button class="btn brand big" type="submit">${cardOn ? 'Save card and book' : 'Accept and book'}</button>
          <button class="linkbtn" type="button" id="qa-no">No thanks, decline this quote</button></form>` : ''}
        ${q.company.phone ? `<a class="btn" href="tel:${esc(q.company.phone.replace(/[^\d+]/g, ''))}">Call ${esc(q.company.name)}</a>` : ''}
      </div>`;
      const qc = $('#qc', v);
      if (qc) qc.onsubmit = async (e) => {
        e.preventDefault();
        await busy($('button[type=submit]', qc), async () => {
          try {
            if (stripeCard) { const r = await payApi('checkout', { kind: 'quote', token }); location.href = r.url; await new Promise(() => {}); }
            q = await api('public.saveQuoteCard', { token, card: formData(qc) }); draw(); toast('Card saved.');
          } catch (err) { showErr($('#qc-err', v), err); }
        });
      };
      const f = $('#qa', v);
      if (!f) return;
      const qt = $('#qa-terms', v); if (qt) qt.onclick = (e) => { e.preventDefault(); termsModal(q.terms, q.company.name); };
      f.onsubmit = async (e) => {
        e.preventDefault();
        const d = formData(f);
        await busy($('button[type=submit]', f), async () => {
          try {
            if (stripeCard) { if (!String(d.name || '').trim()) throw new Error('Type your name to accept the quote.'); const r = await payApi('checkout', { kind: 'quote', token, name: d.name, phone: d.phone, agreeTerms: !!d.agreeTerms }); location.href = r.url; await new Promise(() => {}); }
            q = await api('public.acceptQuote', { token, name: d.name, phone: d.phone, agreeTerms: !!d.agreeTerms, card: cardOn ? { number: d.number, exp: d.exp } : null }); draw(); window.scrollTo(0, 0);
          } catch (err) { showErr($('#qa-err', v), err); }
        });
      };
      $('#qa-no', v).onclick = () => {
        const m = openModal({ title: 'Decline this quote', body: `<label class="field"><span>Tell us why (optional)</span><textarea id="qd-why" maxlength="300" placeholder="Found another option, dates changed, over budget"></textarea></label><div id="qd-err"></div>`, footer: '<button class="btn" type="button" data-close>Keep the quote</button><button class="btn danger" type="button" id="qd-go">Decline</button>' });
        $('[data-close]', m).onclick = closeModal;
        $('#qd-go', m).onclick = async () => { try { q = await api('public.declineQuote', { token, reason: $('#qd-why', m).value }); closeModal(); draw(); } catch (err) { showErr($('#qd-err', m), err); } };
      };
    };
    draw();
  }

  // The company's booking terms, read before agreeing. Opens over whatever is on screen.
  function termsModal(text, name) {
    const box = document.createElement('div');
    box.className = 'overlay termsbox';
    box.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Booking terms"><header><h2>${esc(name ? name + ' booking terms' : 'Booking terms')}</h2><button class="x" type="button" aria-label="Close">×</button></header><div class="body"><div class="termstext">${esc(text)}</div></div><footer><button class="btn primary" type="button">Close</button></footer></div>`;
    const close = () => box.remove();
    box.onclick = (e) => { if (e.target === box) close(); };
    $$('button', box).forEach((b) => { b.onclick = close; });
    document.body.appendChild(box);
  }
  function bookingForm(host, opts) {
    // opts: { info: {rates, addons, vehicleTypes}, mode, initial, quoteFn, submitLabel, onSubmit }
    const vt = opts.info.vehicleTypes;
    const ad = opts.info.addons || { childSeat: 15, meetGreet: 25, extraStop: 20 };
    const dflt = defaultPickup();
    const init = Object.assign({ service: 'transfer', date: dflt.slice(0, 10), time: dflt.slice(11, 16), pickup: '', dropoff: '', hours: opts.info.rates.minHours, passengers: 1, vehicleType: (vt[0] || {}).type, flight: '', notes: '', passengerName: '', passengerPhone: '', passengerEmail: '', childSeats: 0, meetGreet: false, stops: 0, promoCode: '', accountId: '', poNumber: '', costCenter: '' }, opts.initial || {});
    const accts = opts.accounts || [];
    if (init.service === 'airport') init.service = 'transfer';
    const pr = init.prefs || {};
    const state = { bags: 0, signName: '', retOn: false, landOn: false, landDest: '', landDrop: '', retDate: init.date, retTime: '', retFlight: '', prefTemp: pr.temp || '', prefMusic: pr.music || '', prefQuiet: !!pr.quiet, ...init };
    let stopList = Array.isArray(init.stopList) ? init.stopList.slice() : [];
    const defWait = ad.stopWait == null ? 10 : ad.stopWait;
    let stopWaits = stopList.map((x, i) => (Array.isArray(init.stopWaits) && init.stopWaits[i] != null ? init.stopWaits[i] : defWait));
    const pol = opts.info.policy || null;
    const dispatch = opts.mode === 'dispatch';
    const agent = opts.mode === 'agent';
    const clients = opts.clients || [];
    if (agent && !state.payBy) state.payBy = 'agent';
    host.innerHTML = `
      <div class="booking">
        <form class="panel stack" id="bk-form" novalidate>
          <div class="row"><div class="seg" role="group" aria-label="Type of booking">
            <button type="button" data-service="transfer" aria-pressed="${state.service !== 'hourly'}">Transfer</button>
            <button type="button" data-service="hourly" aria-pressed="${state.service === 'hourly'}">By the hour</button>
          </div><span class="small faint" id="bk-service-hint"></span></div>
          <div class="grid3">
            <label class="field"><span>Pickup date</span><input id="bk-date" name="date" type="date" value="${esc(state.date)}" required></label>
            <label class="field"><span>Pickup time</span><input id="bk-time" name="time" type="time" step="300" value="${esc(state.time)}" required>${opts.mode !== 'dispatch' && opts.info.minNoticeHours ? `<span class="hint">Book at least ${opts.info.minNoticeHours} hours ahead</span>` : ''}</label>
            <label class="field" data-show="hourly"><span>Hours</span><input id="bk-hours" name="hours" type="number" min="1" max="24" value="${esc(state.hours)}"><span class="hint">Minimum ${opts.info.rates.minHours} hours</span></label>
          </div>
          <label class="field"><span>Pickup address</span><input id="bk-pickup" name="pickup" autocomplete="off" placeholder="Hotel, airport or street address" value="${esc(state.pickup)}" required></label>
          <div class="stack stops" data-hide="hourly" style="gap:8px"><div id="bk-stops"></div>
            <div><button class="linkbtn" type="button" id="bk-addstop">+ Add a stop on the way <span class="faint">(priced by the extra miles and the wait${opts.info.rates && opts.info.rates.waitPerMin ? `, ${money(opts.info.rates.waitPerMin)}/min` : ''})</span></button></div></div>
          <label class="field"><span id="bk-drop-label">Drop-off address</span><input id="bk-dropoff" name="dropoff" autocomplete="off" placeholder="Where are you going?" value="${esc(state.dropoff)}"></label>
          <div class="grid2">
            <label class="field"><span>Flight number <span class="faint">(required for airport pickups)</span></span><input id="bk-flight" name="flight" class="mono" placeholder="AA 1342" value="${esc(state.flight)}" autocomplete="off">
              <span class="hint" id="bk-flight-hint">For pickups at the airport, set the pickup time to when the flight lands. We track the flight and move the pickup if it's late.</span></label>
            <div></div>
          </div>
          <fieldset class="fs landfs" id="bk-land" hidden><legend><label class="switch"><input type="checkbox" id="bk-land-on" name="landOn" ${state.landOn ? 'checked' : ''}><span id="bk-land-title">${dispatch ? 'Add a pickup when they land' : 'Add a ride when you land'}</span></label></legend>
            <p class="small muted" id="bk-land-info"></p>
            <div class="grid2" id="bk-landf" hidden>
              <label class="field"><span>Landing at</span><select id="bk-land-dest" name="landDest"></select></label>
              <label class="field"><span id="bk-land-droplabel">Where to</span><input id="bk-land-drop" name="landDrop" autocomplete="off" placeholder="Hotel or street address" value="${esc(state.landDrop || '')}"></label>
            </div></fieldset>
          <div class="field"><span>Vehicle</span>
            <div class="vehicles">${vt.map((v) => `<button type="button" class="vcard" data-vehicle="${esc(v.type)}" aria-pressed="${state.vehicleType === v.type}"><b>${esc(v.type)}</b><span>${v.capacity} passengers${v.bags != null ? ` · ${v.bags} suitcase${v.bags === 1 ? '' : 's'}` : ''}</span>${v.models ? `<span class="vmodel">${esc(v.models)}</span>` : ''}</button>`).join('') || '<p class="faint small">No vehicles yet. Add vehicles in the dispatch office first.</p>'}</div>
          </div>
          <div class="grid2">
            <label class="field"><span>Passengers</span><input id="bk-pax" name="passengers" type="number" min="1" max="60" value="${esc(state.passengers)}"></label>
            <label class="field"><span>Suitcases</span><input id="bk-bags" name="bags" type="number" min="0" max="40" value="${esc(state.bags)}"><span class="hint" id="bk-bags-hint"></span></label>
          </div>
          ${agent ? `<div class="agentbox stack" style="gap:10px"><div class="spread"><b>Your client</b>${clients.length ? `<select class="input" id="bk-client" style="width:auto;min-height:34px" aria-label="Saved clients"><option value="">Saved clients…</option>${clients.map((c, i) => `<option value="${i}">${esc(c.name)}${c.trips ? ` (${c.trips} ride${c.trips === 1 ? '' : 's'})` : ''}</option>`).join('')}</select>` : ''}</div>` : ''}
          <div class="grid2">
            <label class="field"><span>${agent ? "Client's name" : 'Passenger name'}</span><input id="bk-name" name="passengerName" value="${esc(state.passengerName)}" ${dispatch || agent ? 'required' : ''}>${dispatch || agent ? '' : '<span class="hint">Booking for someone else? Put their name and mobile.</span>'}</label>
            <label class="field"><span>${agent ? "Client's mobile" : 'Passenger mobile'}</span><input id="bk-phone" name="passengerPhone" type="tel" value="${esc(state.passengerPhone)}"><span class="hint">The chauffeur texts this number.</span></label>
          </div>
          ${agent ? `<label class="field"><span>Client's email <span class="faint">(optional)</span></span><input id="bk-email" name="passengerEmail" type="email" value="${esc(state.passengerEmail)}"><span class="hint">Your client gets the confirmation and chauffeur details. You get a copy by email.</span></label>
            <div class="field"><span>Who pays</span><div class="seg" role="radiogroup">
              <label class="switch"><input type="radio" name="payBy" value="agent" id="bk-payby-agent" ${state.payBy !== 'passenger' ? 'checked' : ''}><span>My card on file</span></label>
              <label class="switch"><input type="radio" name="payBy" value="passenger" id="bk-payby-passenger" ${state.payBy === 'passenger' ? 'checked' : ''}><span>My client: text them a link to add their card</span></label></div></div></div>` : ''}
          ${dispatch ? `<label class="field"><span>Passenger email</span><input id="bk-email" name="passengerEmail" type="email" value="${esc(state.passengerEmail)}"><span class="hint">Links the trip to a customer account and applies their account discount. Leave blank for a one-off.</span></label>` : ''}
          ${accts.length ? `<div class="grid3">
            <label class="field"><span>Bill to</span><select id="bk-acct" name="accountId"><option value="">${dispatch ? 'Passenger pays' : "I'll pay myself"}</option>${accts.map((a) => `<option value="${a.id}" ${state.accountId === a.id ? 'selected' : ''}>${esc(a.name)} (monthly invoice)</option>`).join('')}</select></label>
            <label class="field" data-acct><span id="bk-po-label">PO number</span><input id="bk-po" name="poNumber" value="${esc(state.poNumber)}" autocomplete="off"></label>
            <label class="field" data-acct><span>Cost center <span class="faint">(optional)</span></span><input id="bk-cc" name="costCenter" value="${esc(state.costCenter)}" autocomplete="off"></label>
          </div>` : ''}
          <div class="field"><span>Extras</span>
            <div class="grid3">
              <label class="field"><span class="small muted">Child seats (${money(ad.childSeat)} each)</span><input id="bk-child" name="childSeats" type="number" min="0" max="4" value="${esc(state.childSeats)}"></label>
              <label class="switch" style="align-self:end;min-height:40px;grid-column:span 2"><input type="checkbox" id="bk-meet" name="meetGreet" ${state.meetGreet ? 'checked' : ''}><span>Meet &amp; greet: chauffeur waits inside with a name sign (${money(ad.meetGreet)})</span></label>
            </div>
            <label class="field" id="bk-signf" hidden><span>Name on the greeting sign</span><input id="bk-sign" name="signName" maxlength="60" value="${esc(state.signName)}" placeholder="Leave blank to use the passenger name"></label></div>
          <fieldset class="fs" data-hide="hourly"><legend><label class="switch"><input type="checkbox" id="bk-ret" name="retOn" ${state.retOn ? 'checked' : ''}><span>Book the return trip too</span></label></legend>
            <div class="grid3" id="bk-retf" hidden>
              <label class="field"><span>Return date</span><input id="bk-rdate" name="retDate" type="date" value="${esc(state.retDate)}"></label>
              <label class="field"><span>Return pickup time</span><input id="bk-rtime" name="retTime" type="time" step="300" value="${esc(state.retTime)}"></label>
              <label class="field" id="bk-rflightf"><span>Return flight <span class="faint">(airport pickup)</span></span><input id="bk-rflight" name="retFlight" class="mono" placeholder="AS 330" value="${esc(state.retFlight)}" autocomplete="off"></label>
            </div><p class="small faint" id="bk-ret-hint" hidden></p></fieldset>
          <fieldset class="fs"><legend>Ride preferences <span class="faint small">(optional${dispatch ? '' : ', saved for next time'})</span></legend>
            <div class="grid3">
              <label class="field"><span>Temperature</span><select id="bk-temp" name="prefTemp">${Object.entries(C.TEMPS).map(([k, l]) => `<option value="${k}" ${state.prefTemp === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
              <label class="field"><span>Music</span><select id="bk-music" name="prefMusic">${Object.entries(C.MUSIC).map(([k, l]) => `<option value="${k}" ${state.prefMusic === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
              <label class="switch" style="align-self:end;min-height:40px"><input type="checkbox" id="bk-quiet" name="prefQuiet" ${state.prefQuiet ? 'checked' : ''}><span>Quiet ride, no small talk</span></label>
            </div></fieldset>
          <div class="grid2">
            <label class="field"><span>Promo code</span><input id="bk-promo" name="promoCode" class="mono" value="${esc(state.promoCode)}" autocomplete="off" style="text-transform:uppercase"></label>
            <div></div>
          </div>
          <label class="field"><span>Notes for the chauffeur</span><textarea id="bk-notes" name="notes" placeholder="Accessibility needs, a special occasion, anything else">${esc(state.notes)}</textarea></label>
          <div id="bk-err"></div>
        </form>
        <aside class="panel stack quote" aria-live="polite">
          <span class="label">Your quote</span>
          <div id="bk-quote"><p class="faint small">Enter pickup and drop-off to see the price.</p></div>
          <div id="bk-flightinfo"></div>
          <div id="bk-card"></div>
          ${!dispatch && opts.info.terms ? `<label class="check small"><input type="checkbox" id="bk-terms"> <span>I agree to ${esc((opts.info.company && opts.info.company.name) || 'the company')}'s <a href="#" id="bk-terms-open">booking terms</a></span></label>` : ''}
          <button class="btn ${dispatch ? 'primary' : 'brand'} big" type="button" id="bk-submit">${esc(opts.submitLabel || 'Book this ride')}</button>
          <div class="small muted stack policy" id="bk-policy" style="gap:4px"></div>
          <p class="small faint" id="bk-mapnote">Distances are estimated for now. They become exact once Google Maps is connected.</p>
        </aside>
      </div>`;
    const form = $('#bk-form', host);
    const sync = () => {
      Object.assign(state, formData(form));
      $$('[data-show]', form).forEach((el) => { el.hidden = el.dataset.show !== state.service; });
      $$('[data-hide]', form).forEach((el) => { el.hidden = el.dataset.hide === state.service; });
      $('#bk-drop-label', form).textContent = state.service === 'hourly' ? 'Drop-off address (optional)' : 'Drop-off address';
      const acc = accts.find((a) => a.id === state.accountId);
      $$('[data-acct]', form).forEach((el) => { el.hidden = !acc; });
      const pol = $('#bk-po-label', form); if (pol) pol.innerHTML = acc && acc.requirePo ? 'PO number <span class="faint">(required)</span>' : 'PO number <span class="faint">(optional)</span>';
      const airport = C.isAirport(state.pickup) || C.isAirport(state.dropoff);
      $('#bk-service-hint', form).textContent = state.service !== 'hourly' && airport ? 'Airport flat rate applies' : '';
      stopList = $$('[data-stop]', form).map((i) => i.value);
      stopWaits = $$('[data-swait]', form).map((i) => Number(i.value));
      $('#bk-addstop', form).hidden = stopList.length >= C.MAX_STOPS;
      $('#bk-signf', form).hidden = !state.meetGreet;
      $('#bk-retf', form).hidden = !state.retOn;
      $('#bk-landf', form).hidden = !state.landOn;
      $('#bk-rflightf', form).hidden = !C.isAirport(state.dropoff);
      const rh = $('#bk-ret-hint', form); rh.hidden = !state.retOn; rh.textContent = state.dropoff ? `Picks up at ${state.dropoff.split(',')[0]} and goes back to ${(state.pickup || 'the pickup').split(',')[0]}${stopList.filter(Boolean).length ? ', with the same stops in reverse' : ''}.` : '';
      const vt0 = vt.find((x) => x.type === state.vehicleType);
      const bh = $('#bk-bags-hint', form); if (bh) bh.textContent = vt0 && vt0.bags != null ? `${/^(SUV|[AEIOU])/.test(vt0.type) ? "An" : "A"} ${vt0.type} takes up to ${vt0.bags}.` : '';
      drawPolicy(); drawCard();
    };
    function drawStops() {
      const box = $('#bk-stops', form);
      const waits = (i) => { const w = stopWaits[i] == null ? defWait : stopWaits[i]; return [...new Set([...C.STOP_WAITS, w])].sort((a, b) => a - b).map((m) => `<option value="${m}" ${m === w ? 'selected' : ''}>${m} min</option>`).join(''); };
      box.innerHTML = stopList.map((x, i) => `<div class="stoprow"><label class="field grow"><span>Stop ${i + 1}</span><input data-stop="${i}" autocomplete="off" placeholder="Address of the stop" value="${esc(x)}"></label><label class="field swait"><span>Wait there</span><select data-swait="${i}" aria-label="Wait at stop ${i + 1}">${waits(i)}</select></label><button class="btn sm" type="button" data-rmstop="${i}" aria-label="Remove stop ${i + 1}">Remove</button></div>`).join('');
      $$('[data-swait]', box).forEach((sel) => { sel.onchange = () => { sync(); requote(); }; });
      $$('[data-stop]', box).forEach((inp) => addressAutocomplete(inp, acSlug));
      $$('[data-rmstop]', box).forEach((b) => { b.onclick = () => { stopList.splice(+b.dataset.rmstop, 1); stopWaits.splice(+b.dataset.rmstop, 1); drawStops(); sync(); requote(); }; });
    }
    function drawPolicy() {
      const el = $('#bk-policy', host);
      if (!el || !pol) return;
      const when = state.date && state.time ? new Date(`${state.date}T${state.time}`) : null;
      const until = when && !isNaN(when) ? new Date(when.getTime() - pol.cancelHours * 3600e3) : null;
      const waits = `Free waiting: ${pol.waitAirport} min after landing at the airport, ${pol.waitOther} min elsewhere${opts.info.rates.waitPerMin ? `, then ${money(opts.info.rates.waitPerMin)}/min` : ''}.${pol.noShowFeePct ? ` A no-show is charged ${pol.noShowFeePct === 100 ? 'the full fare' : pol.noShowFeePct + '% of the fare'}.` : ''}`;
      const fee = pol.cancelFeePct === 100 ? 'the full fare' : pol.cancelFeePct + '% of the fare';
      if (pol.cancelHours && pol.cancelFeePct && until && until.getTime() <= Date.now()) { el.innerHTML = `<div>This pickup is less than ${pol.cancelHours} hours away, so cancelling costs ${fee}.</div><div>${waits}</div>`; return; }
      el.innerHTML = `<div>${pol.cancelHours ? `Free cancellation until ${until ? esc(fmtDT(until.toISOString())) : `${pol.cancelHours} hours before pickup`}${pol.cancelFeePct ? `; after that ${pol.cancelFeePct === 100 ? 'the full fare' : pol.cancelFeePct + '% of the fare'} is charged` : ''}.` : 'Free cancellation until pickup.'}</div><div>${waits}</div>`;
    }
    // Card on file. Nothing is charged at booking: the fare goes on the card
    // chargeHours before pickup and extras after the ride.
    const co = opts.info.company || session.company || {};
    const saved = () => (session && session.user && session.user.role === 'customer' && session.user.card) || null;
    let newCard = false, cardKey = null;
    function drawCard() {
      const el = $('#bk-card', host);
      if (!el) return;
      const key = [state.accountId, newCard, !!saved(), dispatch, state.payBy].join('|');
      if (key === cardKey) return;
      cardKey = key;
      if (co.cards === false || state.accountId) { el.innerHTML = ''; return; }
      if (dispatch || (agent && state.payBy === 'passenger')) {
        el.innerHTML = `<p class="note small">Paid by card on file. We text the ${agent ? 'client' : 'passenger'} a link to save their card.</p>`;
        return;
      }
      const hrs = (pol && pol.chargeHours != null ? pol.chargeHours : 24);
      const how = `Nothing is charged now. The fare goes on your card ${hrs} hours before pickup (right away if pickup is sooner), and extras like waiting time or an added stop after the ride.`;
      const k = saved();
      if (k && !newCard) {
        el.innerHTML = `<div class="cardbox"><div class="spread"><span class="small"><b>Card on file</b><br>${esc(cardName(k))}${k.exp ? ` · exp ${esc(k.exp)}` : ''}</span>${co.payMode === 'demo' ? '<button class="linkbtn small" type="button" id="bk-newcard">Use another card</button>' : ''}</div><p class="small muted">${how}</p></div>`;
        const b = $('#bk-newcard', el); if (b) b.onclick = () => { newCard = true; drawCard(); };
      } else if (co.payMode === 'stripe') {
        el.innerHTML = `<div class="cardbox"><b class="small">Card on file</b><p class="small muted">After you book, you'll save your card on a secure Stripe page. ${how}</p></div>`;
      } else {
        el.innerHTML = `<div class="cardbox stack" style="gap:8px"><b class="small">Card on file</b>
          <label class="field"><span>Card number</span><input id="bk-cardno" class="mono" inputmode="numeric" autocomplete="cc-number" value="${esc(state.cardNo || '4242 4242 4242 4242')}"></label>
          <label class="field"><span>Expiry (MM/YY)</span><input id="bk-cardexp" class="mono" autocomplete="cc-exp" value="${esc(state.cardExp || '12/30')}"></label>
          <p class="small muted">${how}${co.payMode === 'demo' ? ' Demo: no real card is charged; a card ending 0341 shows a decline.' : ''}</p></div>`;
        $('#bk-cardno', el).oninput = (e) => { state.cardNo = e.target.value; };
        $('#bk-cardexp', el).oninput = (e) => { state.cardExp = e.target.value; };
      }
    }
    const setService = (s) => { state.service = s; $$('[data-service]', form).forEach((b) => b.setAttribute('aria-pressed', b.dataset.service === s)); sync(); requote(); };
    $$('[data-service]', form).forEach((b) => { b.onclick = () => setService(b.dataset.service); });
    $$('[data-vehicle]', form).forEach((b) => { b.onclick = () => { state.vehicleType = b.dataset.vehicle; $$('[data-vehicle]', form).forEach((x) => x.setAttribute('aria-pressed', x === b)); requote(); }; });
    let qt = null, qn = 0;
    const booking = () => {
      const { date, time, retOn, retDate, retTime, retFlight, prefTemp, prefMusic, prefQuiet, stops, landOn, landDest, landDrop, ...rest } = state;
      const when = date && time ? new Date(`${date}T${time}`) : null;
      const rwhen = retOn && retDate && retTime ? new Date(`${retDate}T${retTime}`) : null;
      const keep = stopList.map((x, i) => i).filter((i) => stopList[i].trim());
      const out = { ...rest, stopList: state.service === 'hourly' ? [] : keep.map((i) => stopList[i]), stopWaits: state.service === 'hourly' ? [] : keep.map((i) => stopWaits[i] == null ? defWait : stopWaits[i]), prefs: { temp: prefTemp, music: prefMusic, quiet: prefQuiet }, pickupAt: when && !isNaN(when) ? when.toISOString() : '' };
      if (landDest || landOn) out.landing = { on: !!landOn && !$('#bk-land', host).hidden, dest: state.flight === landFlight ? landDest : '', dropoff: landDrop };
      if (retOn && state.service !== 'hourly') { out.returnAt = rwhen && !isNaN(rwhen) ? rwhen.toISOString() : 'missing'; out.returnFlight = retFlight; }
      delete out.cardNo; delete out.cardExp; delete out.payDriver;
      if (!agent) delete out.payBy;
      if ($('#bk-cardno', host) && !(agent && state.payBy === 'passenger')) out.card = { number: state.cardNo || $('#bk-cardno', host).value, exp: state.cardExp || $('#bk-cardexp', host).value };
      return out;
    };
    // "Ride when you land": shown once a flight out of an airport is entered.
    let landFlight = null;
    function drawLanding(lp) {
      const fs = $('#bk-land', host);
      landFlight = state.flight;
      fs.hidden = !lp;
      if (!lp) return null;
      const sel = $('#bk-land-dest', host);
      if (!sel.options.length) sel.innerHTML = lp.airports.map((a) => `<option value="${esc(a.code)}">${esc(a.city)}: ${esc(a.name)}</option>`).join('');
      if (sel.value !== lp.dest.code) sel.value = lp.dest.code;
      state.landDest = lp.dest.code;
      const you = dispatch ? 'they' : 'you';
      $('#bk-land-title', host).textContent = `${dispatch ? 'Add a pickup when they land' : 'Add a ride when you land'} in ${lp.dest.city}`;
      $('#bk-land-droplabel', host).textContent = `Where to in ${lp.dest.city}`;
      $('#bk-land-info', host).innerHTML = `Flight ${esc(lp.flight)} lands at ${esc(lp.dest.code)} about <b>${esc(lp.localTime)}</b> ${esc(lp.dest.city)} time${lp.fromFlightData ? '' : `. Check the airport is right; ${you} can change it`}. `
        + (lp.home ? `Our own chauffeur meets ${dispatch ? 'them' : 'you'}.` : lp.partner ? `${esc(lp.partner.name)}, our partner in ${esc(lp.dest.city)}, drives it for ${money(lp.price)}.` : `We don't have a partner in ${esc(lp.dest.city)} yet, so our office books a local car. About ${money(lp.price)}; we confirm the price.`)
        + ` We follow the flight and move the pickup if it lands late.`;
      return lp;
    }
    const returnOf = (b) => ({ ...b, pickup: b.dropoff, dropoff: b.pickup, stopList: (b.stopList || []).slice().reverse(), stopWaits: (b.stopWaits || []).slice().reverse(), pickupAt: b.returnAt, flight: b.returnFlight || '', returnAt: undefined });
    async function requote() {
      clearTimeout(qt);
      qt = setTimeout(async () => {
        const out = $('#bk-quote', host);
        const fbox = $('#bk-flightinfo', host);
        if (!state.pickup || (state.service !== 'hourly' && !state.dropoff)) { out.innerHTML = '<p class="faint small">Enter pickup and drop-off to see the price.</p>'; fbox.innerHTML = ''; return; }
        const n = ++qn;
        try {
          const b = booking();
          const withRet = b.returnAt && b.returnAt !== 'missing';
          const [q, rq] = await Promise.all([opts.quoteFn(b), withRet ? opts.quoteFn(returnOf(b)).catch(() => null) : null]);
          if (n !== qn) return;
          const lp = drawLanding(q.landing), lpOn = lp && state.landOn;
          out.innerHTML = `<div class="total">${money(q.total + (rq ? rq.total : 0) + (lpOn ? lp.price : 0))}</div>
            <div class="small muted">${esc(C.SERVICES[q.service])} · ${esc(q.vehicleType)}${q.miles ? ` · about ${q.miles} mi, ${q.minutes} min` : ''}${stopList.filter(Boolean).length ? ` · ${stopList.filter(Boolean).length} stop${stopList.filter(Boolean).length > 1 ? 's' : ''}` : ''}</div>
            ${rq ? `<div class="qline"><span>First ride</span><span class="num">${money(q.total)}</span></div><div class="qline"><span>Return ride${rq.miles ? `, about ${rq.miles} mi` : ''}</span><span class="num">${money(rq.total)}</span></div><details class="small"><summary>First ride details</summary>${quoteLines(q)}</details>` : `<div>${quoteLines(q)}</div>`}
            ${lpOn ? `<div class="qline"><span>${dispatch ? 'Pickup' : 'Ride'} when ${dispatch ? 'they land' : 'you land'} in ${esc(lp.dest.city)}${lp.estimate ? ' (estimate)' : ''}</span><span class="num">${money(lp.price)}</span></div>` : ''}
            ${q.promoError ? `<div class="err small">${esc(q.promoError)}</div>` : ''}`;
          fbox.innerHTML = flightBox(q.flight, { note: q.flight && q.flight.kind === 'arrival' && q.flight.delayMin ? 'This flight is running late today. If it still is on the day, we move your pickup to match.' : '' });
        } catch (e) { out.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
      }, 250);
    }
    const acSlug = (opts.info.company && opts.info.company.slug) || (session && session.company && session.company.slug);
    addressAutocomplete($('#bk-pickup', host), acSlug);
    addressAutocomplete($('#bk-dropoff', host), acSlug);
    const cl = $('#bk-client', form);
    if (cl) cl.onchange = () => { const c = clients[+cl.value]; if (!c) return; $('#bk-name', form).value = c.name; $('#bk-phone', form).value = c.phone; $('#bk-email', form).value = c.email; cl.value = ''; sync(); requote(); };
    $('#bk-addstop', form).onclick = () => { sync(); stopList.push(''); stopWaits.push(defWait); drawStops(); sync(); const ins = $$('[data-stop]', form); if (ins.length) ins[ins.length - 1].focus(); };
    drawStops();
    getLive().then((i) => { const n = $('#bk-mapnote', host); if (n && i.live && i.live.maps) n.remove(); });
    form.addEventListener('input', () => { sync(); requote(); });
    form.addEventListener('change', () => { sync(); requote(); });
    form.addEventListener('submit', (e) => e.preventDefault());
    $('#bk-submit', host).onclick = (e) => busy(e.currentTarget, async () => {
      sync(); $('#bk-err', host).innerHTML = '';
      const b = booking(), tc = $('#bk-terms', host);
      if (tc) b.agreeTerms = tc.checked;
      try { await opts.onSubmit(b); } catch (err) { showErr($('#bk-err', host), err); $('#bk-err', host).scrollIntoView({ block: 'nearest' }); }
    });
    const to = $('#bk-terms-open', host);
    if (to) to.onclick = (e) => { e.preventDefault(); termsModal(opts.info.terms, (opts.info.company && opts.info.company.name) || ''); };
    sync(); requote();
    return { state };
  }

  // ---- Public booking page --------------------------------------------------
  async function viewBook(slug) {
    current = null;
    let info;
    try { info = await api('public.company', { slug }); }
    catch (e) { const v = shell({}); v.innerHTML = `<div class="panel stack"><h2>Booking page unavailable</h2><p class="muted">${esc(e.message)}</p><a class="btn" href="#signin">Back</a></div>`; return; }
    const signedHere = session && session.user.role === 'customer' && session.user.companyId === info.company.id;
    if (signedHere && session.user.agent) return go('customer');
    const keep = session;
    if (!signedHere) session = { company: info.company, user: null };
    const v = shell({});
    session = keep;
    document.documentElement.style.setProperty('--brand', info.company.color);
    v.innerHTML = `
      <div class="brandhead"><div class="stack" style="gap:6px"><h1>${esc(info.company.name)}</h1><p>${esc(info.company.tagline || 'Book your ride')}</p></div>
        <div class="small" style="opacity:.9">${esc(info.company.phone || '')}${signedHere ? ` · Signed in as ${esc(session.user.name)} · <a href="#customer" style="color:#fff">My trips</a>` : ''}</div></div>
      <a class="eventlink" href="#request.${esc(slug)}"><span>Planning a wedding, prom, corporate event or group trip?</span><b>Request a quote</b></a>
      <a class="eventlink" href="#agent.${esc(slug)}" id="agent-link"><span>Travel agent, assistant or concierge booking for clients? Earn commission on every ride.</span><b>Agent sign-up or login</b></a>
      <div id="book-host"></div><div id="auth-host"></div>`;
    const pending = { booking: null };
    bookingForm($('#book-host', v), {
      info, mode: 'public',
      initial: signedHere ? { passengerName: session.user.name, passengerPhone: session.user.phone } : {},
      quoteFn: (b) => api('public.quote', { slug, booking: b }),
      onSubmit: async (b) => {
        if (signedHere) { const t = await api('customer.book', { booking: b }); await afterBook(t, b); toast(bookedMsg(t)); go('customer'); return; }
        pending.booking = b; showAuth();
      },
    });
    function showAuth() {
      const host = $('#auth-host', v);
      let mode = 'signup';
      const draw = () => {
        host.innerHTML = `<div class="panel stack" style="margin-top:20px;max-width:560px">
          <h2>${mode === 'signup' ? 'Create your account to confirm' : 'Sign in to confirm'}</h2>
          <p class="muted small">Your account lets you see your trips, pay and get your receipts.</p>
          <form id="au-form" class="stack" novalidate>
            ${mode === 'signup' ? `<div class="grid2"><label class="field"><span>Full name</span><input id="au-name" name="name" value="${esc(pending.booking.passengerName || '')}"></label><label class="field"><span>Mobile</span><input id="au-phone" name="phone" type="tel" value="${esc(pending.booking.passengerPhone || '')}"></label></div>` : ''}
            <label class="field"><span>Email</span><input id="au-email" name="email" type="email" autocomplete="username"></label>
            <label class="field"><span>Password</span><input id="au-pass" name="password" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}">${mode === 'signup' ? '<span class="hint">At least 8 characters</span>' : ''}</label>
            <div id="au-err"></div>
            <div class="row"><button class="btn brand" type="submit">${mode === 'signup' ? 'Create account and book' : 'Sign in and book'}</button>
              <button class="linkbtn" type="button" id="au-switch">${mode === 'signup' ? 'I already have an account' : 'Create a new account'}</button></div>
          </form></div>`;
        $('#au-switch', host).onclick = () => { mode = mode === 'signup' ? 'signin' : 'signup'; draw(); };
        $('#au-form', host).onsubmit = async (e) => {
          e.preventDefault();
          const f = formData(e.target);
          await busy($('button[type=submit]', e.target), async () => {
            try {
              const res = mode === 'signup' ? await api('auth.signup', { ...f, slug }) : await api('auth.login', { ...f, slug });
              if (res.user.role !== 'customer' || res.user.companyId !== info.company.id) throw new Error(`That login isn't a ${info.company.name} customer account.`);
              setSession(res);
              const t = await api('customer.book', { booking: pending.booking });
              await afterBook(t, pending.booking); toast(bookedMsg(t)); go('customer');
            } catch (err) { showErr($('#au-err', host), err); }
          });
        };
        $('input', host).focus();
        host.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      draw();
    }
  }

  // ---- Travel agent sign-up ---------------------------------------------------
  async function viewAgentSignup(slug) {
    current = null;
    let info;
    try { info = await api('public.company', { slug }); }
    catch (e) { const v = shell({}); v.innerHTML = `<div class="panel stack"><h2>Page unavailable</h2><p class="muted">${esc(e.message)}</p><a class="btn" href="#signin">Back</a></div>`; return; }
    const keep = session;
    session = { company: info.company, user: null };
    const v = shell({});
    session = keep;
    v.innerHTML = `<div class="brandhead"><div class="stack" style="gap:6px"><h1>${esc(info.company.name)} for travel agents</h1><p>Book chauffeured rides for your clients and earn commission.</p></div></div>
      <div class="panel stack" style="max-width:600px">
        <ul class="small muted" style="margin:0;padding-left:18px"><li>Book for any client: they get the chauffeur's texts, you get a copy.</li><li>Charge your card on file, or text your client a link to pay with their own card.</li><li>Commission on every completed ride, shown month by month.</li><li>Your clients are saved, so the next booking takes seconds.</li></ul>
        <form id="ag-form" class="stack" novalidate>
          <div class="grid2"><label class="field"><span>Your name</span><input id="ag-name" name="name" autocomplete="name"></label><label class="field"><span>Agency or company</span><input id="ag-agency" name="agency" placeholder="Emerald City Travel"></label></div>
          <div class="grid2"><label class="field"><span>Email</span><input id="ag-email" name="email" type="email" autocomplete="username"></label><label class="field"><span>Mobile</span><input id="ag-phone" name="phone" type="tel"></label></div>
          <label class="field"><span>Password</span><input id="ag-pass" name="password" type="password" autocomplete="new-password"><span class="hint">At least 8 characters</span></label>
          <div id="ag-err"></div>
          <div class="row"><button class="btn brand" type="submit" id="ag-go">Create agent account</button><a class="linkbtn" href="#signin">I already have an account</a></div>
        </form></div>`;
    $('#ag-form', v).onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      await busy($('#ag-go', v), async () => {
        try { const res = await api('auth.signup', { ...f, slug, agent: true }); setSession(res); toast(`Welcome, ${res.user.name.split(' ')[0]}. Book your first client ride.`); go('customer'); }
        catch (err) { showErr($('#ag-err', v), err); }
      });
    };
  }

  // ---- Customer -------------------------------------------------------------
  const STEP_OF = { confirmed: 0, assigned: 1, accepted: 1, en_route: 2, arrived: 3, on_board: 4, completed: 5 };
  async function viewCustomer() {
    let tab = 'trips';
    const ui = { trips: null, info: null };
    const AG = session.user.agent;
    const draw = () => {
      const v = shell({ tabs: AG ? [{ key: 'trips', label: 'Bookings' }, { key: 'book', label: 'Book a ride' }, { key: 'commission', label: 'Commission' }] : [{ key: 'trips', label: 'My trips' }, { key: 'book', label: 'Book a ride' }], active: tab, onTab: (t) => { tab = t; draw(); } });
      if (tab === 'book') drawBook(v); else if (tab === 'commission' && AG) drawCommission(v); else drawTrips(v);
    };
    // Travel agent: commission by month, paid and owed.
    async function drawCommission(v) {
      current = { poll: false };
      v.innerHTML = '<p class="faint">Loading…</p>';
      let c; try { c = await api('customer.commission'); } catch (e) { return showErr(v, e); }
      const mon = (m) => new Date(m + '-15T12:00:00').toLocaleDateString([], { month: 'long', year: 'numeric' });
      v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Commission</h1><p class="muted">${esc(AG.agency)} earns ${c.on ? `<b>${c.pct}%</b> of the ride price (before gratuity and tax) on every completed ride you book with ${esc(session.company.name)}` : `no commission at the moment. Call ${esc(session.company.name)} about it`}.</p></div></div>
        <div class="tiles three" style="margin-bottom:16px">
          <div class="tile"><span class="label">Owed to you</span><b class="num">${money(c.owed)}</b><span class="small faint">Completed rides not paid out yet</span></div>
          <div class="tile"><span class="label">Paid to you</span><b class="num">${money(c.paid)}</b></div>
          <div class="tile"><span class="label">Coming up</span><b class="num">${money(c.upcomingEstimate)}</b><span class="small faint">${c.upcoming} upcoming ride${c.upcoming === 1 ? '' : 's'}, once completed</span></div>
        </div>
        <div class="tablewrap"><table id="cm-table"><thead><tr><th>Month</th><th class="r">Completed rides</th><th class="r">Ride sales</th><th class="r">Commission</th><th>Status</th></tr></thead><tbody>
        ${c.months.filter((m) => m.trips).map((m) => `<tr><td>${esc(mon(m.month))}</td><td class="r num">${m.trips}</td><td class="r num">${money(m.sales)}</td><td class="r num">${money(m.commission)}</td><td>${m.owed ? '<span class="pill unpaid">Owed</span>' : '<span class="pill paid">Paid</span>'}</td></tr>`).join('') || '<tr><td colspan="5" class="faint">No completed rides yet.</td></tr>'}
        </tbody></table></div>`;
    }
    async function drawBook(v) {
      current = { poll: false };
      v.innerHTML = '<p class="faint">Loading…</p>';
      let accounts = [];
      let clients = [];
      try { ui.info = ui.info || await api('public.company', { slug: session.company.slug }); accounts = await api('customer.accounts'); if (AG) clients = await api('customer.clients'); } catch (e) { return showErr(v, e); }
      v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Book a ride</h1>${AG ? `<p class="muted">For a client of ${esc(AG.agency)}. They get the texts from the chauffeur; you get a copy of the confirmation.</p>` : ''}</div></div><div id="bk"></div>`;
      bookingForm($('#bk', v), {
        info: ui.info, mode: AG ? 'agent' : 'customer', accounts, clients,
        initial: AG ? { accountId: accounts[0] ? accounts[0].id : '' } : { passengerName: session.user.name, passengerPhone: session.user.phone, accountId: accounts[0] ? accounts[0].id : '', prefs: session.user.prefs || null, signName: (session.user.prefs && session.user.prefs.signName) || '' },
        quoteFn: (b) => api('customer.quote', { booking: b }),
        onSubmit: async (b) => { const t = await api('customer.book', { booking: b }); await afterBook(t, b); if (AG) { toast(bookedMsg(t) + (b.payBy === 'passenger' ? ` We texted ${b.passengerName.split(' ')[0]} a link to add a card.` : '')); tab = 'trips'; draw(); return; } if (b.prefs) setSession({ ...session, user: { ...session.user, prefs: { ...b.prefs, signName: b.signName || '' } } }); toast(bookedMsg(t)); tab = 'trips'; draw(); },
      });
    }
    async function drawTrips(v) {
      let last = '', showAll = false;
      const refresh = async (silent) => {
        let trips, quotes;
        try { [trips, quotes] = await Promise.all([api('customer.trips'), api('customer.quotes')]); } catch (e) { if (!silent) showErr(v, e); return; }
        const sig = JSON.stringify([trips, quotes]);
        const openQuotes = quotes.filter((q) => ['new', 'sent'].includes(q.status) || (q.status === 'accepted' && q.trips.some((t) => !['completed', 'cancelled'].includes(t.status))));
        if (sig === last) return; last = sig;
        const upcoming = trips.filter((t) => !['completed', 'cancelled'].includes(t.status)).reverse();
        const past = trips.filter((t) => ['completed', 'cancelled'].includes(t.status));
        v.innerHTML = `
          <div class="pagehead"><div class="stack" style="gap:4px"><h1>${AG ? 'Bookings' : 'My trips'}</h1><p class="muted">Hello ${esc(session.user.name.split(' ')[0])}. ${AG ? `Rides you booked for ${esc(AG.agency)} clients with ${esc(session.company.name)}.` : `Your rides with ${esc(session.company.name)}.`}</p></div>
            <div class="row"><a class="btn" href="#request.${esc(session.company.slug)}">Request an event quote</a><button class="btn brand" type="button" id="new-trip">Book a ride</button></div></div>
          <div class="stack">
            ${openQuotes.length ? `<span class="label">Event quotes</span>${openQuotes.map((q) => `<a class="trip quotecard" href="#quote.${esc(q.token)}"><div class="spread"><div class="row"><b>${esc(q.eventName || q.eventType)}</b><span class="mono faint small">${esc(q.number)}</span></div>${qPill(q)}</div>
              <div class="spread small"><span class="muted">${q.eventDate ? esc(fmtDT(q.eventDate)) : ''} · ${((n) => `${n} vehicle${n === 1 ? '' : 's'}`)(q.lines.reduce((s2, l) => s2 + l.count, 0))}</span><span>${q.status === 'sent' ? `<b>${money(q.total)}</b> · Review and book →` : q.status === 'new' ? 'Being priced' : 'View →'}</span></div></a>`).join('')}` : ''}
            <span class="label">Upcoming</span>
            ${upcoming.length ? upcoming.map(tripCard).join('') : '<div class="panel muted">No upcoming rides. Book one when you need it.</div>'}
            <span class="label" style="margin-top:12px">Past</span>
            ${past.length ? `<div class="panel pastlist">${past.slice(0, showAll ? past.length : 5).map(pastRow).join('')}</div>${past.length > 5 && !showAll ? `<button class="btn" type="button" id="past-more">Show all ${past.length} past rides</button>` : ''}` : '<p class="faint small">Nothing yet.</p>'}
          </div>`;
        const more = $('#past-more', v); if (more) more.onclick = () => { showAll = true; last = ''; refresh(); };
        $('#new-trip', v).onclick = () => { tab = 'book'; draw(); };
        $$('[data-act]', v).forEach((b) => { b.onclick = () => act(b.dataset.act, trips.find((t) => t.id === b.dataset.id), b); });
      };
      current = { poll: true, refresh };
      v.innerHTML = '<p class="faint">Loading…</p>';
      refresh();
      // A finished ride as one compact row: when, where, price, rating, receipt.
      function pastRow(t) {
        const to = t.dropoff ? t.dropoff.split(',')[0] : `${t.hours} h as directed`;
        const rate = t.status === 'completed' && t.driver && !t.rating;
        return `<div class="pastrow">
          <div class="pr-main"><div class="row"><b>${esc(fmtDT(t.pickupAt))}</b><span class="faint small">${esc(t.ref)}</span>${t.status === 'cancelled' ? pill(t) : ''}</div>
            <div class="small muted">${t.agent ? `${esc(t.passengerName || 'Client')} · ` : ''}${esc(t.pickup.split(',')[0])} → ${esc(to)}${t.commission ? ` · commission ${money(t.commission)}` : ''}</div>
            ${t.rating ? `<span class="stars sm">${stars(t.rating.stars)}</span>` : rate ? `<span class="row small"><span class="muted">Rate ${esc(t.driver.name.split(' ')[0])}:</span><span class="stars rate sm">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-act="rate" data-id="${t.id}" data-stars="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</span></span>` : ''}
            ${t.pay && t.status === 'cancelled' && cardLine(t, 'customer') ? `<div class="small muted">${cardLine(t, 'customer')}</div>` : ''}${t.noShow ? `<div class="small muted">No-show${t.noShow.fee ? `, fee ${money(t.noShow.fee)}` : ''}</div>` : ''}${t.cancelFee && !t.pay ? `<div class="small muted">Late cancellation fee ${money(t.cancelFee)}</div>` : ''}</div>
          <div class="pr-side"><b class="num">${money(t.price.total)}</b>${t.status === 'completed' || t.payment.status === 'paid' ? `<button class="linkbtn small" type="button" data-act="receipt" data-id="${t.id}">Receipt</button>` : ''}</div></div>`;
      }
      function tripCard(t) {
        const step = STEP_OF[t.status];
        const canCancel = ['confirmed', 'assigned', 'accepted'].includes(t.status);
        const showDriver = t.driver && ['accepted', 'en_route', 'arrived', 'on_board', 'completed'].includes(t.status);
        return `<article class="trip">
          <div class="spread"><div class="row"><b>${esc(fmtDT(t.pickupAt))}</b><span class="mono faint small">${esc(t.ref)}</span></div><div class="row">${pill(t)}${payPill(t)}</div></div>
          ${t.agent ? `<div class="small forline">For <b>${esc(t.passengerName || 'client')}</b>${t.passengerPhone ? ` · ${esc(t.passengerPhone)}` : ''}${t.agent.payBy === 'passenger' ? ' · client pays' : ''}${t.agent.pct ? ` · ${t.agent.pct}% commission` : ''}</div>` : ''}
          ${routeHtml(t)}
          ${t.pair ? `<div class="small muted">${t.pair.kind === 'return' ? `Return trip booked: ${esc(t.pair.ref)}, ${esc(fmtDT(t.pair.pickupAt))}` : `Return of ${esc(t.pair.ref)}`}</div>` : ''}
          ${t.landing ? `<div class="small landtag">${t.landing.kind === 'landing' ? `Ride when you land${t.landing.city ? ` in ${esc(t.landing.city)}` : ''}: ${esc(t.landing.ref)}` : `Your ride when you land, after ${esc(t.landing.ref)}`}${t.awayTime ? ` · ${esc(t.awayTime)}` : ''}${t.outOfTown && t.outOfTown.partnerName ? ` · driven by ${esc(t.outOfTown.partnerName)}` : t.outOfTown ? ' · we are booking a local car' : ''}</div>` : ''}
          ${extrasList(t).length ? `<div class="small muted">${esc(extrasList(t).join(' · '))}</div>` : ''}
          ${!['cancelled', 'completed'].includes(t.status) ? `<div><div class="steps">${[0, 1, 2, 3, 4, 5].map((i) => `<div class="${i <= step ? 'on' : ''}"></div>`).join('')}</div>
            <div class="steplabels">${['Booked', 'Chauffeur', 'On the way', 'Arrived', 'On board', 'Done'].map((l, i) => `<span class="${i === step ? 'cur' : ''}">${l}</span>`).join('')}</div></div>` : ''}
          <div class="spread small">
            <span class="muted">${esc(t.serviceLabel)} · ${esc(t.vehicleType)} · ${t.passengers} pax${t.flight ? ' · Flight ' + esc(t.flight) : ''}</span>
            <b class="num" style="font-size:16px">${money(t.price.total)}</b></div>
          ${t.flightInfo && !['completed', 'cancelled'].includes(t.status) ? `<div class="row small">${flightPill(t.flightInfo)}<span class="muted">${t.flightInfo.kind === 'arrival' ? 'Lands' : 'Departs'} ${esc(fmtTime(t.flightInfo.estimated))}${t.flightInfo.terminal ? ' · Terminal ' + esc(t.flightInfo.terminal) : ''}</span></div>` : ''}
          ${t.scheduledPickupAt && t.scheduledPickupAt !== t.pickupAt && !['completed', 'cancelled'].includes(t.status) ? `<div class="note">Your flight time changed, so we moved your pickup from ${esc(fmtTime(t.scheduledPickupAt))} to <b>${esc(fmtTime(t.pickupAt))}</b>. No need to do anything.</div>` : ''}
          ${t.status === 'completed' && t.driver ? (t.rating ? `<div class="small muted">You rated this ride <span class="stars">${'★'.repeat(t.rating.stars)}${'☆'.repeat(5 - t.rating.stars)}</span></div>` : `<div class="row small"><span class="muted">Rate your ride with ${esc(t.driver.name.split(' ')[0])}:</span><span class="stars rate">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-act="rate" data-id="${t.id}" data-stars="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</span></div>`) : ''}
          ${t.live ? trackMap(t.live, t.pickup) : ''}
          ${showDriver ? chauffeurCard(t.driver, t.vehicle, t.status === 'en_route' ? 'On the way to you now.' : t.status === 'arrived' ? 'Waiting at your pickup.' : '') : ''}
          <div class="row">
            ${t.account && t.status !== 'cancelled' ? `<span class="small muted">Billed to ${esc(t.account.name)}${t.poNumber ? ' · PO ' + esc(t.poNumber) : ''}</span>` : ''}
            ${t.pay && (t.pay.needsCard || t.pay.failed) && t.status !== 'cancelled' ? (t.agent && t.agent.payBy === 'passenger' ? `<span class="small muted">Waiting for ${esc((t.passengerName || 'your client').split(' ')[0])} to add a card. <a href="#card.${esc(t.cardToken)}">Add it for them</a></span>` : `<a class="btn brand sm" href="#card.${esc(t.cardToken)}">${t.pay.needsCard ? 'Add a card' : 'Update card'}</a>`) : ''}
            ${!t.pay && t.status !== 'cancelled' && t.payment.status !== 'paid' && !t.account && session.company.cards !== false ? `<button class="btn brand sm" type="button" data-act="pay" data-id="${t.id}">Pay ${money(t.price.total - (t.payment.deposit || 0))}${t.payment.deposit ? ' balance' : ''}</button>` : ''}
            ${t.payment.status === 'paid' || t.status === 'completed' ? `<button class="btn sm" type="button" data-act="receipt" data-id="${t.id}">Receipt</button>` : ''}
            ${canCancel ? `<button class="btn sm danger" type="button" data-act="cancel" data-id="${t.id}">Cancel ride</button>` : ''}
          </div>
          ${t.pay && cardLine(t, 'customer') ? `<div class="small ${t.pay.failed ? 'err-text' : 'muted'}">${cardLine(t, 'customer')}</div>` : ''}
          ${canCancel && t.cancelTerms ? `<div class="small faint">${t.cancelTerms.fee ? `Free cancellation ended ${esc(fmtDT(t.cancelTerms.freeUntil))}. Cancelling now costs ${money(t.cancelTerms.fee)}.` : `Free cancellation until ${esc(fmtDT(t.cancelTerms.freeUntil))}.`}</div>` : ''}
          ${t.status === 'cancelled' && t.cancelFee ? `<div class="small muted">Late cancellation fee: ${money(t.cancelFee)}</div>` : ''}
          ${t.noShow ? `<div class="small muted">Your chauffeur waited${t.noShow.waitedMin ? ` ${t.noShow.waitedMin} min` : ''} at pickup.${t.noShow.fee ? ` No-show fee: ${money(t.noShow.fee)}.` : ''}${session.company.phone ? ` If this is wrong, call ${esc(session.company.phone)}.` : ''}</div>` : ''}</article>`;
      }
      async function act(kind, t, btn) {
        if (kind === 'cancel') {
          const fee = t.cancelTerms && t.cancelTerms.fee;
          if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = fee ? `Tap again to cancel (${money(fee)} fee)` : 'Tap again to cancel'; setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = 'Cancel ride'; } }, 5000); return; }
          await busy(btn, async () => { try { await api('customer.cancel', { id: t.id, acceptFee: !!fee }); toast(fee ? `${t.ref} cancelled. Late cancellation fee ${money(fee)}.` : `${t.ref} cancelled.`); last = ''; refresh(); } catch (e) { toast(e.message, true); } });
        }
        if (kind === 'pay') payModal(t, () => { last = ''; refresh(); });
        if (kind === 'receipt') receiptModal(t);
        if (kind === 'rate') await busy(btn, async () => { try { await api('customer.rate', { id: t.id, stars: +btn.dataset.stars }); toast('Thanks for rating your ride.'); last = ''; refresh(); } catch (e) { toast(e.message, true); } });
      }
    }
    draw();
  }

  function payModal(t, done) {
    const due = t.price.total - (t.payment.deposit || 0);
    if (session.company.payMode === 'stripe') {
      const m = openModal({
        title: `Pay for ${t.ref}`,
        body: `<div class="spread"><span class="muted">${esc(fmtDT(t.pickupAt))}</span><b class="num" style="font-size:22px">${money(due)}</b></div>
          <p class="note">You'll pay on a secure Stripe page. The payment goes straight to ${esc(session.company.name)}, then you come back here.</p><div id="pay-err"></div>`,
        footer: `<button class="btn" type="button" data-close>Not now</button><button class="btn brand" type="button" id="pay-go">Pay ${money(due)} by card</button>`,
      });
      $('[data-close]', m).onclick = closeModal;
      $('#pay-go', m).onclick = (e) => busy(e.currentTarget, async () => {
        try { const r = await payApi('checkout', { kind: 'trip', id: t.id }); location.href = r.url; await new Promise(() => {}); } catch (err) { showErr($('#pay-err', m), err); }
      });
      return;
    }
    const m = openModal({
      title: `Pay for ${t.ref}`,
      body: `<div class="spread"><span class="muted">${esc(fmtDT(t.pickupAt))}</span><b class="num" style="font-size:22px">${money(t.price.total)}</b></div>
        <form id="pay-form" class="stack" novalidate>
          <label class="field"><span>Card number</span><input id="pay-card" class="mono" value="4242 4242 4242 4242" inputmode="numeric"></label>
          <div class="grid2"><label class="field"><span>Expiry</span><input id="pay-exp" class="mono" value="12 / 30"></label><label class="field"><span>CVC</span><input id="pay-cvc" class="mono" value="123"></label></div>
          <p class="note">This is a demo payment and no card is charged. When Stripe is connected, payments go straight to ${esc(session.company.name)}.</p>
          <div id="pay-err"></div></form>`,
      footer: `<button class="btn" type="button" data-close>Not now</button><button class="btn brand" type="button" id="pay-go">Pay ${money(t.price.total)}</button>`,
    });
    $('[data-close]', m).onclick = closeModal;
    $('#pay-go', m).onclick = (e) => busy(e.currentTarget, async () => {
      try {
        const digits = $('#pay-card', m).value.replace(/\D/g, '');
        if (digits.length < 12) throw new Error('Enter the full card number.');
        await api('customer.pay', { id: t.id, last4: digits.slice(-4) });
        closeModal(); toast('Payment received. Thank you.'); done && done();
      } catch (err) { showErr($('#pay-err', m), err); }
    });
  }

  function receiptModal(t) {
    const m = openModal({
      title: `Receipt ${t.ref}`,
      body: `<div class="stack">
        <div class="spread"><b>${esc(session.company.name)}</b><span class="mono small faint">${esc(t.ref)}</span></div>
        <dl class="kv"><dt>Date</dt><dd>${esc(fmtDT(t.pickupAt))}</dd><dt>Passenger</dt><dd>${esc(t.passengerName)}</dd>
          <dt>From</dt><dd>${esc(t.pickup)}</dd>${t.dropoff ? `<dt>To</dt><dd>${esc(t.dropoff)}</dd>` : ''}
          <dt>Vehicle</dt><dd>${esc(t.vehicle ? t.vehicle.name : t.vehicleType)}</dd>${t.driver ? `<dt>Chauffeur</dt><dd>${esc(t.driver.name)}</dd>` : ''}</dl>
        <div>${quoteLines(t.price)}
          <div class="qline" style="border-bottom:0;font-weight:700"><span style="color:var(--ink)">Total</span><span class="num">${money(t.price.total)}</span></div></div>
        <p class="small muted">${t.account && t.payment.status !== 'paid' ? `Billed to ${esc(t.account.name)} on the monthly invoice${t.poNumber ? `, PO ${esc(t.poNumber)}` : ''}.` : t.payment.status === 'paid' ? `Paid by ${esc(t.payment.method === 'card_on_file' ? 'card' : t.payment.method)}${t.payment.last4 ? ' ending ' + esc(t.payment.last4) : ''} on ${esc(fmtDT(t.payment.paidAt))}.` : 'Not paid yet.'}</p></div>`,
      footer: '<button class="btn" type="button" data-close>Close</button>',
    });
    $('[data-close]', m).onclick = closeModal;
  }

  // ---- Driver ---------------------------------------------------------------
  // Asks before closing a trip as a no-show; the note goes in the trip history.
  function noShowModal(t, method, done) {
    const fee = (t.price && t.price.total) || 0;
    const m = openModal({
      title: `Passenger no-show, ${t.ref}`,
      body: `<div class="stack"><p>${esc(t.passengerName || 'The passenger')} will get a text saying the trip is closed as a no-show${t.wait ? `. You arrived for a ${t.wait.freeMin} min free wait` : ''}.</p>
        <label class="field"><span>What happened (optional)</span><input id="ns-note" maxlength="200" placeholder="Called twice, no answer"></label>
        <p class="small faint">The trip is marked cancelled, and the no-show fee is recorded for the office. Fare was ${money(fee)}.</p><div id="ns-err"></div></div>`,
      footer: '<button class="btn" type="button" data-close>Keep waiting</button><button class="btn danger" type="button" id="ns-go">Mark no-show</button>',
    });
    $('[data-close]', m).onclick = closeModal;
    $('#ns-go', m).onclick = (e) => busy(e.currentTarget, async () => {
      try { const r = await api(method, { id: t.id, note: $('#ns-note', m).value }); closeModal(); toast(`${t.ref} closed as a no-show${r.noShow && r.noShow.fee ? `. Fee ${money(r.noShow.fee)}` : ''}.`); done(); } catch (err) { showErr($('#ns-err', m), err); }
    });
  }
  const hm = (min) => { min = Math.round(min || 0); return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`; };
  // Report or edit an incident. Drivers report; the office can also edit and close.
  function incidentModal(x, opts) {
    const office = !!opts.office, ro = '';
    const K = C.INCIDENT_KINDS;
    const localVal = (iso) => { const d = new Date(iso || Date.now()); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
    const m = openModal({
      title: x.id ? `Incident: ${x.kindLabel}` : 'Report an incident',
      body: `<form class="stack" id="inc-f" novalidate>
        ${x.trip ? `<p class="small muted">Trip ${esc(x.trip.ref)} · ${esc(x.trip.passengerName || '')} · ${esc(fmtDT(x.trip.pickupAt))}</p>` : ''}
        <div class="grid2"><label class="field"><span>What happened</span><select name="kind" ${ro}><option value="">Choose…</option>${Object.entries(K).map(([k, l]) => `<option value="${k}" ${x.kind === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label class="field"><span>How serious</span><select name="severity">${[['low', 'Minor'], ['medium', 'Moderate'], ['high', 'Serious']].map(([k, l]) => `<option value="${k}" ${(x.severity || 'medium') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
        <div class="grid2"><label class="field"><span>When</span><input type="datetime-local" name="happenedAt" value="${localVal(x.happenedAt)}"></label>
          <label class="field"><span>Where (optional)</span><input name="location" maxlength="200" value="${esc(x.location || '')}"></label></div>
        <label class="field"><span>Details</span><textarea name="description" rows="4" maxlength="2000" placeholder="What happened, who was involved, any damage or injuries">${esc(x.description || '')}</textarea></label>
        ${office ? `<div class="grid2"><label class="field"><span>Trip number (optional)</span><input name="tripRef" value="${esc(x.trip ? x.trip.ref : '')}" placeholder="${esc(session.company.refPrefix || 'CR')}-1234"></label>
            <label class="field"><span>Driver</span><select name="driverId"><option value="">None</option>${(opts.drivers || []).map((d) => `<option value="${d.id}" ${x.driver && x.driver.id === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label></div>
          <label class="field"><span>What was done about it</span><textarea name="resolution" rows="2" maxlength="1000">${esc(x.resolution || '')}</textarea></label>
          <label class="switch"><input type="checkbox" name="closed" ${x.status === 'closed' ? 'checked' : ''}><span>Closed</span></label>
          ${x.reportedBy ? `<p class="small faint">Reported by ${esc(x.reportedBy)} on ${esc(fmtDT(x.createdAt))}${x.closedBy ? ` · closed by ${esc(x.closedBy)}` : ''}</p>` : ''}` : '<p class="small faint">Dispatch sees this right away. If anyone is hurt, call 911 first.</p>'}
        <div id="inc-err"></div></form>`,
      footer: `<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="inc-save">${x.id ? 'Save' : 'Send report'}</button>`,
    });
    $('[data-close]', m).onclick = closeModal;
    $('#inc-save', m).onclick = (e) => busy(e.currentTarget, async () => {
      const f = formData($('#inc-f', m));
      const args = { ...f, happenedAt: f.happenedAt ? new Date(f.happenedAt).toISOString() : '', tripId: x.trip ? x.trip.id : undefined };
      try {
        if (office) await api('dispatch.saveIncident', { ...args, id: x.id, status: $('[name=closed]', m).checked ? 'closed' : 'open' });
        else await api('driver.reportIncident', args);
        closeModal(); toast(office ? 'Incident saved.' : 'Report sent to dispatch.'); opts.done && opts.done();
      } catch (err) { showErr($('#inc-err', m), err); }
    });
  }
  // Printable trip sheets (driver manifests), one page per driver.
  function printSheets(trips, title) {
    const live = trips.filter((t) => t.status !== 'cancelled').sort((a, b) => a.pickupAt.localeCompare(b.pickupAt));
    if (!live.length) return toast('No trips to print.');
    const groups = new Map();
    for (const t of live) { const k = t.driver ? t.driver.name : 'Unassigned'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
    const sheet = ([name, list]) => `<section class="sheet"><div class="spread"><div><h2>${esc(name)}</h2><p class="small muted">${esc(session.company.name)} · trip sheet · ${esc(title)}</p></div><b>${list.length} trip${list.length === 1 ? '' : 's'}</b></div>
      <table class="sheettable"><thead><tr><th>Time</th><th>Trip</th><th>Passenger</th><th>Route</th><th>Details</th><th class="r">Fare</th></tr></thead><tbody>
      ${list.map((t) => `<tr><td class="mono">${esc(fmtTime(t.pickupAt))}</td><td class="mono">${esc(t.ref)}<br><span class="small">${esc(t.vehicle ? t.vehicle.name + (t.vehicle.plate ? ' · ' + t.vehicle.plate : '') : t.vehicleType)}</span></td>
        <td><b>${esc(t.passengerName)}</b><br><span class="mono small">${esc(t.passengerPhone || '')}</span>${t.passengers > 1 ? `<br><span class="small">${t.passengers} passengers</span>` : ''}</td>
        <td>${esc(t.pickup)}${(t.stopList || []).map((x) => `<br><span class="small">via ${esc(x)}</span>`).join('')}${t.dropoff ? `<br>→ ${esc(t.dropoff)}` : `<br><span class="small">${t.hours} h by the hour</span>`}</td>
        <td class="small">${[t.flight ? `Flight ${t.flight}` : '', ...extrasList(t), t.notes || ''].filter(Boolean).map(esc).join('<br>')}</td>
        <td class="r num">${t.farmIn ? 'Partner' : t.accountId ? 'Account' : money(t.price.total)}<br><span class="small">${t.payment.status === 'paid' ? 'Paid' : t.farmIn || t.accountId ? '' : t.pay ? 'On card' : 'Unpaid'}</span></td></tr>`).join('')}
      </tbody></table>
      <div class="sheetsign"><span>Start mileage ________</span><span>End mileage ________</span><span>Signature ______________________</span></div></section>`;
    const m = openModal({ title: `Trip sheets · ${title}`, wide: true, body: `<div id="sheet-print">${[...groups].map(sheet).join('')}</div>`, footer: '<button class="btn" type="button" data-close>Close</button><button class="btn primary" type="button" id="sheet-go">Print</button>' });
    $('[data-close]', m).onclick = closeModal;
    $('#sheet-go', m).onclick = () => { document.body.classList.add('printing-sheet'); setTimeout(() => { window.print(); document.body.classList.remove('printing-sheet'); }, 50); };
  }
  const waitLine = (t) => { if (!t.wait) return ''; const over = new Date(t.wait.endsAt) <= new Date(); return `${over ? 'Free waiting ended' : 'Free waiting until'} <b>${esc(fmtTime(t.wait.endsAt))}</b> (${t.wait.freeMin} min${t.wait.airport ? ' at the airport' : ''})`; };
  const NEXT_LABEL = { accepted: 'Start trip: drive to pickup', en_route: "I've arrived at pickup", arrived: 'Passenger on board', on_board: 'Complete trip' };
  const stars = (n) => '★★★★★'.slice(0, Math.round(n)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(n));
  // The driver's phone shares GPS from "on the way" until drop-off. The passenger only sees it while the car is on the way; dispatch sees it on the live map.
  const gps = { watch: null, tripId: null, last: 0, state: 'idle' };
  function shareLocation(tripId) {
    if (gps.tripId === tripId) return;
    if (gps.watch != null && navigator.geolocation) navigator.geolocation.clearWatch(gps.watch);
    gps.watch = null; gps.tripId = tripId; gps.last = 0;
    if (!tripId) { gps.state = 'idle'; return; }
    if (!navigator.geolocation) { gps.state = 'unsupported'; return; }
    gps.state = 'asking';
    try {
      gps.watch = navigator.geolocation.watchPosition((p) => {
        if (gps.state !== 'sharing') { gps.state = 'sharing'; const el = $('#drv-gps'); if (el) el.textContent = GPS_TEXT.sharing; }
        if (Date.now() - gps.last < 10000) return;
        gps.last = Date.now();
        api('driver.location', { id: tripId, lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }).catch(() => {});
      }, () => { gps.state = 'denied'; const el = $('#drv-gps'); if (el) el.textContent = GPS_TEXT.denied; }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    } catch (e) { gps.state = 'denied'; }
  }
  const GPS_TEXT = {
    asking: 'Allow location so the passenger can follow you live.',
    sharing: 'Sharing your location with the passenger and dispatch.',
    denied: 'Location is off on this phone. The passenger sees an estimated position.',
    unsupported: 'This phone can’t share location. The passenger sees an estimated position.',
  };

  // The driver's own rides on a month or week calendar, in a full-width sheet.
  function driverCalendar() {
    const m = openModal({ title: 'My calendar', wide: true, body: '<div id="dcal"></div><div id="dcal-detail"></div>' });
    rideCalendar($('#dcal', m), {
      key: 'livery-cal-view-' + session.user.id,
      load: async (from, to) => (await api('driver.trips')).trips.filter((t) => t.pickupAt >= from && t.pickupAt < to),
      open: (t) => {
        const el = $('#dcal-detail', m);
        el.innerHTML = `<div class="trip" style="margin-top:14px"><div class="spread"><b>${esc(fmtDT(t.pickupAt))}</b>${pill(t)}</div>${routeHtml(t)}
          <p class="small muted">${esc(t.passengerName || '')} · ${t.passengers} pax · ${esc(t.serviceLabel)} · ${esc(t.vehicle ? t.vehicle.name : t.vehicleType)} · ${esc(t.ref)}${t.flight ? ` · ✈ ${esc(t.flight)}` : ''}</p></div>`;
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      },
    });
  }

  function viewDriver() {
    const v = shell({ narrow: true });
    let last = '';
    const savePhoto = async (photo) => { const u = await api('driver.setPhoto', { photo }); last = ''; refresh(true); return u; };
    function myPhoto(me) {
      const m = openModal({ title: 'My photo', body: '<div id="mp"></div>' });
      const draw = (photo) => { $('#mp', m).innerHTML = photoField(me.name, photo, 'mp-file'); wirePhoto(m, 'mp-file', async (p) => { const u = await savePhoto(p); draw(u.photo); }); };
      draw(me.photo);
    }
    async function refresh(silent) {
      let data;
      try { data = await api('driver.trips'); } catch (e) { if (!silent) showErr(v, e); return; }
      const sig = JSON.stringify(data); if (sig === last) return; last = sig;
      const { me, trips, week, stats, timeOff } = data;
      const waiting = trips.filter((t) => t.status === 'assigned');
      const live = trips.find((t) => ['en_route', 'arrived', 'on_board'].includes(t.status)) || trips.find((t) => t.status === 'accepted');
      const upcoming = trips.filter((t) => t.status === 'accepted' && t !== live);
      const done = trips.filter((t) => t.status === 'completed').slice(-5).reverse();
      const flightLine = (t) => t.flightInfo ? `<div class="row small">${flightPill(t.flightInfo)}<span class="muted">${esc(t.flight)} ${t.flightInfo.kind === 'arrival' ? 'lands' : 'departs'} ${esc(fmtTime(t.flightInfo.estimated))}${t.flightInfo.terminal ? ` · Terminal ${esc(t.flightInfo.terminal)}` : ''}${t.flightInfo.claim ? ` · claim ${t.flightInfo.claim}` : ''}</span></div>` : '';
      v.innerHTML = `
        <div class="stack" style="gap:18px">
          <div class="spread"><div><h1>${esc(me.name.split(' ')[0])}'s trips</h1><p class="muted small">${esc(session.company.name)}</p></div>
            <label class="switch"><input type="checkbox" id="drv-avail" ${me.available ? 'checked' : ''}><span>${me.available ? 'Available' : 'Off duty'}</span></label></div>
          ${me.photo ? '' : `<div class="panel">${photoField(me.name, '', 'drv-photo')}</div>`}
          ${data.clock ? `<div class="panel clockbar"><div class="stack" style="gap:2px"><b>${data.clock.on ? 'Clocked in' : 'Not clocked in'}</b><span class="small muted">${data.clock.on ? `Since ${esc(fmtTime(data.clock.since))} · ` : ''}Today ${hm(data.clock.todayMin)} · This week ${hm(data.clock.weekMin)}</span></div>
            <button class="btn sm ${data.clock.on ? '' : 'primary'}" type="button" data-act="clock" data-in="${data.clock.on ? '0' : '1'}">${data.clock.on ? 'Clock out' : 'Clock in'}</button></div>` : ''}
          ${waiting.length ? `<div class="stack"><span class="label">Needs your answer</span>${waiting.map((t) => `
            <div class="trip"><div class="spread"><b>${esc(fmtDT(t.pickupAt))}</b><span class="mono small faint">${esc(t.ref)}</span></div>
              ${routeHtml(t)}${flightLine(t)}<p class="small muted">${esc(t.serviceLabel)} · ${esc(t.vehicle ? t.vehicle.name : t.vehicleType)} · ${t.passengers} pax${extrasList(t).length ? ' · ' + esc(extrasList(t).join(' · ')) : ''}</p>
              ${t.offer ? `<p class="small offertag">Accept within ${minsLeft(t.offer.expiresAt)} min or it goes to another driver.</p>` : ''}
              <div class="grid2"><button class="btn primary" type="button" data-act="accept" data-id="${t.id}">Accept</button><button class="btn" type="button" data-act="decline" data-id="${t.id}">Decline</button></div></div>`).join('')}</div>` : ''}
          ${live ? `<div class="stack"><span class="label">${live.status === 'accepted' ? 'Next trip' : 'Current trip'}</span>
            <div class="trip drv-current">
              <div class="spread"><b style="font-size:18px">${esc(fmtTime(live.pickupAt))} <span class="muted" style="font-weight:500;font-size:14px">${esc(fmtDate(live.pickupAt))}</span></b>${pill(live)}</div>
              ${live.pickupAt !== live.scheduledPickupAt ? `<div class="note small">Pickup moved from ${esc(fmtTime(live.scheduledPickupAt))} to match the flight.</div>` : ''}
              ${routeHtml(live)}${flightLine(live)}
              ${live.status === 'en_route' ? `<p class="note small gpsnote" id="drv-gps">${esc(GPS_TEXT[gps.tripId === live.id && gps.state !== 'idle' ? gps.state : 'asking'])}</p>` : ''}
              <dl class="kv"><dt>Passenger</dt><dd>${esc(live.passengerName)} · ${live.passengers} pax</dd>
                ${live.passengerPhone ? `<dt>Phone</dt><dd class="mono">${esc(live.passengerPhone)}</dd>` : ''}
                <dt>Vehicle</dt><dd>${esc(live.vehicle ? `${live.vehicle.name} · ${live.vehicle.plate}` : live.vehicleType)}</dd>
                <dt>Service</dt><dd>${esc(live.serviceLabel)}${live.service === 'hourly' ? `, ${live.hours} h` : ''}</dd>
                ${extrasList(live).length ? `<dt>Requests</dt><dd>${esc(extrasList(live).join(' · '))}</dd>` : ''}
                ${live.notes ? `<dt>Notes</dt><dd>${esc(live.notes)}</dd>` : ''}
                ${live.farmIn ? `<dt>Fare</dt><dd>Billed to ${esc(live.farmIn.fromName)}. Don't collect payment.</dd>` : live.pay ? `<dt>Fare</dt><dd><span class="num">${money(live.price.total)}</span> · on the customer's card. Don't collect payment; waiting time and tolls you add go on the card after the ride.</dd>` : `<dt>Fare</dt><dd><span class="num">${money(live.price.total)}</span> · the office handles payment. Don't take payment from the passenger.</dd>`}</dl>
              <button class="btn primary drv-next" type="button" data-act="advance" data-id="${live.id}">${esc(NEXT_LABEL[live.status])}</button>
              <div class="grid2 drv-btns"><a class="btn" href="${esc(mapsLink(live.status === 'on_board' && live.dropoff ? live.dropoff : live.pickup))}" target="_blank" rel="noopener">Navigate to ${live.status === 'on_board' && live.dropoff ? 'drop-off' : 'pickup'}</a>
              ${['accepted', 'en_route', 'arrived'].includes(live.status) ? `<button class="btn" type="button" data-act="sign" data-id="${live.id}">Show name sign</button>` : `<button class="btn" type="button" data-act="incident" data-id="${live.id}">Report an incident</button>`}</div>
              ${live.status === 'arrived' && live.wait ? `<div class="waitbox"><span class="small">${waitLine(live)}</span><button class="btn sm danger" type="button" data-act="noshow" data-id="${live.id}">Passenger didn't show</button></div>` : ''}
              ${['arrived', 'on_board'].includes(live.status) ? `<form class="grid2" id="drv-extras" data-id="${live.id}">
                <label class="field"><span>Wait time (min)</span><input id="ex-wait" name="waitMin" type="number" min="0" value="${live.waitMin || 0}"></label>
                <label class="field"><span>Tolls and parking ($)</span><input id="ex-tolls" name="tolls" type="number" min="0" step="0.01" value="${live.tolls || 0}"></label>
                <button class="btn" type="submit" style="grid-column:1/-1">Save extras</button></form>` : ''}
              ${['accepted', 'en_route', 'arrived'].includes(live.status) ? `<button class="linkbtn small drv-inc" type="button" data-act="incident" data-id="${live.id}">Report an incident</button>` : ''}
            </div></div>` : (waiting.length ? '' : '<div class="panel muted">No trips right now. New assignments show up here.</div>')}
          <div class="row"><button class="btn" type="button" data-act="calendar">My calendar</button>${me.photo ? `<button class="btn" type="button" data-act="photo">My photo</button>` : ''}</div>
          ${upcoming.length ? `<div class="stack"><span class="label">Coming up</span>${upcoming.map((t) => `<div class="trip"><div class="spread"><b>${esc(fmtDT(t.pickupAt))}</b><span class="mono small faint">${esc(t.ref)}</span></div>${routeHtml(t)}${flightLine(t)}</div>`).join('')}</div>` : ''}
          <div class="stack"><span class="label">This week</span>
            <div class="tiles three">
              <div class="tile"><span class="label">Pay so far</span><b>${money(week.total)}</b><span class="small faint">${week.trips} trips · ${money(week.tips)} tips</span></div>
              <div class="tile"><span class="label">Rating</span><b>${stats.rating == null ? '—' : stats.rating.toFixed(1)}</b><span class="small faint">${stats.ratings} ratings</span></div>
              <div class="tile"><span class="label">On time</span><b>${stats.onTime == null ? '—' : stats.onTime + '%'}</b><span class="small faint">Last 30 days</span></div>
            </div>
            <p class="small faint">Pay is ${me.payType === 'hourly' ? `${money(me.payRate)} per hour` : me.payType === 'perTrip' ? `${money(me.payRate)} per trip` : `${me.payRate}% of the fare`}, plus all tips and tolls back.</p>
          </div>
          ${done.length ? `<div class="stack"><span class="label">Recently completed</span><div class="tablewrap"><table><tbody>${done.map((t) => `<tr><td class="mono small">${esc(fmtDT(t.pickupAt))}</td><td>${esc(t.passengerName)}${t.rating ? `<br><span class="stars small" title="${t.rating.stars} stars">${stars(t.rating.stars)}</span>` : ''}</td><td class="r num">${money(t.price.total)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
          ${live ? '' : '<div class="row"><button class="btn sm" type="button" data-act="incident" data-id="">Report an incident</button></div>'}
          <div class="stack"><span class="label">Time off</span>
            <form class="panel stack" id="drv-off" novalidate>
              <div class="grid2"><label class="field"><span>First day off</span><input id="off-from" name="from" type="date"></label><label class="field"><span>Last day off</span><input id="off-to" name="to" type="date"></label></div>
              <label class="field"><span>Reason (optional)</span><input id="off-reason" name="reason"></label>
              <div id="off-err"></div><button class="btn" type="submit">Ask for time off</button>
              ${timeOff.length ? `<div>${timeOff.map((x) => `<div class="qline small"><span>${esc(fmtDays(x.from, x.to))}${x.reason ? ' · ' + esc(x.reason) : ''}</span><span class="pill ${x.status === 'approved' ? 's-on_board' : x.status === 'declined' ? 's-cancelled' : 's-assigned'}">${x.status === 'requested' ? 'Waiting' : x.status === 'approved' ? 'Approved' : 'Declined'}</span></div>`).join('')}</div>` : ''}
            </form></div>
        </div>`;
      shareLocation(live && ['en_route', 'arrived', 'on_board'].includes(live.status) ? live.id : null);
      $('#drv-avail', v).onchange = async (e) => { try { await api('driver.availability', { available: e.target.checked }); last = ''; refresh(); } catch (err) { toast(err.message, true); } };
      wirePhoto(v, 'drv-photo', savePhoto);
      $$('[data-act]', v).forEach((b) => { b.onclick = () => b.dataset.act === 'calendar' ? driverCalendar() : b.dataset.act === 'photo' ? myPhoto(me) : b.dataset.act === 'sign' ? nameSign(trips.find((x) => x.id === b.dataset.id)) : b.dataset.act === 'incident' ? incidentModal({ trip: (() => { const t = trips.find((x) => x.id === b.dataset.id); return t ? { id: t.id, ref: t.ref, pickupAt: t.pickupAt, passengerName: t.passengerName } : null; })() }, { done: () => {} }) : b.dataset.act === 'noshow' ? noShowModal(trips.find((x) => x.id === b.dataset.id), 'driver.noShow', () => { last = ''; refresh(); }) : busy(b, async () => {
        const id = b.dataset.id;
        try {
          if (b.dataset.act === 'accept') { await api('driver.respond', { id, accept: true }); toast('Trip accepted. The passenger has been told.'); }
          if (b.dataset.act === 'decline') { await api('driver.respond', { id, accept: false }); toast('Declined. Dispatch will reassign it.'); }
          if (b.dataset.act === 'advance') { const t = await api('driver.advance', { id }); toast(t.statusLabel + '.'); }
          if (b.dataset.act === 'clock') { const c = await api('driver.clock', { in: b.dataset.in === '1' }); toast(c.on ? 'Clocked in.' : `Clocked out. ${hm(c.todayMin)} today.`); }
          last = ''; refresh();
        } catch (err) { toast(err.message, true); }
      }); });
      const ex = $('#drv-extras', v);
      if (ex) ex.onsubmit = async (e) => { e.preventDefault(); try { await api('driver.extras', { id: ex.dataset.id, ...formData(ex) }); toast('Extras saved and fare updated.'); last = ''; refresh(); } catch (err) { toast(err.message, true); } };
      $('#drv-off', v).onsubmit = async (e) => {
        e.preventDefault();
        try { await api('driver.requestTimeOff', formData(e.target)); toast('Request sent to dispatch.'); last = ''; refresh(); } catch (err) { showErr($('#off-err', v), err); }
      };
    }
    current = { poll: true, refresh };
    v.innerHTML = '<p class="faint">Loading…</p>';
    refresh();
  }
  function routeHtml(t) {
    const stops = (t.stopList || []).map((x, i) => `<span class="bar"></span><span></span><i class="mid"></i><div class="small">Stop: ${esc(x)}${t.stopWaits && t.stopWaits[i] != null ? ` <span class="muted">· wait ${t.stopWaits[i]} min</span>` : ''}</div>`).join('');
    return `<div class="route"><i></i><div>${esc(t.pickup)}</div>${stops}${t.dropoff ? `<span class="bar"></span><span></span><i class="end"></i><div>${esc(t.dropoff)}</div>` : ''}</div>`;
  }
  // Suitcases, extras and ride preferences in one line, for every screen.
  function extrasList(t) {
    const p = t.prefs || {};
    return [
      t.bags ? `${t.bags} suitcase${t.bags > 1 ? 's' : ''}` : '',
      t.childSeats ? `${t.childSeats} child seat${t.childSeats > 1 ? 's' : ''}` : '',
      t.meetGreet ? `Meet & greet, sign “${t.signName || t.passengerName || 'passenger'}”` : '',
      !(t.stopList && t.stopList.length) && t.stops ? `${t.stops} extra stop${t.stops > 1 ? 's' : ''}` : '',
      p.temp ? `${C.TEMPS[p.temp]} cabin` : '', p.music ? C.MUSIC[p.music] : '', p.quiet ? 'Quiet ride' : '',
    ].filter(Boolean);
  }
  // Full-screen greeting sign the chauffeur holds up at arrivals.
  function nameSign(t) {
    if (!t) return;
    const el = document.createElement('div');
    el.className = 'namesign'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Name sign');
    el.innerHTML = `<div class="ns-name">${esc(t.signName || t.passengerName || 'Welcome')}</div><div class="ns-co">${esc(session.company.name)}</div><div class="ns-hint">Tap anywhere to close</div>`;
    const close = () => { el.remove(); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
    el.onclick = close;
    document.body.appendChild(el);
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  }
  // After booking: keep the new card on the session, or send the customer to
  // Stripe to save one when the ride still needs it.
  async function afterBook(t, b) {
    if (t.card && b && b.card && session && session.user) setSession({ ...session, user: { ...session.user, card: t.card } });
    if (t.pay && t.pay.needsCard && session.company && session.company.payMode === 'stripe') {
      toast(`${bookedMsg(t)} Next, save your card.`);
      const r = await payApi('checkout', { kind: 'card', token: t.cardToken });
      location.href = r.url; await new Promise(() => {});
    }
  }
  const bookedMsg = (t) => (t.returnTrip ? `Booked ${t.ref} and the return ${t.returnTrip.ref}.` : `Booked. Reference ${t.ref}.`) + (t.landingTrip ? ` Your ride when you land is ${t.landingTrip.ref}.` : '');

  // ---- Dispatch -------------------------------------------------------------
  const todayStr = () => toLocalInput(new Date()).slice(0, 10);
  function docState(d) {
    if (!d) return { cls: 'off', label: 'Not set', days: null };
    const days = Math.floor((new Date(d + 'T12:00:00').getTime() - Date.now()) / 86400000);
    if (days < 0) return { cls: 's-cancelled', label: 'Expired', days };
    if (days <= 30) return { cls: 's-assigned', label: `${days} day${days === 1 ? '' : 's'} left`, days };
    return { cls: 's-on_board', label: new Date(d + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }), days };
  }
  const docPill = (label, d) => { const s = docState(d); return `<span class="pill ${s.cls}" title="${esc(label)}">${esc(label)}: ${esc(s.label)}</span>`; };
  const pct = (n) => n == null ? '—' : n + '%';

  function viewDispatch() {
    const isAdmin = session.user.role === 'admin';
    // What this office login may do (admins: everything). The server checks too.
    const P = isAdmin ? new Proxy({}, { get: () => true }) : (session.user.perms || {});
    const tabs = [
      { key: 'board', label: 'Board' }, { key: 'trips', label: 'Trips' }, { key: 'calendar', label: 'Calendar' }, { key: 'quotes', label: 'Quotes' }, { key: 'flights', label: 'Flights' },
      { key: 'drivers', label: 'Drivers' }, { key: 'fleet', label: 'Fleet' }, { key: 'incidents', label: 'Incidents' }, { key: 'customers', label: 'Customers' }, ...(P.reports ? [{ key: 'reports', label: 'Reports' }] : []),
      { key: 'network', label: 'Network' }, { key: 'pricing', label: 'Pricing' }, { key: 'messages', label: 'Texts & emails' },
      { key: 'settings', label: 'Rates & brand' }, ...(isAdmin ? [{ key: 'team', label: 'Team' }] : []),
    ];
    const tabKey = 'livery-dispatch-tab-' + session.user.id;
    let tab = store.get(tabKey) || 'board';
    if (!tabs.some((t) => t.key === tab)) tab = 'board';
    let day = new Date(); day.setHours(0, 0, 0, 0);
    const go2 = (t) => { tab = t; store.set(tabKey, t); draw(); };
    const draw = () => {
      const v = shell({ tabs, active: tab, onTab: go2, wide: tab === 'board' });
      ({ board: drawBoard, trips: drawTrips, calendar: drawCalendar, quotes: drawQuotes, flights: drawFlights, drivers: drawDrivers, fleet: drawFleet, incidents: drawIncidents, customers: drawCustomers, reports: drawReports, network: drawNetwork, pricing: drawPricing, messages: drawMessages, settings: drawSettings, team: drawTeam })[tab](v);
    };
    const warnToast = (r, okText) => {
      if (r.warnings && r.warnings.length) toast(`${okText} Check: ${r.warnings.join(' ')}`, true, 7000);
      else toast(okText);
    };

    // Board ------------------------------------------------------------------
    function drawBoard(v0) {
      v0.innerHTML = '<div id="bd-map"></div><div id="bd-main"><p class="faint">Loading…</p></div>';
      const v = $('#bd-main', v0);
      let last = '';
      const fmap = fleetMap($('#bd-map', v0), (id) => tripModal(id, () => { last = ''; refresh(); }));
      async function refresh(silent) {
        fmap.update();
        const to = new Date(day.getTime()); to.setDate(to.getDate() + 1);
        let b;
        try { b = await api('dispatch.board', { from: day.toISOString(), to: to.toISOString() }); } catch (e) { if (!silent) showErr(v, e); return; }
        const sig = JSON.stringify(b); if (sig === last) return; last = sig;
        const live = b.trips.filter((t) => t.status !== 'cancelled');
        const unassigned = live.filter((t) => t.status === 'confirmed' && !t.farmout);
        const withPartners = live.filter((t) => t.farmout);
        const inProgress = live.filter((t) => ['en_route', 'arrived', 'on_board'].includes(t.status));
        const booked = live.reduce((s, t) => s + t.price.total, 0);
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const isToday = today.getTime() === day.getTime();
        const serious = b.alerts.filter((a) => a.level !== 'info');
        const alertsOpen = store.get('livery-alerts-open') !== '0';
        v.innerHTML = `
          <div class="boardbar">
            <div class="row"><button class="btn sm" type="button" id="d-prev" aria-label="Previous day">‹</button>
              <input class="input" style="width:auto;min-height:34px;padding:4px 8px" type="date" id="d-day" value="${toLocalInput(day).slice(0, 10)}">
              <button class="btn sm" type="button" id="d-next" aria-label="Next day">›</button>
              ${isToday ? '' : '<button class="btn sm" type="button" id="d-today">Today</button>'}</div>
            <h2 style="margin-right:auto">${isToday ? 'Today' : esc(fmtDate(day.toISOString()))}</h2>
            <div class="row small">
              <span class="pill count">${live.length} trips</span>
              <span class="pill ${unassigned.length ? 's-assigned' : ''}">${unassigned.length} unassigned</span>
              <span class="pill s-en_route">${inProgress.length} in progress</span>
              ${P.reports ? `<span class="pill paid">${money0(booked)} booked</span>` : ''}
              ${b.unassignedLater ? `<span class="pill">${b.unassignedLater} unassigned on later days</span>` : ''}
              <button class="btn sm" type="button" id="d-print">Print trip sheets</button>
            </div>
            ${P.bookings ? '<button class="btn primary" type="button" id="d-new">New booking</button>' : ''}
          </div>
          ${serious.length ? `<details class="alerts" id="d-alerts" ${alertsOpen ? 'open' : ''}><summary><b>${serious.length} thing${serious.length === 1 ? '' : 's'} need${serious.length === 1 ? 's' : ''} attention</b> <span class="small faint">dispatch, flights, fleet, drivers and partners</span></summary>
            <ul>${serious.map((a) => `<li class="al-${a.level}"><span class="pill ${a.level === 'bad' ? 's-cancelled' : 's-assigned'}">${a.area === 'flights' ? 'Flight' : a.area === 'fleet' ? 'Fleet' : a.area === 'network' ? 'Network' : a.area === 'dispatch' ? 'Dispatch' : a.area === 'billing' ? 'Billing' : a.area === 'quotes' ? 'Quotes' : 'Driver'}</span>
              ${a.tripId ? `<button type="button" class="linkbtn" data-trip="${a.tripId}">${esc(a.text)}</button>` : `<button type="button" class="linkbtn" data-goto="${a.area}">${esc(a.text)}</button>`}</li>`).join('')}</ul></details>` : ''}
          <div class="board">
            <section class="lane unassigned" data-driver="">
              <div class="lanehead"><div class="grow"><h3>Unassigned</h3><p class="small faint">Drag a trip onto a driver</p></div><span class="pill count">${unassigned.length}</span></div>
              ${unassigned.map(cardHtml).join('') || '<p class="empty">Every trip has a driver.</p>'}
            </section>
            <div class="lanes">${withPartners.length ? `<section class="lane partners">
              <div class="lanehead"><div class="grow"><h3>With partners</h3><p class="small faint">Covered by other companies</p></div><span class="pill count">${withPartners.length}</span></div>
              ${withPartners.map(cardHtml).join('')}</section>` : ''}${b.drivers.map((d) => {
              const mine = b.trips.filter((t) => t.driverId === d.id && t.status !== 'cancelled');
              const veh = b.vehicles.find((x) => x.id === d.vehicleId);
              return `<section class="lane" data-driver="${d.id}">
                <div class="lanehead"><span class="avatar ${d.available && !d.timeOff ? 'on' : ''}">${esc(initials(d.name))}</span>
                  <div class="grow"><h3>${esc(d.name)}</h3><p class="small faint">${d.timeOff ? 'Time off today' : d.available ? 'Available' : 'Off duty'}${veh ? ' · ' + esc(veh.name) : ''}</p></div><span class="pill count">${mine.length}</span></div>
                ${mine.map(cardHtml).join('') || '<p class="empty">No trips</p>'}
              </section>`;
            }).join('') || '<div class="panel muted">No drivers yet. Add them in the Drivers tab.</div>'}</div>
          </div>
          ${b.trips.some((t) => t.status === 'cancelled') ? `<p class="small faint" style="margin-top:12px">${b.trips.filter((t) => t.status === 'cancelled').length} cancelled trip(s) on this day are hidden. See the Trips tab.</p>` : ''}`;
        $('#d-prev', v).onclick = () => { day.setDate(day.getDate() - 1); last = ''; refresh(); };
        $('#d-print', v).onclick = () => printSheets(b.trips, isToday ? `Today, ${fmtDate(day.toISOString())}` : fmtDate(day.toISOString()));
        $('#d-next', v).onclick = () => { day.setDate(day.getDate() + 1); last = ''; refresh(); };
        const tb = $('#d-today', v); if (tb) tb.onclick = () => { day = new Date(); day.setHours(0, 0, 0, 0); last = ''; refresh(); };
        $('#d-day', v).onchange = (e) => { if (!e.target.value) return; const [y, mo, dd] = e.target.value.split('-').map(Number); day = new Date(y, mo - 1, dd); last = ''; refresh(); };
        if ($('#d-new', v)) $('#d-new', v).onclick = () => newBookingModal(() => { last = ''; refresh(); });
        const al = $('#d-alerts', v); if (al) al.ontoggle = () => store.set('livery-alerts-open', al.open ? '1' : '0');
        $$('[data-trip]', v).forEach((b2) => { b2.onclick = () => tripModal(b2.dataset.trip, () => { last = ''; refresh(); }); });
        $$('[data-goto]', v).forEach((b2) => { b2.onclick = () => { if (b2.dataset.goto === 'billing') { custSub = 'accounts'; go2('customers'); } else go2(b2.dataset.goto); }; });
        $$('.card', v).forEach((c) => {
          c.onclick = () => tripModal(c.dataset.id, () => { last = ''; refresh(); });
          c.onkeydown = (e) => { if (e.key === 'Enter') c.click(); };
          c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.dataset.id); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); });
          c.addEventListener('dragend', () => c.classList.remove('dragging'));
        });
        $$('.lane', v).forEach((lane) => {
          lane.addEventListener('dragover', (e) => { e.preventDefault(); lane.classList.add('over'); });
          lane.addEventListener('dragleave', (e) => { if (!lane.contains(e.relatedTarget)) lane.classList.remove('over'); });
          lane.addEventListener('drop', async (e) => {
            e.preventDefault(); lane.classList.remove('over');
            const id = e.dataTransfer.getData('text/plain');
            const t = b.trips.find((x) => x.id === id);
            if (lane.dataset.driver === undefined) return;
            if (!t || (t.driverId || '') === lane.dataset.driver) return;
            try {
              const r = await api('dispatch.assign', { id, driverId: lane.dataset.driver || null });
              if (r.driver) warnToast(r, `${r.ref} sent to ${r.driver.name}${r.vehicle ? ' in the ' + r.vehicle.name : ''}.`);
              else toast(`${r.ref} unassigned.`);
            } catch (err) { toast(err.message, true); }
            last = ''; refresh();
          });
        });
      }
      current = { poll: true, refresh };
      refresh();
    }

    // Live map ---------------------------------------------------------------
    // Google Maps when the site has a browser key; otherwise a built-in map
    // drawn from the same positions, with towns and airports for orientation.
    const MAP_STATE = { en_route: 'On the way', arrived: 'At pickup', on_board: 'On board', free: 'Free', off: 'Off duty' };
    function fleetMap(host, openTrip) {
      const openKey = 'livery-map-open';
      let data = null, busyMap = false, lastAt = 0, gm = null;
      const isOpen = () => store.get(openKey) !== '0';
      const line = (c) => c.state === 'en_route' ? `On the way to ${c.trip.place}${c.etaMin ? ` · ${c.etaMin} min` : ''}`
        : c.state === 'arrived' ? `Waiting at ${c.trip.place}` : c.state === 'on_board' ? `${c.trip.passengerName || 'Passenger'} on board${c.to ? ` · ${c.etaMin} min to drop-off` : ''}`
        : c.state === 'free' ? `Free · ${c.where}` : `Off duty · ${c.where}`;
      const initials = (n) => n.split(' ').map((w) => w[0]).join('').slice(0, 2);
      function svgMap(d) {
        const hw = host.clientWidth || 1000; // draw at real pixel size so labels stay readable on phones
        const pts = [...d.cars.map((c) => c.pos), ...d.cars.filter((c) => c.to).map((c) => c.to), ...d.pickups.map((p) => p.pos)];
        if (!pts.length) pts.push(d.center);
        const k = Math.cos(d.center.lat * Math.PI / 180);
        let minX = Math.min(...pts.map((p) => p.lng * k)), maxX = Math.max(...pts.map((p) => p.lng * k)), minY = Math.min(...pts.map((p) => p.lat)), maxY = Math.max(...pts.map((p) => p.lat));
        const minSpan = 0.12; // about 8 miles
        if (maxX - minX < minSpan) { const m = (minX + maxX) / 2; minX = m - minSpan / 2; maxX = m + minSpan / 2; }
        if (maxY - minY < minSpan * 0.6) { const m = (minY + maxY) / 2; minY = m - minSpan * 0.3; maxY = m + minSpan * 0.3; }
        const W = Math.max(300, hw > 760 ? hw - 312 : hw - 36), H = hw > 760 ? 460 : Math.round(W * 0.85), pad = W < 600 ? 30 : 48;
        const span = Math.max((maxX - minX) / (W - 2 * pad), (maxY - minY) / (H - 2 * pad));
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        const P = (p) => [W / 2 + (p.lng * k - cx) / span, H / 2 - (p.lat - cy) / span].map((n) => Math.round(n));
        const inside = ([x, y]) => x > 10 && x < W - 10 && y > 10 && y < H - 10;
        // Skip a label that would sit on top of a car, a pin or another label.
        const taken = [...d.cars.map((c) => P(c.pos)).map(([x, y]) => [x - 16, y - 16, x + 16, y + 16]), ...d.pickups.map((p) => P(p.pos)).map(([x, y]) => [x - 10, y - 20, x + 10, y + 2])];
        const free = (r) => { if (taken.some((o) => r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1])) return false; taken.push(r); return true; };
        const pinLabel = new Set(d.pickups.filter((p) => { const [x, y] = P(p.pos); return free([x - 26, y - 37, x + 26, y - 23]); }).map((p) => p.id));
        const marks = d.landmarks.map((l) => [l, P(l)]).filter(([l, xy]) => inside(xy)).map(([l, [x, y]]) => [l, [x, y], x + 10 + l.name.length * 6.5 < W && free([x + 6, y - 7, x + 10 + l.name.length * 6.5, y + 7])]);
        const mile = 1 / 69 / span; // pixels per mile
        const bar = [1, 2, 5, 10, 20].find((m) => m * mile > 70) || 20;
        const routes = d.cars.filter((c) => c.to && ['en_route', 'on_board'].includes(c.state)).map((c) => { const [a, b] = P(c.pos), [x, y] = P(c.to); return `<line x1="${a}" y1="${b}" x2="${x}" y2="${y}" class="fm-route ${c.state}" />`; }).join('');
        const pins = d.pickups.map((p) => { const [x, y] = P(p.pos); return `<g class="fm-pin ${p.unassigned ? 'open' : ''}" data-trip="${p.id}" transform="translate(${x} ${y})"><title>${esc(`${fmtTime(p.pickupAt)} ${p.ref} ${p.passengerName}${p.driver ? ' · ' + p.driver : ' · needs a driver'}`)}</title><path d="M0 0C-6-8-9-11-9-16a9 9 0 0 1 18 0c0 5-3 8-9 16z" />${pinLabel.has(p.id) ? `<text y="-26" text-anchor="middle">${esc(fmtTime(p.pickupAt))}</text>` : ''}</g>`; }).join('');
        const cars = d.cars.map((c) => { const [x, y] = P(c.pos); return `<g class="fm-car ${c.state}" ${c.trip ? `data-trip="${c.trip.id}"` : ''} transform="translate(${x} ${y})"><title>${esc(`${c.name}: ${line(c)}${c.source === 'gps' ? ' (live GPS)' : ' (estimated)'}`)}</title>${c.source === 'gps' && c.state !== 'off' ? '<circle r="20" class="fm-halo" />' : ''}<circle r="13" /><text y="4" text-anchor="middle">${esc(initials(c.name))}</text></g>`; }).join('');
        return `<svg viewBox="0 0 ${W} ${H}" class="fm-svg" role="img" aria-label="Map of ${d.cars.length} cars and ${d.pickups.length} upcoming pickups">
          <rect width="${W}" height="${H}" class="fm-bg" />
          ${marks.map(([l, [x, y], label]) => `<g class="fm-mark"><rect x="${x - 3}" y="${y - 3}" width="6" height="6" />${label ? `<text x="${x + 8}" y="${y + 4}">${esc(l.name)}</text>` : `<title>${esc(l.name)}</title>`}</g>`).join('')}
          ${routes}${pins}${cars}
          <g class="fm-scale" transform="translate(${Math.round(W - pad - bar * mile)} ${H - 18})"><line x1="0" y1="0" x2="${Math.round(bar * mile)}" y2="0" /><text x="${Math.round(bar * mile / 2)}" y="-6" text-anchor="middle">${bar} mi</text></g>
        </svg>`;
      }
      const COLORS = { en_route: '#2a5db0', arrived: '#9a5b00', on_board: '#1f7a4d', free: '#545a66', off: '#a0a5ae' };
      function googleMap(d, el) {
        const g = window.google.maps;
        if (!gm || !el.contains(gm.div)) {
          gm = { div: document.createElement('div'), markers: new Map(), lines: new Map() };
          gm.div.className = 'fm-google'; el.innerHTML = ''; el.appendChild(gm.div);
          gm.map = new g.Map(gm.div, { center: d.center, zoom: 10, mapTypeControl: false, streetViewControl: false, fullscreenControl: true });
          gm.fit = true;
        }
        const seen = new Set();
        const put = (key, pos, o) => { seen.add(key); let mk = gm.markers.get(key); if (!mk) { mk = new g.Marker({ map: gm.map }); gm.markers.set(key, mk); } if (mk._l) g.event.removeListener(mk._l); mk._l = o.trip ? mk.addListener('click', () => openTrip(o.trip)) : null; mk.setPosition(pos); mk.setTitle(o.title); mk.setLabel(o.label); mk.setIcon(o.icon); };
        for (const c of d.cars) put('car:' + c.id, c.pos, { trip: c.trip && c.trip.id, title: `${c.name}: ${line(c)}`, label: { text: initials(c.name), color: '#fff', fontSize: '11px', fontWeight: '700' }, icon: { path: g.SymbolPath.CIRCLE, scale: 13, fillColor: COLORS[c.state], fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 } });
        for (const p of d.pickups) put('pick:' + p.id, p.pos, { trip: p.id, title: `${fmtTime(p.pickupAt)} ${p.ref} ${p.passengerName}`, label: null, icon: { path: 'M0 0C-6-8-9-11-9-16a9 9 0 0 1 18 0c0 5-3 8-9 16z', scale: 1, fillColor: p.unassigned ? '#b3261e' : '#ffffff', fillOpacity: 1, strokeColor: p.unassigned ? '#ffffff' : '#545a66', strokeWeight: 1.5, anchor: new g.Point(0, 0) } });
        for (const [key, mk] of gm.markers) if (!seen.has(key)) { mk.setMap(null); gm.markers.delete(key); }
        const keep = new Set();
        for (const c of d.cars.filter((x) => x.to && ['en_route', 'on_board'].includes(x.state))) { keep.add(c.id); let pl = gm.lines.get(c.id); if (!pl) { pl = new g.Polyline({ map: gm.map, strokeOpacity: 0.7, strokeWeight: 3 }); gm.lines.set(c.id, pl); } pl.setOptions({ strokeColor: COLORS[c.state] }); pl.setPath([c.pos, c.to]); }
        for (const [key, pl] of gm.lines) if (!keep.has(key)) { pl.setMap(null); gm.lines.delete(key); }
        if (gm.fit && (d.cars.length || d.pickups.length)) { const bd = new g.LatLngBounds(); [...d.cars.map((c) => c.pos), ...d.pickups.map((p) => p.pos)].forEach((p) => bd.extend(p)); gm.map.fitBounds(bd, 40); gm.fit = false; }
      }
      let gmaps = null; // the Google script, loaded once
      const loadGoogle = (key) => gmaps || (gmaps = new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`; sc.async = true; sc.onload = () => ok(); sc.onerror = () => no(new Error('Google Maps did not load')); document.head.appendChild(sc); }));
      function draw() {
        if (!data) return;
        const d = data, open = isOpen();
        const counts = Object.keys(MAP_STATE).map((k) => [k, d.cars.filter((c) => c.state === k).length]).filter(([, n]) => n);
        const unassigned = d.pickups.filter((p) => p.unassigned).length;
        if (!host.querySelector('.fleetmap')) host.innerHTML = '<section class="panel fleetmap"></section>';
        const box = host.querySelector('.fleetmap');
        const keepGoogle = open && gm && box.querySelector('.fm-google');
        const head = `<div class="fm-head"><h2>Live map</h2><span class="small muted fm-legend">${counts.map(([k, n]) => `<span><i class="fm-dot ${k}"></i>${n} ${MAP_STATE[k].toLowerCase()}</span>`).join('')}${d.pickups.length ? `<span>${d.pickups.length} pickup${d.pickups.length === 1 ? '' : 's'} in the next 6 hours${unassigned ? `, <b>${unassigned} need${unassigned === 1 ? 's' : ''} a driver</b>` : ''}</span>` : ''}</span><button class="btn sm" type="button" id="fm-toggle">${open ? 'Hide map' : 'Show map'}</button></div>`;
        const order = Object.keys(MAP_STATE);
        const list = `<ul class="fm-list">${d.cars.slice().sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state)).map((c) => `<li ${c.trip ? `data-trip="${c.trip.id}" class="click"` : ''}><i class="fm-dot ${c.state}"></i><div><b>${esc(c.name)}</b>${c.vehicle ? ` <span class="small faint">${esc(c.vehicle.name)}</span>` : ''}<br><span class="small muted">${esc(line(c))}</span>${c.next ? `<br><span class="small faint">Next: ${esc(fmtTime(c.next.pickupAt))} ${esc(c.next.ref)}</span>` : ''}</div></li>`).join('')}</ul>`;
        if (!open) { box.innerHTML = head; gm = null; }
        else if (keepGoogle) { box.querySelector('.fm-head').outerHTML = head; box.querySelector('.fm-side').innerHTML = list; googleMap(d, box.querySelector('.fm-canvas')); }
        else {
          box.innerHTML = `${head}<div class="fm-body"><div class="fm-canvas">${d.useGoogle ? '<p class="faint small">Loading Google Maps…</p>' : svgMap(d)}</div><div class="fm-side">${list}</div></div>
            <p class="small faint">Cars show live GPS when the driver's phone shares it, otherwise an estimate. ${d.useGoogle ? '' : 'Street maps appear once a Google Maps browser key is added. '}Tap a car or pin to open the trip.</p>`;
          if (d.useGoogle) loadGoogle(d.mapsKey).then(() => googleMap(data, box.querySelector('.fm-canvas'))).catch(() => { data.useGoogle = false; gm = null; box.innerHTML = ''; draw(); });
        }
        $('#fm-toggle', box).onclick = () => { store.set(openKey, open ? '0' : '1'); gm = null; box.innerHTML = ''; draw(); };
        $$('[data-trip]', box).forEach((el) => { el.onclick = () => openTrip(el.dataset.trip); });
      }
      async function update() {
        if (busyMap || Date.now() - lastAt < 4000) return;
        busyMap = true; lastAt = Date.now();
        try {
          const [d, info] = await Promise.all([api('dispatch.fleetMap', {}), getLive()]);
          d.mapsKey = !DEMO && info.mapsKey ? info.mapsKey : '';
          d.useGoogle = !!d.mapsKey && !(data && data.useGoogle === false);
          const changed = !data || JSON.stringify([d.cars, d.pickups]) !== JSON.stringify([data.cars, data.pickups]);
          data = d;
          if (changed || !host.querySelector('.fleetmap')) draw();
        } catch (e) { /* the board still works without the map */ }
        busyMap = false;
      }
      return { update };
    }
    function cardHtml(t) {
      const movable = !['on_board', 'completed', 'cancelled'].includes(t.status) && !t.farmout;
      const f = t.flightInfo;
      return `<article class="card ${t.status === 'completed' ? 'done' : ''}" data-id="${t.id}" tabindex="0" ${movable ? 'draggable="true"' : ''}>
        <div class="spread"><span class="t">${esc(fmtTime(t.pickupAt))}${t.pickupAt !== t.scheduledPickupAt ? ' <span class="small faint" title="Moved to match the flight">moved</span>' : ''}</span>${pill(t)}</div>
        <div class="spread"><b>${esc(t.passengerName || 'Passenger')}</b><span class="mono small faint">${esc(t.ref)}</span></div>
        <div class="addr">${esc(t.pickup)}</div>
        ${t.dropoff ? `<div class="addr">→ ${esc(t.dropoff)}</div>` : `<div class="addr">${t.hours} h as directed</div>`}
        ${f ? `<div class="row small"><span class="mono">✈ ${esc(f.flight)}</span>${flightPill(f)}</div>` : ''}
        ${t.live && !t.live.arrived ? `<div class="small eta">● ${t.live.etaMin} min to pickup · ${t.live.milesLeft} mi</div>` : ''}
        ${t.farmout ? `<div class="partnertag small">${t.farmout.status === 'offered' ? 'Offered to' : 'With'} ${esc(t.farmout.toName)}${t.driver ? ' · ' + esc(t.driver.name) : ''}</div>` : ''}
        ${t.farmIn ? `<div class="partnertag in small">From ${esc(t.farmIn.fromName)}</div>` : ''}
        ${t.account ? `<div class="small accttag">Bill to ${esc(t.account.name)}</div>` : ''}
        ${t.status === 'assigned' && t.offer ? `<div class="small offertag">Waiting to accept · ${minsLeft(t.offer.expiresAt)} min left</div>` : ''}
        ${t.status === 'confirmed' && t.needsDriver && !t.farmout ? `<div class="small needtag">Needs a driver: ${esc(t.needsDriver.why)}</div>` : ''}
        <div class="spread small"><span class="muted">${esc(t.vehicle ? t.vehicle.name : t.vehicleType)} · ${t.passengers} pax</span><span class="num">${money0(t.price.total)}${t.payment.status === 'paid' ? ' ✓' : ''}</span></div>
      </article>`;
    }

    async function bookingInfo() {
      const [s, vehicles, accounts] = await Promise.all([api('dispatch.settings'), api('dispatch.vehicles'), api('dispatch.accounts')]);
      const caps = {}; vehicles.filter((x) => x.status === 'active').forEach((x) => { caps[x.type] = Math.max(caps[x.type] || 0, x.capacity); });
      return { rates: s.rates, addons: s.addons, vehicleTypes: C.VEHICLE_TYPES.filter((t) => caps[t]).map((t) => ({ type: t, capacity: caps[t] })), accounts: accounts.filter((a) => a.active) };
    }
    async function newBookingModal(done) {
      let info;
      try { info = await bookingInfo(); } catch (e) { return toast(e.message, true); }
      const m = openModal({ title: 'New booking', wide: true, body: '<div id="nb"></div>' });
      bookingForm($('#nb', m), {
        info, mode: 'dispatch', submitLabel: 'Create booking', accounts: info.accounts,
        quoteFn: (b) => api('dispatch.quote', { booking: b }),
        onSubmit: async (b) => { const t = await api('dispatch.createTrip', { booking: b }); closeModal(); toast((t.driver ? `${t.ref} created and sent to ${t.driver.name}. Waiting for them to accept.` : `${t.ref} created. Assign a driver next.`) + (t.returnTrip ? ` Return trip ${t.returnTrip.ref} created too.` : '') + (t.landingTrip ? ` Landing pickup ${t.landingTrip.ref} ${t.landingTrip.farmout ? `sent to ${t.landingTrip.farmout.toName}` : 'needs a local company'}.` : '')); done && done(); },
      });
    }

    async function tripModal(id, done) {
      let t, drivers, vehicles, accounts;
      try { [t, drivers, vehicles, accounts] = await Promise.all([api('dispatch.trip', { id }), api('dispatch.drivers'), api('dispatch.vehicles'), api('dispatch.accounts')]); } catch (e) { return toast(e.message, true); }
      const closed = ['completed', 'cancelled'].includes(t.status);
      const lock = closed ? 'disabled' : '';
      const billLock = closed || t.invoiceId || t.farmIn ? 'disabled' : '';
      const noAssign = ['on_board', 'completed', 'cancelled'].includes(t.status);
      const f = t.flightInfo;
      const canApply = f && f.suggestedPickup && f.suggestedPickup !== t.pickupAt && !noAssign;
      const fo = t.farmout && !t.farmout.done ? t.farmout : null;
      const canFarm = !t.farmout && !t.farmIn && ['confirmed', 'assigned'].includes(t.status);
      const priceLock = t.farmIn ? 'disabled' : '';
      const canSuggest = ['confirmed', 'assigned'].includes(t.status) && (!t.farmout || t.farmout.done);
      const m = openModal({
        title: `${t.ref} · ${t.passengerName || 'Passenger'}`, wide: true, onClose: done,
        body: `<div class="tripedit">
          <form id="te-form" class="stack" novalidate>
            <div class="grid2">
              <label class="field"><span>Type</span><select id="te-service" name="service" ${lock}><option value="transfer" ${t.service !== 'hourly' ? 'selected' : ''}>Transfer</option><option value="hourly" ${t.service === 'hourly' ? 'selected' : ''}>By the hour</option></select></label>
              <label class="field"><span>Pickup time</span><input id="te-when" name="pickupAt" type="datetime-local" value="${toLocalInput(new Date(t.pickupAt))}" ${lock}></label>
            </div>
            <label class="field"><span>Pickup</span><input id="te-pickup" name="pickup" autocomplete="off" value="${esc(t.pickup)}" ${lock}></label>
            <label class="field"><span>Drop-off</span><input id="te-dropoff" name="dropoff" autocomplete="off" value="${esc(t.dropoff)}" ${lock}></label>
            <div class="grid3">
              <label class="field"><span>Vehicle type</span><select id="te-vtype" name="vehicleType" ${lock}>${C.VEHICLE_TYPES.map((x) => `<option ${t.vehicleType === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
              <label class="field"><span>Passengers</span><input id="te-pax" name="passengers" type="number" min="1" value="${t.passengers}" ${lock}></label>
              <label class="field"><span>Hours (by the hour)</span><input id="te-hours" name="hours" type="number" min="1" value="${t.hours}" ${lock}></label>
            </div>
            <div class="grid3">
              <label class="field"><span>Passenger</span><input id="te-name" name="passengerName" value="${esc(t.passengerName)}" ${lock}></label>
              <label class="field"><span>Phone</span><input id="te-phone" name="passengerPhone" value="${esc(t.passengerPhone)}" ${lock}></label>
              <label class="field"><span>Flight</span><input id="te-flight" name="flight" class="mono" value="${esc(t.flight)}" ${lock}></label>
            </div>
            <div class="grid3">
              <label class="field"><span>Child seats</span><input id="te-child" name="childSeats" type="number" min="0" max="4" value="${t.childSeats || 0}" ${lock}></label>
              <label class="field"><span>Suitcases</span><input id="te-bags" name="bags" type="number" min="0" max="40" value="${t.bags || 0}" ${lock}></label>
              <label class="switch" style="align-self:end;min-height:40px"><input type="checkbox" id="te-meet" name="meetGreet" ${t.meetGreet ? 'checked' : ''} ${lock}><span>Meet &amp; greet</span></label>
            </div>
            <div class="grid3">
              <label class="field"><span>Stops on the way, one per line</span><textarea id="te-stops" name="stopList" rows="2" ${lock} placeholder="${t.stops && !(t.stopList || []).length ? `${t.stops} stop(s), no address yet` : 'None'}">${esc((t.stopList || []).join('\n'))}</textarea></label>
              <label class="field"><span>Wait at each stop, minutes</span><input id="te-swaits" name="stopWaits" value="${esc((t.stopWaits || []).join(', '))}" placeholder="For example 15, 10" ${lock}></label>
              <label class="field"><span>Name on greeting sign</span><input id="te-sign" name="signName" maxlength="60" value="${esc(t.signName || '')}" placeholder="${esc(t.passengerName || '')}" ${lock}></label>
            </div>
            ${t.prefs && (t.prefs.temp || t.prefs.music || t.prefs.quiet) ? `<p class="small muted">Passenger preferences: ${esc([t.prefs.temp ? C.TEMPS[t.prefs.temp] + ' cabin' : '', t.prefs.music ? C.MUSIC[t.prefs.music] : '', t.prefs.quiet ? 'Quiet ride' : ''].filter(Boolean).join(' · '))}</p>` : ''}
            ${t.pair ? `<p class="small muted">${t.pair.kind === 'return' ? `Return trip: ${esc(t.pair.ref)} on ${esc(fmtDT(t.pair.pickupAt))}` : `This is the return of ${esc(t.pair.ref)}`}</p>` : ''}
            ${t.landing ? `<p class="small landtag">${t.landing.kind === 'landing' ? `Pickup when they land${t.landing.city ? ` in ${esc(t.landing.city)}` : ''}: ${esc(t.landing.ref)}` : `Pickup when they land, after ${esc(t.landing.ref)}`}${t.awayTime ? `, ${esc(t.awayTime)}` : ''}.${t.outOfTown ? (t.farmout ? ` With ${esc(t.farmout.toName)}.` : ` Out of town: send it to a partner in ${esc(t.outOfTown.city)} or book a local company, then mark it done.`) : ''}</p>` : ''}
            ${t.cancelFee ? `<p class="small muted">Cancelled late by the customer. Fee: ${money(t.cancelFee)}</p>` : ''}
            ${t.noShow ? `<p class="small muted">No-show, marked by ${esc(t.noShow.by)}${t.noShow.waitedMin ? ` after waiting ${t.noShow.waitedMin} min` : ''}.${t.noShow.fee ? ` Fee: ${money(t.noShow.fee)}${t.payment.status === 'paid' ? ' (fare already paid)' : ', not collected yet'}.` : ''}${t.noShow.note ? ` ${esc(t.noShow.note)}` : ''}</p>` : ''}
            ${t.wait ? `<p class="small muted">Driver at pickup. ${waitLine(t)}.</p>` : ''}
            ${t.termsAgreed ? `<p class="small faint">${esc(t.termsAgreed.by || 'Customer')} agreed to the booking terms on ${esc(fmtDT(t.termsAgreed.at))}.</p>` : ''}
            <div class="grid3">
              <label class="field"><span>Miles (override)</span><input id="te-miles" name="milesOverride" type="number" min="0" step="0.1" placeholder="${t.price.miles}" value="${t.milesOverride == null ? '' : t.milesOverride}" ${lock}></label>
              <label class="field"><span>Wait (min)</span><input id="te-wait" name="waitMin" type="number" min="0" value="${t.waitMin || 0}" ${lock}></label>
              <label class="field"><span>Tolls ($)</span><input id="te-tolls" name="tolls" type="number" min="0" step="0.01" value="${t.tolls || 0}" ${lock}></label>
            </div>
            <fieldset class="fs"><legend>Adjust the price</legend>
              <div class="grid3">
                <label class="field"><span>Add or take off ($)</span><input id="te-adj" name="adjAmount" type="number" step="0.01" placeholder="-20 or 35" ${priceLock} value="${t.adjustment ? t.adjustment.amount : ''}"></label>
                <label class="field" style="grid-column:span 2"><span>Reason</span><input id="te-adjr" name="adjReason" ${priceLock} placeholder="Goodwill credit, extra luggage…" value="${esc(t.adjustment ? t.adjustment.reason : '')}"></label>
              </div>
              <label class="field"><span>Or set a fixed total ($)</span><input id="te-price" name="priceOverride" type="number" min="0" step="0.01" placeholder="Leave blank to use your rates" ${priceLock} value="${t.priceOverride == null ? '' : t.priceOverride}"></label>
              ${t.farmIn ? `<p class="small muted">The price was agreed with ${esc(t.farmIn.fromName)} when you accepted the trip.</p>` : ''}
            </fieldset>
            ${accounts.length ? `<div class="grid3">
              <label class="field"><span>Bill to</span><select id="te-acct" name="accountId" ${billLock}><option value="">Passenger pays</option>${accounts.filter((a) => a.active || a.id === t.accountId).map((a) => `<option value="${a.id}" ${t.accountId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
              <label class="field"><span>PO number</span><input id="te-po" name="poNumber" value="${esc(t.poNumber || '')}" ${billLock}></label>
              <label class="field"><span>Cost center</span><input id="te-cc" name="costCenter" value="${esc(t.costCenter || '')}" ${billLock}></label>
            </div>` : ''}
            <label class="field"><span>Notes</span><textarea id="te-notes" name="notes">${esc(t.notes)}</textarea></label>
            <div id="te-err"></div>
            <div class="row"><button class="btn primary" type="submit">Save changes</button><span class="small faint">Booked ${t.agent ? `by ${esc(t.agent.name)} (${esc(t.agent.agency)}, travel agent${t.agent.pct ? `, ${t.agent.pct}% commission` : ''}${t.agent.payBy === 'passenger' ? ', client pays' : ''})` : esc(t.source === 'phone' ? 'by phone' : 'online')} ${esc(fmtDT(t.createdAt))}</span></div>
          </form>
          <div class="side">
            ${t.warnings && t.warnings.length ? `<div class="warnbox"><b>Check before the trip</b><ul>${t.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
            ${t.farmout ? `<div class="sidebox partnerbox"><div class="spread"><span class="label">${fo && fo.status === 'offered' ? 'Offered to partner' : 'Partner company'}</span>${pill(t)}</div>
              <b>${esc(t.farmout.toName)}</b>
              <dl class="kv small"><dt>You pay them</dt><dd class="num">${money(t.farmout.rate)}</dd><dt>You keep</dt><dd class="num">${money(t.price.total - t.farmout.rate)}</dd>
                ${t.driver ? `<dt>Chauffeur</dt><dd>${esc(t.driver.name)}${t.driver.phone ? ` · <span class="mono">${esc(t.driver.phone)}</span>` : ''}</dd>` : ''}
                ${t.vehicle ? `<dt>Vehicle</dt><dd>${esc(t.vehicle.name)}${t.vehicle.plate ? ' · ' + esc(t.vehicle.plate) : ''}</dd>` : ''}
                ${t.affiliate ? `<dt>Their ref</dt><dd class="mono">${esc(t.affiliate.ref)}</dd>` : ''}</dl>
              <p class="small muted">${fo && fo.status === 'offered' ? 'Waiting for them to accept. You will see it here and on the board.' : t.farmout.done ? 'Completed by the partner.' : 'They dispatch it. Status, chauffeur and vehicle update here, and your passenger gets texts from you.'}</p>
              <div class="row">${fo ? '<button class="btn sm" type="button" id="te-takeback">Take it back</button>' : ''}<button class="btn sm" type="button" id="te-msgpartner" data-partner="${t.farmout.toCompanyId}">Message them</button></div>
            </div>` : ''}
            ${t.farmIn ? `<div class="sidebox partnerbox in"><span class="label">From a partner</span><b>${esc(t.farmIn.fromName)}</b>
              <dl class="kv small"><dt>Their ref</dt><dd class="mono">${esc(t.farmIn.fromRef)}</dd><dt>They pay you</dt><dd class="num">${money(t.price.total)}</dd>${t.farmIn.fromPhone ? `<dt>Office</dt><dd class="mono">${esc(t.farmIn.fromPhone)}</dd>` : ''}</dl>
              <p class="small muted">Texts to the passenger come from ${esc(t.farmIn.fromName)}. Your driver should not collect payment.</p>
              ${!noAssign ? `<div class="row"><input class="input grow" id="te-hbreason" placeholder="Reason (optional)"><button class="btn sm danger" type="button" id="te-handback">Hand it back</button></div>` : ''}
              <button class="btn sm" type="button" id="te-msgpartner" data-partner="${t.farmIn.fromCompanyId}">Message them</button>
            </div>` : ''}
            ${!t.farmout || t.farmout.done ? `<div class="sidebox"><div class="spread"><span class="label">Status</span>${pill(t)}</div>
              ${t.status === 'assigned' && t.offer && t.driver ? `<p class="small offertag">Waiting for ${esc(t.driver.name)} to accept · ${minsLeft(t.offer.expiresAt)} min left</p>` : ''}
              ${t.status === 'confirmed' && t.needsDriver ? `<p class="small needtag">Needs a driver: ${esc(t.needsDriver.why)}</p>` : ''}
              ${canSuggest ? '<div id="te-suggest" class="suggest"><p class="small faint">Finding the best drivers…</p></div>' : ''}
              <label class="field"><span>Driver</span><select id="te-driver" ${noAssign ? 'disabled' : ''}><option value="">Unassigned</option>${drivers.filter((d) => d.active).map((d) => `<option value="${d.id}" ${t.driverId === d.id ? 'selected' : ''}>${esc(d.name)}${d.timeOffToday ? ' (time off)' : d.available ? '' : ' (off duty)'}</option>`).join('')}</select></label>
              <label class="field"><span>Vehicle</span><select id="te-vehicle" ${noAssign ? 'disabled' : ''}><option value="">Best free vehicle</option>${vehicles.filter((x) => x.status !== 'retired').map((x) => `<option value="${x.id}" ${t.vehicleId === x.id ? 'selected' : ''}>${esc(x.name)} · ${esc(x.type)} · ${x.capacity} seats${x.status === 'maintenance' ? ' (in the shop)' : ''}</option>`).join('')}</select></label>
              ${noAssign ? '' : '<button class="btn primary" type="button" id="te-assign">Save assignment</button>'}
              <label class="field"><span>Change status by hand</span><select id="te-status">${Object.entries(C.STATUS_LABELS).map(([k, l]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
              <button class="btn sm" type="button" id="te-setstatus">Update status</button>
              ${['accepted', 'en_route', 'arrived'].includes(t.status) && !t.farmout ? '<button class="btn sm danger" type="button" id="te-noshow">Passenger no-show</button>' : ''}
              <button class="btn sm" type="button" id="te-sheet">Print trip sheet</button>
              ${canFarm ? '<button class="btn sm" type="button" id="te-farm">Send to a partner company</button>' : ''}
            </div>` : ''}
            ${t.live ? `<div class="sidebox"><span class="label">Live tracking</span><div id="te-live">${trackMap(t.live, t.pickup)}</div>${t.trackToken ? `<p class="small faint">Passenger link: <span class="mono">#track.${esc(t.trackToken)}</span></p>` : ''}</div>` : ''}
            ${f ? `<div class="sidebox"><span class="label">Flight</span>${flightBox(f)}
              ${t.pickupAt !== t.scheduledPickupAt ? `<p class="small muted">Pickup moved from ${esc(fmtTime(t.scheduledPickupAt))} to ${esc(fmtTime(t.pickupAt))}.</p>` : ''}
              ${canApply ? `<button class="btn sm" type="button" id="te-applyflight">Move pickup to ${esc(fmtTime(f.suggestedPickup))}</button>` : ''}</div>` : ''}
            <div class="sidebox"><div class="spread"><span class="label">Price</span><b class="num" style="font-size:20px">${money(t.price.total)}</b></div>
              <div class="small">${quoteLines(t.price)}</div>
              ${t.pay ? cardBox(t) : ''}
              <div class="spread" ${t.pay ? 'hidden' : ''}><span>${payPill(t)}</span>
                ${t.account && t.status !== 'cancelled' ? `<span class="small muted">${t.account.invoice ? `On invoice <button type="button" class="linkbtn" id="te-inv">${esc(t.account.invoice.number)}</button> (${esc(t.account.invoice.status)})` : t.status === 'completed' ? `Goes on the next ${esc(t.account.name)} invoice` : `Billed to ${esc(t.account.name)}`}</span>` : t.status === 'cancelled' ? '' : t.payment.status === 'paid' ? '<button class="btn sm" type="button" data-pay="unpaid">Mark unpaid</button>' : `<div class="row"><button class="btn sm" type="button" data-pay="card">Card</button><button class="btn sm" type="button" data-pay="cash">Cash</button><button class="btn sm" type="button" data-pay="invoice">Invoice</button></div>`}</div>
            </div>
            <div class="sidebox"><span class="label">History</span><ul class="timeline">${t.history.slice().reverse().map((h) => `<li><span class="mono">${esc(fmtDT(h.at))}</span><span>${esc(C.STATUS_LABELS[h.status] || HIST_LABELS[h.status] || h.status)}${h.by ? ' · ' + esc(h.by) : ''}${h.note ? ' · ' + esc(h.note) : ''}</span></li>`).join('')}</ul></div>
            ${t.rating ? `<div class="sidebox"><span class="label">Customer rating</span><span class="stars">${stars(t.rating.stars)}</span>${t.rating.comment ? `<p class="small">${esc(t.rating.comment)}</p>` : ''}</div>` : ''}
            ${!closed && t.pay && t.cancelTerms && t.cancelTerms.fee ? `<label class="check small"><input type="checkbox" id="te-keepfee"> <span>Keep the ${money(t.cancelTerms.fee)} late-cancellation fee (free cancellation ended ${esc(fmtDT(t.cancelTerms.freeUntil))}). Otherwise the card is refunded in full.</span></label>` : ''}
            ${!closed ? '<button class="btn danger" type="button" id="te-cancel">Cancel this trip</button>' : ''}
          </div></div>`,
      });
      const reopen = () => { m._onClose = null; closeModal(); tripModal(id, done); };
      if (t.live) {
        const timer = setInterval(async () => {
          const box = $('#te-live', m);
          if (!box || !m.isConnected) return clearInterval(timer);
          try { const x = await api('dispatch.trip', { id }); box.innerHTML = x.live ? trackMap(x.live, x.pickup) : '<p class="small muted">Tracking ended.</p>'; } catch (e) { clearInterval(timer); }
        }, 5000);
      }
      addressAutocomplete($('#te-pickup', m), session.company.slug);
      addressAutocomplete($('#te-dropoff', m), session.company.slug);
      $('#te-form', m).onsubmit = async (e) => {
        e.preventDefault();
        const fd = formData(e.target);
        const { adjAmount, adjReason, ...f2 } = fd;
        f2.adjustment = { amount: adjAmount, reason: adjReason };
        if (f2.pickupAt) f2.pickupAt = new Date(f2.pickupAt).toISOString();
        // Older trips only have a stop count; keep it until stops are typed in.
        if (!String(f2.stopList || '').trim() && t.stops && !(t.stopList || []).length) { delete f2.stopList; delete f2.stopWaits; }
        if (closed) { for (const k of Object.keys(f2)) if (!['notes', 'priceOverride', 'adjustment'].includes(k)) delete f2[k]; }
        if (t.invoiceId) { for (const k of Object.keys(f2)) if (k !== 'notes') delete f2[k]; }
        await busy($('button[type=submit]', e.target), async () => {
          try { const r = await api('dispatch.updateTrip', { id, patch: f2 }); toast(`Trip saved. Total ${money(r.price.total)}.`); reopen(); } catch (err) { showErr($('#te-err', m), err); }
        });
      };
      const as = $('#te-assign', m);
      if (as) as.onclick = () => busy(as, async () => {
        try { const r = await api('dispatch.assign', { id, driverId: $('#te-driver', m).value || null, vehicleId: $('#te-vehicle', m).value || null }); r.driver ? warnToast(r, `Assigned to ${r.driver.name}.`) : toast('Unassigned.'); reopen(); } catch (err) { toast(err.message, true); }
      });
      const sg = $('#te-suggest', m);
      if (sg) api('dispatch.suggest', { id }).then((list) => {
        const top = list.slice(0, 4);
        const anyOk = top.some((r) => r.ok);
        sg.innerHTML = `<div class="spread"><span class="label">Best drivers for this trip</span>${anyOk ? '<button class="btn sm primary" type="button" id="te-auto">Auto-assign</button>' : ''}</div>
          ${anyOk ? '' : '<p class="small needtag">Nobody is free for this trip. Clear a conflict below or send it to a partner company.</p>'}
          ${top.map((r, i) => `<div class="sg ${r.ok ? '' : 'no'}"><div class="grow"><b>${i + 1}. ${esc(r.name)}</b>${t.driverId === r.driverId ? ' <span class="pill s-assigned">current</span>' : ''}
            <div class="small muted">${r.miles} mi away (${esc(r.from)}) · about ${r.minutes} min${r.vehicle ? ' · ' + esc(r.vehicle) : ''}</div>
            ${r.warnings.length ? `<div class="small ${r.ok ? 'faint' : 'bad'}">${r.warnings.map(esc).join(' ')}</div>` : ''}</div>
            ${r.ok && t.driverId !== r.driverId ? `<button class="btn sm" type="button" data-pick="${r.driverId}" data-veh="${r.vehicleId || ''}">Assign</button>` : ''}</div>`).join('') || '<p class="small faint">No drivers yet.</p>'}`;
        $$('[data-pick]', sg).forEach((b) => { b.onclick = () => busy(b, async () => {
          try { const r = await api('dispatch.assign', { id, driverId: b.dataset.pick, vehicleId: b.dataset.veh || null }); warnToast(r, `Sent to ${r.driver.name}.`); reopen(); } catch (err) { toast(err.message, true); }
        }); });
        const au = $('#te-auto', sg);
        if (au) au.onclick = () => busy(au, async () => {
          try { const r = await api('dispatch.autoAssign', { id }); toast(`Sent to ${r.driver.name}, ${r.picked.miles} mi away. Waiting for them to accept.`); reopen(); } catch (err) { toast(err.message, true); }
        });
      }).catch(() => { sg.innerHTML = ''; });
      const ti = $('#te-inv', m); if (ti) ti.onclick = () => invoiceModal(t.account.invoice.id, reopen);
      const ap = $('#te-applyflight', m);
      if (ap) ap.onclick = () => busy(ap, async () => { try { await api('dispatch.applyFlight', { id }); toast('Pickup moved. Driver and passenger told.'); reopen(); } catch (err) { toast(err.message, true); } });
      const tf = $('#te-farm', m); if (tf) tf.onclick = () => { m._onClose = null; closeModal(); farmModal(t, () => tripModal(id, done)); };
      const tb = $('#te-takeback', m); if (tb) tb.onclick = () => {
        if (!tb.dataset.armed) { tb.dataset.armed = '1'; tb.textContent = 'Click again to take it back'; return; }
        busy(tb, async () => { try { await api('network.cancelOffer', { id: t.farmout.id }); toast(`${t.ref} is back with you. Assign a driver.`); reopen(); } catch (err) { toast(err.message, true); } });
      };
      const hb = $('#te-handback', m); if (hb) hb.onclick = () => {
        if (!hb.dataset.armed) { hb.dataset.armed = '1'; hb.textContent = 'Click again to hand back'; return; }
        busy(hb, async () => { try { await api('network.handBack', { tripId: id, reason: $('#te-hbreason', m).value }); toast(`Handed back to ${t.farmIn.fromName}.`); closeModal(); } catch (err) { toast(err.message, true); } });
      };
      const mp = $('#te-msgpartner', m); if (mp) mp.onclick = () => { netState.sub = 'messages'; netState.partner = mp.dataset.partner; m._onClose = null; closeModal(); go2('network'); };
      const shb = $('#te-sheet', m); if (shb) shb.onclick = () => printSheets([t], `${t.ref}, ${fmtDate(t.pickupAt)}`);
      const nsb = $('#te-noshow', m); if (nsb) nsb.onclick = () => noShowModal(t, 'dispatch.noShow', reopen);
      const ss = $('#te-setstatus', m); if (ss) ss.onclick = (e) => busy(e.currentTarget, async () => {
        try { await api('dispatch.setStatus', { id, status: $('#te-status', m).value }); toast('Status updated.'); reopen(); } catch (err) { toast(err.message, true); }
      });
      const cc = $('#te-charge', m); if (cc) cc.onclick = (e) => busy(e.currentTarget, async () => {
        try { const r = await api('dispatch.chargeCard', { id }); const p = r.pay; toast(p.failed ? `The card was declined: ${p.failed.error}.` : p.pending ? 'Charging the card now.' : 'Card updated.', !!p.failed); reopen(); } catch (err) { toast(err.message, true); }
      });
      const cl = $('#te-cardlink', m); if (cl) cl.onclick = (e) => busy(e.currentTarget, async () => {
        try { await api('dispatch.sendCardLink', { id }); toast('Card link sent to the passenger.'); reopen(); } catch (err) { toast(err.message, true); }
      });
      $$('[data-pay]', m).forEach((b) => { b.onclick = () => busy(b, async () => {
        try { await api('dispatch.markPaid', b.dataset.pay === 'unpaid' ? { id, unpaid: true } : { id, method: b.dataset.pay }); toast('Payment updated.'); reopen(); } catch (err) { toast(err.message, true); }
      }); });
      const cx = $('#te-cancel', m);
      if (cx) cx.onclick = () => {
        if (!cx.dataset.armed) { cx.dataset.armed = '1'; cx.textContent = 'Click again to cancel the trip'; return; }
        busy(cx, async () => { try { await api('dispatch.setStatus', { id, status: 'cancelled', keepFee: !!($('#te-keepfee', m) || {}).checked }); toast(`${t.ref} cancelled. The passenger has been told.`); closeModal(); } catch (err) { toast(err.message, true); } });
      };
    }

    // Network: send trips to partner companies -------------------------------
    async function farmModal(t, back) {
      let partners;
      try { partners = await api('network.partnersFor', { tripId: t.id }); } catch (e) { return toast(e.message, true); }
      const suggested = Math.round(t.price.total * 0.8);
      const m = openModal({
        title: `Send ${t.ref} to a partner`, onClose: back,
        body: partners.length ? `<form id="fm" class="stack" novalidate>
          <p class="small muted">${esc(fmtDT(t.pickupAt))} · ${esc(t.vehicleType)} · ${t.passengers} pax · ${esc(t.pickup)}${t.dropoff ? ' → ' + esc(t.dropoff) : ''}</p>
          <div class="field"><span>Partner company</span><div class="stack" style="gap:8px">${partners.map((p, i) => `<label class="partnerpick"><input type="radio" name="toCompanyId" value="${p.id}" ${i === 0 ? 'checked' : ''}>
            <span class="grow"><b>${esc(p.name)}</b><span class="small muted">${esc(p.areas || p.region)}</span>
              <span class="small faint">${p.vehicleTypes.map((v) => `${v.count} ${esc(v.type)}`).join(', ') || 'No vehicles listed'}${p.acceptRate != null ? ` · accepts ${p.acceptRate}% of offers` : ''}</span></span>
            ${p.fits ? '<span class="pill s-on_board">Has a ' + esc(t.vehicleType) + '</span>' : '<span class="pill off">No ' + esc(t.vehicleType) + '</span>'}</label>`).join('')}</div></div>
          <div class="grid2"><label class="field"><span>You pay them ($)</span><input id="fm-rate" name="rate" type="number" min="1" step="1" value="${suggested}"><span class="hint" id="fm-keep"></span></label>
            <div class="field"><span>Customer pays you</span><b class="num" style="font-size:20px;padding-top:6px">${money(t.price.total)}</b></div></div>
          <label class="field"><span>Note for them</span><textarea id="fm-note" name="note" placeholder="Why you're sending it, passenger preferences, sign name…"></textarea></label>
          <p class="note small">Your passenger keeps dealing with you. The partner sees the trip, passenger name and phone, but not the customer's email or your price.</p>
          <div id="fm-err"></div></form>` : '<p class="muted">No other companies have joined the network yet.</p>',
        footer: partners.length ? '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="fm-send">Send offer</button>' : '<button class="btn" type="button" data-close>Close</button>',
      });
      $('[data-close]', m).onclick = closeModal;
      if (!partners.length) return;
      const keep = () => { const r = +$('#fm-rate', m).value || 0; $('#fm-keep', m).textContent = `You keep ${money(t.price.total - r)} (${t.price.total ? Math.round((t.price.total - r) / t.price.total * 100) : 0}%).`; };
      $('#fm-rate', m).oninput = keep; keep();
      $('#fm-send', m).onclick = (e) => busy(e.currentTarget, async () => {
        try {
          const f = formData($('#fm', m));
          const r = await api('network.offer', { tripId: t.id, ...f });
          toast(`${t.ref} offered to ${r.partnerName}. You'll see their answer on the board.`);
          closeModal();
        } catch (err) { showErr($('#fm-err', m), err); }
      });
    }

    const netState = { sub: 'trips', partner: null };
    async function drawNetwork(v) {
      let last = '';
      const refresh = async (silent) => {
        let d;
        try { d = await api('network.overview'); } catch (e) { if (!silent) showErr(v, e); return; }
        if (netState.sub === 'messages' && silent) return; // don't disturb typing
        const sig = JSON.stringify(d) + netState.sub; if (sig === last) return; last = sig;
        const subs = [['trips', `Trips${d.waiting ? ` (${d.waiting})` : ''}`], ['partners', 'Partners'], ['messages', `Messages${d.unreadTotal ? ` (${d.unreadTotal})` : ''}`], ['balances', 'Balances'], ['auto', `Auto farm-out${d.auto.on ? ' · on' : ''}`], ...(isAdmin ? [['settings', 'Settings']] : [])];
        v.innerHTML = `<div class="subtabs">${subs.map(([k, l]) => `<button type="button" data-sub="${k}" aria-pressed="${netState.sub === k}">${l}</button>`).join('')}</div>
          <div class="pagehead"><div class="stack" style="gap:4px"><h1>Network</h1><p class="muted">Companies on ${esc(PLATFORM)} send each other trips they can't cover. You keep the customer; the partner does the driving for an agreed amount.</p></div></div>
          ${d.me.joined ? '' : `<div class="warnbox" style="margin-bottom:16px"><b>You're not in the network yet.</b> Other companies can't see you or send you trips. ${isAdmin ? '<button class="btn sm" type="button" id="nw-join" style="margin-left:8px">Join the network</button>' : 'Ask your company admin to join.'}</div>`}
          <div id="nw"></div>`;
        $$('[data-sub]', v).forEach((b) => { b.onclick = () => { netState.sub = b.dataset.sub; last = ''; refresh(); }; });
        const j = $('#nw-join', v); if (j) j.onclick = () => busy(j, async () => { try { await api('network.saveSettings', { joined: true }); toast('You joined the network.'); last = ''; refresh(); } catch (e) { toast(e.message, true); } });
        const host = $('#nw', v);
        ({ trips: netTrips, partners: netPartners, messages: netMessages, balances: netBalances, auto: netAuto, settings: netSettings })[netState.sub](host, d, () => { last = ''; refresh(); });
      };
      current = { poll: true, refresh };
      v.innerHTML = '<p class="faint">Loading…</p>';
      refresh();
    }
    const farmPill = (r) => `<span class="pill ${({ offered: 's-assigned', accepted: 's-en_route', completed: 's-completed', declined: 's-cancelled', returned: 's-cancelled', cancelled: 'off', expired: 'off' })[r.status] || ''}">${esc(r.statusLabel)}</span>`;
    const tripLine = (x) => x ? `${esc(fmtDT(x.pickupAt))} · ${esc(x.vehicleType)} · ${x.passengers} pax` : '';
    function netTrips(host, d, redraw) {
      const waiting = d.incoming.filter((r) => r.status === 'offered');
      const inRest = d.incoming.filter((r) => r.status !== 'offered');
      host.innerHTML = `
        ${waiting.length ? `<span class="label">Waiting for your answer</span><div class="stack" style="margin:8px 0 22px">${waiting.map((r) => `<article class="trip offer">
          <div class="spread"><b>${esc(r.partnerName)} offers you a trip</b><b class="num" style="font-size:20px">${money(r.rate)}</b></div>
          <div class="small muted">${tripLine(r.trip)} · ${esc(r.trip.serviceLabel)}${r.trip.service === 'hourly' ? `, ${r.trip.hours} h` : ''}</div>
          <div class="route"><i></i><div>${esc(r.trip.pickup)}</div>${r.trip.dropoff ? `<span class="bar"></span><span></span><i class="end"></i><div>${esc(r.trip.dropoff)}</div>` : ''}</div>
          <div class="small">${r.trip.flight ? `Flight <span class="mono">${esc(r.trip.flight)}</span> · ` : ''}Passenger ${esc(r.trip.passengerName || '')}${r.trip.meetGreet ? ' · Meet & greet' : ''}${r.trip.childSeats ? ` · ${r.trip.childSeats} child seat(s)` : ''}</div>
          ${r.note ? `<div class="note">“${esc(r.note)}”</div>` : ''}
          <div class="row"><button class="btn primary" type="button" data-accept="${r.id}">Accept for ${money(r.rate)}</button>
            <input class="input grow" style="min-width:160px" data-reason="${r.id}" placeholder="Reason if you decline (optional)"><button class="btn" type="button" data-decline="${r.id}">Decline</button></div>
        </article>`).join('')}</div>` : ''}
        <span class="label">Trips you sent</span>
        ${d.sent.length ? `<div class="tablewrap" style="margin:8px 0 22px"><table><thead><tr><th>Pickup</th><th>Trip</th><th>Partner</th><th>Status</th><th>Chauffeur</th><th class="r">You pay</th><th class="r">You keep</th><th></th></tr></thead><tbody>
          ${d.sent.map((r) => `<tr><td class="mono small">${r.trip ? esc(fmtDT(r.trip.pickupAt)) : ''}</td><td><span class="mono small">${esc(r.ref)}</span><div class="small">${esc(r.trip ? r.trip.passengerName : '')}</div></td>
            <td>${esc(r.partnerName)}${r.auto ? ' <span class="pill count">Auto</span>' : ''}${r.childRef ? `<div class="mono small faint">${esc(r.childRef)}</div>` : ''}</td>
            <td>${farmPill(r)}${r.status === 'accepted' && r.trip ? `<div class="small faint">${esc(C.STATUS_LABELS[r.trip.status] || '')}</div>` : ''}${r.reason ? `<div class="small faint">${esc(r.reason)}</div>` : ''}</td>
            <td class="small">${r.affiliate && r.affiliate.driver ? `${esc(r.affiliate.driver.name)}${r.affiliate.vehicle ? `<div class="faint">${esc(r.affiliate.vehicle.name)} · ${esc(r.affiliate.vehicle.plate)}</div>` : ''}` : '—'}</td>
            <td class="r num">${money(r.rate)}</td><td class="r num ${r.margin < 0 ? 'bad' : ''}">${r.margin == null ? '' : money(r.margin)}</td>
            <td class="r"><button class="linkbtn small" type="button" data-open="${r.tripId}">Open</button></td></tr>`).join('')}</tbody></table></div>`
          : '<p class="faint small" style="margin:8px 0 22px">Nothing sent yet. Open a trip on the board and choose "Send to a partner company".</p>'}
        <span class="label">Trips you took from partners</span>
        ${inRest.length ? `<div class="tablewrap" style="margin-top:8px"><table><thead><tr><th>Pickup</th><th>From</th><th>Your trip</th><th>Status</th><th class="r">They pay you</th><th></th></tr></thead><tbody>
          ${inRest.map((r) => `<tr><td class="mono small">${r.trip ? esc(fmtDT(r.trip.pickupAt)) : ''}</td><td>${esc(r.partnerName)}<div class="mono small faint">${esc(r.ref)}</div></td>
            <td class="mono small">${esc(r.childRef || '—')}</td><td>${farmPill(r)}${r.status === 'accepted' && r.trip && r.trip.status ? `<div class="small faint">${esc(C.STATUS_LABELS[r.trip.status] || '')}</div>` : ''}</td>
            <td class="r num">${money(r.rate)}</td><td class="r">${r.tripId ? `<button class="linkbtn small" type="button" data-open="${r.tripId}">Open</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="faint small" style="margin-top:8px">None yet.</p>'}`;
      $$('[data-accept]', host).forEach((b) => { b.onclick = () => busy(b, async () => {
        try { const r = await api('network.respond', { id: b.dataset.accept, accept: true }); toast(`Accepted. It's on your board as ${r.childRef}. Assign a driver.`); redraw(); } catch (e) { toast(e.message, true); }
      }); });
      $$('[data-decline]', host).forEach((b) => { b.onclick = () => busy(b, async () => {
        try { await api('network.respond', { id: b.dataset.decline, accept: false, reason: $(`[data-reason="${b.dataset.decline}"]`, host).value }); toast('Declined. They have been told.'); redraw(); } catch (e) { toast(e.message, true); }
      }); });
      $$('[data-open]', host).forEach((b) => { b.onclick = () => tripModal(b.dataset.open, redraw); });
    }
    function netPartners(host, d) {
      host.innerHTML = d.members.length ? `<div class="partners">${d.members.map((p) => `<article class="panel partner">
        <div class="row"><span class="avatar" style="background:${esc(p.color || '#555')};color:#fff">${esc(initials(p.name))}</span><div class="grow"><b>${esc(p.name)}</b><div class="small muted">${esc(p.region)}</div></div></div>
        ${p.areas ? `<div class="small"><span class="faint">Covers</span> ${esc(p.areas)}</div>` : ''}
        ${p.about ? `<p class="small muted" style="margin:0">${esc(p.about)}</p>` : ''}
        <div class="row small">${p.vehicleTypes.map((v) => `<span class="pill count">${v.count} ${esc(v.type)}${v.count > 1 ? 's' : ''}</span>`).join('') || '<span class="faint">No vehicles listed</span>'}</div>
        <dl class="kv small"><dt>Drivers</dt><dd>${p.drivers}</dd><dt>You sent them</dt><dd>${p.sentToThem} trip${p.sentToThem === 1 ? '' : 's'}</dd><dt>They sent you</dt><dd>${p.gotFromThem} trip${p.gotFromThem === 1 ? '' : 's'}</dd>${p.acceptRate != null ? `<dt>Accepts</dt><dd>${p.acceptRate}% of offers</dd>` : ''}
          <dt>Office</dt><dd class="mono">${esc(p.phone || '')}</dd></dl>
        <div class="row"><button class="btn sm" type="button" data-msg="${p.id}">Message${d.unread[p.id] ? ` (${d.unread[p.id]})` : ''}</button></div>
      </article>`).join('')}</div>` : '<div class="panel muted">No other companies have joined the network yet.</div>';
      $$('[data-msg]', host).forEach((b) => { b.onclick = () => { netState.sub = 'messages'; netState.partner = b.dataset.msg; drawNetwork($('#view')); }; });
    }
    async function netMessages(host, d) {
      const partner = netState.partner || (d.members[0] && d.members[0].id);
      host.innerHTML = `<div class="chat">
        <nav class="chatlist">${d.members.map((p) => `<button type="button" data-p="${p.id}" aria-pressed="${p.id === partner}"><b>${esc(p.name)}</b>${d.unread[p.id] && p.id !== partner ? `<span class="pill count">${d.unread[p.id]}</span>` : ''}</button>`).join('') || '<p class="faint small">No partners yet.</p>'}</nav>
        <section class="chatpane" id="nw-chat">${partner ? '<p class="faint">Loading…</p>' : ''}</section></div>`;
      $$('[data-p]', host).forEach((b) => { b.onclick = () => { netState.partner = b.dataset.p; netMessages(host, d); }; });
      if (!partner) return;
      const pane = $('#nw-chat', host);
      const load = async () => {
        let th; try { th = await api('network.thread', { companyId: partner }); } catch (e) { return showErr(pane, e); }
        pane.innerHTML = `<div class="chathead"><b>${esc(th.partner.name)}</b><span class="small faint mono">${esc(th.partner.phone || '')}</span></div>
          <div class="msgs" id="nw-msgs">${th.messages.map((x) => x.system ? `<div class="sysmsg small">${esc(x.text)} <span class="faint">${esc(fmtDT(x.at))}</span></div>`
            : `<div class="bubble ${x.mine ? 'mine' : ''}"><div>${esc(x.text)}</div><span class="small faint">${esc(x.by)} · ${esc(fmtDT(x.at))}</span></div>`).join('') || '<p class="faint small">No messages yet.</p>'}</div>
          <form class="row" id="nw-send"><input class="input grow" id="nw-text" placeholder="Message ${esc(th.partner.name)}" autocomplete="off"><button class="btn primary" type="submit">Send</button></form>`;
        const ms = $('#nw-msgs', pane); ms.scrollTop = ms.scrollHeight;
        $('#nw-send', pane).onsubmit = async (e) => {
          e.preventDefault();
          const text = $('#nw-text', pane).value.trim(); if (!text) return;
          try { await api('network.send', { companyId: partner, text }); await load(); $('#nw-text', pane).focus(); } catch (err) { toast(err.message, true); }
        };
      };
      load();
    }
    function netBalances(host, d, redraw) {
      const done = d.sent.concat(d.incoming).filter((r) => r.status === 'completed');
      host.innerHTML = `<p class="muted small" style="margin-top:0">Money between you and partners for completed trips. Settle up however you agree (bank transfer, monthly invoice), then mark the trips settled.</p>
        ${d.balances.length ? `<div class="tablewrap" style="margin-bottom:22px"><table><thead><tr><th>Partner</th><th class="r">Trips</th><th class="r">You owe them</th><th class="r">They owe you</th><th class="r">Net</th></tr></thead><tbody>
          ${d.balances.map((b) => `<tr><td><b>${esc(b.partnerName)}</b></td><td class="r">${b.trips}</td><td class="r num">${money(b.youOwe)}</td><td class="r num">${money(b.owedToYou)}</td><td class="r num"><b>${b.net >= 0 ? money(b.net) + ' to you' : money(-b.net) + ' to them'}</b></td></tr>`).join('')}</tbody></table></div>`
          : '<div class="panel muted" style="margin-bottom:22px">All settled. Nothing owed either way.</div>'}
        <span class="label">Completed partner trips</span>
        ${done.length ? `<div class="tablewrap" style="margin-top:8px"><table><thead><tr><th>Done</th><th>Trip</th><th>Partner</th><th>Direction</th><th class="r">Amount</th><th></th></tr></thead><tbody>
          ${done.map((r) => `<tr><td class="mono small">${esc(fmtDate(r.completedAt || r.updatedAt))}</td><td class="mono small">${esc(r.ref)}</td><td>${esc(r.partnerName)}</td><td class="small">${r.direction === 'sent' ? 'You owe them' : 'They owe you'}</td><td class="r num">${money(r.rate)}</td>
            <td class="r">${r.settledAt ? `<span class="pill paid">Settled ${esc(fmtDate(r.settledAt))}</span> <button class="linkbtn small" type="button" data-unsettle="${r.id}">Undo</button>` : `<button class="btn sm" type="button" data-settle="${r.id}">Mark settled</button>`}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="faint small" style="margin-top:8px">None yet.</p>'}`;
      $$('[data-settle]', host).forEach((b) => { b.onclick = () => busy(b, async () => { try { await api('network.settle', { id: b.dataset.settle }); toast('Marked settled.'); redraw(); } catch (e) { toast(e.message, true); } }); });
      $$('[data-unsettle]', host).forEach((b) => { b.onclick = async () => { try { await api('network.settle', { id: b.dataset.unsettle, undo: true }); redraw(); } catch (e) { toast(e.message, true); } }; });
    }
    // Automatic farm-out rules: when to send, what to pay, and partners in order.
    function netAuto(host, d, redraw) {
      const a = d.auto, ro = isAdmin ? '' : 'disabled';
      let order = [...a.order, ...d.members.map((m) => m.id).filter((x) => !a.order.includes(x))];
      const picked = new Set(a.order);
      const byId = Object.fromEntries(d.members.map((m) => [m.id, m]));
      const auto = d.sent.filter((r) => r.auto).slice(0, 8);
      host.innerHTML = `<div class="autofarm">
        <form class="panel stack" id="af-form">
          <div class="spread"><div class="stack" style="gap:2px"><h2 style="margin:0;font-size:18px">Send trips to partners automatically</h2>
            <p class="small muted" style="margin:0">When none of your own cars is free, the trip goes to your first partner. If they decline or don't answer in time, it goes to the next one. You keep the customer and the price.</p></div>
            <label class="switch"><input type="checkbox" name="on" id="af-on" ${a.on ? 'checked' : ''} ${ro}><span>${a.on ? 'On' : 'Off'}</span></label></div>
          ${d.me.joined ? '' : '<div class="note warn">Join the network first, under Settings.</div>'}
          <fieldset class="fs"><legend>When to send a trip</legend>
            <label class="check"><input type="checkbox" name="noDriver" ${a.noDriver ? 'checked' : ''} ${ro}> <span>Auto-dispatch can't find a free driver with a suitable car</span></label>
            <div class="row"><label class="check"><input type="checkbox" id="af-lc" ${a.lastCallHours ? 'checked' : ''} ${ro}> <span>Any trip still without a driver</span></label>
              <input class="input num-in" type="number" name="lastCallHours" min="1" max="48" value="${a.lastCallHours || 2}" ${ro}><span class="small">hours before pickup</span></div>
          </fieldset>
          <fieldset class="fs"><legend>Offer</legend>
            <div class="row"><span>Pay the partner</span><input class="input num-in" type="number" name="ratePct" min="10" max="100" value="${a.ratePct}" ${ro}><span>% of the fare</span></div>
            <div class="row"><span>Wait</span><input class="input num-in" type="number" name="answerMin" min="5" max="240" value="${a.answerMin}" ${ro}><span>minutes for an answer, then try the next partner</span></div>
          </fieldset>
          <fieldset class="fs"><legend>Partners, in order</legend>
            ${d.members.length ? `<ol class="aflist" id="af-list"></ol><p class="small faint" style="margin:0">Only partners with a car that seats everyone get the offer. A bigger car counts; a party bus only when one was booked.</p>` : '<p class="small muted" style="margin:0">No other companies are in the network yet.</p>'}
          </fieldset>
          ${isAdmin ? '<div><button class="btn primary" type="submit">Save rules</button></div>' : '<p class="small muted">Only a company admin can change these rules.</p>'}
        </form>
        <div class="stack"><span class="label">Sent automatically</span>
          ${auto.length ? `<div class="tablewrap"><table><thead><tr><th>Trip</th><th>Partner</th><th>Status</th><th class="r">You pay</th></tr></thead><tbody>${auto.map((r) => `<tr><td><b>${esc(r.ref)}</b><div class="small muted">${r.trip ? esc(fmtDT(r.trip.pickupAt)) : ''}</div></td><td>${esc(r.partnerName)}</td><td>${farmPill(r)}</td><td class="r num">${money(r.rate)}</td></tr>`).join('')}</tbody></table></div>`
            : `<p class="small faint">${a.on ? 'Nothing yet. Trips appear here when they go out.' : 'Nothing yet.'}</p>`}
        </div></div>`;
      const drawList = () => {
        const el = $('#af-list', host); if (!el) return;
        el.innerHTML = order.map((pid, i) => { const m = byId[pid]; if (!m) return ''; return `<li class="${picked.has(pid) ? '' : 'off'}">
          <label class="check"><input type="checkbox" data-pick="${pid}" ${picked.has(pid) ? 'checked' : ''} ${ro}> <span><b>${esc(m.name)}</b><span class="small muted"> · ${esc(m.region)} · ${esc(m.vehicleTypes.map((v) => v.type).join(', ') || 'no cars listed')}${m.acceptRate != null ? ` · accepts ${m.acceptRate}%` : ''}</span></span></label>
          <span class="row" style="gap:4px"><button class="btn sm" type="button" data-up="${i}" ${i === 0 || ro ? 'disabled' : ''} aria-label="Move up">↑</button><button class="btn sm" type="button" data-down="${i}" ${i === order.length - 1 || ro ? 'disabled' : ''} aria-label="Move down">↓</button></span></li>`; }).join('');
        $$('[data-pick]', el).forEach((c) => { c.onchange = () => { if (c.checked) picked.add(c.dataset.pick); else picked.delete(c.dataset.pick); drawList(); }; });
        $$('[data-up]', el).forEach((b) => { b.onclick = () => { const i = +b.dataset.up; [order[i - 1], order[i]] = [order[i], order[i - 1]]; drawList(); }; });
        $$('[data-down]', el).forEach((b) => { b.onclick = () => { const i = +b.dataset.down; [order[i + 1], order[i]] = [order[i], order[i + 1]]; drawList(); }; });
      };
      drawList();
      const f = $('#af-form', host);
      $('#af-on', host).onchange = (e) => { e.target.nextElementSibling.textContent = e.target.checked ? 'On' : 'Off'; };
      f.onsubmit = async (e) => {
        e.preventDefault();
        const x = formData(f);
        try {
          await api('network.saveAuto', { on: !!$('#af-on', f).checked, noDriver: !!f.noDriver.checked, lastCallHours: $('#af-lc', f).checked ? +x.lastCallHours : 0, ratePct: +x.ratePct, answerMin: +x.answerMin, partners: order.filter((pid) => picked.has(pid)) });
          toast($('#af-on', f).checked ? 'Rules saved. Automatic farm-out is on.' : 'Rules saved. Automatic farm-out is off.');
          redraw();
        } catch (err) { toast(err.message, true); }
      };
    }
    function netSettings(host, d, redraw) {
      host.innerHTML = `<form class="panel stack" id="nw-set" style="max-width:640px">
        <label class="switch"><input type="checkbox" name="joined" ${d.me.joined ? 'checked' : ''}><span>Listed in the network. Other companies can see you and send you trips.</span></label>
        <label class="field"><span>Areas you cover</span><input class="input" name="areas" value="${esc(d.me.areas || '')}" placeholder="Cities, counties and airports"><span class="hint">Partners see this when choosing who to send a trip to. Your base: ${esc(d.me.region)}.</span></label>
        <label class="field"><span>About your company</span><textarea name="about" placeholder="Fleet, specialties, languages, how to reach your dispatch after hours">${esc(d.me.about || '')}</textarea></label>
        <div><button class="btn primary" type="submit">Save</button></div></form>`;
      $('#nw-set', host).onsubmit = async (e) => { e.preventDefault(); try { await api('network.saveSettings', formData(e.target)); toast('Network settings saved.'); redraw(); } catch (err) { toast(err.message, true); } };
    }

    // Trips ------------------------------------------------------------------
    function drawTrips(v) {
      const f = { q: '', status: '' };
      v.innerHTML = `<div class="pagehead"><h1>Trips</h1><div class="row"><button class="btn" type="button" id="t-import">Import from a spreadsheet</button><button class="btn primary" type="button" id="t-new">New booking</button></div></div>
        <div class="row" style="margin-bottom:14px"><input class="input" style="max-width:320px" id="t-q" type="search" placeholder="Search name, reference, address, flight">
          <div class="seg" id="t-when">${[['upcoming', 'Upcoming'], ['past', 'Past'], ['all', 'All']].map(([k, l]) => `<button type="button" data-when="${k}" aria-pressed="${k === 'upcoming'}">${l}</button>`).join('')}</div>
          <select class="input" style="width:auto" id="t-status"><option value="">All statuses</option><option value="active">In progress</option>${Object.entries(C.STATUS_LABELS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
        <div id="t-list"></div>`;
      let last = '';
      async function refresh(silent) {
        let trips;
        try { trips = await api('dispatch.trips', f); } catch (e) { if (!silent) showErr($('#t-list', v), e); return; }
        const sig = JSON.stringify(trips) + when + shown; if (sig === last) return; last = sig;
        // Upcoming (soonest first) by default; past trips newest first. A search or
        // status filter looks through everything.
        const open = (t) => !['completed', 'cancelled'].includes(t.status);
        const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
        const w = f.q || f.status ? 'all' : when;
        const all = trips.length;
        if (w === 'upcoming') trips = trips.filter((t) => open(t) || new Date(t.pickupAt) >= dayStart).sort((x, y) => x.pickupAt.localeCompare(y.pickupAt));
        else if (w === 'past') trips = trips.filter((t) => !open(t) && new Date(t.pickupAt) < dayStart).sort((x, y) => y.pickupAt.localeCompare(x.pickupAt));
        const more = trips.length - shown;
        trips = trips.slice(0, shown);
        $('#t-list', v).innerHTML = trips.length ? `<div class="tablewrap"><table><thead><tr><th>Pickup</th><th>Ref</th><th>Passenger</th><th>Route</th><th>Vehicle</th><th>Driver</th><th>Status</th><th class="r">Total</th></tr></thead><tbody>
          ${trips.map((t) => `<tr class="click" data-id="${t.id}"><td class="mono small" style="white-space:nowrap">${esc(fmtDT(t.pickupAt))}</td><td class="mono small">${esc(t.ref)}</td><td>${esc(t.passengerName)}</td>
            <td class="small" style="min-width:220px">${esc(t.pickup)}${t.dropoff ? `<br><span class="faint">→ ${esc(t.dropoff)}</span>` : ''}${t.flight ? `<br><span class="mono faint">✈ ${esc(t.flight)}</span>` : ''}</td><td class="small">${esc(t.vehicle ? t.vehicle.name : t.vehicleType)}</td>
            <td class="small">${t.driver ? esc(t.driver.name) : '<span class="warntext">Unassigned</span>'}</td><td>${pill(t)}</td><td class="r num">${money(t.price.total)}<br>${payPill(t)}</td></tr>`).join('')}
          </tbody></table></div>${more > 0 ? `<div class="row" style="justify-content:center;margin-top:12px"><button class="btn" type="button" id="t-more">Show ${Math.min(more, 50)} more</button></div>` : ''}` : `<div class="panel muted">${all && w !== 'all' ? `No ${w} trips. <button type="button" class="linkbtn" data-when="all">See all trips</button>` : 'No trips match.'}</div>`;
        $$('tr[data-id]', v).forEach((r) => { r.onclick = () => tripModal(r.dataset.id, () => { last = ''; refresh(); }); });
        const mb = $('#t-more', v); if (mb) mb.onclick = () => { shown += 50; refresh(); };
        $$('#t-list [data-when]', v).forEach((b) => { b.onclick = () => setWhen(b.dataset.when); });
      }
      let when = 'upcoming', shown = 50;
      const setWhen = (k) => { when = k; shown = 50; $$('#t-when button', v).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.when === k))); refresh(); };
      $$('#t-when button', v).forEach((b) => { b.onclick = () => setWhen(b.dataset.when); });
      let st = null;
      $('#t-q', v).oninput = (e) => { f.q = e.target.value; clearTimeout(st); st = setTimeout(() => { last = ''; refresh(); }, 200); };
      $('#t-status', v).onchange = (e) => { f.status = e.target.value; last = ''; refresh(); };
      $('#t-new', v).onclick = () => newBookingModal(() => { last = ''; refresh(); });
      $('#t-import', v).onclick = () => importModal(() => { last = ''; refresh(); });
      current = { poll: true, refresh };
      refresh();
    }

    // Calendar -----------------------------------------------------------------
    async function drawCalendar(v) {
      v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Calendar</h1><p class="muted">Every ride by day. Tap a ride to open it, or a day to see that week.</p></div><div class="row"><button class="btn primary" type="button" id="cal-new">New booking</button></div></div><div id="cal-host"></div>`;
      let drivers = [];
      try { drivers = await api('dispatch.drivers'); } catch (e) { /* filter is optional */ }
      const cal = rideCalendar($('#cal-host', v), {
        key: 'livery-cal-view-' + session.user.id,
        drivers: drivers.map((d) => ({ id: d.id, name: d.name })),
        load: (from, to) => api('dispatch.trips', { from, to }),
        open: (t, redraw) => tripModal(t.id, redraw),
      });
      $('#cal-new', v).onclick = () => newBookingModal(() => cal.refresh());
      current = { poll: true, refresh: (silent) => { if (!silent) cal.refresh(); } };
    }

    // Trip import: a CSV saved from Excel or Google Sheets, checked row by row before anything is saved.
    const IMPORT_COLS = [['date', 'Date'], ['time', 'Time'], ['passengerName', 'Passenger'], ['passengerPhone', 'Phone'], ['passengerEmail', 'Email'], ['pickup', 'Pickup'], ['dropoff', 'Drop-off'], ['vehicleType', 'Vehicle type'], ['passengers', 'Passengers'], ['service', 'Service'], ['hours', 'Hours'], ['flight', 'Flight'], ['account', 'Company account'], ['poNumber', 'PO number'], ['notes', 'Notes']];
    function parseCsv(text) {
      const rows = []; let row = [], cell = '', q = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
        else if (ch === '"') q = true;
        else if (ch === ',' || ch === '\t') { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x.trim())) rows.push(row); row = []; }
        else cell += ch;
      }
      row.push(cell); if (row.some((x) => x.trim())) rows.push(row);
      return rows;
    }
    function importRows(text) {
      const grid = parseCsv(text.replace(/^\ufeff/, ''));
      if (grid.length < 2) throw new Error('The file needs a header row and at least one trip.');
      const norm = (h) => h.toLowerCase().replace(/[^a-z]/g, '');
      const alias = { pickupdate: 'date', day: 'date', pickuptime: 'time', name: 'passengerName', passengername: 'passengerName', mobile: 'passengerPhone', phonenumber: 'passengerPhone', from: 'pickup', pickupaddress: 'pickup', to: 'dropoff', dropoffaddress: 'dropoff', vehicle: 'vehicleType', pax: 'passengers', flightnumber: 'flight', account: 'account', po: 'poNumber' };
      const keyOf = (h) => { const n = norm(h); const hit = IMPORT_COLS.find(([k, l]) => norm(l) === n || norm(k) === n); return hit ? hit[0] : alias[n] || null; };
      const keys = grid[0].map(keyOf);
      if (!keys.includes('date') || !keys.includes('pickup')) throw new Error('Couldn\'t find the Date and Pickup columns. Start from the template.');
      return grid.slice(1).map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] || '').trim()]).filter(([k]) => k)));
    }
    function importModal(done) {
      let rows = null;
      const m = openModal({
        title: 'Import trips', wide: true,
        body: `<div class="stack"><p class="small muted">Save your spreadsheet as CSV (Excel and Google Sheets both can) with one trip per row. Times are ${esc(session.company.name)}'s local time. We check every row first and save nothing until all rows are right.</p>
          <div class="row"><button class="btn sm" type="button" id="im-tpl">Download the template</button><label class="btn sm"><input type="file" id="im-file" accept=".csv,text/csv,.txt" hidden>Choose a CSV file</label><span class="small faint" id="im-name"></span></div>
          <label class="switch"><input type="checkbox" id="im-confirm"><span>Send each passenger the booking confirmation</span></label>
          <div id="im-out"></div></div>`,
        footer: '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="im-go" disabled>Import</button>',
      });
      $('[data-close]', m).onclick = closeModal;
      $('#im-tpl', m).onclick = async () => {
        const d = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
        const sample = [IMPORT_COLS.map((c) => c[1]), [d, '14:30', 'Jordan Smith', '(206) 555-0100', 'jordan@example.com', 'Seattle-Tacoma International Airport (SEA)', '1201 3rd Ave, Seattle', 'Sedan', '1', 'Airport transfer', '', 'AS 330', '', '', 'Meet at baggage claim'], [d, '6:00 PM', 'Casey Lee', '(206) 555-0101', '', 'Space Needle, Seattle', '', 'SUV', '4', 'By the hour', '3', '', '', '', '']];
        await saveFile('trip-import-template.csv', sample.map((r) => r.map((x) => /[",]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x).join(',')).join('\r\n'), 'text/csv');
      };
      const show = (res, saved) => {
        $('#im-out', m).innerHTML = `<p class="${res.bad ? 'needtag' : 'small'}">${saved ? `Imported ${res.saved} trips.` : res.bad ? `${res.bad} of ${res.rows.length} rows need fixing. Fix them in the spreadsheet and choose the file again.` : `All ${res.rows.length} rows are ready.`}</p>
          <div class="tablewrap"><table><thead><tr><th>Row</th><th>Passenger</th><th>Pickup</th><th>Result</th></tr></thead><tbody>${res.rows.map((r) => `<tr><td class="mono small">${r.row + 1}</td><td>${esc(r.passengerName || '')}</td><td class="small">${r.ok ? `${esc(fmtDT(r.pickupAt))}<br><span class="faint">${esc(r.pickup)}</span>` : ''}</td><td class="small">${r.ok ? (r.ref ? `<span class="mono">${esc(r.ref)}</span>` : `${esc(r.vehicleType)} · ${money(r.total)}`) : `<span class="err-text">${esc(r.error)}</span>`}</td></tr>`).join('')}</tbody></table></div>`;
      };
      $('#im-file', m).onchange = async (e) => {
        const file = e.target.files[0]; if (!file) return;
        $('#im-name', m).textContent = file.name;
        try { rows = importRows(await file.text()); const res = await api('dispatch.importTrips', { rows, check: true }); show(res); $('#im-go', m).disabled = !!res.bad; }
        catch (err) { rows = null; $('#im-go', m).disabled = true; $('#im-out', m).innerHTML = `<p class="err-text">${esc(err.message)}</p>`; }
        e.target.value = '';
      };
      $('#im-go', m).onclick = (e) => busy(e.currentTarget, async () => {
        try { const res = await api('dispatch.importTrips', { rows, confirm: $('#im-confirm', m).checked }); show(res, true); $('#im-go', m).disabled = true; toast(`Imported ${res.saved} trips.`); done(); }
        catch (err) { $('#im-out', m).insertAdjacentHTML('afterbegin', `<p class="err-text">${esc(err.message)}</p>`); }
      });
    }

    // Flights ----------------------------------------------------------------
    function drawFlights(v) {
      let last = '';
      async function refresh(silent, force) {
        let d;
        try { d = await api('dispatch.flights', { force: !!force }); } catch (e) { if (!silent) showErr(v, e); return; }
        if (force && d.moved.length) toast(`Pickup moved for ${d.moved.join(', ')}. Drivers and passengers told.`);
        else if (force) toast('All flights checked.');
        const sig = JSON.stringify(d); if (sig === last) return; last = sig;
        const s = d.settings;
        const late = d.trips.filter((t) => t.flightInfo && t.flightInfo.delayMin && t.flightInfo.status !== 'landed').length;
        v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Flights</h1>
            <p class="muted">Every trip with a flight number in the next two days. The system checks them every few minutes${s.lastRun ? `, last at ${esc(fmtTime(s.lastRun))}` : ''}.</p></div>
            <button class="btn primary" type="button" id="fl-check">Check all flights now</button></div>
          <div class="tiles" style="margin-bottom:16px">
            <div class="tile"><span class="label">Flights tracked</span><b>${d.trips.length}</b></div>
            <div class="tile"><span class="label">Running late</span><b>${late}</b></div>
            <div class="tile"><span class="label">Pickups moved</span><b>${d.trips.filter((t) => t.pickupAt !== t.scheduledPickupAt).length}</b></div>
          </div>
          <form class="panel row" id="fl-set" style="margin-bottom:16px;gap:18px">
            <label class="switch"><input type="checkbox" id="fl-auto" name="autoAdjust" ${s.autoAdjust ? 'checked' : ''} ${isAdmin ? '' : 'disabled'}><span>Move pickup times automatically when an arriving flight is late</span></label>
            <label class="row small">Only when late by at least <input class="input" style="width:80px" type="number" id="fl-min" name="minDelay" min="0" max="180" value="${s.minDelay}" ${isAdmin ? '' : 'disabled'}> min</label>
            ${isAdmin ? '<button class="btn sm" type="submit">Save</button>' : '<span class="small faint">Only the company admin can change this.</span>'}
          </form>
          ${d.trips.length ? `<div class="tablewrap"><table><thead><tr><th>Pickup</th><th>Trip</th><th>Flight</th><th>Status</th><th>Scheduled</th><th>Now expected</th><th>Terminal</th><th>Driver</th><th></th></tr></thead><tbody>
          ${d.trips.map((t) => { const f = t.flightInfo || {}; const apply = f.suggestedPickup && f.suggestedPickup !== t.pickupAt && ['confirmed', 'assigned', 'accepted', 'en_route'].includes(t.status);
            return `<tr class="click" data-id="${t.id}"><td class="mono small" style="white-space:nowrap">${esc(fmtDT(t.pickupAt))}${t.pickupAt !== t.scheduledPickupAt ? `<br><span class="faint">was ${esc(fmtTime(t.scheduledPickupAt))}</span>` : ''}</td>
              <td><span class="mono small">${esc(t.ref)}</span><br>${esc(t.passengerName)}</td>
              <td><b class="mono">${esc(t.flight)}</b><br><span class="small faint">${esc(f.airline || '')} · ${f.kind === 'departure' ? 'departing' : 'arriving'}${f.airport ? ' ' + esc(f.airport) : ''}</span></td>
              <td>${flightPill(f)}</td><td class="mono small">${f.scheduled ? esc(fmtTime(f.scheduled)) : ''}</td><td class="mono small"><b>${f.estimated ? esc(fmtTime(f.estimated)) : ''}</b></td>
              <td class="small">${esc(f.terminal || '')}${f.claim ? ` · claim ${f.claim}` : ''}</td><td class="small">${t.driver ? esc(t.driver.name) : '<span class="warntext">Unassigned</span>'}</td>
              <td>${apply ? `<button class="btn sm" type="button" data-apply="${t.id}">Move pickup</button>` : ''}</td></tr>`; }).join('')}
          </tbody></table></div>` : '<div class="panel muted">No upcoming trips have a flight number.</div>'}
          <p class="small faint" style="margin-top:10px">Flight times are simulated in this version. Connecting FlightAware gives live times, gates and delays.</p>`;
        $('#fl-check', v).onclick = (e) => busy(e.currentTarget, () => { last = ''; return refresh(false, true); });
        $('#fl-set', v).onsubmit = async (e) => { e.preventDefault(); try { await api('dispatch.saveFlightSettings', formData(e.target)); toast('Flight settings saved.'); last = ''; refresh(); } catch (err) { toast(err.message, true); } };
        $$('tr[data-id]', v).forEach((r) => { r.onclick = (e) => { if (e.target.closest('[data-apply]')) return; tripModal(r.dataset.id, () => { last = ''; refresh(); }); }; });
        $$('[data-apply]', v).forEach((b) => { b.onclick = () => busy(b, async () => { try { await api('dispatch.applyFlight', { id: b.dataset.apply }); toast('Pickup moved. Driver and passenger told.'); last = ''; refresh(); } catch (err) { toast(err.message, true); } }); });
      }
      current = { poll: true, refresh };
      v.innerHTML = '<p class="faint">Loading…</p>';
      refresh();
    }

    // Drivers ----------------------------------------------------------------
    let driverSub = 'list';
    function drawDrivers(v) {
      current = { poll: false };
      v.innerHTML = `<div class="subtabs">${[['list', 'Drivers'], ['auto', 'Auto-dispatch'], ...(P.pay ? [['pay', 'Driver pay']] : []), ['hours', 'Hours'], ['timeoff', 'Time off']].map(([k, l]) => `<button type="button" data-sub="${k}" aria-pressed="${driverSub === k}">${l}</button>`).join('')}</div><div id="dv"></div>`;
      $$('[data-sub]', v).forEach((b) => { b.onclick = () => { driverSub = b.dataset.sub; drawDrivers(v); }; });
      const host = $('#dv', v);
      ({ list: driverList, auto: autoDispatchView, pay: driverPayView, hours: hoursView, timeoff: timeOffView })[driverSub](host, () => drawDrivers(v));
    }
    async function driverList(host, redraw) {
      let drivers, vehicles;
      try { [drivers, vehicles] = await Promise.all([api('dispatch.drivers'), api('dispatch.vehicles')]); } catch (e) { return showErr(host, e); }
      host.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Drivers</h1><p class="muted">Each driver signs in to the driver app with their own email and password. Open a driver for their schedule, documents, pay and reviews.</p></div><button class="btn primary" type="button" id="dr-add">Add driver</button></div>
        <div class="tablewrap"><table><thead><tr><th>Driver</th><th>Usual vehicle</th><th>Today</th><th class="r">Rating</th><th class="r">Accepts</th><th class="r">On time</th><th class="r">Trips (30 days)</th><th>Documents</th></tr></thead><tbody>
        ${drivers.map((d) => `<tr class="click" data-id="${d.id}"><td><div class="row" style="gap:10px;flex-wrap:nowrap">${face(d.name, d.photo, 'sm')}<div><b>${esc(d.name)}</b><br><span class="mono small faint">${esc(d.phone)}</span></div></div></td>
          <td class="small">${esc((vehicles.find((x) => x.id === d.vehicleId) || {}).name || '—')}</td>
          <td>${!d.active ? '<span class="pill off">Login disabled</span>' : d.timeOffToday ? '<span class="pill s-arrived">Time off</span>' : d.available ? '<span class="pill s-on_board">Available</span>' : '<span class="pill off">Off duty</span>'}</td>
          <td class="r num">${d.rating == null ? '—' : `<span class="stars">★</span> ${d.rating.toFixed(1)}`}</td><td class="r num">${pct(d.acceptance)}</td><td class="r num">${pct(d.onTime)}</td><td class="r num">${d.completed30}</td>
          <td><div class="row" style="gap:4px">${docPill('License', d.licenseExp)}${docPill('Permit', d.permitExp)}</div></td></tr>`).join('') || '<tr><td colspan="8" class="faint">No drivers yet.</td></tr>'}
        </tbody></table></div>`;
      $('#dr-add', host).onclick = () => driverModal(null, vehicles, redraw);
      $$('tr[data-id]', host).forEach((r) => { r.onclick = () => driverModal(r.dataset.id, vehicles, redraw); });
    }
    async function driverModal(id, vehicles, done) {
      let data = { driver: { name: '', email: '', phone: '', active: true, payType: 'percent', payRate: 35, schedule: Object.fromEntries(C.DAYS.map((d) => [d, { on: !['sat', 'sun'].includes(d), start: '07:00', end: '19:00' }])) }, stats: null, timeOff: [], recent: [] };
      if (id) { try { data = await api('dispatch.driver', { id }); } catch (e) { return toast(e.message, true); } }
      const d = data.driver, s = data.stats;
      const DAYN = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
      const m = openModal({
        title: id ? d.name : 'Add driver', wide: true, onClose: done,
        body: `${s ? `<div class="tiles">
            <div class="tile"><span class="label">Rating</span><b>${s.rating == null ? '—' : s.rating.toFixed(1)}</b><span class="small faint">${s.ratings} ratings</span></div>
            <div class="tile"><span class="label">Accepts trips</span><b>${pct(s.acceptance)}</b></div>
            <div class="tile"><span class="label">On time</span><b>${pct(s.onTime)}</b></div>
            <div class="tile"><span class="label">Last 30 days</span><b>${s.completed30} trips</b><span class="small faint">${money0(s.revenue30)} billed</span></div></div>` : ''}
          ${id ? `<div id="dm-photo">${photoField(d.name, d.photo, 'dm-photofile')}</div>` : ''}
          <form id="dm" class="stack" novalidate>
            <h3>Contact and login</h3>
            <div class="grid3"><label class="field"><span>Full name</span><input id="dm-name" name="name" value="${esc(d.name)}"></label>
              <label class="field"><span>Mobile</span><input id="dm-phone" name="phone" type="tel" value="${esc(d.phone)}"></label>
              <label class="field"><span>Email (sign-in)</span><input id="dm-email" name="email" type="email" value="${esc(d.email)}"></label></div>
            <div class="grid3"><label class="field"><span>${id ? 'New password' : 'Password'}</span><input id="dm-pass" name="password" type="text" autocomplete="new-password" placeholder="${id ? 'Leave blank to keep' : 'At least 8 characters'}"></label>
              <label class="field"><span>Usual vehicle</span><select id="dm-vehicle" name="vehicleId"><option value="">None</option>${vehicles.filter((x) => x.status !== 'retired').map((x) => `<option value="${x.id}" ${d.vehicleId === x.id ? 'selected' : ''}>${esc(x.name)} · ${esc(x.plate)}</option>`).join('')}</select></label>
              <label class="switch" style="align-self:end;min-height:40px"><input type="checkbox" id="dm-active" name="active" ${d.active === false ? '' : 'checked'}><span>Login enabled</span></label></div>
            <h3>License and documents</h3>
            <div class="grid3"><label class="field"><span>Driver's license number</span><input id="dm-lic" name="licenseNumber" class="mono" value="${esc(d.licenseNumber || '')}"></label>
              <label class="field"><span>License expires</span><input id="dm-licexp" name="licenseExp" type="date" value="${esc(d.licenseExp || '')}"></label>
              <label class="field"><span>Chauffeur permit expires</span><input id="dm-permit" name="permitExp" type="date" value="${esc(d.permitExp || '')}"></label></div>
            <h3>Pay</h3>
            <div class="grid3"><label class="field"><span>Paid by</span><select id="dm-paytype" name="payType">${Object.entries(C.PAY_TYPES).map(([k, l]) => `<option value="${k}" ${d.payType === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
              <label class="field"><span>Rate</span><input id="dm-payrate" name="payRate" type="number" min="0" step="0.5" value="${d.payRate}"><span class="hint">Percent, or dollars per hour or trip. Tips and tolls always go to the driver.</span></label>
              <label class="field"><span>Hire date</span><input id="dm-hire" name="hireDate" type="date" value="${esc(d.hireDate || '')}"></label></div>
            <h3>Weekly schedule</h3>
            <div class="sched">${C.DAYS.map((k) => { const x = (d.schedule || {})[k] || { on: false, start: '07:00', end: '19:00' }; return `<label class="switch"><input type="checkbox" data-day="${k}" ${x.on ? 'checked' : ''}><span>${DAYN[k]}</span></label><input class="input" type="time" data-start="${k}" value="${x.start}"><input class="input" type="time" data-end="${k}" value="${x.end}">`; }).join('')}</div>
            <label class="field"><span>Notes</span><textarea id="dm-notes" name="notes">${esc(d.notes || '')}</textarea></label>
            <div id="dm-err"></div>
            <div><button class="btn primary" type="submit">${id ? 'Save driver' : 'Add driver'}</button></div>
          </form>
          ${id ? `<div class="stack"><h3>Time off</h3>
            ${data.timeOff.length ? `<div class="tablewrap"><table><tbody>${data.timeOff.map((x) => `<tr><td class="small nowrap">${esc(fmtDays(x.from, x.to))}</td><td class="small">${esc(x.reason || '')}</td>
              <td><span class="pill ${x.status === 'approved' ? 's-on_board' : x.status === 'declined' ? 's-cancelled' : 's-assigned'}">${x.status === 'requested' ? 'Waiting' : x.status === 'approved' ? 'Approved' : 'Declined'}</span></td>
              <td class="r">${x.status === 'requested' ? `<button class="btn sm" type="button" data-off="approve" data-id="${x.id}">Approve</button> <button class="btn sm" type="button" data-off="decline" data-id="${x.id}">Decline</button>` : `<button class="btn sm" type="button" data-off="delete" data-id="${x.id}">Remove</button>`}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small faint">No time off booked.</p>'}
            <form class="row" id="dm-off"><input class="input" style="width:auto" type="date" name="from" id="dmo-from"><span class="small">to</span><input class="input" style="width:auto" type="date" name="to" id="dmo-to"><input class="input grow" name="reason" id="dmo-reason" placeholder="Reason"><button class="btn sm" type="submit">Add time off</button></form>
            </div>
            ${s.reviews.length ? `<div class="stack"><h3>Recent reviews</h3>${s.reviews.map((r) => `<div class="qline"><span><span class="stars">${stars(r.stars)}</span> ${esc(r.comment)}</span><span class="mono small faint">${esc(r.ref)}</span></div>`).join('')}</div>` : ''}
            ${data.recent.length ? `<div class="stack"><h3>Recent trips</h3><div class="tablewrap"><table><tbody>${data.recent.map((t) => `<tr><td class="mono small">${esc(fmtDT(t.pickupAt))}</td><td class="mono small">${esc(t.ref)}</td><td class="small">${esc(t.passengerName)}</td><td>${pill(t)}</td><td class="r num">${money(t.price.total)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}` : ''}`,
      });
      const reopen = () => { m._onClose = null; closeModal(); driverModal(id, vehicles, done); };
      const drawPhoto = (photo) => { const h = $('#dm-photo', m); if (!h) return; h.innerHTML = photoField(d.name, photo, 'dm-photofile'); wirePhoto(h, 'dm-photofile', async (p) => { const r = await api('dispatch.setDriverPhoto', { id, photo: p }); drawPhoto(r.photo); }); };
      if (id) drawPhoto(d.photo);
      $('#dm', m).onsubmit = async (e) => {
        e.preventDefault();
        const f = formData(e.target);
        f.schedule = {};
        for (const k of C.DAYS) f.schedule[k] = { on: $(`[data-day=${k}]`, m).checked, start: $(`[data-start=${k}]`, m).value, end: $(`[data-end=${k}]`, m).value };
        await busy($('button[type=submit]', e.target), async () => {
          try { const r = await api('dispatch.saveDriver', { ...f, id }); toast(id ? 'Driver saved.' : `${r.name} added. They can sign in now.`); if (id) reopen(); else closeModal(); } catch (err) { showErr($('#dm-err', m), err); }
        });
      };
      $$('[data-off]', m).forEach((b) => { b.onclick = () => busy(b, async () => { try { await api('dispatch.timeOff', { action: b.dataset.off, id: b.dataset.id }); reopen(); } catch (err) { toast(err.message, true); } }); });
      const of = $('#dm-off', m);
      if (of) of.onsubmit = async (e) => { e.preventDefault(); try { await api('dispatch.timeOff', { action: 'add', driverId: id, ...formData(of) }); toast('Time off added.'); reopen(); } catch (err) { toast(err.message, true); } };
    }
    let payPeriod = null;
    function periodFor(kind) {
      const n = new Date(); n.setHours(12, 0, 0, 0);
      const monday = new Date(n); monday.setDate(n.getDate() - ((n.getDay() + 6) % 7));
      const iso = (d) => toLocalInput(d).slice(0, 10);
      if (kind === 'last') { const a = new Date(monday); a.setDate(a.getDate() - 7); const b = new Date(monday); b.setDate(b.getDate() - 1); return { from: iso(a), to: iso(b), kind }; }
      if (kind === 'month') { const a = new Date(n.getFullYear(), n.getMonth(), 1, 12); return { from: iso(a), to: iso(n), kind }; }
      const b = new Date(monday); b.setDate(b.getDate() + 6);
      return { from: iso(monday), to: iso(b), kind: 'week' };
    }
    async function driverPayView(host, redraw) {
      payPeriod = payPeriod || periodFor('week');
      let rows;
      try { rows = await api('dispatch.payroll', payPeriod); } catch (e) { return showErr(host, e); }
      const tot = rows.reduce((a, r) => ({ trips: a.trips + r.trips, hours: a.hours + Number(r.hours || 0), fares: a.fares + r.fares, base: a.base + r.base, tips: a.tips + r.tips, reimbursed: a.reimbursed + r.reimbursed, total: a.total + r.total }), { trips: 0, hours: 0, fares: 0, base: 0, tips: 0, reimbursed: 0, total: 0 });
      host.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Driver pay</h1><p class="muted">Pay for completed trips in the period, worked out from each driver's pay setting. Tips and tolls go to the driver in full.</p></div></div>
        <div class="row" style="margin-bottom:14px"><div class="seg">${[['week', 'This week'], ['last', 'Last week'], ['month', 'This month']].map(([k, l]) => `<button type="button" data-per="${k}" aria-pressed="${payPeriod.kind === k}">${l}</button>`).join('')}</div>
          <input class="input" style="width:auto" type="date" id="pp-from" value="${payPeriod.from}"><span class="small">to</span><input class="input" style="width:auto" type="date" id="pp-to" value="${payPeriod.to}"></div>
        <div class="tablewrap"><table><thead><tr><th>Driver</th><th>Paid by</th><th class="r">Trips</th><th class="r">Hours</th><th class="r">Fares</th><th class="r">Base pay</th><th class="r">Tips</th><th class="r">Tolls back</th><th class="r">Total pay</th><th class="r">Payout</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td class="small">${r.payType === 'percent' ? `${r.payRate}% of fare` : r.payType === 'hourly' ? `${money(r.payRate)}/hr` : `${money(r.payRate)}/trip`}</td>
          <td class="r num">${r.trips}</td><td class="r num">${Number(r.hours || 0).toFixed(1)}</td><td class="r num">${money(r.fares)}</td><td class="r num">${money(r.base)}</td><td class="r num">${money(r.tips)}</td><td class="r num">${money(r.reimbursed)}</td><td class="r num"><b>${money(r.total)}</b></td>
          <td class="r">${r.paidAt ? `<span class="pill paid">Paid ${esc(fmtDate(r.paidAt))}</span> <button class="linkbtn small" type="button" data-unpay="${r.driverId}">Undo</button>` : r.total > 0 ? `<button class="btn sm" type="button" data-pay="${r.driverId}" data-amt="${r.total}">Mark paid</button>` : ''}</td></tr>`).join('')}
        <tr><td><b>Total</b></td><td></td><td class="r num"><b>${tot.trips}</b></td><td class="r num"><b>${tot.hours.toFixed(1)}</b></td><td class="r num"><b>${money(tot.fares)}</b></td><td class="r num"><b>${money(tot.base)}</b></td><td class="r num"><b>${money(tot.tips)}</b></td><td class="r num"><b>${money(tot.reimbursed)}</b></td><td class="r num"><b>${money(tot.total)}</b></td><td></td></tr>
        </tbody></table></div>`;
      $$('[data-per]', host).forEach((b) => { b.onclick = () => { payPeriod = periodFor(b.dataset.per); redraw(); }; });
      const dates = () => { const f = $('#pp-from', host).value, t = $('#pp-to', host).value; if (f && t) { payPeriod = { from: f, to: t, kind: 'custom' }; redraw(); } };
      $('#pp-from', host).onchange = dates; $('#pp-to', host).onchange = dates;
      $$('[data-pay]', host).forEach((b) => { b.onclick = () => busy(b, async () => { try { await api('dispatch.markPayout', { driverId: b.dataset.pay, from: payPeriod.from, to: payPeriod.to, amount: b.dataset.amt }); toast('Marked paid.'); redraw(); } catch (e) { toast(e.message, true); } }); });
      $$('[data-unpay]', host).forEach((b) => { b.onclick = async () => { try { await api('dispatch.markPayout', { driverId: b.dataset.unpay, from: payPeriod.from, to: payPeriod.to, undo: true }); redraw(); } catch (e) { toast(e.message, true); } }; });
    }
    async function autoDispatchView(host, redraw) {
      let r;
      try { r = await api('dispatch.rules'); } catch (e) { return showErr(host, e); }
      const ro = isAdmin ? '' : 'disabled';
      host.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Auto-dispatch</h1><p class="muted">How trips get to drivers. Dispatch can always assign or move a trip by hand.</p></div></div>
        <form id="ad-form" class="stack" style="max-width:640px" novalidate>
          <fieldset class="fs"><legend>Auto-assign</legend>
            <label class="switch"><input type="checkbox" name="autoAssign" ${r.autoAssign ? 'checked' : ''} ${ro}><span>Send new trips to the best driver automatically</span></label>
            <p class="small muted">Picks the closest free driver with a car of the booked type. It skips drivers on time off, off duty, already busy, with expired papers or a car that's in the shop. Drivers working outside their usual shift are used last.</p>
            <label class="field"><span>Start auto-assigning this many hours before pickup</span><input class="input" type="number" name="horizonHours" min="1" max="168" value="${r.horizonHours}" ${ro}></label>
          </fieldset>
          <fieldset class="fs"><legend>Online booking</legend>
            <label class="field"><span>Customers must book at least this many hours before pickup (0 = no limit)</span><input class="input" type="number" name="minNoticeHours" min="0" max="72" value="${r.minNoticeHours}" ${ro}><span class="hint">Applies to the booking page, the customer app and quote requests. Dispatch can still book a sooner pickup.</span></label>
          </fieldset>
          <fieldset class="fs"><legend>Driver must accept</legend>
            <label class="field"><span>Minutes a driver has to accept a trip</span><input class="input" type="number" name="acceptMin" min="2" max="240" value="${r.acceptMin}" ${ro}></label>
            <label class="field"><span>If the driver declines or doesn't answer in time</span><select name="onNoAnswer" ${ro}>
              <option value="next" ${r.onNoAnswer === 'next' ? 'selected' : ''}>Offer it to the next best driver</option>
              <option value="office" ${r.onNoAnswer === 'office' ? 'selected' : ''}>Send it back to dispatch with an alert</option></select></label>
          </fieldset>
          <fieldset class="fs"><legend>Pickup reminders</legend>
            <label class="switch"><input type="checkbox" name="remindEvening" ${r.remindEvening ? 'checked' : ''} ${ro}><span>Text the driver the evening before</span></label>
            <label class="field"><span>Send the evening text from (hour, 24-hour clock)</span><input class="input" type="number" name="eveningHour" min="12" max="23" value="${r.eveningHour}" ${ro}></label>
            <label class="field"><span>Text the driver this many minutes before pickup (0 = off)</span><input class="input" type="number" name="remindBeforeMin" min="0" max="720" value="${r.remindBeforeMin}" ${ro}></label>
            <label class="field"><span>Alert dispatch if the driver hasn't tapped "On the way" this many minutes before pickup (0 = off)</span><input class="input" type="number" name="lateStartMin" min="0" max="240" value="${r.lateStartMin}" ${ro}></label>
          </fieldset>
          <div id="ad-err"></div>
          ${isAdmin ? '<div><button class="btn primary" type="submit">Save</button></div>' : '<p class="small faint">Only a company admin can change these.</p>'}
        </form>`;
      const f = $('#ad-form', host);
      f.onsubmit = async (e) => {
        e.preventDefault();
        const rules = { ...formData(f), autoAssign: f.autoAssign.checked, remindEvening: f.remindEvening.checked };
        await busy($('button[type=submit]', f), async () => {
          try { await api('dispatch.saveRules', { rules }); toast('Auto-dispatch saved.'); redraw(); } catch (err) { showErr($('#ad-err', host), err); }
        });
      };
    }
    // Drivers clock in and out in the driver app; the office checks and fixes it here.
    let hoursRange = null;
    async function hoursView(host, redraw) {
      let r, drivers;
      try { [r, drivers] = await Promise.all([api('dispatch.timeclock', hoursRange || {}), api('dispatch.drivers')]); } catch (e) { return showErr(host, e); }
      hoursRange = { from: r.from, to: r.to };
      host.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Hours</h1><p class="muted">Drivers clock in and out in the driver app. Fix a missed clock-out here.${r.onNow.length ? ` On the clock now: ${esc(r.onNow.join(', '))}.` : ''}</p></div>
          <div class="row">${r.entries.length ? '<button class="btn" type="button" id="hr-csv">Download (CSV)</button>' : ''}<button class="btn primary" type="button" id="hr-add">Add a shift</button></div></div>
        <div class="row" style="margin-bottom:14px"><label class="field inline"><span>From</span><input type="date" id="hr-from" value="${r.from}"></label><label class="field inline"><span>To</span><input type="date" id="hr-to" value="${r.to}"></label></div>
        ${r.totals.length ? `<div class="tiles">${r.totals.map((t) => `<div class="tile"><span class="label">${esc(t.name)}</span><b class="num">${hm(t.minutes)}</b><span class="small faint">${t.shifts} shift${t.shifts === 1 ? '' : 's'}</span></div>`).join('')}</div>` : ''}
        ${r.entries.length ? `<div class="tablewrap" style="margin-top:14px"><table><thead><tr><th>Driver</th><th>Clock in</th><th>Clock out</th><th class="r">Hours</th><th>Note</th></tr></thead><tbody>
          ${r.entries.map((e) => `<tr class="click" data-id="${e.id}"><td>${esc(e.driver)}</td><td class="mono small">${esc(fmtDT(e.in))}</td><td class="mono small">${e.out ? esc(fmtDT(e.out)) : '<span class="pill s-on_board">On the clock</span>'}</td><td class="r num">${hm(e.minutes)}</td><td class="small muted">${esc(e.note || '')}</td></tr>`).join('')}
        </tbody></table></div>` : `<div class="panel empty"><b>No clock-ins between ${esc(fmtDay(r.from))} and ${esc(fmtDay(r.to))}</b><span class="muted small">Drivers clock in from the driver app, or you can add a shift by hand.</span></div>`}`;
      const reload = () => { hoursRange = { from: $('#hr-from', host).value, to: $('#hr-to', host).value }; hoursView(host, redraw); };
      $('#hr-from', host).onchange = reload; $('#hr-to', host).onchange = reload;
      if ($('#hr-csv', host)) $('#hr-csv', host).onclick = async () => { if (await saveFile(`${session.company.slug}-hours-${r.from}-to-${r.to}.csv`, rowsCsv(r.entries.map((e) => ({ Driver: e.driver, Date: e.date, 'Clock in': fmtDT(e.in), 'Clock out': e.out ? fmtDT(e.out) : '', Hours: (e.minutes / 60).toFixed(2), Note: e.note || '' }))), 'text/csv')) toast('Downloaded.'); };
      const edit = (e) => {
        const lv = (iso) => iso ? toLocalInput(new Date(iso)) : '';
        const m = openModal({
          title: e ? `Shift: ${e.driver}` : 'Add a shift',
          body: `<form class="stack" id="hr-f" novalidate>${e ? '' : `<label class="field"><span>Driver</span><select name="driverId"><option value="">Choose…</option>${drivers.filter((d) => d.active).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label>`}
            <div class="grid2"><label class="field"><span>Clock in</span><input type="datetime-local" name="in" value="${lv(e && e.in)}"></label><label class="field"><span>Clock out</span><input type="datetime-local" name="out" value="${lv(e && e.out)}"></label></div>
            <label class="field"><span>Note</span><input name="note" maxlength="200" value="${esc((e && e.note) || '')}" placeholder="Forgot to clock out"></label><div id="hr-err"></div></form>`,
          footer: `${e ? '<button class="btn danger" type="button" id="hr-del">Delete</button>' : ''}<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="hr-save">Save</button>`,
        });
        $('[data-close]', m).onclick = closeModal;
        const del = $('#hr-del', m); if (del) del.onclick = () => busy(del, async () => { try { await api('dispatch.saveTime', { id: e.id, remove: true }); closeModal(); toast('Shift deleted.'); hoursView(host, redraw); } catch (err) { showErr($('#hr-err', m), err); } });
        $('#hr-save', m).onclick = (ev) => busy(ev.currentTarget, async () => {
          const f = formData($('#hr-f', m));
          try { await api('dispatch.saveTime', { id: e ? e.id : undefined, driverId: f.driverId, in: f.in ? new Date(f.in).toISOString() : '', out: f.out ? new Date(f.out).toISOString() : '', note: f.note }); closeModal(); toast('Shift saved.'); hoursView(host, redraw); } catch (err) { showErr($('#hr-err', m), err); }
        });
      };
      $('#hr-add', host).onclick = () => edit(null);
      $$('tr[data-id]', host).forEach((row) => { row.onclick = () => edit(r.entries.find((e) => e.id === row.dataset.id)); });
    }
    async function timeOffView(host, redraw) {
      let list;
      try { list = await api('dispatch.timeOffList'); } catch (e) { return showErr(host, e); }
      host.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Time off</h1><p class="muted">Requests from the driver app, and time off you've added. Approved days show on the board and warn you when assigning.</p></div></div>
        <div class="tablewrap"><table><thead><tr><th>Driver</th><th>Dates</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>
        ${list.map((x) => `<tr><td><b>${esc(x.driverName)}</b></td><td class="small nowrap">${esc(fmtDays(x.from, x.to))}</td><td class="small">${esc(x.reason || '')}</td>
          <td><span class="pill ${x.status === 'approved' ? 's-on_board' : x.status === 'declined' ? 's-cancelled' : 's-assigned'}">${x.status === 'requested' ? 'Waiting' : x.status === 'approved' ? 'Approved' : 'Declined'}</span>${x.decidedBy ? `<span class="small faint"> by ${esc(x.decidedBy)}</span>` : ''}</td>
          <td class="r">${x.status === 'requested' ? `<button class="btn sm" type="button" data-off="approve" data-id="${x.id}">Approve</button> <button class="btn sm" type="button" data-off="decline" data-id="${x.id}">Decline</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="faint">No time off yet.</td></tr>'}
        </tbody></table></div>`;
      $$('[data-off]', host).forEach((b) => { b.onclick = () => busy(b, async () => { try { await api('dispatch.timeOff', { action: b.dataset.off, id: b.dataset.id }); toast(b.dataset.off === 'approve' ? 'Approved.' : 'Declined.'); redraw(); } catch (e) { toast(e.message, true); } }); });
    }

    function personModal({ title, person, method, extra, done, role, collect, setup }) {
      const p = person || {};
      const m = openModal({
        title,
        body: `<form id="pm-form" class="stack" novalidate>
          <div class="grid2"><label class="field"><span>Full name</span><input id="pm-name" name="name" value="${esc(p.name)}"></label>
            <label class="field"><span>Mobile</span><input id="pm-phone" name="phone" type="tel" value="${esc(p.phone)}"></label></div>
          <label class="field"><span>Email (used to sign in)</span><input id="pm-email" name="email" type="email" value="${esc(p.email)}"></label>
          <label class="field"><span>${person ? 'New password' : 'Password'}</span><input id="pm-pass" name="password" type="text" autocomplete="new-password" placeholder="${person ? 'Leave blank to keep the current one' : 'At least 8 characters'}"></label>
          ${extra || ''}
          <label class="switch"><input type="checkbox" id="pm-active" name="active" ${p.active === false ? '' : 'checked'}><span>Login enabled</span></label>
          <div id="pm-err"></div></form>`,
        footer: `<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="pm-save">Save</button>`,
      });
      $('[data-close]', m).onclick = closeModal;
      if (setup) setup(m);
      $('#pm-save', m).onclick = (e) => busy(e.currentTarget, async () => {
        try { await api(method, { ...formData($('#pm-form', m)), id: p.id, role, ...(collect ? collect(m) : {}) }); closeModal(); toast('Saved.'); done(); } catch (err) { showErr($('#pm-err', m), err); }
      });
    }

    // Fleet ------------------------------------------------------------------
    // Incidents --------------------------------------------------------------
    let incFilter = 'open';
    async function drawIncidents(v) {
      current = { poll: false };
      let list, drivers;
      try { [list, drivers] = await Promise.all([api('dispatch.incidents', { status: incFilter }), api('dispatch.drivers')]); } catch (e) { return showErr(v, e); }
      const sev = { low: ['Minor', ''], medium: ['Moderate', 's-assigned'], high: ['Serious', 's-cancelled'] };
      v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Incidents</h1><p class="muted">Accidents, vehicle damage, injuries, complaints and lost items. Drivers report them from the driver app.</p></div><button class="btn primary" type="button" id="inc-new">Log an incident</button></div>
        <div class="seg" role="group" style="margin-bottom:14px">${[['open', 'Open'], ['closed', 'Closed'], ['all', 'All']].map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${incFilter === k}">${l}</button>`).join('')}</div>
        ${list.length ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>What</th><th>Details</th><th>Trip</th><th>Driver and car</th><th>Status</th></tr></thead><tbody>
          ${list.map((x) => `<tr class="click" data-id="${x.id}"><td class="mono small" style="white-space:nowrap">${esc(fmtDT(x.happenedAt))}</td><td><b>${esc(x.kindLabel)}</b><br><span class="pill ${sev[x.severity][1]}">${sev[x.severity][0]}</span></td>
            <td class="small" style="min-width:240px">${esc(x.description.length > 140 ? x.description.slice(0, 140) + '…' : x.description)}${x.resolution ? `<br><span class="faint">Done: ${esc(x.resolution)}</span>` : ''}</td>
            <td class="mono small">${x.trip ? esc(x.trip.ref) : '—'}</td><td class="small">${x.driver ? esc(x.driver.name) : '—'}${x.vehicle ? `<br><span class="faint">${esc(x.vehicle.name)} · ${esc(x.vehicle.plate || '')}</span>` : ''}</td>
            <td>${x.status === 'closed' ? '<span class="pill off">Closed</span>' : '<span class="pill s-assigned">Open</span>'}</td></tr>`).join('')}
        </tbody></table></div>` : `<div class="panel muted">${incFilter === 'open' ? 'No open incidents.' : 'No incidents yet.'}</div>`}`;
      $$('[data-f]', v).forEach((b) => { b.onclick = () => { incFilter = b.dataset.f; drawIncidents(v); }; });
      const done = () => drawIncidents(v);
      $('#inc-new', v).onclick = () => incidentModal({}, { office: true, drivers, done });
      $$('tr[data-id]', v).forEach((r) => { r.onclick = () => incidentModal(list.find((x) => x.id === r.dataset.id), { office: true, drivers, done }); });
    }

    async function drawFleet(v) {
      current = { poll: false };
      let vehicles, alerts;
      try { [vehicles, alerts] = await Promise.all([api('dispatch.vehicles'), api('dispatch.alerts')]); } catch (e) { return showErr(v, e); }
      const fleetAlerts = alerts.filter((a) => a.area === 'fleet' && a.level !== 'info');
      const worstDoc = (x) => { const s = [x.registrationExp, x.insuranceExp, x.inspectionExp].map(docState); return s.find((d) => d.cls === 's-cancelled') ? 's-cancelled' : s.find((d) => d.cls === 's-assigned') ? 's-assigned' : s.find((d) => d.cls === 'off') ? 'off' : 's-on_board'; };
      v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Fleet</h1><p class="muted">Vehicles and their documents. Cars in the shop can't be booked or assigned.</p></div><button class="btn primary" type="button" id="vh-add">Add vehicle</button></div>
        <div class="tiles" style="margin-bottom:16px">
          <div class="tile"><span class="label">In service</span><b>${vehicles.filter((x) => x.status === 'active').length}</b></div>
          <div class="tile"><span class="label">In the shop</span><b>${vehicles.filter((x) => x.status === 'maintenance').length}</b></div>
          <div class="tile"><span class="label">Need attention</span><b>${fleetAlerts.length}</b></div>
          <div class="tile"><span class="label">Billed this month</span><b>${money0(vehicles.reduce((s, x) => s + x.revenueMonth, 0))}</b></div>
        </div>
        ${fleetAlerts.length ? `<div class="warnbox" style="margin-bottom:16px"><ul>${fleetAlerts.map((a) => `<li>${esc(a.text)}</li>`).join('')}</ul></div>` : ''}
        <div class="tablewrap"><table><thead><tr><th>Vehicle</th><th>Type</th><th>Status</th><th>Documents</th><th class="r">Trips this month</th><th class="r">Billed this month</th></tr></thead><tbody>
        ${vehicles.map((x) => `<tr class="click" data-id="${x.id}"><td><b>${esc(x.name)}</b><br><span class="mono small faint">${esc(x.plate)}${x.year ? ' · ' + x.year : ''}</span></td>
          <td class="small">${esc(x.type)} · ${x.capacity} seats</td>
          <td><span class="pill ${x.status === 'active' ? 's-on_board' : x.status === 'maintenance' ? 's-assigned' : 'off'}">${esc(C.VEHICLE_STATUS[x.status])}</span></td>
          <td><span class="pill ${worstDoc(x)}">${worstDoc(x) === 's-cancelled' ? 'Expired' : worstDoc(x) === 's-assigned' ? 'Expiring' : worstDoc(x) === 'off' ? 'Missing dates' : 'Up to date'}</span></td>
          <td class="r num">${x.tripsMonth}</td><td class="r num">${money0(x.revenueMonth)}</td></tr>`).join('') || '<tr><td colspan="6" class="faint">No vehicles yet.</td></tr>'}
        </tbody></table></div>`;
      $('#vh-add', v).onclick = () => vehicleModal(null, () => drawFleet(v));
      $$('tr[data-id]', v).forEach((r) => { r.onclick = () => vehicleModal(r.dataset.id, () => drawFleet(v)); });
    }
    async function vehicleModal(id, done) {
      let data = { vehicle: { type: 'Sedan', capacity: 3, status: 'active' }, log: [], upcoming: [] };
      if (id) { try { data = await api('dispatch.vehicle', { id }); } catch (e) { return toast(e.message, true); } }
      const p = data.vehicle;
      const m = openModal({
        title: id ? p.name : 'Add vehicle', wide: true, onClose: done,
        body: `${id ? `<div class="tiles">
            <div class="tile"><span class="label">This month</span><b>${p.tripsMonth} trips</b><span class="small faint">${money0(p.revenueMonth)} billed</span></div></div>` : ''}
          <form id="vf" class="stack" novalidate>
            <div class="grid3"><label class="field" style="grid-column:span 2"><span>Name</span><input id="vf-name" name="name" placeholder="Lincoln Navigator" value="${esc(p.name)}"></label>
              <label class="field"><span>Status</span><select id="vf-status" name="status">${Object.entries(C.VEHICLE_STATUS).map(([k, l]) => `<option value="${k}" ${p.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
            <div class="grid3"><label class="field"><span>Type</span><select id="vf-type" name="type">${C.VEHICLE_TYPES.map((t) => `<option ${p.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
              <label class="field"><span>Seats</span><input id="vf-cap" name="capacity" type="number" min="1" max="60" value="${p.capacity}"></label>
              <label class="field"><span>Plate</span><input id="vf-plate" name="plate" class="mono" value="${esc(p.plate)}"></label></div>
            <div class="grid3"><label class="field"><span>Year</span><input id="vf-year" name="year" type="number" min="1980" max="2100" value="${p.year || ''}"></label>
              <label class="field"><span>Color</span><input id="vf-color" name="color" value="${esc(p.color)}"></label>
              <label class="field"><span>VIN</span><input id="vf-vin" name="vin" class="mono" value="${esc(p.vin || '')}"></label></div>
            <div class="grid3"><label class="field"><span>Registration expires</span><input id="vf-reg" name="registrationExp" type="date" value="${esc(p.registrationExp || '')}"></label>
              <label class="field"><span>Insurance expires</span><input id="vf-ins" name="insuranceExp" type="date" value="${esc(p.insuranceExp || '')}"></label>
              <label class="field"><span>Inspection due</span><input id="vf-insp" name="inspectionExp" type="date" value="${esc(p.inspectionExp || '')}"></label></div>
            <div id="vf-err"></div>
            <div><button class="btn primary" type="submit">${id ? 'Save vehicle' : 'Add vehicle'}</button></div>
          </form>
            ${id && data.upcoming.length ? `<div class="stack"><h3>Booked trips</h3><div class="tablewrap"><table><tbody>${data.upcoming.map((t) => `<tr><td class="mono small">${esc(fmtDT(t.pickupAt))}</td><td class="mono small">${esc(t.ref)}</td><td class="small">${esc(t.passengerName)}</td><td class="small">${t.driver ? esc(t.driver.name) : ''}</td><td>${pill(t)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`,
      });
      const reopen = () => { m._onClose = null; closeModal(); vehicleModal(id, done); };
      $('#vf', m).onsubmit = async (e) => {
        e.preventDefault();
        await busy($('button[type=submit]', e.target), async () => {
          try { await api('dispatch.saveVehicle', { ...formData(e.target), id }); toast('Vehicle saved.'); if (id) reopen(); else closeModal(); } catch (err) { showErr($('#vf-err', m), err); }
        });
      };
    }

    // Quotes -----------------------------------------------------------------
    let quoteFilter = 'open';
    async function drawQuotes(v) {
      current = { poll: false };
      v.innerHTML = '<p class="faint">Loading…</p>';
      let list;
      try { list = await api('dispatch.quotes'); } catch (e) { return showErr(v, e); }
      const groups = { open: (q) => ['new', 'sent'].includes(q.status), booked: (q) => q.status === 'accepted', closed: (q) => ['declined', 'expired', 'cancelled'].includes(q.status), all: () => true };
      const shown = list.filter(groups[quoteFilter]);
      const sum = (arr) => arr.reduce((s, q) => s + q.total, 0);
      const vehicles = (q) => q.lines.reduce((s, l) => s + l.count, 0);
      v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Quotes</h1><p class="muted">Event and group requests. Price each ride, send the quote, and the customer books it by saving a card. No deposit: each ride is charged before its pickup.</p></div>
          <div class="row"><button class="btn" type="button" id="qt-link">Copy request link</button><button class="btn primary" type="button" id="qt-new">New quote</button></div></div>
        <div class="tiles" style="margin-bottom:14px">
          <div class="tile"><span class="label">Need a price</span><b class="num ${list.some((q) => q.status === 'new') ? 'bad' : ''}">${list.filter((q) => q.status === 'new').length}</b><span class="small faint">New requests</span></div>
          <div class="tile"><span class="label">Awaiting reply</span><b class="num">${money0(sum(list.filter((q) => q.status === 'sent')))}</b><span class="small faint">${list.filter((q) => q.status === 'sent').length} sent</span></div>
          <div class="tile"><span class="label">Booked</span><b class="num">${money0(sum(list.filter((q) => q.status === 'accepted')))}</b><span class="small faint">${((n) => `${n} event${n === 1 ? '' : 's'}`)(list.filter((q) => q.status === 'accepted').length)}</span></div>
        </div>
        <div class="row" style="margin-bottom:12px"><div class="seg" role="group" aria-label="Show">${[['open', 'Open'], ['booked', 'Booked'], ['closed', 'Declined or expired'], ['all', 'All']].map(([k, l]) => `<button type="button" data-qf="${k}" aria-pressed="${quoteFilter === k}">${l}</button>`).join('')}</div></div>
        <div class="tablewrap"><table><thead><tr><th>Quote</th><th>Event</th><th>Contact</th><th>First pickup</th><th class="r">Vehicles</th><th class="r">Total</th><th>Status</th></tr></thead><tbody>
          ${shown.map((q) => `<tr class="click" data-q="${q.id}"><td class="mono small">${esc(q.number)}${q.source === 'online' ? '' : '<br><span class="faint">by phone</span>'}</td><td><b>${esc(q.eventName || q.eventType)}</b>${q.eventName ? `<br><span class="small muted">${esc(q.eventType)}</span>` : ''}</td><td class="small">${esc(q.contact.name)}${q.contact.org ? `<br><span class="muted">${esc(q.contact.org)}</span>` : ''}</td><td class="small">${q.eventDate ? esc(fmtDT(q.eventDate)) : '—'}</td><td class="r num">${vehicles(q)}</td><td class="r num">${q.total ? money(q.total) : '—'}</td><td>${qPill(q)}</td></tr>`).join('') || `<tr><td colspan="7" class="faint">No quotes here. Share your request link so customers can ask for one.</td></tr>`}
        </tbody></table></div>`;
      $$('[data-qf]', v).forEach((b) => { b.onclick = () => { quoteFilter = b.dataset.qf; drawQuotes(v); }; });
      $$('tr[data-q]', v).forEach((r) => { r.onclick = () => quoteModal(r.dataset.q, () => drawQuotes(v)); });
      $('#qt-new', v).onclick = () => quoteModal(null, () => drawQuotes(v));
      $('#qt-link', v).onclick = async () => {
        const url = DEMO ? `#request.${session.company.slug}` : `${location.origin}${location.pathname}#request.${session.company.slug}`;
        try { await navigator.clipboard.writeText(url); toast('Request link copied. Put it on your website.'); } catch (e) { toast(`Your request link: ${url}`, false, 8000); }
      };
    }
    async function quoteModal(id, done) {
      let q, info;
      try { [q, info] = await Promise.all([id ? api('dispatch.getQuote', { id }) : null, bookingInfo()]); } catch (e) { return toast(e.message, true); }
      const editable = !q || !['accepted', 'cancelled'].includes(q.status);
      const c = q ? q.contact : { name: '', phone: '', email: '', org: '' };
      const m = openModal({
        title: q ? `Quote ${q.number}` : 'New quote',
        wide: true,
        body: `<form id="qm" class="stack" novalidate>
          ${q ? `<div class="spread"><div class="row">${qPill(q)}<span class="small muted">${q.source === 'online' ? 'Requested online' : 'Taken by phone'} ${esc(fmtDT(q.createdAt))}${q.customer ? ' · customer account ' + esc(q.customer.name) : ''}</span></div>
            ${['sent', 'expired', 'accepted', 'declined'].includes(q.status) ? `<a class="btn sm" href="#quote.${esc(q.token)}" target="_blank" rel="noopener">Customer's page</a>` : ''}</div>` : ''}
          ${q && q.status === 'declined' && q.declineReason ? `<div class="note">Declined: “${esc(q.declineReason)}”</div>` : ''}
          ${q && q.status === 'accepted' ? `<div class="note">Booked ${esc(fmtDT(q.decidedAt))}${q.depositPaid ? `, deposit ${money(q.depositPaid.amount)} paid by ${esc(q.depositPaid.method)}` : q.card ? `, ${esc(cardName(q.card))} on file` : q.needsCard ? ', waiting for the customer to add a card' : ''}. Trips: ${q.trips.map((t) => `<button type="button" class="linkbtn mono" data-trip="${t.id}">${esc(t.ref)}</button>`).join(' ')}</div>` : ''}
          <div class="grid3"><label class="field"><span>Contact name</span><input name="name" value="${esc(c.name)}" ${editable ? '' : 'disabled'}></label>
            <label class="field"><span>Mobile</span><input name="phone" type="tel" value="${esc(c.phone)}" ${editable ? '' : 'disabled'}></label>
            <label class="field"><span>Email</span><input name="email" type="email" value="${esc(c.email)}" ${editable ? '' : 'disabled'}></label></div>
          <div class="grid3"><label class="field"><span>Company or school</span><input name="org" value="${esc(c.org || '')}" ${editable ? '' : 'disabled'}></label>
            <label class="field"><span>Type of event</span><select name="eventType" ${editable ? '' : 'disabled'}>${C.EVENT_TYPES.map((x) => `<option ${q && q.eventType === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
            <label class="field"><span>Event name</span><input name="eventName" value="${esc(q ? q.eventName : '')}" ${editable ? '' : 'disabled'}></label></div>
          ${q && q.notes ? `<div class="note"><b>From the customer:</b> ${esc(q.notes)}</div>` : !q ? `<label class="field"><span>Customer's notes</span><textarea name="notes" maxlength="800"></textarea></label>` : ''}
          <div id="qm-rides" class="stack"></div>
          <div class="grid3">
            <label class="field"><span>Price held until</span><input name="validUntil" type="date" value="${esc(q ? q.validUntil : '')}" ${editable ? '' : 'disabled'}><span class="hint">Blank: one week from sending.</span></label>
            <div class="qtotal"><span class="label">Quote total</span><b class="num" id="qm-total"></b><span class="small muted" id="qm-dep"></span></div>
          </div>
          <label class="field"><span>Message to the customer (shows on the quote)</span><textarea name="message" maxlength="800" placeholder="What's included, cancellation terms" ${editable ? '' : 'disabled'}>${esc(q ? q.message : '')}</textarea></label>
          ${q && q.history && q.history.length ? `<details class="small"><summary>History</summary><ul class="steps-list">${q.history.map((h) => `<li><span class="mono faint">${esc(fmtDT(h.at))}</span> ${esc(h.what)}${h.by ? ` · ${esc(h.by)}` : ''}</li>`).join('')}</ul></details>` : ''}
          <div id="qm-err"></div></form>`,
        footer: !editable ? `${q.status === 'cancelled' ? '<button class="btn" type="button" id="qm-reopen">Reopen</button>' : ''}<button class="btn" type="button" data-close>Close</button>`
          : `${q ? '<button class="btn danger" type="button" id="qm-cancel">Cancel quote</button>' : ''}${q && ['declined', 'expired'].includes(q.status) ? '<button class="btn" type="button" id="qm-reopen">Reopen</button>' : ''}<span class="grow"></span>
            ${q ? '<button class="btn" type="button" id="qm-book">Book it now</button>' : ''}<button class="btn" type="button" id="qm-save">Save</button><button class="btn primary" type="button" id="qm-send">${q && q.sentAt ? 'Save and send again' : 'Save and send quote'}</button>`,
      });
      const form = $('#qm', m), err = $('#qm-err', m);
      const paint = () => { const t = rides.total(); $('#qm-total', m).textContent = money(t); $('#qm-dep', m).textContent = 'No deposit · card on file'; };
      const rides = rideEditor($('#qm-rides', m), { vehicleTypes: info.vehicleTypes, slug: session.company.slug, staff: true, locked: !editable, lines: q ? q.lines : [{ ...blankRide(), vehicleType: 'SUV' }], onChange: paint });
      paint();
      $$('[data-close]', m).forEach((b) => { b.onclick = closeModal; });
      $$('[data-trip]', m).forEach((b) => { b.onclick = () => tripModal(b.dataset.trip, done); });
      const reopen = (nq) => { if (done) done(); quoteModal(nq.id, done); };
      const save = async () => {
        const f = formData(form);
        const payload = { contact: { name: f.name, phone: f.phone, email: f.email, org: f.org }, eventType: f.eventType, eventName: f.eventName, lines: rides.get(), validUntil: f.validUntil, message: f.message };
        if (!q) payload.notes = f.notes; else payload.id = q.id;
        return api('dispatch.saveQuote', payload);
      };
      const btn = (sel, fn) => { const b = $(sel, m); if (b) b.onclick = () => busy(b, async () => { try { await fn(); } catch (e) { showErr(err, e); } }); };
      btn('#qm-save', async () => { const nq = await save(); toast(`Quote ${nq.number} saved.`); reopen(nq); });
      btn('#qm-send', async () => { const nq = await save(); q = nq; const s = await api('dispatch.sendQuote', { id: nq.id }); toast(`Quote ${s.number} sent to ${[s.contact.phone, s.contact.email].filter(Boolean).join(' and ')}.`); reopen(s); });
      btn('#qm-cancel', async () => { const b = $('#qm-cancel', m); if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Tap again to cancel'; return; } const nq = await api('dispatch.quoteAction', { id: q.id, action: 'cancel' }); toast(`Quote ${nq.number} cancelled.`); reopen(nq); });
      btn('#qm-reopen', async () => { const nq = await api('dispatch.quoteAction', { id: q.id, action: 'reopen' }); toast(`Quote ${nq.number} reopened.`); reopen(nq); });
      btn('#qm-book', async () => {
        const nq = await save();
        const m2 = openModal({ title: `Book quote ${nq.number}`, body: `<div class="stack"><p>This books ${((n) => `${n} vehicle${n === 1 ? '' : 's'}`)(nq.lines.reduce((s, l) => s + l.count, 0))} at ${money(nq.total)} and sends the customer one confirmation.</p>
            ${nq.cards !== false ? '<p class="small muted">The confirmation includes a link for the customer to add a card. Each ride is then charged before its pickup.</p>' : ''}<div id="qb-err"></div></div>`,
          footer: '<button class="btn" type="button" data-close>Back</button><button class="btn primary" type="button" id="qb-go">Book it</button>' });
        $('[data-close]', m2).onclick = () => reopen(nq);
        $('#qb-go', m2).onclick = () => busy($('#qb-go', m2), async () => {
          try { const r = await api('dispatch.quoteAction', { id: nq.id, action: 'accept' }); toast(`Booked ${r.trips.length} trip${r.trips.length === 1 ? '' : 's'}: ${r.trips.map((t) => t.ref).join(', ')}.`); reopen(r); } catch (e) { showErr($('#qb-err', m2), e); }
        });
      });
    }

    // Reports ----------------------------------------------------------------
    const rep = { preset: 'month', from: '', to: '', group: '', metric: 'revenue' };
    const dayIn = (tz, shift = 0) => { const d = new Date(Date.now() + shift * 864e5); return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); };
    const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    function repRange(tz) {
      const today = dayIn(tz), y = today.slice(0, 4), m = today.slice(0, 7);
      if (rep.preset === 'custom' && rep.from && rep.to) return [rep.from, rep.to];
      if (rep.preset === 'last') { const first = m + '-01', end = addDays(first, -1); return [end.slice(0, 7) + '-01', end]; }
      if (rep.preset === '30') return [addDays(today, -29), today];
      if (rep.preset === '90') return [addDays(today, -89), today];
      if (rep.preset === 'year') { const start = y + '-01-01'; return [Date.parse(today) - Date.parse(start) > 395 * 864e5 ? addDays(today, -395) : start, today]; }
      return [m + '-01', today];
    }
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const ymdLabel = (k, group, long) => {
      const [y, mo, d] = k.split('-').map(Number);
      if (group === 'month') return long ? `${MON[mo - 1]} ${y}` : MON[mo - 1];
      return (group === 'week' && long ? 'Week of ' : '') + `${MON[mo - 1]} ${d}`;
    };
    const niceStep = (max, n) => { const raw = max / n, p = Math.pow(10, Math.floor(Math.log10(raw || 1))); return [1, 2, 2.5, 5, 10].map((x) => x * p).find((x) => x >= raw) || p * 10; };
    function drawChart(host, r) {
      const vals = r.series.map((b) => rep.metric === 'trips' ? b.trips : b.revenue);
      const W = Math.max(280, host.clientWidth), H = 240, L = rep.metric === 'trips' ? 34 : 58, R = 8, T = 12, B = 28;
      const step = niceStep(Math.max(...vals, 1), 4), top = Math.max(step, Math.ceil(Math.max(...vals, 1) / step) * step);
      const iw = W - L - R, ih = H - T - B, n = vals.length, slot = iw / n, bw = Math.max(2, Math.min(44, slot * 0.72));
      const y = (v) => T + ih - v / top * ih;
      const fmt = (v) => rep.metric === 'trips' ? String(v) : v >= 1000 ? '$' + (v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'k' : '$' + v;
      const every = Math.max(1, Math.ceil(n / Math.floor(iw / 64)));
      let g = '';
      for (let v = 0; v <= top + 1e-9; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid${v === 0 ? ' base' : ''}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="ax">${fmt(v)}</text>`;
      r.series.forEach((b, i) => {
        const v = vals[i], x = L + i * slot + (slot - bw) / 2, h = Math.max(v ? 2 : 0, ih - (y(v) - T));
        g += `<rect x="${x}" y="${T + ih - h}" width="${bw}" height="${h}" rx="${Math.min(3, bw / 4)}" class="bar" data-i="${i}"/>`;
        g += `<rect x="${L + i * slot}" y="${T}" width="${slot}" height="${ih}" class="hit" data-i="${i}"><title>${esc(ymdLabel(b.key, r.group, true))}: ${money(b.revenue)}, ${b.trips} trip${b.trips === 1 ? '' : 's'}</title></rect>`;
        if (i % every === 0) g += `<text x="${L + i * slot + slot / 2}" y="${H - 8}" text-anchor="middle" class="ax">${esc(ymdLabel(b.key, r.group))}</text>`;
      });
      host.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="${rep.metric === 'trips' ? 'Completed trips' : 'Revenue'} by ${r.group}">${g}</svg><div class="charttip" hidden></div>`;
      const tip = $('.charttip', host), svg = $('svg', host);
      $$('.hit', host).forEach((h) => {
        h.onmouseenter = () => {
          const i = +h.dataset.i, b = r.series[i];
          $$('.bar', svg).forEach((x) => x.classList.toggle('on', x.dataset.i === h.dataset.i));
          tip.innerHTML = `<b>${esc(ymdLabel(b.key, r.group, true))}</b><span>${money(b.revenue)}</span><span>${b.trips} trip${b.trips === 1 ? '' : 's'}</span>`;
          tip.hidden = false;
          const cx = L + i * slot + slot / 2, tw = tip.offsetWidth;
          tip.style.left = Math.min(W - tw, Math.max(0, cx - tw / 2)) + 'px';
          tip.style.top = Math.max(0, y(vals[i]) - tip.offsetHeight - 8) + 'px';
        };
      });
      svg.onmouseleave = () => { tip.hidden = true; $$('.bar', svg).forEach((x) => x.classList.remove('on')); };
    }
    const shareList = (rows, total) => rows.length ? `<div class="shares">${rows.map((x) => { const p = total ? Math.round(x.revenue / total * 100) : 0; return `<div class="share"><div class="spread"><span>${esc(x.label)}</span><span class="num">${money0(x.revenue)} <span class="faint">· ${x.trips} trip${x.trips === 1 ? '' : 's'}</span></span></div><div class="track" title="${p}% of revenue"><i style="width:${Math.max(p, x.revenue ? 1 : 0)}%"></i></div></div>`; }).join('')}</div>` : '<p class="faint">No completed trips in this range.</p>';
    // Any list of flat objects as CSV, columns in the order of the first row.
    function rowsCsv(rows) {
      const cols = Object.keys(rows[0] || {});
      const q = (v) => { const s2 = v == null ? '' : String(v); return /[",\n]/.test(s2) ? '"' + s2.replace(/"/g, '""') + '"' : s2; };
      return [cols.map(q).join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\r\n');
    }
    function csvOf(rows) {
      const cols = [['date', 'Date'], ['time', 'Time'], ['ref', 'Trip'], ['status', 'Status'], ['service', 'Service'], ['passenger', 'Passenger'], ['account', 'Company account'], ['po', 'PO number'], ['costCenter', 'Cost center'], ['pickup', 'Pickup'], ['dropoff', 'Drop-off'], ['vehicleType', 'Vehicle type'], ['vehicle', 'Vehicle'], ['driver', 'Driver'], ['source', 'Booked through'], ['partner', 'Sent to partner'], ['fare', 'Fare'], ['gratuity', 'Gratuity'], ['tolls', 'Tolls'], ['total', 'Total'], ['payment', 'Payment'], ['rating', 'Rating']];
      const q = (v) => { const s2 = v == null ? '' : String(v); return /[",\n]/.test(s2) ? '"' + s2.replace(/"/g, '""') + '"' : s2; };
      return [cols.map((c) => c[1]).join(','), ...rows.map((row) => cols.map((c) => q(row[c[0]])).join(','))].join('\r\n');
    }
    async function saveFile(name, text, type) {
      // Inside the hosted demo the page can't download directly; ask the viewer through the host.
      const dl = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
      if (dl) {
        try { await dl.save({ filename: name, data: text }); return true; } catch (e) { if (e && e.code === 'declined') return false; }
      }
      const url = URL.createObjectURL(new Blob([text], { type }));
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return true;
    }
    async function drawReports(v) {
      current = { poll: false };
      const tz = session.company.timezone;
      const [from, to] = repRange(tz);
      v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Reports</h1><p class="muted">Money and trips by pickup date. Totals count completed trips; cancellations are counted separately.</p></div>
          <div class="row"><button class="btn" type="button" id="rp-csv" disabled>Download trips (CSV)</button>${isAdmin ? '<button class="btn" type="button" id="rp-qb">QuickBooks export</button>' : ''}<button class="btn" type="button" id="rp-print">Print</button></div></div>
        <div class="row repbar">
          <div class="seg" role="group" aria-label="Date range">${[['month', 'This month'], ['last', 'Last month'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['year', 'This year'], ['custom', 'Custom']].map(([k, l]) => `<button type="button" data-pre="${k}" aria-pressed="${rep.preset === k}">${l}</button>`).join('')}</div>
          <div class="row" id="rp-custom" ${rep.preset === 'custom' ? '' : 'hidden'}><label class="field inline"><span>From</span><input type="date" id="rp-from" value="${from}"></label><label class="field inline"><span>To</span><input type="date" id="rp-to" value="${to}"></label><button class="btn" type="button" id="rp-go">Show</button></div>
          <label class="field inline"><span>Group by</span><select id="rp-group"><option value="">Automatic</option>${['day', 'week', 'month'].map((g) => `<option value="${g}" ${rep.group === g ? 'selected' : ''}>${g[0].toUpperCase() + g.slice(1)}</option>`).join('')}</select></label>
        </div>
        <div id="rp-body"><p class="faint">Loading report…</p></div>`;
      $$('[data-pre]', v).forEach((b) => { b.onclick = () => { rep.preset = b.dataset.pre; if (rep.preset === 'custom') { rep.from = from; rep.to = to; } drawReports(v); }; });
      $('#rp-go', v).onclick = () => { rep.from = $('#rp-from', v).value; rep.to = $('#rp-to', v).value; drawReports(v); };
      $('#rp-group', v).onchange = (e) => { rep.group = e.target.value; drawReports(v); };
      $('#rp-print', v).onclick = () => window.print();
      const body = $('#rp-body', v);
      let r;
      try { r = await api('dispatch.reports', { from, to, group: rep.group || undefined }); } catch (e) { return showErr(body, e); }
      const T = r.totals;
      const csv = $('#rp-csv', v); csv.disabled = !r.rows.length;
      csv.onclick = async () => { if (await saveFile(`${session.company.slug}-trips-${r.from}-to-${r.to}.csv`, csvOf(r.rows), 'text/csv')) toast(`Downloaded ${r.rows.length} trips.`); };
      const qb = $('#rp-qb', v);
      if (qb) qb.onclick = () => busy(qb, async () => {
        try {
          const x = await api('dispatch.accountingExport', { from: r.from, to: r.to });
          if (!x.invoices.length && !x.receipts.length) return toast('Nothing paid or invoiced in these dates.');
          if (x.invoices.length) await saveFile(`${session.company.slug}-quickbooks-invoices-${r.from}-to-${r.to}.csv`, rowsCsv(x.invoices), 'text/csv');
          if (x.receipts.length) await saveFile(`${session.company.slug}-quickbooks-sales-receipts-${r.from}-to-${r.to}.csv`, rowsCsv(x.receipts), 'text/csv');
          toast(`QuickBooks files ready: ${x.invoices.length} invoice lines, ${x.receipts.length} sales receipts. Import them in QuickBooks under Settings, Import data.`, false, 8000);
        } catch (err) { toast(err.message, true); }
      });
      const rangeText = r.from === r.to ? ymdLabel(r.from, 'day', true) : `${ymdLabel(r.from, 'day')}, ${r.from.slice(0, 4)} to ${ymdLabel(r.to, 'day')}, ${r.to.slice(0, 4)}`;
      body.innerHTML = `<p class="small muted printonly">${esc(session.company.name)} · ${esc(rangeText)}</p>
        <div class="tiles">
          <div class="tile"><span class="label">Revenue</span><b class="num">${money0(T.revenue)}</b><span class="small faint">${money0(T.fares)} fares, ${money0(T.gratuity)} gratuity</span></div>
          <div class="tile"><span class="label">Completed trips</span><b class="num">${T.trips}</b><span class="small faint">Plus ${T.upcoming} upcoming</span></div>
          <div class="tile"><span class="label">Average trip</span><b class="num">${money(T.avgTrip)}</b></div>
          <div class="tile"><span class="label">Cancelled</span><b class="num">${T.cancelled}</b><span class="small faint">${T.cancelRate}% of bookings</span></div>
          ${T.farmedOut ? `<div class="tile"><span class="label">Kept after partners</span><b class="num">${money0(T.kept)}</b><span class="small faint">${T.farmedOut} trip${T.farmedOut === 1 ? '' : 's'} sent to partners</span></div>` : ''}
        </div>
        <section class="panel repchart">
          <div class="spread"><h2>${rep.metric === 'trips' ? 'Completed trips' : 'Revenue'} by ${r.group}</h2>
            <div class="seg" role="group" aria-label="Show"><button type="button" data-met="revenue" aria-pressed="${rep.metric === 'revenue'}">Revenue</button><button type="button" data-met="trips" aria-pressed="${rep.metric === 'trips'}">Trips</button></div></div>
          <p class="small faint">${esc(rangeText)} · ${esc((r.timezone || '').replace(/_/g, ' '))} time</p>
          <div class="chart" id="rp-chart"></div>
        </section>
        <div class="repgrid">
          <section class="panel"><h2>Payments</h2>${shareList(r.byPayment, T.revenue)}</section>
          <section class="panel"><h2>Where bookings came from</h2>${shareList(r.bySource, T.revenue)}</section>
          <section class="panel"><h2>By service</h2>${shareList(r.byService, T.revenue)}</section>
          <section class="panel"><h2>By vehicle type</h2>${shareList(r.byVehicleType, T.revenue)}</section>
        </div>
        <h2 class="rephead">Drivers</h2>
        <div class="tablewrap"><table><thead><tr><th>Driver</th><th class="r">Trips</th><th class="r">Revenue</th><th class="r">Hours</th><th class="r">Driver pay</th><th class="r">Tips</th><th class="r">Rating</th><th class="r">On time</th></tr></thead><tbody>
          ${r.drivers.map((d) => `<tr><td><b>${esc(d.name)}</b></td><td class="r num">${d.trips}</td><td class="r num">${money(d.revenue)}</td><td class="r num">${d.hours}</td><td class="r num">${money(d.pay)}</td><td class="r num">${money(d.tips)}</td><td class="r num">${d.rating == null ? '—' : d.rating.toFixed(1) + ' ★'}</td><td class="r num ${d.onTime != null && d.onTime < 85 ? 'bad' : ''}">${pct(d.onTime)}</td></tr>`).join('') || '<tr><td colspan="8" class="faint">No drivers yet.</td></tr>'}
        </tbody></table></div>
        <h2 class="rephead">Vehicles</h2>
        <div class="tablewrap"><table><thead><tr><th>Vehicle</th><th>Type</th><th class="r">Trips</th><th class="r">Revenue</th><th class="r">Hours on trips</th><th class="r">Busy</th></tr></thead><tbody>
          ${r.vehicles.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td class="small">${esc(x.type)}</td><td class="r num">${x.trips}</td><td class="r num">${money(x.revenue)}</td><td class="r num">${x.hours}</td><td class="r num" title="Share of a 12-hour day spent on trips">${x.use}%</td></tr>`).join('')}
        </tbody></table></div>
        <h2 class="rephead">Top customers</h2>
        <div class="tablewrap"><table><thead><tr><th>Customer</th><th class="r">Trips</th><th class="r">Revenue</th><th class="r">Share</th></tr></thead><tbody>
          ${r.customers.map((x) => `<tr><td>${esc(x.label)}</td><td class="r num">${x.trips}</td><td class="r num">${money(x.revenue)}</td><td class="r num">${T.revenue ? Math.round(x.revenue / T.revenue * 100) : 0}%</td></tr>`).join('') || '<tr><td colspan="4" class="faint">No completed trips in this range.</td></tr>'}
        </tbody></table></div>
        <h2 class="rephead">Every trip in this range <span class="faint small">(${r.rows.length})</span></h2>
        <div class="tablewrap"><table><thead><tr><th>Date</th><th>Trip</th><th>Passenger</th><th>Driver</th><th>Status</th><th>Payment</th><th class="r">Total</th></tr></thead><tbody id="rp-rows"></tbody></table></div>
        <div id="rp-more"></div>`;
      const rows = r.rows.slice().reverse();
      let shown = 25;
      const drawRows = () => {
        $('#rp-rows', body).innerHTML = rows.slice(0, shown).map((x) => `<tr><td class="small">${esc(ymdLabel(x.date, 'day'))} ${esc(x.time)}</td><td class="mono small">${esc(x.ref)}</td><td>${esc(x.account ? `${x.passenger} (${x.account})` : x.passenger)}</td><td class="small">${esc(x.driver || x.partner || '—')}</td><td class="small">${esc(x.status)}</td><td class="small">${esc(x.status === 'Cancelled' ? '—' : x.payment)}</td><td class="r num">${x.status === 'Cancelled' ? '—' : money(x.total)}</td></tr>`).join('') || '<tr><td colspan="7" class="faint">No trips in this range.</td></tr>';
        $('#rp-more', body).innerHTML = rows.length > shown ? `<button class="btn" type="button" style="margin-top:10px">Show all ${rows.length} trips</button>` : '';
        const more = $('#rp-more button', body); if (more) more.onclick = () => { shown = rows.length; drawRows(); };
      };
      drawRows();
      const chart = $('#rp-chart', body);
      drawChart(chart, r);
      $$('[data-met]', body).forEach((b) => { b.onclick = () => { rep.metric = b.dataset.met; $$('[data-met]', body).forEach((x) => x.setAttribute('aria-pressed', x === b)); $('.repchart h2', body).textContent = `${rep.metric === 'trips' ? 'Completed trips' : 'Revenue'} by ${r.group}`; drawChart(chart, r); }; });
      let rt; const onResize = () => { if (!document.body.contains(chart)) return window.removeEventListener('resize', onResize); clearTimeout(rt); rt = setTimeout(() => drawChart(chart, r), 120); };
      window.addEventListener('resize', onResize);
    }

    // Customers --------------------------------------------------------------
    let custSub = 'people';
    function drawCustomers(v) {
      current = { poll: false };
      v.innerHTML = `<div class="subtabs">${[['people', 'Customers'], ['agents', 'Travel agents'], ['accounts', 'Company accounts'], ...(P.customers ? [['invoices', 'Invoices']] : [])].map(([k, l]) => `<button type="button" data-sub="${k}" aria-pressed="${custSub === k}">${l}</button>`).join('')}</div><div id="cv"></div>`;
      $$('[data-sub]', v).forEach((b) => { b.onclick = () => { custSub = b.dataset.sub; drawCustomers(v); }; });
      const host = $('#cv', v);
      ({ people: customerList, agents: agentList, accounts: accountList, invoices: invoiceList })[custSub](host, () => drawCustomers(v));
    }
    const TERMS = { 0: 'Due on receipt', 15: 'Net 15', 30: 'Net 30', 45: 'Net 45' };
    const invPill = (i) => i.status === 'paid' ? '<span class="pill paid">Paid</span>' : i.status === 'void' ? '<span class="pill off">Void</span>' : i.overdue ? `<span class="pill s-cancelled">${i.overdueDays} day${i.overdueDays === 1 ? '' : 's'} overdue</span>` : '<span class="pill s-assigned">Open</span>';
    async function accountList(host, redraw) {
      let list;
      try { list = await api('dispatch.accounts'); } catch (e) { return showErr(host, e); }
      const owed = list.reduce((s2, a) => s2 + a.openBalance, 0), late = list.reduce((s2, a) => s2 + a.overdueBalance, 0), ub = list.reduce((s2, a) => s2 + a.unbilledTotal, 0);
      host.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Company accounts</h1><p class="muted">Businesses that book on account and pay by monthly invoice. Their bookers' trips are billed to the account, with an optional PO number and cost center.</p></div><button class="btn primary" type="button" id="ac-add">Add account</button></div>
        <div class="tiles" style="margin-bottom:14px"><div class="tile"><span class="label">Not invoiced yet</span><b class="num">${money(ub)}</b></div><div class="tile"><span class="label">Invoiced, unpaid</span><b class="num">${money(owed)}</b></div><div class="tile"><span class="label">Overdue</span><b class="num ${late ? 'bad' : ''}">${money(late)}</b></div></div>
        <div class="tablewrap"><table><thead><tr><th>Company</th><th>Terms</th><th class="r">Discount</th><th class="r">Bookers</th><th class="r">Upcoming</th><th class="r">Not invoiced</th><th class="r">Unpaid</th><th></th></tr></thead><tbody>
        ${list.map((a) => `<tr class="click" data-id="${a.id}"><td><b>${esc(a.name)}</b>${a.active ? '' : ' <span class="pill off">Inactive</span>'}${a.requirePo ? ' <span class="pill">PO required</span>' : ''}<br><span class="small faint">${esc(a.billingEmail || 'No billing email')}</span></td>
          <td class="small">${TERMS[a.terms]}</td><td class="r num">${a.discountPct ? a.discountPct + '%' : '—'}</td><td class="r num">${a.bookers}</td><td class="r num">${a.upcoming}</td>
          <td class="r num">${a.unbilledCount ? `${money(a.unbilledTotal)}<br><span class="small faint">${a.unbilledCount} trip${a.unbilledCount === 1 ? '' : 's'}</span>` : '—'}</td><td class="r num">${a.openBalance ? money(a.openBalance) : '—'}</td><td>${a.overdueBalance ? '<span class="pill s-cancelled">Overdue</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="faint">No company accounts yet.</td></tr>'}
        </tbody></table></div>`;
      $('#ac-add', host).onclick = () => accountForm(null, redraw);
      $$('tr[data-id]', host).forEach((r) => { r.onclick = () => accountModal(r.dataset.id, redraw); });
    }
    function accountForm(a, done) {
      a = a || { terms: 30, discountPct: 0, active: true };
      const m = openModal({
        title: a.id ? `Edit ${a.name}` : 'New company account',
        body: `<form id="af" class="stack" novalidate>
          <label class="field"><span>Company name</span><input name="name" value="${esc(a.name || '')}" required></label>
          <div class="grid2"><label class="field"><span>Billing contact</span><input name="contact" value="${esc(a.contact || '')}"></label>
            <label class="field"><span>Billing email</span><input name="billingEmail" type="email" value="${esc(a.billingEmail || '')}"><span class="hint">Invoices are emailed here.</span></label></div>
          <div class="grid2"><label class="field"><span>Phone</span><input name="phone" value="${esc(a.phone || '')}"></label>
            <label class="field"><span>Billing address</span><input name="address" value="${esc(a.address || '')}"></label></div>
          <div class="grid2"><label class="field"><span>Payment terms</span><select name="terms">${Object.entries(TERMS).map(([k, l]) => `<option value="${k}" ${Number(k) === a.terms ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <label class="field"><span>Account discount (%)</span><input name="discountPct" type="number" min="0" max="50" step="0.5" value="${a.discountPct || 0}"><span class="hint">Taken off every trip billed to this account.</span></label></div>
          <label class="switch"><input type="checkbox" name="requirePo" ${a.requirePo ? 'checked' : ''}><span>Require a PO number on every booking</span></label>
          <label class="switch"><input type="checkbox" name="active" ${a.active !== false ? 'checked' : ''}><span>Active (bookers can bill this account)</span></label>
          <label class="field"><span>Notes</span><textarea name="notes">${esc(a.notes || '')}</textarea></label>
          <div id="af-err"></div></form>`,
        footer: '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="af-save">Save</button>',
      });
      $('[data-close]', m).onclick = closeModal;
      $('#af-save', m).onclick = (e) => busy(e.currentTarget, async () => {
        try { const r = await api('dispatch.saveAccount', { ...formData($('#af', m)), id: a.id }); closeModal(); toast(`${r.name} saved.`); done && done(r); } catch (err) { showErr($('#af-err', m), err); }
      });
    }
    async function accountModal(aid, done) {
      let d;
      try { d = await api('dispatch.account', { id: aid }); } catch (e) { return toast(e.message, true); }
      const a = d.account;
      const today = toLocalInput(new Date()).slice(0, 10);
      const tripRow = (t) => `<tr><td class="small">${esc(fmtDate(t.pickupAt))}</td><td class="mono small">${esc(t.ref)}</td><td>${esc(t.passengerName)}</td><td class="small">${esc(t.pickup)}${t.dropoff ? ' → ' + esc(t.dropoff) : ''}</td><td class="small">${esc(t.poNumber || '')}${t.costCenter ? `<br><span class="faint">${esc(t.costCenter)}</span>` : ''}</td><td class="r num">${money(t.price.total)}</td></tr>`;
      const m = openModal({
        title: a.name, wide: true, onClose: done,
        body: `<div class="stack">
          <div class="spread"><div class="small muted">${esc(TERMS[a.terms])} · ${a.discountPct ? a.discountPct + '% discount' : 'No discount'}${a.requirePo ? ' · PO required' : ''} · ${esc(a.billingEmail || 'no billing email')}${a.contact ? ' · ' + esc(a.contact) : ''}</div><button class="btn sm" type="button" id="am-edit">Edit account</button></div>
          <div class="tiles"><div class="tile"><span class="label">Not invoiced yet</span><b class="num">${money(a.unbilledTotal)}</b></div><div class="tile"><span class="label">Invoiced, unpaid</span><b class="num">${money(a.openBalance)}</b></div><div class="tile"><span class="label">Overdue</span><b class="num ${a.overdueBalance ? 'bad' : ''}">${money(a.overdueBalance)}</b></div></div>
          <div class="panel stack"><div class="spread"><h2>Completed trips not invoiced</h2>
            ${d.unbilled.length ? `<div class="row"><label class="small muted" for="am-thru">Up to</label><input class="input" style="width:auto" type="date" id="am-thru" value="${today}"><label class="switch small"><input type="checkbox" id="am-send" checked><span>Email it</span></label><button class="btn primary sm" type="button" id="am-inv">Create invoice</button></div>` : ''}</div>
            ${d.unbilled.length ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Ref</th><th>Passenger</th><th>Route</th><th>PO / cost center</th><th class="r">Amount</th></tr></thead><tbody>${d.unbilled.map(tripRow).join('')}</tbody></table></div>` : '<p class="small faint">Nothing to invoice. Completed trips billed to this account show up here.</p>'}</div>
          <div class="panel stack"><h2>Invoices</h2>
            ${d.invoices.length ? `<div class="tablewrap"><table><thead><tr><th>Number</th><th>Issued</th><th>Due</th><th class="r">Trips</th><th class="r">Total</th><th>Status</th></tr></thead><tbody>${d.invoices.map((i) => `<tr class="click" data-inv="${i.id}"><td class="mono">${esc(i.number)}</td><td class="small">${esc(fmtDate(i.issuedAt))}</td><td class="small">${esc(fmtDate(i.dueAt))}</td><td class="r num">${i.lines.length}</td><td class="r num">${money(i.total)}</td><td>${invPill(i)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small faint">No invoices yet.</p>'}</div>
          <div class="grid2">
            <div class="panel stack"><h2>Bookers</h2><p class="small muted">People who can bill this account when they book online. Phone bookings can bill it from the booking form.</p>
              ${d.bookers.map((u) => `<div class="spread small"><span><b>${esc(u.name)}</b> · <span class="mono">${esc(u.email)}</span>${u.hasLogin ? '' : ' <span class="faint">(no login yet)</span>'}</span><button class="linkbtn small" type="button" data-rmb="${u.id}">Remove</button></div>`).join('') || '<p class="small faint">No bookers yet.</p>'}
              <form class="row" id="am-addb" novalidate><input class="input grow" name="name" placeholder="Name" style="min-width:110px"><input class="input grow" name="email" type="email" placeholder="Email" style="min-width:150px"><button class="btn sm" type="submit">Add booker</button></form><div id="am-err"></div></div>
            <div class="panel stack"><h2>Upcoming trips</h2>${d.upcoming.length ? d.upcoming.map((t) => `<div class="spread small"><span>${esc(fmtDT(t.pickupAt))} · ${esc(t.passengerName)}</span><span class="mono faint">${esc(t.ref)}</span></div>`).join('') : '<p class="small faint">None booked.</p>'}</div>
          </div></div>`,
      });
      const reopen = () => { m._onClose = null; closeModal(); accountModal(aid, done); };
      $('#am-edit', m).onclick = () => { m._onClose = null; closeModal(); accountForm(a, () => accountModal(aid, done)); };
      const ci = $('#am-inv', m);
      if (ci) ci.onclick = () => busy(ci, async () => {
        try { const inv = await api('dispatch.createInvoice', { accountId: aid, through: $('#am-thru', m).value, send: $('#am-send', m).checked }); toast(`${inv.number} created for ${money(inv.total)}${inv.sentTo ? `, emailed to ${inv.sentTo}` : ''}.`); m._onClose = null; closeModal(); invoiceModal(inv.id, () => accountModal(aid, done)); } catch (err) { toast(err.message, true); }
      });
      $$('[data-inv]', m).forEach((r) => { r.onclick = () => { m._onClose = null; closeModal(); invoiceModal(r.dataset.inv, () => accountModal(aid, done)); }; });
      $$('[data-rmb]', m).forEach((b) => { b.onclick = () => busy(b, async () => { try { await api('dispatch.accountBooker', { accountId: aid, remove: b.dataset.rmb }); reopen(); } catch (err) { toast(err.message, true); } }); });
      $('#am-addb', m).onsubmit = (e) => { e.preventDefault(); busy($('button', e.target), async () => {
        try { const u = await api('dispatch.accountBooker', { accountId: aid, ...formData(e.target) }); toast(`${u.name} can now book on this account.`); reopen(); } catch (err) { showErr($('#am-err', m), err); }
      }); };
    }
    async function invoiceModal(iid, done) {
      let d;
      try { d = await api('dispatch.invoice', { id: iid }); } catch (e) { return toast(e.message, true); }
      const i = d.invoice, a = d.account || {}, c = d.company;
      const m = openModal({
        title: `Invoice ${i.number}`, wide: true, onClose: done,
        body: `<div class="invoice" id="inv-print">
          <div class="spread" style="align-items:flex-start"><div><h2 style="margin:0">${esc(c.name)}</h2><div class="small muted">${esc(c.phone || '')}${c.email ? ' · ' + esc(c.email) : ''}</div></div>
            <div style="text-align:right"><div class="label">Invoice</div><b class="mono">${esc(i.number)}</b><div>${invPill(i)}</div></div></div>
          <div class="grid2"><div><span class="label">Bill to</span><div><b>${esc(a.name || i.accountName)}</b></div><div class="small">${esc(a.contact || '')}</div><div class="small">${esc(a.address || '')}</div><div class="small mono">${esc(a.billingEmail || '')}</div></div>
            <dl class="kv small"><dt>Issued</dt><dd>${esc(fmtDate(i.issuedAt))}</dd><dt>Terms</dt><dd>${esc(TERMS[i.terms] || '')}</dd><dt>Due</dt><dd>${esc(fmtDate(i.dueAt))}</dd>${i.sentAt ? `<dt>Emailed</dt><dd>${esc(fmtDate(i.sentAt))} to ${esc(i.sentTo)}</dd>` : ''}${i.paidAt ? `<dt>Paid</dt><dd>${esc(fmtDate(i.paidAt))}${i.paidMethod ? ' by ' + esc(i.paidMethod.toUpperCase()) : ''}</dd>` : ''}</dl></div>
          <div class="tablewrap"><table><thead><tr><th>Date</th><th>Ref</th><th>Passenger</th><th>Trip</th><th>PO</th><th>Cost center</th><th class="r">Amount</th></tr></thead><tbody>
            ${i.lines.map((l) => `<tr><td class="small">${esc(fmtDate(l.date))}</td><td class="mono small">${esc(l.ref)}</td><td>${esc(l.passenger)}</td><td class="small">${esc(l.route)} · ${esc(l.vehicle)}</td><td class="small mono">${esc(l.po)}</td><td class="small">${esc(l.costCenter)}</td><td class="r num">${money(l.amount)}</td></tr>`).join('')}
            <tr><td colspan="6" class="r"><b>Total due</b></td><td class="r num"><b>${money(i.total)}</b></td></tr></tbody></table></div>
          <p class="small faint">Amounts include gratuity and any discounts shown on each trip's receipt.</p></div>`,
        footer: `<button class="btn" type="button" id="inv-print-btn">Print or save PDF</button>
          ${i.status === 'open' ? '<button class="btn" type="button" data-ia="send">Email again</button><button class="btn danger" type="button" data-ia="void">Void</button><select class="input" id="inv-method" style="width:auto"><option value="check">Check</option><option value="ach">ACH</option><option value="wire">Wire</option><option value="card">Card</option></select><button class="btn primary" type="button" data-ia="paid">Mark paid</button>' : ''}
          ${i.status === 'paid' ? '<button class="btn" type="button" data-ia="unpaid">Mark unpaid</button>' : ''}`,
      });
      $('#inv-print-btn', m).onclick = () => { document.body.classList.add('printing-invoice'); window.print(); setTimeout(() => document.body.classList.remove('printing-invoice'), 500); };
      $$('[data-ia]', m).forEach((b) => { b.onclick = () => {
        if (b.dataset.ia === 'void' && !b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Click again to void'; return; }
        busy(b, async () => {
          try {
            const r = await api('dispatch.invoiceAction', { id: iid, action: b.dataset.ia, method: ($('#inv-method', m) || {}).value });
            toast({ paid: `${r.number} marked paid.`, unpaid: `${r.number} is open again.`, void: `${r.number} voided. Its trips can go on a new invoice.`, send: `${r.number} emailed to ${r.sentTo}.` }[b.dataset.ia]);
            m._onClose = null; closeModal(); invoiceModal(iid, done);
          } catch (err) { toast(err.message, true); }
        });
      }; });
    }
    async function invoiceList(host, redraw) {
      let list;
      try { list = await api('dispatch.invoices'); } catch (e) { return showErr(host, e); }
      const open = list.filter((i) => i.status === 'open');
      host.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Invoices</h1><p class="muted">Monthly invoices to company accounts. Create them from an account; mark them paid when the money arrives.</p></div></div>
        <div class="tiles" style="margin-bottom:14px"><div class="tile"><span class="label">Open</span><b class="num">${money(open.reduce((s2, i) => s2 + i.total, 0))}</b></div><div class="tile"><span class="label">Overdue</span><b class="num ${open.some((i) => i.overdue) ? 'bad' : ''}">${money(open.filter((i) => i.overdue).reduce((s2, i) => s2 + i.total, 0))}</b></div><div class="tile"><span class="label">Paid (all time)</span><b class="num">${money(list.filter((i) => i.status === 'paid').reduce((s2, i) => s2 + i.total, 0))}</b></div></div>
        <div class="tablewrap"><table><thead><tr><th>Number</th><th>Account</th><th>Issued</th><th>Due</th><th class="r">Trips</th><th class="r">Total</th><th>Status</th></tr></thead><tbody>
        ${list.map((i) => `<tr class="click" data-inv="${i.id}"><td class="mono">${esc(i.number)}</td><td>${esc(i.accountName)}</td><td class="small">${esc(fmtDate(i.issuedAt))}</td><td class="small">${esc(fmtDate(i.dueAt))}</td><td class="r num">${i.lines.length}</td><td class="r num">${money(i.total)}</td><td>${invPill(i)}</td></tr>`).join('') || '<tr><td colspan="7" class="faint">No invoices yet. Open a company account to create one.</td></tr>'}
        </tbody></table></div>`;
      $$('[data-inv]', host).forEach((r) => { r.onclick = () => invoiceModal(r.dataset.inv, redraw); });
    }
    // Travel agents who book for their clients, and the commission they earn.
    async function agentList(v, redraw) {
      let d;
      try { d = await api('dispatch.agents'); } catch (e) { return showErr(v, e); }
      const owed = d.agents.reduce((s2, a) => s2 + a.owed, 0);
      const lastMonth = (() => { const x = new Date(); x.setDate(1); x.setMonth(x.getMonth() - 1); return x.toISOString().slice(0, 7); })();
      v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Travel agents</h1><p class="muted">Agents, assistants and concierges who book rides for their clients. They sign up from your booking page and earn commission on completed rides (ride price before gratuity and tax).</p></div>
          <a class="btn" href="#agent.${esc(session.company.slug)}">Agent sign-up page</a></div>
        <div class="tiles three" style="margin-bottom:16px">
          <div class="tile"><span class="label">Agents</span><b class="num">${d.agents.length}</b></div>
          <div class="tile"><span class="label">Commission owed</span><b class="num">${money(owed)}</b></div>
          <div class="tile"><span class="label">Default commission</span><b class="num">${d.cfg.on ? d.cfg.commissionPct + '%' : 'Off'}</b>${isAdmin ? '<button class="linkbtn small" type="button" id="ag-cfg">Change</button>' : ''}</div>
        </div>
        <div class="tablewrap"><table id="ag-table"><thead><tr><th>Agent</th><th>Agency</th><th>Contact</th><th class="r">Commission</th><th class="r">Rides</th><th class="r">Upcoming</th><th class="r">Clients</th><th class="r">Ride sales</th><th class="r">Owed</th><th class="r">Paid</th></tr></thead><tbody>
        ${d.agents.map((a) => `<tr class="click" data-ag="${a.id}"><td><b>${esc(a.name)}</b></td><td>${esc(a.agency)}</td><td class="small"><span class="mono">${esc(a.email)}</span><br>${esc(a.phone || '')}</td><td class="r num">${a.commissionOn ? `${a.pct}%${a.customPct ? '*' : ''}` : 'Off'}</td><td class="r num">${a.trips}</td><td class="r num">${a.upcoming}</td><td class="r num">${a.clients}</td><td class="r num">${money(a.sales)}</td><td class="r num">${a.owed ? `<b>${money(a.owed)}</b>` : money(0)}</td><td class="r num">${money(a.paid)}</td></tr>`).join('') || '<tr><td colspan="10" class="faint">No travel agents yet. Share your agent sign-up page with local hotels and travel agencies.</td></tr>'}
        </tbody></table></div><p class="small faint" style="margin-top:8px">* Own rate for this agent.</p>`;
      const cfgBtn = $('#ag-cfg', v);
      if (cfgBtn) cfgBtn.onclick = () => {
        const m = openModal({ title: 'Default agent commission', body: `<form id="agc" class="stack" novalidate><label class="field"><span>Commission on completed rides (%)</span><input name="commissionPct" type="number" min="0" max="30" step="0.5" value="${d.cfg.commissionPct}"></label><label class="switch"><input type="checkbox" name="on" ${d.cfg.on ? 'checked' : ''}><span>Pay commission to travel agents</span></label><p class="small faint">Applies to new bookings. Each ride keeps the rate it was booked at.</p><div id="agc-err"></div></form>`,
          footer: '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="agc-save">Save</button>' });
        $('[data-close]', m).onclick = closeModal;
        $('#agc-save', m).onclick = (e) => busy(e.currentTarget, async () => { try { await api('dispatch.saveAgentCfg', formData($('#agc', m))); closeModal(); toast('Commission saved.'); redraw(); } catch (err) { showErr($('#agc-err', m), err); } });
      };
      $$('tr[data-ag]', v).forEach((r) => { r.onclick = () => {
        const a = d.agents.find((x) => x.id === r.dataset.ag);
        const m = openModal({
          title: `${a.name}, ${a.agency}`,
          body: `<form id="agf" class="stack" novalidate>
            <p class="muted small">Agent since ${esc(fmtDate(a.since))}. ${a.trips} ride${a.trips === 1 ? '' : 's'} for ${a.clients} client${a.clients === 1 ? '' : 's'}, ${money(a.sales)} in ride sales.</p>
            <div class="grid2"><label class="field"><span>Agency</span><input name="agency" value="${esc(a.agency)}" ${isAdmin ? '' : 'disabled'}></label>
              <label class="field"><span>Commission (%)</span><input name="commissionPct" type="number" min="0" max="30" step="0.5" value="${a.customPct ? a.pct : ''}" placeholder="${d.cfg.commissionPct} (default)" ${isAdmin ? '' : 'disabled'}><span class="hint">Leave blank for your default.</span></label></div>
            <label class="switch"><input type="checkbox" name="commissionOn" ${a.commissionOn ? 'checked' : ''} ${isAdmin ? '' : 'disabled'}><span>Earns commission</span></label>
            ${a.owed && isAdmin ? `<div class="note">Owed: <b>${money(a.owed)}</b>. <button class="btn sm" type="button" id="agf-pay">Mark paid through ${esc(new Date(lastMonth + '-15T12:00:00').toLocaleDateString([], { month: 'long' }))}</button> <button class="btn sm" type="button" id="agf-payall">Mark all paid</button></div>` : ''}
            <div id="agf-err"></div></form>`,
          footer: `<button class="btn" type="button" data-close>Close</button>${isAdmin ? '<button class="btn primary" type="button" id="agf-save">Save</button>' : ''}`,
        });
        $('[data-close]', m).onclick = closeModal;
        const pay = async (through, b) => busy(b, async () => { try { const x = await api('dispatch.payCommission', { id: a.id, through }); closeModal(); toast(`${money(x.amount)} commission marked paid for ${x.trips} ride${x.trips === 1 ? '' : 's'}.`); redraw(); } catch (err) { showErr($('#agf-err', m), err); } });
        const p1 = $('#agf-pay', m); if (p1) p1.onclick = (e) => pay(lastMonth, e.currentTarget);
        const p2 = $('#agf-payall', m); if (p2) p2.onclick = (e) => pay(new Date().toISOString().slice(0, 7), e.currentTarget);
        const sv = $('#agf-save', m); if (sv) sv.onclick = (e) => busy(e.currentTarget, async () => { const f = formData($('#agf', m)); try { await api('dispatch.saveAgent', { id: a.id, ...f }); closeModal(); toast('Agent saved.'); redraw(); } catch (err) { showErr($('#agf-err', m), err); } });
      }; });
    }
    async function customerList(v, redraw) {
      let list, accounts;
      try { [list, accounts] = await Promise.all([api('dispatch.customers'), api('dispatch.accounts')]); } catch (e) { return showErr(v, e); }
      list.sort((a, b) => (b.lastTrip || '').localeCompare(a.lastTrip || ''));
      v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Customers</h1><p class="muted">People who booked online, plus passengers added by phone with an email. Open one to give them an account discount.</p></div>
          <a class="btn" href="#book.${esc(session.company.slug)}">Open your booking page</a></div>
        <div class="tablewrap"><table><thead><tr><th>Name</th><th>Company account</th><th>Email</th><th>Phone</th><th>Online login</th><th class="r">Discount</th><th class="r">Trips</th><th class="r">Spent</th><th>Last trip</th></tr></thead><tbody>
        ${list.map((c) => `<tr class="click" data-id="${c.id}"><td><b>${esc(c.name)}</b></td><td class="small">${esc(c.account)}</td><td class="mono small">${esc(c.email)}</td><td class="mono small">${esc(c.phone)}</td><td>${c.hasLogin ? '<span class="pill s-on_board">Yes</span>' : '<span class="pill off">No</span>'}</td><td class="r num">${c.discountPct ? c.discountPct + '%' : '—'}</td><td class="r num">${c.trips}</td><td class="r num">${money(c.spend)}</td><td class="small">${c.lastTrip ? esc(fmtDate(c.lastTrip)) : '—'}</td></tr>`).join('') || '<tr><td colspan="9" class="faint">No customers yet.</td></tr>'}
        </tbody></table></div>`;
      $$('tr[data-id]', v).forEach((r) => { r.onclick = () => {
        const c = list.find((x) => x.id === r.dataset.id);
        const m = openModal({
          title: c.name,
          body: `<form id="cf" class="stack" novalidate>
            <div class="grid2"><label class="field"><span>Books for company account</span><select id="cf-acct" name="accountId"><option value="">None</option>${accounts.map((a) => `<option value="${a.id}" ${c.accountId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
              <label class="field"><span>Account discount (%)</span><input id="cf-disc" name="discountPct" type="number" min="0" max="50" step="0.5" value="${c.discountPct}"><span class="hint">Taken off every new booking for this customer.</span></label></div>
            <label class="field"><span>Phone</span><input id="cf-phone" name="phone" value="${esc(c.phone)}"></label>
            <label class="field"><span>Notes</span><textarea id="cf-notes" name="notes">${esc(c.notes)}</textarea></label>
            <div id="cf-err"></div></form>`,
          footer: '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="cf-save">Save</button>',
        });
        $('[data-close]', m).onclick = closeModal;
        $('#cf-save', m).onclick = (e) => busy(e.currentTarget, async () => { try { await api('dispatch.saveCustomer', { ...formData($('#cf', m)), id: c.id }); closeModal(); toast('Customer saved.'); redraw(); } catch (err) { showErr($('#cf-err', m), err); } });
      }; });
    }

    // Pricing ----------------------------------------------------------------
    async function drawPricing(v) {
      current = { poll: false };
      let d;
      try { d = await api('dispatch.pricing'); } catch (e) { return showErr(v, e); }
      const p = d.pricing;
      const ro = isAdmin ? '' : 'disabled';
      let peaks = p.peakDates.map((x) => ({ ...x }));
      let promos = p.promos.map((x) => ({ ...x }));
      const numIn = (id, name, val, step, extra) => `<input class="input" id="${id}" name="${name}" type="number" min="0" step="${step || 1}" value="${val}" ${ro} ${extra || ''}>`;
      v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Pricing</h1><p class="muted">Automatic price adjustments on top of your base rates. Quotes and new bookings use them straight away; booked trips keep their price.${isAdmin ? '' : ' Only the company admin can change these.'}</p></div></div>
        <form id="pr" class="stack" novalidate style="max-width:900px">
          <div class="panel stack"><h2>Automatic adjustments</h2>
            <div class="rule"><div><b>Late night</b><p class="small muted">Added to the fare for pickups between these hours (${esc(d.timezone.replace('_', ' '))} time).</p></div>
              <div class="row"><span class="small">+</span>${numIn('pr-night', 'nightPct', p.nightPct, 1, 'style="width:80px"')}<span class="small">% from</span>${numIn('pr-ns', 'nightStart', p.nightStart, 1, 'style="width:70px" max="23"')}<span class="small">:00 to</span>${numIn('pr-ne', 'nightEnd', p.nightEnd, 1, 'style="width:70px" max="23"')}<span class="small">:00</span></div></div>
            <div class="rule"><div><b>Weekend</b><p class="small muted">Added for Saturday and Sunday pickups.</p></div>
              <div class="row"><span class="small">+</span>${numIn('pr-wk', 'weekendPct', p.weekendPct, 1, 'style="width:80px"')}<span class="small">%</span></div></div>
            <div class="rule"><div><b>Busy times</b><p class="small muted">Added when most of that vehicle type is already booked within two hours of the pickup.</p></div>
              <div class="row"><span class="small">+</span>${numIn('pr-busy', 'busyPct', p.busyPct, 1, 'style="width:80px"')}<span class="small">% when</span>${numIn('pr-bt', 'busyThreshold', p.busyThreshold, 5, 'style="width:80px" max="100"')}<span class="small">% of vehicles are booked</span></div></div>
          </div>
          <div class="panel stack"><h2>Busy dates</h2><p class="small muted">Holidays, proms, graduations, concerts. The highest matching date applies.</p><div id="pr-peaks"></div>${isAdmin ? '<div><button class="btn sm" type="button" id="pr-addpeak">Add a date</button></div>' : ''}</div>
          <div class="panel stack"><h2>Add-ons</h2>
            <div class="grid3"><label class="field"><span>Child seat, each ($)</span>${numIn('pr-child', 'childSeat', p.addons.childSeat, 0.5)}</label>
              <label class="field"><span>Meet &amp; greet inside ($)</span>${numIn('pr-meet', 'meetGreet', p.addons.meetGreet, 0.5)}</label>
              <label class="field"><span>Wait booked at each stop (min)</span>${numIn('pr-swait', 'stopWait', p.addons.stopWait == null ? 10 : p.addons.stopWait, 5, 'max="240"')}</label></div>
            <div class="grid3"><label class="field"><span>Stop fee, each, optional ($)</span>${numIn('pr-stop', 'extraStop', p.addons.extraStop, 0.5)}</label></div>
            <p class="small muted">Each stop is priced by the extra miles it adds (your per-mile rate) plus the wait booked there (your waiting rate per minute). Customers can choose the wait for each stop; any longer wait is charged after the ride.</p></div>
          <div class="panel stack"><h2>Promo codes</h2><p class="small muted">Customers type these on the booking page. Leave max uses at 0 for no limit.</p><div id="pr-promos"></div>${isAdmin ? '<div><button class="btn sm" type="button" id="pr-addpromo">Add a promo code</button></div>' : ''}</div>
          <div id="pr-err"></div>
          ${isAdmin ? '<div><button class="btn primary" type="submit">Save pricing</button></div>' : ''}
        </form>`;
      const drawPeaks = () => {
        $('#pr-peaks', v).innerHTML = peaks.length ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Name</th><th>Surcharge %</th><th></th></tr></thead><tbody>${peaks.map((x, i) => `<tr>
          <td><input class="input" type="date" data-pk="${i}" data-f="date" value="${esc(x.date)}" ${ro}></td><td><input class="input" data-pk="${i}" data-f="label" value="${esc(x.label)}" ${ro}></td>
          <td><input class="input" style="width:90px" type="number" min="0" data-pk="${i}" data-f="pct" value="${x.pct}" ${ro}></td><td>${isAdmin ? `<button class="linkbtn small" type="button" data-rmpk="${i}">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small faint">No busy dates set.</p>';
        $$('[data-pk]', v).forEach((el) => { el.oninput = () => { peaks[el.dataset.pk][el.dataset.f] = el.value; }; });
        $$('[data-rmpk]', v).forEach((b) => { b.onclick = () => { peaks.splice(Number(b.dataset.rmpk), 1); drawPeaks(); }; });
      };
      const drawPromos = () => {
        $('#pr-promos', v).innerHTML = promos.length ? `<div class="tablewrap"><table><thead><tr><th>Code</th><th>Discount</th><th>Ends</th><th>Max uses</th><th class="r">Used</th><th>On</th><th></th></tr></thead><tbody>${promos.map((x, i) => `<tr>
          <td><input class="input mono" style="width:130px;text-transform:uppercase" data-pr="${i}" data-f="code" value="${esc(x.code)}" ${ro}></td>
          <td><div class="row" style="flex-wrap:nowrap"><input class="input" style="width:90px" type="number" min="0" data-pr="${i}" data-f="value" value="${x.value}" ${ro}><select class="input" style="width:auto" data-pr="${i}" data-f="type" ${ro}><option value="percent" ${x.type !== 'amount' ? 'selected' : ''}>% off</option><option value="amount" ${x.type === 'amount' ? 'selected' : ''}>$ off</option></select></div></td>
          <td><input class="input" type="date" data-pr="${i}" data-f="expires" value="${esc(x.expires || '')}" ${ro}></td>
          <td><input class="input" style="width:80px" type="number" min="0" data-pr="${i}" data-f="maxUses" value="${x.maxUses || 0}" ${ro}></td>
          <td class="r num">${x.uses || 0}</td>
          <td><input type="checkbox" data-pr="${i}" data-f="active" ${x.active !== false ? 'checked' : ''} ${ro}></td>
          <td>${isAdmin ? `<button class="linkbtn small" type="button" data-rmpr="${i}">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small faint">No promo codes yet.</p>';
        $$('[data-pr]', v).forEach((el) => { el.oninput = el.onchange = () => { promos[el.dataset.pr][el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value; }; });
        $$('[data-rmpr]', v).forEach((b) => { b.onclick = () => { promos.splice(Number(b.dataset.rmpr), 1); drawPromos(); }; });
      };
      drawPeaks(); drawPromos();
      if (isAdmin) {
        $('#pr-addpeak', v).onclick = () => { peaks.push({ date: todayStr(), label: '', pct: 20 }); drawPeaks(); };
        $('#pr-addpromo', v).onclick = () => { promos.push({ code: '', type: 'percent', value: 10, expires: '', maxUses: 0, uses: 0, active: true }); drawPromos(); };
        $('#pr', v).onsubmit = async (e) => {
          e.preventDefault();
          const f = formData(e.target);
          await busy($('button[type=submit]', e.target), async () => {
            try {
              await api('dispatch.savePricing', { nightPct: f.nightPct, nightStart: f.nightStart, nightEnd: f.nightEnd, weekendPct: f.weekendPct, busyPct: f.busyPct, busyThreshold: f.busyThreshold, addons: { childSeat: f.childSeat, meetGreet: f.meetGreet, extraStop: f.extraStop, stopWait: f.stopWait }, peakDates: peaks, promos });
              toast('Pricing saved.'); drawPricing(v);
            } catch (err) { showErr($('#pr-err', v), err); }
          });
        };
      }
    }

    const DELIVERY = { sent: ['Delivered', 'ok'], failed: ['Not delivered', 'bad'], skipped: ['No phone or email', 'bad'], simulated: ['Logged only', ''], sending: ['Sending', ''], held: ['Not sent: out of texts', 'bad'] };
    const deliveryTag = (m) => (m.outOfTexts === 'email' ? ' · <span class="dtag">Sent by email: out of texts</span>' : '') + _deliveryTag(m);
    const _deliveryTag = (m) => { const d = m.delivery && DELIVERY[m.delivery.status]; return d ? ` · <span class="dtag ${d[1]}" ${m.delivery.error ? `title="${esc(m.delivery.error)}"` : ''}>${d[0]}${m.delivery.error && m.delivery.status === 'failed' ? ': ' + esc(m.delivery.error) : ''}</span>` : ''; };
    // This month's texts: what's used, what's left, and buying more.
    function textsPanel(t) {
      const mon = new Date(t.month + '-15T12:00:00').toLocaleDateString([], { month: 'long' });
      const status = t.out ? '<span class="pill s-cancelled">Out of texts</span>' : t.low ? '<span class="pill unpaid">Running low</span>' : '<span class="pill s-on_board">OK</span>';
      return `<section class="panel stack texts" id="tx-panel" style="margin-bottom:16px">
        <div class="spread"><h2>Texts this month</h2>${status}</div>
        <div class="txbar ${t.out ? 'out' : t.low ? 'low' : ''}"><span style="width:${t.pct}%"></span></div>
        <div class="tiles three">
          <div class="tile"><span class="label">Used in ${esc(mon)}</span><b class="num">${t.used}</b><span class="small faint">${t.fromPacks ? `${t.used - t.fromPacks} of ${t.included} included, ${t.fromPacks} from packs` : `of ${t.included} included`}</span></div>
          <div class="tile"><span class="label">Left</span><b class="num">${t.left}</b><span class="small faint">${t.credits ? `${t.credits} bought texts, never expire` : 'Resets on the 1st'}</span></div>
          <div class="tile"><span class="label">Not sent</span><b class="num">${t.held}</b><span class="small faint">Held while out of texts</span></div>
        </div>
        ${t.out ? `<p class="note warn">You're out of texts. Passenger messages go by email until you buy more. Texts to drivers and to passengers without an email are held.</p>` : t.low ? `<p class="note">You've used most of this month's texts. When they run out, passenger messages switch to email.</p>` : ''}
        ${isAdmin && IOS_APP ? '<p class="small muted">Manage your texts and plan on the website.</p>' : isAdmin ? `<div class="row"><select class="input" id="tx-packs" style="width:auto">${[1, 2, 3, 4, 6, 10].map((n) => `<option value="${n}">${n * t.packSize} texts, ${money(n * t.packPrice)}</option>`).join('')}</select>
          <button class="btn primary" type="button" id="tx-buy">Buy texts</button>
          <label class="switch"><input type="checkbox" id="tx-auto" ${t.autoTopUp ? 'checked' : ''}><span>Buy ${t.packSize} more automatically when I run out</span></label></div>` : '<p class="small faint">Only a company admin can buy more texts.</p>'}
        ${t.planInfo ? `<p class="small muted" id="tx-plan">Your plan: <b>${esc(t.planInfo.planLabel)}</b>, ${t.planInfo.billing === 'yearly' ? `${money(t.planInfo.yearlyFee)} a year` : `${money(t.planInfo.monthlyFee)} a month`}, with ${t.included} texts a month. Dispatch, the driver app and the passenger app are all included.${t.planInfo.inTrial ? ` Free trial until ${esc(fmtYMD(t.planInfo.trialEnds))}.` : ''}${t.planInfo.priceLockedUntil ? ` Price locked until ${esc(fmtYMD(t.planInfo.priceLockedUntil))}.` : ''}</p>` : ''}
        <p class="small faint">Emails are unlimited. A text over 160 characters counts as 2 or more, the same way phone carriers bill it. Bought texts go on your next monthly invoice.</p>
        ${t.packs.length ? `<details><summary class="small">Texts bought (${t.packs.length})</summary><div class="tablewrap"><table><tbody>${t.packs.map((p) => `<tr><td class="small nowrap">${esc(fmtDT(p.at))}</td><td class="r num">${p.texts}</td><td class="r num">${p.free ? 'Free' : money(p.price)}</td><td class="small muted">${p.auto ? 'Automatic' : esc(p.by)}${p.invoiceId ? ' · invoiced' : ''}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
      </section>`;
    }
    async function drawMessages(v) {
      let last = '';
      async function refresh(silent) {
        let list, cm, tx;
        let info;
        try { [list, cm, info, tx] = await Promise.all([api('dispatch.messages'), api('dispatch.clientMsgs'), getLive(), api('dispatch.texts')]); } catch (e) { if (!silent) showErr(v, e); return; }
        const lv = info.live || {};
        const sig = JSON.stringify([list, cm, tx]); if (sig === last) return;
        if (silent && document.activeElement && document.activeElement.closest('#cm-form')) return;
        last = sig;
        const ro = isAdmin ? '' : 'disabled';
        const sw = (k, label) => `<label class="switch"><input type="checkbox" name="${k}" ${cm[k] ? 'checked' : ''} ${ro}><span>${label}</span></label>`;
        v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Texts &amp; emails</h1>
            <p class="muted">Every confirmation and update the system sends to passengers, drivers and the office, including flight delay notices. ${lv.sms && lv.email ? 'Texts and emails are delivered for real.' : lv.sms ? 'Texts are delivered for real; emails are only logged until an email service is connected.' : lv.email ? 'Emails are delivered for real; texts are only logged until Twilio is connected.' : 'They are logged here and not delivered yet. Connecting Twilio and an email service sends them for real.'}</p></div></div>
          ${textsPanel(tx)}
          <form class="panel stack" id="cm-form" style="margin-bottom:16px" novalidate><h2>Messages to passengers</h2>
            <div class="cmgrid">
              ${sw('confirmText', 'Booking confirmation by text, right away')}
              ${sw('confirmEmail', 'Booking confirmation by email, right away')}
              ${sw('remind24', 'Reminder by text and email 24 hours before pickup')}
              ${sw('approach', 'Text when the car is about 10 minutes away')}
              ${sw('review', 'Review request by text and email after the trip')}
            </div>
            <label class="field" style="max-width:420px"><span>Send the review request this many minutes after the trip ends (0 = right away)</span><input class="input" type="number" name="reviewDelayMin" min="0" max="1440" value="${cm.reviewDelayMin}" ${ro}></label>
            <p class="small faint">The 24-hour reminder goes to trips booked more than a day ahead. Passengers of trips taken from a partner company hear from that company. ${isAdmin ? '' : 'Only a company admin can change these.'}</p>
            <div class="row">${isAdmin ? '<button class="btn primary" type="submit">Save</button>' : ''}<button class="btn" type="button" id="cm-words">Edit the wording</button></div>
          </form>
          <div class="panel">${list.map((m) => `<div class="msg"><div><span class="pill ${m.channel === 'sms' ? 's-en_route' : 's-arrived'}">${m.channel === 'sms' ? 'Text' : 'Email'}</span></div>
            <div class="stack" style="gap:2px"><div class="small faint"><span class="mono">${esc(fmtDT(m.at))}</span> · to ${esc(m.recipient)} · ${esc(m.ref)}${deliveryTag(m)}</div><div>${esc(m.body).replace(/#(track|review|quote)\.([a-f0-9]+)/g, '<a href="#$1.$2">#$1.$2</a>')}</div></div></div>`).join('') || '<p class="faint">Nothing sent yet.</p>'}</div>`;
        const f = $('#cm-form', v);
        const again = () => { last = ''; refresh(); };
        const buy = $('#tx-buy', v);
        if (buy) buy.onclick = () => busy(buy, async () => { try { const n = +$('#tx-packs', v).value; const r = await api('dispatch.buyTexts', { packs: n }); toast(`Added ${n * r.packSize} texts. ${money(n * r.packPrice)} goes on your next monthly invoice.`); again(); } catch (err) { toast(err.message, true); } });
        const auto = $('#tx-auto', v);
        if (auto) auto.onchange = async () => { try { await api('dispatch.saveTexts', { autoTopUp: auto.checked }); toast(auto.checked ? 'Automatic top-up is on.' : 'Automatic top-up is off.'); again(); } catch (err) { toast(err.message, true); } };
        $('#cm-words', v).onclick = () => wordingModal();
        f.onsubmit = async (e) => {
          e.preventDefault();
          await busy($('button[type=submit]', f), async () => {
            try { await api('dispatch.saveClientMsgs', { settings: formData(f) }); toast('Passenger messages saved.'); last = ''; refresh(); } catch (err) { toast(err.message, true); }
          });
        };
      }
      current = { poll: true, refresh };
      refresh();
    }

    // Each passenger message, in the company's own words.
    async function wordingModal() {
      let list;
      try { list = await api('dispatch.templates'); } catch (e) { return toast(e.message, true); }
      const ro = isAdmin ? '' : 'disabled';
      const WORDS = ['company', 'passenger', 'ref', 'pickup_time', 'pickup', 'dropoff', 'driver', 'driver_first', 'vehicle', 'plate', 'car_line', 'total', 'phone', 'flight', 'track_link', 'review_link', 'fee'];
      const m = openModal({
        title: 'Message wording', wide: true,
        body: `<div class="stack"><p class="small muted">Leave a box empty to use our wording. Words in braces are filled in for each trip: ${WORDS.map((w) => `<code>{${w}}</code>`).join(' ')}. Lines ending in <code>_line</code> in our wording add a whole sentence only when it applies.</p>
          ${list.map((t) => `<label class="field"><span>${esc(t.label)}</span><textarea rows="2" data-tpl="${t.key}" placeholder="${esc(t.default)}" ${ro}>${esc(t.text)}</textarea>
            ${t.preview ? `<span class="hint">Example: ${esc(t.preview)}</span>` : ''}</label>`).join('')}<div id="tpl-err"></div></div>`,
        footer: `<button class="btn" type="button" data-close>${isAdmin ? 'Cancel' : 'Close'}</button>${isAdmin ? '<button class="btn primary" type="button" id="tpl-save">Save wording</button>' : ''}`,
      });
      $('[data-close]', m).onclick = closeModal;
      const sv = $('#tpl-save', m);
      if (sv) sv.onclick = () => busy(sv, async () => {
        const templates = Object.fromEntries($$('[data-tpl]', m).map((x) => [x.dataset.tpl, x.value.trim()]));
        try { const r = await api('dispatch.saveTemplates', { templates }); closeModal(); toast(r.saved ? `Saved. ${r.saved} message${r.saved === 1 ? '' : 's'} use your wording.` : 'Saved. All messages use our wording.'); } catch (err) { showErr($('#tpl-err', m), err); }
      });
    }

    async function drawSettings(v) {
      current = { poll: false };
      let s;
      try { s = await api('dispatch.settings'); } catch (e) { return showErr(v, e); }
      const ro = isAdmin ? '' : 'disabled';
      const r = s.rates;
      const link = DEMO ? `#book.${s.company.slug}` : `${location.origin}${location.pathname}#book.${s.company.slug}`;
      const num = (k, label, step, hint) => `<label class="field"><span>${label}</span><input id="rs-${k}" name="${k}" type="number" min="0" step="${step || 0.01}" value="${r[k]}" ${ro}>${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
      v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Rates &amp; brand</h1><p class="muted">${isAdmin ? 'Base rates for a sedan. Night, weekend, busy-time and holiday adjustments are in Pricing.' : 'Only the company admin can change these.'}</p></div></div>
        <form id="rs" class="stack" novalidate style="max-width:860px">
          <div class="panel stack"><h2>Brand</h2>
            <div class="grid2"><label class="field"><span>Company name</span><input id="rs-name" name="name" value="${esc(s.company.name)}" ${ro}></label>
              <label class="field"><span>Brand color</span><input id="rs-color" name="color" type="color" value="${esc(s.company.color)}" ${ro} style="padding:4px;height:40px"></label></div>
            <label class="field"><span>Tagline on your booking page</span><input id="rs-tagline" name="tagline" value="${esc(s.company.tagline)}" ${ro}></label>
            <div class="grid2"><label class="field"><span>Phone</span><input id="rs-phone" name="phone" value="${esc(s.company.phone)}" ${ro}></label>
              <label class="field"><span>Email</span><input id="rs-email" name="email" value="${esc(s.company.email)}" ${ro}></label></div>
            <div class="field"><span>Your booking page</span><div class="row"><input class="input mono grow" id="rs-link" readonly value="${esc(link)}"><button class="btn" type="button" id="rs-copy">Copy</button><a class="btn" href="#book.${esc(s.company.slug)}">Open</a></div>
              <span class="hint">Link to this from your website, or embed it as a booking widget.</span></div>
          </div>
          <div class="panel stack"><h2>Rates</h2>
            <div class="grid3">${num('base', 'Base fare ($)')}${num('perMile', 'Per mile ($)')}${num('minFare', 'Minimum fare ($)')}
              ${num('hourly', 'Hourly rate ($)')}${num('minHours', 'Minimum hours', 1)}${num('airportFlat', 'Airport flat rate ($)')}
              ${num('gratuityPct', 'Gratuity (%)', 0.5)}${num('taxPct', 'Tax (%)', 0.1)}${num('waitPerMin', 'Wait time per minute ($)')}</div>
            <h3 style="margin-top:6px">Vehicle multipliers</h3><p class="small muted">Rates above are for a sedan. Each vehicle type multiplies them.</p>
            <div class="grid3">${C.VEHICLE_TYPES.map((t) => `<label class="field"><span>${t}</span><input id="rs-m-${t.replace(/\W/g, '')}" data-mult="${t}" type="number" min="0.1" step="0.05" value="${r.multipliers[t]}" ${ro}></label>`).join('')}</div>
            <h3 style="margin-top:6px">Suitcases per vehicle</h3><p class="small muted">Customers see this when they choose a vehicle, and can't book more suitcases than fit.</p>
            <div class="grid3">${C.VEHICLE_TYPES.map((t) => `<label class="field"><span>${t}</span><input data-bags="${t}" type="number" min="0" max="40" step="1" value="${s.company.bags[t]}" ${ro}></label>`).join('')}</div>
          </div>
          <div class="panel stack"><h2>Cancellation, waiting and no-shows</h2><p class="small muted">Shown to customers when they book and on their trips.</p>
            <div class="grid2">
              <label class="field"><span>Free cancellation until (hours before pickup)</span><input name="pol_cancelHours" type="number" min="0" max="168" value="${s.company.policy.cancelHours}" ${ro}></label>
              <label class="field"><span>Late cancellation fee (% of fare)</span><input name="pol_cancelFeePct" type="number" min="0" max="100" value="${s.company.policy.cancelFeePct}" ${ro}></label>
              <label class="field"><span>Free waiting at airports (minutes after landing)</span><input name="pol_waitAirport" type="number" min="0" max="180" value="${s.company.policy.waitAirport}" ${ro}></label>
              <label class="field"><span>Free waiting elsewhere (minutes)</span><input name="pol_waitOther" type="number" min="0" max="120" value="${s.company.policy.waitOther}" ${ro}></label>
              <label class="field"><span>No-show fee (% of fare)</span><input name="pol_noShowFeePct" type="number" min="0" max="100" value="${s.company.policy.noShowFeePct}" ${ro}></label>
              <label class="field"><span>Charge the card (hours before pickup)</span><input name="pol_chargeHours" type="number" min="0" max="168" value="${s.company.policy.chargeHours}" ${ro}></label>
            </div><p class="small faint">After the free time, waiting is charged at the wait time rate above. Once it runs out, the driver can mark the passenger a no-show. Customers save a card when they book (no deposit): the fare goes on it this many hours before pickup, extras like waiting time or added stops 30 minutes after drop-off, and a cancellation keeps any fee and refunds the rest.</p>
          </div>
          <div class="panel stack"><h2>Booking terms</h2><p class="small muted">Optional. When filled in, customers must tick "I agree" before they book online or accept a quote, and each trip records the version they agreed to.</p>
            <label class="field"><span>Your terms and conditions</span><textarea name="terms" rows="6" maxlength="6000" placeholder="For example: no smoking; a cleaning fee of $250 applies to spills; children under 8 need a car seat." ${ro}>${esc(s.company.terms || '')}</textarea></label></div>
          <div class="panel stack" id="rs-cards"><h2>Card payments</h2>${cardsPanel(s.company)}</div>
          <div id="rs-err"></div>
          ${isAdmin ? '<div class="savebar"><button class="btn primary" type="submit">Save rates and brand</button></div>' : ''}
        </form>`;
      const sc = $('#rs-stripe', v);
      if (sc) sc.onclick = () => busy(sc, async () => { try { const r = await payApi('connect'); location.href = r.url; await new Promise(() => {}); } catch (err) { toast(err.message, true); } });
      $('#rs-copy', v).onclick = async () => {
        const inp = $('#rs-link', v);
        try { await navigator.clipboard.writeText(inp.value); toast('Link copied.'); } catch (e) { inp.select(); toast('Press Ctrl+C or ⌘C to copy.'); }
      };
      $('#rs', v).onsubmit = async (e) => {
        e.preventDefault();
        const f = formData(e.target);
        const rates = { multipliers: {} };
        for (const k of ['base', 'perMile', 'minFare', 'hourly', 'minHours', 'airportFlat', 'gratuityPct', 'taxPct', 'waitPerMin']) rates[k] = f[k];
        $$('[data-mult]', v).forEach((i) => { rates.multipliers[i.dataset.mult] = i.value; });
        rates.bags = {}; $$('[data-bags]', v).forEach((i) => { rates.bags[i.dataset.bags] = i.value; });
        const policy = { cancelHours: f.pol_cancelHours, cancelFeePct: f.pol_cancelFeePct, waitAirport: f.pol_waitAirport, waitOther: f.pol_waitOther, noShowFeePct: f.pol_noShowFeePct, chargeHours: f.pol_chargeHours };
        await busy($('button[type=submit]', e.target), async () => {
          try {
            const res = await api('dispatch.saveSettings', { name: f.name, color: f.color, tagline: f.tagline, phone: f.phone, email: f.email, rates, policy, terms: f.terms });
            setSession({ ...session, company: { ...session.company, ...res.company } });
            toast('Saved.'); draw();
          } catch (err) { showErr($('#rs-err', v), err); }
        });
      };
    }

    function cardsPanel(c) {
      if (c.payMode === 'demo') return '<p class="muted">Card payments are simulated on this copy. Customers pay with a pretend card and nothing is charged.</p>';
      if (c.payMode === 'off') return `<p class="muted">Online card payments are off until the platform owner adds Stripe. Customers pay the chauffeur, or you bill company accounts.</p>`;
      const st = c.stripe;
      if (st && st.ready) return `<p><span class="pill s-on_board">Connected</span> Card payments go to your own Stripe account and from there to your bank.</p><div><a class="btn" href="https://dashboard.stripe.com" target="_blank" rel="noopener">Open Stripe</a></div>`;
      if (!isAdmin) return '<p class="muted">Not set up yet. The company admin can connect Stripe here.</p>';
      return `<p class="muted">${st ? 'Stripe still needs a few details before customers can pay by card.' : 'Connect a Stripe account so customers save a card when they book and every charge goes straight to your bank. Stripe charges its own card fees; we take nothing.'}</p>
        <div><button class="btn primary" type="button" id="rs-stripe">${st ? 'Finish Stripe setup' : 'Connect Stripe'}</button></div>`;
    }

    async function drawTeam(v) {
      current = { poll: false };
      let team, perms;
      try { [team, perms] = await Promise.all([api('dispatch.team'), api('dispatch.staffPerms')]); } catch (e) { return showErr(v, e); }
      const level = (p) => p.role === 'admin' ? 'admin' : perms.every((x) => !p.perms[x.key]) ? 'view' : 'dispatcher';
      const levelText = (p) => {
        const l = level(p);
        if (l === 'admin') return '<b>Admin</b><div class="small faint">Everything, including rates, pricing and the team</div>';
        if (l === 'view') return '<b>View only</b><div class="small faint">Sees the board and trips, can’t change anything</div>';
        const on = perms.filter((x) => p.perms[x.key]), off = perms.filter((x) => !p.perms[x.key]);
        const std = perms.every((x) => !!p.perms[x.key] === x.on);
        return `<b>Dispatcher${std ? '' : ' (custom)'}</b><div class="small faint">${off.length ? 'No ' + off.map((x) => x.label.toLowerCase()).join(', no ') : 'Everything except rates, pricing and the team'}</div>`;
      };
      v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Team</h1><p class="muted">Office staff who can use the dispatch board, and what each one is allowed to do.</p></div><button class="btn primary" type="button" id="tm-add">Add office staff</button></div>
        <div class="tablewrap"><table id="tm-table"><thead><tr><th>Name</th><th>Email (login)</th><th>Access level</th><th>Login</th></tr></thead><tbody>
        ${team.map((p) => `<tr class="click" data-id="${p.id}"><td><b>${esc(p.name)}</b></td><td class="mono small" data-label="Email">${esc(p.email)}</td><td data-label="Access level" style="min-width:220px">${levelText(p)}</td><td data-label="Login">${p.active ? '<span class="pill s-on_board">Enabled</span>' : '<span class="pill off">Disabled</span>'}</td></tr>`).join('')}
        </tbody></table></div>
        <details class="panel" style="margin-top:16px"><summary><b>What each access level can do</b></summary>
          <ul class="small" style="margin:10px 0 0;padding-left:18px">
            <li><b>Admin</b>: everything, including rates, pricing, brand, texts plan, agent commission and this Team page.</li>
            <li><b>Dispatcher</b>: you pick from the list below. New dispatchers start with everything ticked except reports.</li>
            <li><b>View only</b>: sees the board, trips, calendar, quotes and flights. Can’t book, assign or change anything.</li>
          </ul>
          <ul class="small muted" style="margin:8px 0 0;padding-left:18px">${perms.map((x) => `<li>${esc(x.label)}${x.on ? '' : ' <span class="faint">(off for new dispatchers)</span>'}</li>`).join('')}</ul></details>`;
      const accessHtml = (p) => {
        const l = p ? level(p) : 'dispatcher', has = (k, d) => p ? !!p.perms[k] : d;
        return `<label class="field"><span>Access level</span><select id="pm-level">
            <option value="admin" ${l === 'admin' ? 'selected' : ''}>Admin: everything</option>
            <option value="dispatcher" ${l === 'dispatcher' ? 'selected' : ''}>Dispatcher: choose below</option>
            <option value="view" ${l === 'view' ? 'selected' : ''}>View only</option></select></label>
          <fieldset class="fs" id="pm-perms" ${l === 'dispatcher' ? '' : 'hidden'}><legend>This dispatcher can</legend>
            ${perms.map((x) => `<label class="check"><input type="checkbox" data-perm="${x.key}" ${has(x.key, x.on) ? 'checked' : ''}><span>${esc(x.label)}</span></label>`).join('')}</fieldset>`;
      };
      const setup = (m) => {
        const sel = $('#pm-level', m);
        sel.onchange = () => {
          $('#pm-perms', m).hidden = sel.value !== 'dispatcher';
          // Coming from View only: start from the standard ticks.
          const boxes = $$('[data-perm]', m);
          if (sel.value === 'dispatcher' && !boxes.some((c) => c.checked)) boxes.forEach((c) => { c.checked = perms.find((x) => x.key === c.dataset.perm).on; });
        };
      };
      const collect = (m) => {
        const l = $('#pm-level', m).value, perms2 = {};
        $$('[data-perm]', m).forEach((c) => { perms2[c.dataset.perm] = l === 'dispatcher' && c.checked; });
        return { role: l === 'admin' ? 'admin' : 'dispatcher', perms: perms2 };
      };
      $('#tm-add', v).onclick = () => personModal({ title: 'Add office staff', person: null, method: 'dispatch.saveStaff', role: 'dispatcher', extra: accessHtml(null), setup, collect, done: () => drawTeam(v) });
      $$('tr[data-id]', v).forEach((r) => { r.onclick = () => { const p = team.find((x) => x.id === r.dataset.id); personModal({ title: `Edit ${p.name}`, person: p, method: 'dispatch.saveStaff', role: p.role, extra: p.id === session.user.id ? '<p class="small muted">You can’t change your own access level.</p>' : accessHtml(p), setup: p.id === session.user.id ? null : setup, collect: p.id === session.user.id ? null : collect, done: () => drawTeam(v) }); }; });
    }

    draw();
  }

  // ---- Platform owner -------------------------------------------------------
  function viewOwner() {
    let tab = 'companies';
    const draw = () => {
      const v = shell({ tabs: [{ key: 'companies', label: 'Companies' }, { key: 'billing', label: 'Billing' }, { key: 'connections', label: 'Connections' }], active: tab, onTab: (t) => { tab = t; draw(); } });
      ({ companies: drawCompanies, billing: drawBilling, connections: drawConnections })[tab](v);
    };
    // Which outside services are real. Keys live in the host's settings, never here.
    async function drawConnections(v) {
      current = { poll: false };
      let st;
      if (DEMO) st = { demo: true, sms: { service: 'Twilio' }, email: { service: 'Resend' }, cards: { service: 'Stripe' }, maps: { service: 'Google Maps' }, flights: { service: 'FlightAware AeroAPI' } };
      else { try { st = await api('owner.connections'); } catch (e) { return showErr(v, e); } }
      const rows = [
        ['sms', 'Texts to passengers and drivers', 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM', (x) => x.from ? `From ${esc(x.from)}` : ''],
        ['email', 'Emails: confirmations, receipts, quotes, invoices', 'RESEND_API_KEY, EMAIL_FROM', (x) => x.from ? `From ${esc(x.from)}` : ''],
        ['cards', 'Card payments (cards on file)', 'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET', (x) => x.mode ? `${x.mode === 'live' ? 'Live mode, real charges' : 'Test mode, no real charges'}${x.webhook ? ' · webhook on' : ''}` : ''],
        ['maps', 'Real distances, drive times and address search', 'GOOGLE_MAPS_API_KEY', (x) => x.on ? `${x.routes} routes saved` : ''],
        ['flights', 'Live flight status and delays', 'FLIGHTAWARE_API_KEY', (x) => x.on ? `${x.tracked} flights checked` : ''],
      ];
      v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Connections</h1><p class="muted">${st.demo ? 'This demo runs in your browser, so every service is simulated.' : 'Each service switches on when its key is added in your host’s settings (Render, Environment). Keys are never shown here.'}</p></div></div>
        <div class="tablewrap"><table><thead><tr><th>Service</th><th>Used for</th><th>Status</th><th>Settings to add</th></tr></thead><tbody>
        ${rows.map(([k, label, keys, more]) => { const x = st[k] || {}; return `<tr><td><b>${esc(x.service || k)}</b></td><td>${label}</td><td>${x.on ? '<span class="pill s-on_board">On</span>' : '<span class="pill s-confirmed">Simulated</span>'}${more(x) ? `<div class="small faint">${more(x)}</div>` : ''}</td><td class="mono small">${keys}</td></tr>`; }).join('')}
        </tbody></table></div>
        <p class="small faint" style="margin-top:12px">Step-by-step setup for each one is in DEPLOY.md, under “Switching on real services”.</p>`;
    }

    async function drawCompanies(v) {
      let last = '', plans = null;
      async function refresh(silent) {
        let list, invoices, leads;
        try { [list, invoices, plans, leads] = await Promise.all([api('owner.companies'), api('owner.invoices'), api('owner.plans'), api('owner.leads')]); } catch (e) { if (!silent) showErr(v, e); return; }
        const sig = JSON.stringify([list, invoices, plans, leads]); if (sig === last) return; last = sig;
        const active = list.filter((c) => c.status === 'active');
        const mrr = active.filter((c) => !c.inTrial).reduce((s, c) => s + c.monthlyEquivalent, 0);
        const trials = active.filter((c) => c.inTrial).length;
        const open = invoices.filter((i) => i.status === 'open').reduce((s, i) => s + i.total, 0);
        v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Companies on ${PLATFORM}</h1><p class="muted">Every limo company you host. Each one has its own logins, booking page, fleet and customers.</p></div>
            <button class="btn primary" type="button" id="co-add">Add company</button></div>
          <div class="tiles" style="margin-bottom:20px">
            <div class="tile"><span class="label">Active companies</span><b>${active.length}</b></div>
            <div class="tile"><span class="label">Monthly subscriptions</span><b>${money0(mrr)}</b>${trials ? `<span class="small faint">${trials} on free trial</span>` : ''}</div>
            <div class="tile"><span class="label">Founding places left</span><b>${plans.foundingLeft}</b><span class="small faint">of ${plans.plans.founding.limit}</span></div>
            <div class="tile"><span class="label">Trips booked this month</span><b>${list.reduce((s, c) => s + c.tripsMonth, 0)}</b></div>
            <div class="tile"><span class="label">Unpaid invoices</span><b>${money0(open)}</b></div>
          </div>
          ${leads.length ? `<details class="panel" id="co-leads" style="margin-bottom:20px" ${leads.some((l) => l.status === 'new') ? 'open' : ''}><summary><b>Free-trial requests</b> <span class="pill ${leads.some((l) => l.status === 'new') ? 's-assigned' : 'off'} count">${leads.filter((l) => l.status === 'new').length} new</span> <span class="small faint">from the home page. Add the company when you have spoken to them.</span></summary>
            <div class="tablewrap" style="margin-top:12px"><table><thead><tr><th>Received</th><th>Name and company</th><th>Contact</th><th>City</th><th>Fleet</th><th>Note</th><th>Status</th><th></th></tr></thead><tbody>
            ${leads.map((l) => `<tr><td class="mono small nowrap">${esc(fmtDT(l.at))}</td><td data-label="Name and company"><b>${esc(l.name)}</b><br><span class="small">${esc(l.company)}</span></td>
              <td data-label="Contact" class="small"><a href="mailto:${esc(l.email)}">${esc(l.email)}</a>${l.phone ? `<br><a href="tel:${esc(l.phone)}">${esc(l.phone)}</a>` : ''}</td><td data-label="City" class="small">${esc(l.city || '')}</td><td data-label="Fleet" class="small">${esc(l.fleet || '')}</td><td data-label="Note" class="small" style="max-width:260px">${esc(l.note || '')}</td>
              <td data-label="Status"><select class="input" style="width:auto;min-height:32px;padding:3px 6px" data-lead="${l.id}" aria-label="Status">${[['new', 'New'], ['contacted', 'Contacted'], ['signed', 'Signed up']].map(([k, t]) => `<option value="${k}" ${l.status === k ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
              <td><button class="linkbtn small" type="button" data-rmlead="${l.id}">Remove</button></td></tr>`).join('')}
            </tbody></table></div></details>` : ''}
          <div class="tablewrap"><table><thead><tr><th>Company</th><th>Admin login</th><th>Plan</th><th class="r">Fee</th><th class="r">Drivers</th><th class="r">Vehicles</th><th class="r">Trips this month</th><th class="r">Booked this month</th><th>Texts this month</th><th>Status</th><th></th></tr></thead><tbody>
          ${list.map((c) => `<tr><td><div class="row" style="flex-wrap:nowrap"><span class="avatar" style="background:${esc(c.color)};color:#fff;border:0">${esc(initials(c.name))}</span><div><b>${esc(c.name)}</b><br><a class="small mono" href="#book.${esc(c.slug)}">#book.${esc(c.slug)}</a></div></div></td>
            <td class="mono small">${esc(c.adminEmail)}</td>
            <td class="nowrap"><select class="input" style="width:auto;min-height:32px;padding:3px 6px" data-plan="${c.id}" aria-label="Plan">${Object.entries(C.PLANS).map(([k, p]) => `<option value="${k}" ${c.plan === k ? 'selected' : ''}>${p.label}</option>`).join('')}</select>
              <select class="input" style="width:auto;min-height:32px;padding:3px 6px" data-billing="${c.id}" aria-label="Billing"><option value="monthly" ${c.billing === 'monthly' ? 'selected' : ''}>Monthly</option><option value="yearly" ${c.billing === 'yearly' ? 'selected' : ''}>Yearly</option></select></td>
            <td class="r num nowrap">${c.billing === 'yearly' ? `${money(c.yearlyFee)}/yr` : `${money(c.monthlyFee)}/mo`}${c.inTrial ? `<div class="small faint">Trial until ${esc(fmtYMD(c.trialEnds))}</div>` : c.priceLockedUntil ? `<div class="small faint">Locked until ${esc(fmtYMD(c.priceLockedUntil))}</div>` : c.paidThrough ? `<div class="small faint">Paid through ${esc(c.paidThrough)}</div>` : ''}</td><td class="r num">${c.drivers}</td><td class="r num">${c.vehicles}</td><td class="r num">${c.tripsMonth}</td><td class="r num">${money0(c.bookedMonth)}</td>
            <td class="nowrap"><button class="linkbtn num" type="button" data-texts="${c.id}">${c.texts.used} / ${c.texts.included}${c.texts.custom ? '*' : ''}</button>${c.texts.out ? ' <span class="pill s-cancelled">Out</span>' : c.texts.low ? ' <span class="pill unpaid">Low</span>' : ''}${c.texts.credits ? `<div class="small faint">+${c.texts.credits} bought</div>` : ''}</td>
            <td>${c.status === 'active' ? '<span class="pill s-on_board">Active</span>' : '<span class="pill s-cancelled">Paused</span>'}</td>
            <td><button class="btn sm" type="button" data-status="${c.id}" data-to="${c.status === 'active' ? 'suspended' : 'active'}">${c.status === 'active' ? 'Pause' : 'Resume'}</button></td></tr>`).join('')}
          </tbody></table></div>
          <p class="small faint" style="margin-top:10px">Pausing a company signs out its staff, drivers and customers and closes its booking page until you resume it.</p>`;
        $('#co-add', v).onclick = addCompany;
        $$('[data-lead]', v).forEach((el) => { el.onchange = async () => { try { await api('owner.leadAction', { id: el.dataset.lead, action: el.value }); last = ''; refresh(); } catch (e) { toast(e.message, true); } }; });
        $$('[data-rmlead]', v).forEach((el) => { el.onclick = async () => { if (!confirm('Remove this request?')) return; try { await api('owner.leadAction', { id: el.dataset.rmlead, action: 'delete' }); last = ''; refresh(); } catch (e) { toast(e.message, true); } }; });
        $$('[data-texts]', v).forEach((b) => { b.onclick = () => textsModal(list.find((c) => c.id === b.dataset.texts)); });
        $$('[data-plan]', v).forEach((s) => { s.onchange = async () => { try { await api('owner.updateCompany', { id: s.dataset.plan, plan: s.value }); toast('Plan changed.'); } catch (e) { toast(e.message, true); } last = ''; refresh(); }; });
        $$('[data-billing]', v).forEach((s) => { s.onchange = async () => { try { await api('owner.updateCompany', { id: s.dataset.billing, billing: s.value }); toast(s.value === 'yearly' ? 'Now billed yearly: 12 months for the price of 10.' : 'Now billed monthly.'); } catch (e) { toast(e.message, true); } last = ''; refresh(); }; });
        $$('[data-status]', v).forEach((b) => { b.onclick = () => busy(b, async () => { try { await api('owner.updateCompany', { id: b.dataset.status, status: b.dataset.to }); toast(b.dataset.to === 'active' ? 'Company resumed.' : 'Company paused.'); last = ''; refresh(); } catch (e) { toast(e.message, true); } }); });
      }
      // Owner: change one company's monthly texts, or give it free texts.
      async function textsModal(c) {
        let plan; try { plan = await api('owner.textPlan'); } catch (e) { return toast(e.message, true); }
        const t = c.texts;
        const m = openModal({
          title: `Texts: ${c.name}`,
          body: `<form id="ot" class="stack" novalidate>
            <p class="muted">${t.used} texts used this month${t.fromPacks ? ` (${t.fromPacks} from bought packs)` : ''}, ${t.credits} bought texts left${t.held ? `, ${t.held} not sent while out` : ''}.</p>
            <label class="field"><span>Texts included each month</span><input id="ot-inc" name="textsIncluded" type="number" min="0" value="${t.custom ? t.included : ''}" placeholder="${plan.plans[c.plan] != null ? plan.plans[c.plan] : plan.included} (plan default)"><span class="hint">Leave blank to use the ${esc(c.planLabel)} plan's ${plan.plans[c.plan] != null ? plan.plans[c.plan] : plan.included}.</span></label>
            <label class="field"><span>Give free texts</span><select id="ot-gift" name="giftPacks"><option value="">None</option>${[1, 2, 4].map((n) => `<option value="${n}">${n * plan.packSize} texts, no charge</option>`).join('')}</select></label>
            <div id="ot-err"></div></form>`,
          footer: `<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="ot-save">Save</button>`,
        });
        $('[data-close]', m).onclick = closeModal;
        $('#ot-save', m).onclick = (e) => busy(e.currentTarget, async () => {
          const f = formData($('#ot', m));
          try { await api('owner.updateCompany', { id: c.id, textsIncluded: f.textsIncluded, ...(f.giftPacks ? { giftPacks: f.giftPacks } : {}) }); closeModal(); toast('Texts updated.'); last = ''; refresh(); } catch (err) { showErr($('#ot-err', m), err); }
        });
      }
      function addCompany() {
        const m = openModal({
          title: 'Add a limo company',
          body: `<form id="ac" class="stack" novalidate>
            <div class="grid2"><label class="field"><span>Company name</span><input id="ac-name" name="name" placeholder="Gold Coast Limousine"></label>
              <label class="field"><span>Booking link name</span><input id="ac-slug" name="slug" class="mono" placeholder="gold-coast"><span class="hint">Their page: #book.<span id="ac-slug-show">…</span></span></label></div>
            <div class="grid2"><label class="field"><span>Plan</span><select id="ac-plan" name="plan">${Object.entries(C.PLANS).map(([k, p]) => `<option value="${k}" ${k === 'standard' ? 'selected' : ''} ${k === 'founding' && plans.foundingLeft <= 0 ? 'disabled' : ''}>${p.label}: $${p.monthly}/mo, ${p.setup ? `$${p.setup} setup` : 'no setup fee'}, ${plans.texts[k]} texts${k === 'founding' ? ` (${plans.foundingLeft} places left)` : ''}</option>`).join('')}</select></label>
              <label class="field"><span>Billing</span><select id="ac-billing" name="billing"><option value="monthly">Monthly</option><option value="yearly">Yearly: 12 months for the price of 10, no setup fee</option></select></label></div>
            <label class="switch"><input type="checkbox" id="ac-trial" name="trial" checked><span>Start with a ${plans.trialDays}-day free trial (nothing billed until it ends)</span></label>
            <p class="small faint">Every plan includes dispatch, the driver app and the passenger app. Founding is for the first ${plans.plans.founding.limit} companies, with the price locked for 2 years.</p>
            <div class="grid2">
              <label class="field"><span>Brand color</span><input id="ac-color" name="color" type="color" value="#2b4a7e" style="padding:4px;height:40px"></label>
              <label class="field"><span>Phone</span><input id="ac-phone" name="phone" type="tel"></label></div>
            <h3>Their admin login</h3>
            <div class="grid2"><label class="field"><span>Admin name</span><input id="ac-aname" name="adminName"></label>
              <label class="field"><span>Admin email</span><input id="ac-aemail" name="adminEmail" type="email"></label></div>
            <label class="field"><span>Temporary password</span><input id="ac-apass" name="adminPassword" type="text" autocomplete="new-password" placeholder="At least 8 characters"><span class="hint">Share it with them; they can add drivers, vehicles and dispatchers after signing in.</span></label>
            <div id="ac-err"></div></form>`,
          footer: `<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="ac-save">Create company</button>`,
        });
        const name = $('#ac-name', m), slug = $('#ac-slug', m);
        const show = () => { $('#ac-slug-show', m).textContent = (slug.value || name.value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || '…'; };
        name.oninput = show; slug.oninput = show;
        $('[data-close]', m).onclick = closeModal;
        $('#ac-save', m).onclick = (e) => busy(e.currentTarget, async () => {
          try { const c = await api('owner.createCompany', formData($('#ac', m))); closeModal(); toast(`${c.name} is set up. Their admin can sign in now.`); last = ''; refresh(); } catch (err) { showErr($('#ac-err', m), err); }
        });
      }
      current = { poll: true, refresh };
      v.innerHTML = '<p class="faint">Loading…</p>';
      refresh();
    }
    async function drawBilling(v) {
      current = { poll: false };
      let invoices, tp;
      try { [invoices, tp] = await Promise.all([api('owner.invoices'), api('owner.textPlan')]); } catch (e) { return showErr(v, e); }
      const month = new Date().toISOString().slice(0, 7);
      v.innerHTML = `<div class="pagehead"><div class="stack" style="gap:4px"><h1>Billing</h1><p class="muted">Monthly invoices to each company for their plan, plus the setup fee on their first bill. Yearly companies get one invoice a year for 10 months (no setup fee). Companies on a free trial are skipped until it ends.</p></div>
          <div class="row"><input class="input" type="month" id="bl-month" value="${month}" style="width:auto"><button class="btn primary" type="button" id="bl-run">Create invoices for ${esc(new Date(month + '-15T12:00:00').toLocaleDateString([], { month: 'long', year: 'numeric' }))}</button></div></div>
        <p class="note" style="margin-bottom:16px">Invoices are tracked here for now. Connecting Stripe Billing charges each company's card automatically. Text packs a company buys go on its next invoice.</p>
        <form class="panel stack" id="tp-form" style="margin-bottom:16px" novalidate><h2>Texts for every company</h2>
          <div class="grid3">${Object.entries(C.PLANS).map(([k, p]) => `<label class="field"><span>${esc(p.label)} plan, texts a month</span><input class="input" type="number" name="plan_${k}" min="0" value="${tp.plans[k]}"></label>`).join('')}</div>
          <div class="grid3">
            <label class="field"><span>Texts in a pack</span><input class="input" type="number" name="packSize" min="50" value="${tp.packSize}"></label>
            <label class="field"><span>Pack price ($)</span><input class="input" type="number" name="packPrice" min="0" step="0.01" value="${tp.packPrice}"></label>
            <label class="field"><span>Warn at (% used)</span><input class="input" type="number" name="warnPct" min="50" max="99" value="${tp.warnPct}"></label></div>
          <p class="small faint">Emails are unlimited. A company can have its own monthly number; set it from the Texts column on Companies.</p>
          <div id="tp-err"></div><div><button class="btn" type="submit">Save texts</button></div></form>
        <div class="tablewrap"><table><thead><tr><th>Invoice</th><th>Company</th><th>Period</th><th>Items</th><th class="r">Total</th><th>Status</th><th></th></tr></thead><tbody>
        ${invoices.map((i) => `<tr><td class="mono small">${esc(i.number)}</td><td>${esc(i.companyName)}</td><td class="mono small">${esc(i.period)}</td><td class="small">${i.items.map((x) => `${esc(x.label)}: ${money(x.amount)}`).join('<br>')}</td>
          <td class="r num">${money(i.total)}</td><td>${i.status === 'paid' ? '<span class="pill paid">Paid</span>' : '<span class="pill unpaid">Open</span>'}</td>
          <td><button class="btn sm" type="button" data-inv="${i.id}" data-paid="${i.status !== 'paid'}">${i.status === 'paid' ? 'Reopen' : 'Mark paid'}</button></td></tr>`).join('') || '<tr><td colspan="7" class="faint">No invoices yet.</td></tr>'}
        </tbody></table></div>`;
      $('#bl-month', v).onchange = (e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) $('#bl-run', v).textContent = `Create invoices for ${new Date(e.target.value + '-15T12:00:00').toLocaleDateString([], { month: 'long', year: 'numeric' })}`; };
      $('#bl-run', v).onclick = (e) => busy(e.currentTarget, async () => {
        try { const r = await api('owner.runBilling', { period: $('#bl-month', v).value }); toast(r.created ? `${r.created} invoice(s) created for ${r.period}.` : `Every active company already has an invoice for ${r.period}.`); drawBilling(v); } catch (err) { toast(err.message, true); }
      });
      $('#tp-form', v).onsubmit = (e) => { e.preventDefault(); busy($('button[type=submit]', e.target), async () => { const f = formData(e.target); const pl = {}; for (const k of Object.keys(C.PLANS)) { pl[k] = f['plan_' + k]; delete f['plan_' + k]; } try { await api('owner.saveTextPlan', { ...f, plans: pl }); toast('Text allowance saved.'); } catch (err) { showErr($('#tp-err', v), err); } }); };
      $$('[data-inv]', v).forEach((b) => { b.onclick = () => busy(b, async () => { try { await api('owner.markInvoice', { id: b.dataset.inv, paid: b.dataset.paid === 'true' }); drawBilling(v); } catch (err) { toast(err.message, true); } }); });
    }
    draw();
  }

  // ---- Boot -----------------------------------------------------------------
  (async function boot() {
    if (session) {
      try { const me = await api('auth.me'); setSession({ ...session, user: me.user, company: me.company }); }
      catch (e) { setSession(null); }
    }
    if (!session && DEMO && !location.hash) location.hash = 'signin';
    render();
    // Coming back from Stripe.
    const qs = new URLSearchParams(location.search);
    const back = qs.get('paid') ? [`Payment received for ${qs.get('paid')}. Thank you.`]
      : qs.get('cardsaved') ? [`Card saved for ${qs.get('cardsaved')}. Nothing is charged until shortly before pickup.`]
      : qs.get('payment') === 'cancelled' ? ['Payment cancelled. Nothing was charged.']
      : qs.get('payment') ? ['The payment did not go through. Nothing was charged.', true]
      : qs.get('stripe') === 'ready' ? ['Stripe is connected. Customers can now pay by card.']
      : qs.get('stripe') ? ['Stripe still needs a few details. Open Rates & brand to finish.', true] : null;
    if (back) { history.replaceState(null, '', location.pathname + location.hash); toast(back[0], back[1], 6000); }
  })();
})();
