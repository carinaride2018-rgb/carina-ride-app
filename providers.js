/*
 * Real outside services for the Livery server.
 *
 * Each service switches on when its keys are set in the environment and
 * otherwise stays simulated, so the app runs the same with or without them:
 *
 *   Texts        Twilio            TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 *   Email        Resend            RESEND_API_KEY, EMAIL_FROM
 *   Card pay     Stripe Connect    STRIPE_SECRET_KEY (STRIPE_WEBHOOK_SECRET optional)
 *   Maps         Google Maps       GOOGLE_MAPS_API_KEY (Routes API + Places API (New))
 *   Flights      FlightAware       FLIGHTAWARE_API_KEY (AeroAPI)
 *
 * No dependencies: Node 18+ fetch only. core.js stays synchronous, so maps
 * and flight answers are fetched ahead of time and kept in small caches.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');

function createProviders(rawEnv, opts) {
  opts = opts || {};
  // Keys pasted into a host's settings often pick up spaces, quotes or a
  // "Bearer " prefix, which the services then reject as an invalid key.
  const env = {};
  for (const [k, v] of Object.entries(rawEnv || {})) {
    env[k] = typeof v === 'string' && /(_KEY|_TOKEN|_SID|_SECRET|_FROM)$/.test(k) ? v.trim().replace(/^(['"])(.*)\1$/, '$2').replace(/^Bearer\s+/i, '').trim() : v;
  }
  const log = opts.log || ((...a) => console.log(...a));
  // Base URLs can be pointed at a local fake for tests only.
  const url = (name, def) => env[`LIVERY_TEST_${name}_URL`] || def;
  const has = (...keys) => keys.every((k) => String(env[k] || '').trim());

  const on = {
    sms: has('TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'),
    email: has('RESEND_API_KEY', 'EMAIL_FROM'),
    cards: has('STRIPE_SECRET_KEY'),
    maps: has('GOOGLE_MAPS_API_KEY'),
    flights: has('FLIGHTAWARE_API_KEY'),
  };

  async function request(method, href, { headers, body, form, timeoutMs } = {}) {
    const h = { ...(headers || {}) };
    let payload;
    if (form) { payload = encodeForm(form); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    const res = await fetch(href, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs || 10000) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 300) }; }
    if (!res.ok) {
      const msg = (data && (data.message || (data.error && (data.error.message || data.error)) || data.detail || data.title)) || `HTTP ${res.status}`;
      const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)); err.status = res.status; err.data = data; throw err;
    }
    return data;
  }

  // ---- Texts and email --------------------------------------------------------

  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
  // US and Canada numbers become +1XXXXXXXXXX; others must be typed with +.
  function e164(s) {
    const raw = String(s || '').trim();
    const d = raw.replace(/\D/g, '');
    if (raw.startsWith('+') && d.length >= 8 && d.length <= 15) return '+' + d;
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d[0] === '1') return '+' + d;
    return null;
  }
  const fromAddress = () => { const m = String(env.EMAIL_FROM).match(/<([^>]+)>/); return (m ? m[1] : String(env.EMAIL_FROM)).trim(); };
  const SUBJECTS = { reminder: 'Ride reminder', quote: 'Your quote', invoice: 'Your invoice', login: 'Your LimoRelay login', reset: 'Reset your password', test: 'LimoRelay test email', signup: 'LimoRelay sign-up', approved: 'Your LimoRelay account is approved', declined: 'Your LimoRelay sign-up', planinvoice: 'Your LimoRelay invoice', billing: 'Your LimoRelay membership' };
  function subjectOf(m) {
    if (SUBJECTS[m.kind]) return `${SUBJECTS[m.kind]}${m.ref ? ' ' + m.ref : ''}`;
    const body = String(m.body || '').replace(new RegExp('^' + escapeRe(m.company.name) + ':\\s*'), '');
    const first = body.split(/(?<=[.!?])\s/)[0] || body;
    const sub = first.length > 78 ? first.slice(0, 75).replace(/\s+\S*$/, '') + '…' : first;
    return sub.charAt(0).toUpperCase() + sub.slice(1);
  }

  async function sendSms(to, body) {
    const sid = env.TWILIO_ACCOUNT_SID;
    const from = String(env.TWILIO_FROM).trim();
    const form = { To: to, Body: body };
    if (/^MG[0-9a-f]{32}$/i.test(from)) form.MessagingServiceSid = from; else form.From = from;
    const r = await request('POST', `${url('TWILIO', 'https://api.twilio.com')}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64') }, form,
    });
    return r && r.sid;
  }
  async function sendEmail(to, m) {
    const name = String(m.company.name || 'Bookings').replace(/["<>]/g, '');
    const r = await request('POST', `${url('RESEND', 'https://api.resend.com')}/emails`, {
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: { from: `${name} <${fromAddress()}>`, to: [to], subject: subjectOf(m), text: m.body, ...(isEmail(m.replyTo) ? { reply_to: m.replyTo } : isEmail(m.company.email) ? { reply_to: m.company.email } : {}) },
    });
    return r && r.id;
  }

  // Twilio signs each incoming-text request: HMAC-SHA1 of the full URL plus
  // every form field (sorted by name), keyed with the auth token.
  function verifyTwilio(signature, href, params) {
    if (!on.sms || !signature) return false;
    const data = href + Object.keys(params).sort().map((k) => k + params[k]).join('');
    const want = crypto.createHmac('sha1', String(env.TWILIO_AUTH_TOKEN)).update(data, 'utf8').digest('base64');
    const a = Buffer.from(want), b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // One outbox message -> { id, status: sent | failed | simulated | skipped, via, error }.
  // The address decides the channel: a driver with no phone gets an email.
  async function deliver(m) {
    const rcpt = String(m.recipient || '').trim();
    const phone = !isEmail(rcpt) && e164(rcpt);
    const channel = isEmail(rcpt) ? 'email' : phone ? 'sms' : null;
    if (!channel) return { id: m.id, status: 'skipped', error: 'No phone number or email address' };
    if (!on[channel]) return { id: m.id, status: 'simulated' };
    try {
      const via = channel === 'sms' ? await sendSms(phone, m.body) : await sendEmail(rcpt, m);
      return { id: m.id, status: 'sent', via: String(via || '') };
    } catch (e) {
      log(`${channel} to ${rcpt} failed: ${e.message}`);
      return { id: m.id, status: 'failed', error: e.message };
    }
  }

  // ---- Maps ------------------------------------------------------------------

  const ROUTE_TTL = 30 * 86400e3;
  const routes = new Map(); // "from|to" -> { miles, minutes, at } or { fail: at }
  const rkey = (a, b) => `${norm(a)}|${norm(b)}`;
  let routesFile = null, routesDirty = false;
  function loadRoutes(file) {
    routesFile = file;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(saved)) if (v && (v.miles != null || v.lat != null) && Date.now() - v.at < ROUTE_TTL) routes.set(k, v);
    } catch (e) { /* first start */ }
  }
  function saveRoutes() {
    if (!routesFile || !routesDirty) return;
    routesDirty = false;
    const keep = [...routes.entries()].filter(([, v]) => v.miles != null || v.lat != null).slice(-8000);
    try { fs.writeFileSync(routesFile + '.tmp', JSON.stringify(Object.fromEntries(keep))); fs.renameSync(routesFile + '.tmp', routesFile); } catch (e) { log('saving routes failed', e.message); }
  }
  // Read by core.estimateRoute(). Null means "not known yet": core estimates.
  function route(a, b) {
    const v = routes.get(rkey(a, b));
    return v && v.miles != null ? { miles: v.miles, minutes: v.minutes, source: 'google' } : null;
  }
  async function fetchRoute(a, b) {
    const k = rkey(a, b);
    const v = routes.get(k);
    if (v && (v.miles != null || Date.now() - v.fail < 10 * 60e3)) return;
    try {
      const r = await request('POST', `${url('GOOGLE_ROUTES', 'https://routes.googleapis.com')}/directions/v2:computeRoutes`, {
        headers: { 'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration' },
        body: { origin: { address: a }, destination: { address: b }, travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', units: 'IMPERIAL' },
        timeoutMs: 6000,
      });
      const best = r && r.routes && r.routes[0];
      if (!best || best.distanceMeters == null) throw new Error('No driving route found');
      const miles = Math.round(best.distanceMeters / 1609.344 * 100) / 100;
      const minutes = Math.max(1, Math.round(parseInt(String(best.duration || '0'), 10) / 60));
      routes.set(k, { miles, minutes, at: Date.now() });
      routesDirty = true;
    } catch (e) {
      routes.set(k, { fail: Date.now() });
      log(`route ${a} -> ${b} failed: ${e.message}`);
    }
  }
  async function warmRoutes(pairs, timeoutMs) {
    const todo = [];
    const seen = new Set();
    for (const [a, b] of pairs) {
      if (!a || !b || norm(a) === norm(b)) continue;
      const k = rkey(a, b); if (seen.has(k)) continue; seen.add(k);
      const v = routes.get(k);
      if (!v || (v.miles == null && Date.now() - v.fail >= 10 * 60e3)) todo.push([a, b]);
    }
    if (!todo.length) return;
    await withTimeout(Promise.all(todo.slice(0, 8).map(([a, b]) => fetchRoute(a, b))), timeoutMs || 5000);
  }
  // Where an address is, for the dispatch map. Kept with the routes; core reads
  // it through geo() and uses its own estimate until a place is known.
  const gkey = (a) => `@geo|${norm(a)}`;
  function geo(a) {
    const v = routes.get(gkey(a));
    return v && v.lat != null ? { lat: v.lat, lng: v.lng } : null;
  }
  async function fetchGeo(a) {
    const k = gkey(a), v = routes.get(k);
    if (v && (v.lat != null || Date.now() - v.fail < 30 * 60e3)) return;
    try {
      const r = await request('POST', `${url('GOOGLE_PLACES', 'https://places.googleapis.com')}/v1/places:searchText`, {
        headers: { 'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': 'places.location' },
        body: { textQuery: a, maxResultCount: 1 }, timeoutMs: 6000,
      });
      const loc = r && r.places && r.places[0] && r.places[0].location;
      if (!loc || loc.latitude == null) throw new Error('Place not found');
      routes.set(k, { lat: loc.latitude, lng: loc.longitude, at: Date.now() });
      routesDirty = true;
    } catch (e) {
      routes.set(k, { fail: Date.now() });
      log(`place "${a}" failed: ${e.message}`);
    }
  }
  async function warmGeo(addrs, timeoutMs) {
    const todo = [...new Set(addrs.filter((a) => a && String(a).trim()))].filter((a) => { const v = routes.get(gkey(a)); return !v || (v.lat == null && Date.now() - v.fail >= 30 * 60e3); });
    if (!todo.length) return;
    await withTimeout(Promise.all(todo.slice(0, 10).map(fetchGeo)), timeoutMs || 5000);
  }

  // Address suggestions for core's places.suggest, same shape as its own.
  async function places(query, center) {
    const q = String(query || '').trim();
    if (q.length < 3) return [];
    try {
      const r = await request('POST', `${url('GOOGLE_PLACES', 'https://places.googleapis.com')}/v1/places:autocomplete`, {
        headers: { 'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY },
        body: { input: q, includedRegionCodes: ['us', 'ca'], ...(center ? { locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: 50000 } } } : {}) },
        timeoutMs: 4000,
      });
      return ((r && r.suggestions) || []).map((s) => s.placePrediction).filter(Boolean).slice(0, 6).map((p) => {
        const label = (p.structuredFormat && p.structuredFormat.mainText && p.structuredFormat.mainText.text) || p.text.text;
        const sub = (p.structuredFormat && p.structuredFormat.secondaryText && p.structuredFormat.secondaryText.text) || '';
        const types = p.types || [];
        return { label, sub, address: p.text.text, kind: types.includes('airport') ? 'airport' : /^\d/.test(label) ? 'street' : 'place' };
      });
    } catch (e) {
      log(`places "${q}" failed: ${e.message}`);
      return null; // core falls back to its own list
    }
  }

  // ---- Flights ---------------------------------------------------------------

  // flight code -> { at, from, to, list: [AeroAPI flights], error }
  const flights = new Map();
  const wanted = new Map(); // code -> latest sched asked about
  const LOOKAHEAD = 2 * 86400e3; // AeroAPI has live data from about two days out
  const ident = (code) => code.replace(/\s+/g, '');
  async function fetchFlight(code, around) {
    const t = new Date(around).getTime();
    const from = new Date(Math.max(Date.now() - 9 * 86400e3, t - 18 * 3600e3));
    const to = new Date(Math.min(Date.now() + LOOKAHEAD, t + 18 * 3600e3));
    if (to <= from) return;
    const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    try {
      const r = await request('GET', `${url('AEROAPI', 'https://aeroapi.flightaware.com/aeroapi')}/flights/${encodeURIComponent(ident(code))}?ident_type=designator&start=${iso(from)}&end=${iso(to)}`, {
        headers: { 'x-apikey': env.FLIGHTAWARE_API_KEY }, timeoutMs: 6000,
      });
      flights.set(code, { at: Date.now(), from: from.getTime(), to: to.getTime(), list: (r && r.flights) || [] });
    } catch (e) {
      flights.set(code, { at: Date.now(), from: from.getTime(), to: to.getTime(), list: [], error: e.message });
      log(`flight ${code} failed: ${e.message}`);
    }
  }
  const age = (code) => { const f = flights.get(code); return f ? Date.now() - f.at : Infinity; };
  const covers = (code, t) => { const f = flights.get(code); return f && t >= f.from && t <= f.to; };
  // How often to re-check: close to the flight every 5 minutes, else every 30.
  const stale = (code, t) => !covers(code, t) || age(code) > (Math.abs(t - Date.now()) < 4 * 3600e3 ? 5 * 60e3 : 30 * 60e3);

  // Read by core.flightStatus(). Never invents a delay: until real data is in,
  // the flight shows as on schedule and pickups are not moved.
  function flightHook(code, schedIso, kind, nowDate) {
    const t = new Date(schedIso).getTime();
    const placeholder = (label) => ({ scheduled: schedIso, estimated: schedIso, delayMin: 0, status: 'scheduled', label, airport: '', terminal: '', claim: null, checkedAt: nowDate.toISOString(), source: 'flightaware' });
    if (t - Date.now() > LOOKAHEAD) return placeholder('Tracking starts 2 days before');
    if (stale(code, t)) wanted.set(code, schedIso);
    const f = flights.get(code);
    if (!f || !covers(code, t)) return placeholder('Checking flight');
    const sk = kind === 'arrival' ? 'scheduled_in' : 'scheduled_out';
    let best = null, diff = Infinity;
    for (const x of f.list) { const d = Math.abs(new Date(x[sk] || x.scheduled_on || x.scheduled_off || 0).getTime() - t); if (d < diff) { diff = d; best = x; } }
    if (!best || diff > 8 * 3600e3) return placeholder(f.error ? 'Flight data unavailable' : 'Flight not found on this day');
    const sched = best[sk];
    const est = kind === 'arrival' ? (best.actual_in || best.estimated_in || best.actual_on || best.estimated_on || sched) : (best.actual_out || best.estimated_out || sched);
    const delayMin = Math.max(0, Math.round((new Date(est) - new Date(sched)) / 60000));
    const status = best.cancelled ? 'cancelled'
      : kind === 'arrival' ? (best.actual_in || best.actual_on ? 'landed' : best.actual_off || best.actual_out ? 'in_air' : 'scheduled')
      : (best.actual_out || best.actual_off ? 'departed' : 'scheduled');
    const label = { cancelled: 'Cancelled', landed: 'Landed', departed: 'Departed', in_air: 'In the air', scheduled: delayMin ? 'Delayed' : 'On time' }[status];
    const ap = kind === 'arrival' ? best.destination : best.origin;
    return {
      scheduled: new Date(sched).toISOString(), estimated: new Date(est).toISOString(), delayMin, status, label,
      airport: (ap && (ap.code_iata || ap.code)) || '', terminal: (kind === 'arrival' ? best.terminal_destination : best.terminal_origin) || '',
      claim: kind === 'arrival' ? best.baggage_claim || null : null, checkedAt: new Date(f.at).toISOString(), source: 'flightaware',
      // Where a departing flight lands and when, for the "ride when you land" offer.
      ...(kind !== 'arrival' && best.destination ? { destination: best.destination.code_iata || '', arrives: best.scheduled_in || best.scheduled_on || null } : {}),
    };
  }
  // A booking form asking about a flight waits briefly for the first answer.
  async function prefetchFlights(items, timeoutMs) {
    const todo = items.filter((x) => x.code && x.at && new Date(x.at).getTime() - Date.now() < LOOKAHEAD && stale(x.code, new Date(x.at).getTime()));
    if (todo.length) await withTimeout(Promise.all(todo.slice(0, 4).map((x) => fetchFlight(x.code, x.at))), timeoutMs || 5000);
  }
  // Called every minute with upcoming trips; refreshes what is due.
  async function pollFlights(upcoming) {
    for (const u of upcoming) if (u.flight && u.sched) { const t = new Date(u.sched).getTime(); if (t - Date.now() < LOOKAHEAD && stale(u.flight, t)) wanted.set(u.flight, u.sched); }
    const due = [...wanted.entries()].slice(0, 20);
    wanted.clear();
    for (const [code, sched] of due) await fetchFlight(code, sched);
    return due.length;
  }

  // ---- Stripe ----------------------------------------------------------------

  const stripeBase = () => url('STRIPE', 'https://api.stripe.com');
  const stripe = (method, path, form, account, extra) => request(method, `${stripeBase()}${path}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(account ? { 'Stripe-Account': account } : {}), ...(extra || {}) },
    ...(form ? { form } : {}),
  });
  const pay = {
    // A Standard account belongs to the limo company: their money goes to their bank.
    async createAccount(company) { return stripe('POST', '/v1/accounts', { type: 'standard', ...(company.email ? { email: company.email } : {}), business_profile: { name: company.name }, metadata: { livery_company: company.id } }); },
    async onboardingLink(account, returnUrl, refreshUrl) { return stripe('POST', '/v1/account_links', { account, return_url: returnUrl, refresh_url: refreshUrl, type: 'account_onboarding' }); },
    async getAccount(account) { return stripe('GET', `/v1/accounts/${encodeURIComponent(account)}`); },
    async checkout(p, successUrl, cancelUrl) {
      return stripe('POST', '/v1/checkout/sessions', {
        mode: 'payment', success_url: successUrl, cancel_url: cancelUrl,
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: p.amount, product_data: { name: p.description } } }],
        ...(p.email ? { customer_email: p.email } : {}),
        metadata: p.meta, payment_intent_data: { description: p.description, metadata: p.meta },
      }, p.account);
    },
    async getSession(id, account) { return stripe('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}?expand[]=payment_intent.latest_charge&expand[]=setup_intent.payment_method`, null, account); },
    // Card on file: a Stripe customer on the company's account, then Stripe's
    // page in setup mode saves the card without charging it.
    async setup(p, successUrl, cancelUrl) {
      const cust = await stripe('POST', '/v1/customers', { ...(p.email ? { email: p.email } : {}), ...(p.name ? { name: p.name } : {}), metadata: p.meta }, p.account);
      return stripe('POST', '/v1/checkout/sessions', {
        mode: 'setup', currency: 'usd', payment_method_types: ['card'], customer: cust.id, success_url: successUrl, cancel_url: cancelUrl,
        metadata: p.meta, setup_intent_data: { description: p.description, metadata: p.meta },
      }, p.account);
    },
    cardOf(session) {
      const pm = session && session.setup_intent && session.setup_intent.payment_method;
      const card = pm && pm.card;
      if (!pm || !pm.id || !session.customer) return null;
      return { customer: typeof session.customer === 'string' ? session.customer : session.customer.id, pm: pm.id, brand: card ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : 'Card', last4: card ? card.last4 : '', exp: card ? `${String(card.exp_month).padStart(2, '0')}/${String(card.exp_year).slice(-2)}` : '' };
    },
    // Charges a saved card with nobody at the screen. The charge id doubles as
    // Stripe's idempotency key, so a retry after a timeout can't charge twice.
    // Network trouble leaves it pending to try again; a decline is final.
    async charge(x) {
      try {
        const r = x.kind === 'refund'
          ? await stripe('POST', '/v1/refunds', { payment_intent: x.refundOf, amount: x.amount, metadata: x.meta }, x.account, { 'Idempotency-Key': x.id })
          : await stripe('POST', '/v1/payment_intents', { amount: x.amount, currency: 'usd', customer: x.customer, payment_method: x.pm, off_session: true, confirm: true, description: x.description, metadata: x.meta }, x.account, { 'Idempotency-Key': x.id });
        if (x.kind === 'refund' || r.status === 'succeeded') return { ok: true, ref: r.id };
        if (r.status === 'processing') return { retry: true };
        return { ok: false, error: r.status === 'requires_action' ? 'The bank asked the customer to confirm the payment' : `Payment ${r.status}`, ref: r.id };
      } catch (e) {
        if (!e.status || e.status >= 500 || e.status === 429) return { retry: true, error: e.message };
        const d = e.data && e.data.error;
        return { ok: false, error: (d && d.code === 'authentication_required') ? 'The bank asked the customer to confirm the payment' : e.message };
      }
    },
    // Stripe-Signature: t=...,v1=... over "<t>.<raw body>" with the webhook secret.
    verifyWebhook(raw, header) {
      const secret = env.STRIPE_WEBHOOK_SECRET;
      if (!secret) return null;
      const parts = Object.fromEntries(String(header || '').split(',').map((x) => x.split('=')).filter((x) => x.length === 2).map(([k, v]) => [k, v]));
      const sigs = String(header || '').split(',').filter((x) => x.startsWith('v1=')).map((x) => x.slice(3));
      if (!parts.t || !sigs.length || Math.abs(Date.now() / 1000 - Number(parts.t)) > 600) return null;
      const want = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
      const ok = sigs.some((s) => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
      if (!ok) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    },
    last4(session) { const ch = session && session.payment_intent && session.payment_intent.latest_charge; return (ch && ch.payment_method_details && ch.payment_method_details.card && ch.payment_method_details.card.last4) || ''; },
  };

  return {
    on, deliver, e164, verifyTwilio,
    route, warmRoutes, geo, warmGeo, places, loadRoutes, saveRoutes,
    // A browser key (restricted to your site) for drawing Google maps; never the server key.
    mapsKey: env.GOOGLE_MAPS_BROWSER_KEY || '',
    flightHook, prefetchFlights, pollFlights,
    pay,
    // What the owner's Connections screen shows. Never includes key values.
    status() {
      return {
        sms: { on: on.sms, service: 'Twilio', from: on.sms ? String(env.TWILIO_FROM).replace(/^(\+?\d{2})\d+(\d{2})$/, '$1•••$2') : '' },
        email: { on: on.email, service: 'Resend', from: on.email ? fromAddress() : '' },
        cards: { on: on.cards, service: 'Stripe', mode: on.cards ? (String(env.STRIPE_SECRET_KEY).startsWith('sk_live') ? 'live' : 'test') : '', webhook: has('STRIPE_WEBHOOK_SECRET') },
        maps: { on: on.maps, service: 'Google Maps', routes: [...routes.keys()].filter((k) => !k.startsWith('@geo|')).length, mapDisplay: !!env.GOOGLE_MAPS_BROWSER_KEY },
        flights: { on: on.flights, service: 'FlightAware AeroAPI', tracked: flights.size },
      };
    },
  };
}

// Stripe's form encoding: nested objects and arrays become a[b][0][c]=v.
function encodeForm(obj, prefix, out) {
  out = out || [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encodeForm(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const escapeRe = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref())]);

module.exports = { createProviders, encodeForm };
