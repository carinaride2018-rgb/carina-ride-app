#!/usr/bin/env node
/*
 * Livery server. No dependencies: Node 18+ only.
 *
 *   node server.js            # http://localhost:3000, with sample companies
 *   PORT=8080 DATA_FILE=/var/lib/livery/db.json node server.js
 *
 * For a real business, start with SAMPLE_DATA=off and OWNER_EMAIL /
 * OWNER_PASSWORD set: the first start creates only your owner login.
 * See .env.example and DEPLOY.md.
 *
 * Serves the web app from ./public and the API at POST /api/<method>.
 * Data is kept in one JSON file (DATA_FILE). That is fine for a first company
 * or two; move to Postgres before hosting many companies.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createCore, setProviders, normFlight } = require('./core.js');
const { createProviders } = require('./providers.js');
const { createWebPush } = require('./webpush.js');
const { createNativePush, isNative } = require('./nativepush.js');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const PUBLIC = path.join(__dirname, 'public');
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}/`;
const BLANK = /^(off|false|0|no)$/i.test(process.env.SAMPLE_DATA || '');
const TRUST_PROXY = /^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY || '');

// A real business must not start with an owner login nobody chose.
if (BLANK && !fs.existsSync(DATA_FILE)) {
  if (!process.env.OWNER_EMAIL || (process.env.OWNER_PASSWORD || '').length < 12) {
    console.error('SAMPLE_DATA=off needs OWNER_EMAIL and an OWNER_PASSWORD of at least 12 characters for the first start.');
    process.exit(1);
  }
}

// Texts, email, card payments, maps and flights: real when their keys are set.
const live = createProviders(process.env);
if (live.on.maps) {
  live.loadRoutes(path.join(path.dirname(DATA_FILE), 'routes.json'));
  setProviders({ route: live.route, places: live.places, geo: live.geo });
}
if (live.on.flights) setProviders({ flight: live.flightHook });

// Phone notifications that arrive with the app closed. Free, no account needed.
const push = process.env.WEB_PUSH === 'off' ? null : createWebPush(process.env, path.join(path.dirname(DATA_FILE), 'vapid.json'));
// The App Store and Google Play apps: Apple and Google notifications (null until their keys are set).
const nativePush = createNativePush(process.env);

const core = createCore({
  pushKey: push ? push.publicKey : '',
  nativePush: nativePush ? nativePush.ready : null,
  mapsKey: live.mapsKey,
  publicUrl: PUBLIC_URL,
  blank: BLANK,
  // Sample data keeps pretend card payments; a real site without Stripe has none.
  payMode: live.on.cards ? 'stripe' : BLANK ? 'off' : 'demo',
  live: { ...live.on },
  owner: { name: process.env.OWNER_NAME, email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD },
  load() {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { return null; }
  },
  save(db) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  },
  hash: (pw, salt) => new Promise((resolve, reject) => {
    crypto.scrypt(pw, salt, 32, (err, key) => (err ? reject(err) : resolve(key.toString('hex'))));
  }),
  randomId: (n) => crypto.randomBytes(n || 16).toString('hex'),
});

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  ...(PUBLIC_URL.startsWith('https:') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
};

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Install details for the phone app. With ?c=<slug> it carries the limo
// company's name and colour and opens on its booking page.
async function serveManifest(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const slug = q.get('c');
  // Drivers and office staff open on their own screen, passengers on the booking page.
  const staff = q.get('r') && q.get('r') !== 'customer';
  let co = null;
  if (slug) { try { co = await core.call(null, 'public.company', { slug }); } catch (e) { co = null; } }
  const name = co ? (co.company || co).name + (q.get('r') === 'driver' ? ' Driver' : q.get('r') === 'staff' ? ' Dispatch' : '') : 'Livery';
  const color = co ? (co.company || co).color || '#15171c' : '#15171c';
  send(res, 200, {
    name, short_name: name.length > 14 ? name.split(' ')[0] : name, description: co ? `Book and track rides with ${name}` : 'Limousine booking and dispatch',
    id: co ? `/?c=${slug}${staff ? '&r=staff' : ''}` : '/', start_url: co && !staff ? `/?source=app#book.${slug}` : '/?source=app', scope: '/', display: 'standalone', orientation: 'portrait',
    background_color: '#f4f5f7', theme_color: color,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, 'application/manifest+json');
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/manifest.webmanifest') return serveManifest(req, res);
  if (rel === '/') rel = '/index.html';
  const file = rel === '/core.js' ? path.join(__dirname, 'core.js') : path.join(PUBLIC, path.normalize(rel));
  if (rel !== '/core.js' && !file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

// Simple per-IP limit on sign-in attempts.
const attempts = new Map();
function limited(ip) {
  const nowMs = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => nowMs - t < 10 * 60000);
  list.push(nowMs); attempts.set(ip, list);
  return list.length > 30;
}

// Hosts put the app behind a proxy; only then is X-Forwarded-For the visitor.
const clientIp = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
const LIMITED = new Set(['auth.login', 'auth.signup', 'public.requestQuote', 'public.acceptQuote', 'public.rate']);

// ---- Outside services ---------------------------------------------------------

// Sends whatever texts and emails the last action created. One run at a time;
// a run asked for while one is going happens straight after it.
let flushing = null, flushAgain = false;
function flushOutbox() {
  if (flushing) { flushAgain = true; return flushing; }
  flushing = (async () => {
    do {
      flushAgain = false;
      const msgs = await core.outbox(15);
      const results = [];
      for (const m of msgs) results.push(await live.deliver(m));
      await core.delivered(results);
      if (push || nativePush) {
        const notes = await core.pushOutbox(), gone = [];
        for (const n of notes) {
          const r = isNative(n.endpoint) ? (nativePush ? await nativePush.send(n, n.payload) : 'skipped') : (push ? await push.send(n, n.payload) : 'skipped');
          if (r === 'gone') gone.push(n.endpoint);
        }
        if (gone.length) await core.pushGone(gone);
      }
    } while (flushAgain);
  })().catch((e) => console.error('outbox', e)).finally(() => { flushing = null; });
  return flushing;
}

// Fetches distances and flight times a request is about to need, so the
// answer uses real data. Gives up after a few seconds and lets core estimate.
function collect(obj, out, depth) {
  if (!obj || typeof obj !== 'object' || depth > 4) return;
  if (Array.isArray(obj)) { for (const x of obj) collect(x, out, depth + 1); return; }
  if (typeof obj.pickup === 'string' && typeof obj.dropoff === 'string') out.pairs.push(...legs(obj.pickup, obj.stopList, obj.dropoff));
  if (typeof obj.flight === 'string' && obj.flight.trim() && obj.pickupAt) out.flights.push({ code: normFlight(obj.flight), at: obj.pickupAt });
  for (const v of Object.values(obj)) if (v && typeof v === 'object') collect(v, out, depth + 1);
}
// Each leg of a ride: pickup, any stops, drop-off.
function legs(pickup, stops, dropoff) {
  const pts = [pickup, ...(Array.isArray(stops) ? stops.filter((x) => typeof x === 'string' && x.trim()) : []), dropoff];
  return pts.slice(1).map((p, i) => [pts[i], p]);
}
async function warmFor(args) {
  if (!live.on.maps && !live.on.flights) return;
  const out = { pairs: [], flights: [] };
  collect(args, out, 0);
  await Promise.all([
    live.on.maps && out.pairs.length ? live.warmRoutes(out.pairs, 4000) : null,
    live.on.flights && out.flights.length ? live.prefetchFlights(out.flights, 4000) : null,
  ]);
}

// ---- Card payments (Stripe Connect) -------------------------------------------
// Each limo company connects its own Stripe account; customers pay on Stripe's
// page and the money goes straight to that company.
const base = PUBLIC_URL.endsWith('/') ? PUBLIC_URL : PUBLIC_URL + '/';
function redirect(res, to) { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', ...SECURITY_HEADERS }); res.end(); }
const bearer = (req) => { const a = req.headers.authorization || ''; return a.startsWith('Bearer ') ? a.slice(7) : null; };

async function payRoute(req, res, url, raw) {
  const p = url.pathname;
  const fail = (e) => send(res, e.status && e.status < 500 ? e.status : 502, { ok: false, error: e.status && e.status < 500 && !e.data ? e.message : `Stripe: ${e.message}` });
  if (!live.on.cards && p !== '/pay/webhook') return send(res, 404, { ok: false, error: 'Card payments are not switched on.' });
  try {
    if (p === '/pay/checkout' && req.method === 'POST') {
      const args = raw ? JSON.parse(raw) : {};
      const what = await core.pay.prepare(bearer(req), args);
      const success = `${base}pay/return?s={CHECKOUT_SESSION_ID}&a=${encodeURIComponent(what.account)}`;
      const cancel = `${base}?payment=cancelled${what.back}`;
      const session = what.mode === 'setup' ? await live.pay.setup(what, success, cancel) : await live.pay.checkout(what, success, cancel);
      return send(res, 200, { ok: true, data: { url: session.url } });
    }
    if (p === '/pay/return' && req.method === 'GET') {
      const sid = url.searchParams.get('s'), acct = url.searchParams.get('a');
      if (!sid || !acct) return redirect(res, base);
      const session = await live.pay.getSession(sid, acct);
      if (session.mode === 'setup') {
        const card = session.status === 'complete' && live.pay.cardOf(session);
        if (!card) return redirect(res, `${base}?payment=unpaid`);
        const done = await core.pay.complete({ account: acct, sessionId: session.id, meta: session.metadata, setup: card });
        runCharges(); flushOutbox();
        return redirect(res, `${base}?cardsaved=${encodeURIComponent(done.ref)}${done.back}`);
      }
      if (session.payment_status !== 'paid') return redirect(res, `${base}?payment=unpaid`);
      const done = await core.pay.complete({ account: acct, sessionId: session.id, amount: session.amount_total, meta: session.metadata, last4: live.pay.last4(session) });
      flushOutbox();
      return redirect(res, `${base}?paid=${encodeURIComponent(done.ref)}${done.back}`);
    }
    if (p === '/pay/connect' && req.method === 'POST') {
      const c = await core.pay.company(bearer(req));
      let account = c.stripe && c.stripe.accountId;
      if (!account) { account = (await live.pay.createAccount(c)).id; await core.pay.setStripe(c.id, { accountId: account, ready: false }); }
      const link = await live.pay.onboardingLink(account, `${base}pay/connected?c=${encodeURIComponent(c.id)}`, `${base}pay/connected?c=${encodeURIComponent(c.id)}&again=1`);
      return send(res, 200, { ok: true, data: { url: link.url } });
    }
    if (p === '/pay/connected' && req.method === 'GET') {
      // Stripe sends the admin back here. The account's own state decides.
      const cid = url.searchParams.get('c');
      const c = cid && await core.pay.setStripe(cid, {});
      if (!c || !c.accountId) return redirect(res, base);
      const acct = await live.pay.getAccount(c.accountId);
      await core.pay.setStripe(cid, { ready: !!acct.charges_enabled, detailsSubmitted: !!acct.details_submitted });
      return redirect(res, `${base}?stripe=${acct.charges_enabled ? 'ready' : 'pending'}`);
    }
    if (p === '/pay/webhook' && req.method === 'POST') {
      // Optional backup for customers who close the tab before returning.
      const evt = live.pay.verifyWebhook(raw, req.headers['stripe-signature']);
      if (!evt) return send(res, 400, { ok: false, error: 'Bad signature.' });
      const o = evt.data && evt.data.object;
      if (evt.type === 'checkout.session.completed' && o && o.mode === 'setup' && evt.account) {
        try { const full = await live.pay.getSession(o.id, evt.account); const card = live.pay.cardOf(full); if (card) { await core.pay.complete({ account: evt.account, sessionId: o.id, meta: full.metadata || {}, setup: card }); runCharges(); flushOutbox(); } } catch (e) { console.error('webhook', e.message); }
      }
      if (evt.type === 'checkout.session.completed' && o && o.payment_status === 'paid' && evt.account) {
        try { await core.pay.complete({ account: evt.account, sessionId: o.id, amount: o.amount_total, meta: o.metadata || {}, last4: '' }); flushOutbox(); } catch (e) { console.error('webhook', e.message); }
      }
      if (evt.type === 'account.updated' && o && o.metadata && o.metadata.livery_company) {
        try { await core.pay.setStripe(o.metadata.livery_company, { ready: !!o.charges_enabled, detailsSubmitted: !!o.details_submitted }); } catch (e) { console.error('webhook', e.message); }
      }
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false, error: 'Not found.' });
  } catch (e) {
    if (!e.status) console.error(e);
    if (req.method === 'GET') return redirect(res, `${base}?payment=error`);
    return fail(e);
  }
}

// Saved-card charges: the core queues them (fare 24 hours before pickup,
// extras after the ride, refunds on cancel) and this runs them on Stripe.
let charging = false, chargeAgain = false;
async function runCharges() {
  if (!live.on.cards) return;
  if (charging) { chargeAgain = true; return; }
  charging = true;
  try {
    do {
      chargeAgain = false;
      for (const x of await core.pay.pendingCharges()) {
        const r = await live.pay.charge(x);
        if (r.retry) { if (r.error) console.error(`card ${x.id}: ${r.error}, will retry`); continue; }
        await core.pay.chargeResult({ tripId: x.tripId, id: x.id, ...r });
      }
    } while (chargeAgain);
  } catch (e) { console.error('card charges', e.message); }
  charging = false;
  flushOutbox();
}

// The owner's Connections screen: which services are real. Never shows keys.
async function connections(token) {
  const me = await core.call(token, 'auth.me', {});
  if (me.user.role !== 'owner') { const e = new Error("Your login can't do that."); e.status = 403; throw e; }
  return { publicUrl: base, sample: !BLANK, ...live.status() };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return send(res, 200, { ok: true });
  if (url.pathname.startsWith('/pay/')) {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
    req.on('end', () => payRoute(req, res, url, Buffer.concat(chunks).toString('utf8')));
    return;
  }
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
    return serveStatic(req, res);
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' });
  const method = url.pathname.slice(5);
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > 1e6) { req.destroy(); } else chunks.push(c); });
  req.on('end', async () => {
    let args = {};
    try { args = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch (e) { return send(res, 400, { ok: false, error: 'Request body must be JSON.' }); }
    if (LIMITED.has(method) && limited(clientIp(req) + method)) {
      return send(res, 429, { ok: false, error: 'Too many attempts. Wait a few minutes and try again.' });
    }
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    try {
      if (method === 'owner.connections') return send(res, 200, { ok: true, data: await connections(token) });
      await warmFor(args);
      const data = await core.call(token, method, args);
      send(res, 200, { ok: true, data });
      flushOutbox();
      runCharges();
    } catch (e) {
      if (!e.status) console.error(e);
      send(res, e.status || 500, { ok: false, error: e.status ? e.message : 'Something went wrong on the server.' });
    }
  });
});

// Accept deadlines and driver reminders need a clock, not just requests.
setInterval(() => { core.tick().catch((e) => console.error('dispatch tick', e)).then(flushOutbox).then(runCharges); }, 30000).unref();
// Real flight times and distances for trips in the next day and a half.
if (live.on.flights || live.on.maps) {
  setInterval(async () => {
    try {
      const up = await core.upcoming(36);
      if (live.on.flights && await live.pollFlights(up)) await core.tick();
      if (live.on.maps) await live.warmGeo(up.flatMap((u) => [u.pickup, u.dropoff, ...u.stops]), 20000);
      if (live.on.maps) { await live.warmRoutes(up.filter((u) => u.dropoff).flatMap((u) => legs(u.pickup, u.stops, u.dropoff)), 20000); live.saveRoutes(); }
    } catch (e) { console.error('live data', e); }
  }, 60000).unref();
}
flushOutbox();

process.on('SIGTERM', () => server.close(() => process.exit(0)));

server.listen(PORT, () => {
  console.log(`Livery running at http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}${BLANK ? ' (no sample data)' : ''}`);
  const st = live.status();
  console.log('Connections: ' + Object.entries(st).map(([k, v]) => `${k} ${v.on ? 'on' : 'simulated'}`).join(', '));
});
