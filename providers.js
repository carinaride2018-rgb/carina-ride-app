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
const { bookingPdf } = require('./pdf.js');
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
  const SUBJECTS = { chauffeur: 'Your chauffeur', en_route: 'Your chauffeur is on the way', approach: 'Your chauffeur is 10 minutes away', arrived: 'Your chauffeur has arrived', confirm: 'Ride confirmed', receipt: 'Your receipt', changed: 'Ride changed', office_new: 'New booking', office_changed: 'Booking changed', biz_request: 'Business account request', biz_reply: 'Business rides', net_post: 'New trip on the trip board', late_driver: 'Driver not on the way', noshow_ask: 'No-show to confirm',  reminder: 'Ride reminder', reminder24: 'Ride reminder', quote: 'Your quote', invoice: 'Your invoice', login: 'Your LimoRelay login', reset: 'Reset your password', test: 'LimoRelay test email', signup: 'LimoRelay sign-up', approved: 'Your LimoRelay account is approved', declined: 'Your LimoRelay sign-up', planinvoice: 'Your LimoRelay invoice', billing: 'Your LimoRelay membership' };
  function subjectOf(m) {
    if (SUBJECTS[m.kind]) return `${SUBJECTS[m.kind]}${m.ref ? ' ' + m.ref : ''}`;
    // One line only: a greeting ("Hi Tsion,") is skipped and line breaks become
    // spaces, since a subject with line breaks is refused by the email service.
    const body = String(m.body || '').replace(new RegExp('^' + escapeRe(m.company.name) + ':\\s*'), '').replace(/^\s*(hi|hello|dear)\b[^\n]*\n+/i, '').replace(/\s+/g, ' ').trim();
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
  // Wake-up call: Twilio reads the message and waits for one key; the key goes
  // to answerUrl (<PUBLIC_URL>twilio/wake). Calls come from TWILIO_VOICE_FROM, or
  // TWILIO_FROM when that is a phone number (a Messaging Service can't call).
  const voiceFrom = () => { const v = String(env.TWILIO_VOICE_FROM || '').trim() || String(env.TWILIO_FROM || '').trim(); return /^MG/i.test(v) ? '' : v; };
  async function placeCall(to, body, answerUrl) {
    const sid = env.TWILIO_ACCOUNT_SID, from = voiceFrom();
    if (!from) throw new Error('Set TWILIO_VOICE_FROM to a Twilio phone number to place calls');
    const x = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const say = `<Say voice="Polly.Joanna">${x(body)}</Say>`;
    const twiml = `<Response><Gather numDigits="1" timeout="8" method="POST" action="${x(answerUrl)}">${say}<Pause length="1"/>${say}</Gather><Say voice="Polly.Joanna">We did not hear from you. We will call again shortly.</Say></Response>`;
    const r = await request('POST', `${url('TWILIO', 'https://api.twilio.com')}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64') }, form: { To: to, From: from, Twiml: twiml },
    });
    return r && r.sid;
  }
  // Twilio's delivery state for one sent text, e.g. delivered, or undelivered with error 30034.
  async function smsStatus(msgSid) {
    const sid = env.TWILIO_ACCOUNT_SID;
    const r = await request('GET', `${url('TWILIO', 'https://api.twilio.com')}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages/${encodeURIComponent(msgSid)}.json`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64') },
    });
    return { status: (r && r.status) || '', code: (r && r.error_code) || null, message: (r && r.error_message) || '' };
  }
  async function sendEmail(to, m) {
    // Booking emails carry a printable PDF of the same details. If the PDF
    // can't be made, the email still goes out without it.
    let pdf = null;
    if (PDF_KINDS[m.kind] && m.ref) {
      try { pdf = { filename: `${String(m.ref).replace(/[^\w-]/g, '')}.pdf`, content: bookingPdf(m, PDF_KINDS[m.kind]).toString('base64') }; }
      catch (e) { log(`PDF for ${m.ref} failed: ${e.message}`); }
    }
    // The banner (or logo) goes inside the email as an inline picture, so mail
    // apps show it right away instead of "Some images are blocked".
    const pic = inlinePic(m.company);
    const attachments = [pdf, pic && { filename: pic.filename, content: pic.content, content_id: pic.cid }].filter(Boolean);
    const name = String(m.company.name || 'Bookings').replace(/["<>]/g, '');
    const r = await request('POST', `${url('RESEND', 'https://api.resend.com')}/emails`, {
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: { from: `${name} <${fromAddress()}>`, to: [to], subject: subjectOf(m), text: m.body, html: emailHtml(m, { pdf: !!pdf, cid: pic && pic.cid, banner: !!(pic && pic.banner) }), ...(attachments.length ? { attachments } : {}), ...(isEmail(m.replyTo) ? { reply_to: m.replyTo } : isEmail(m.company.email) ? { reply_to: m.company.email } : {}) },
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
    if (m.channel === 'call') {
      if (!phone) return { id: m.id, status: 'skipped', error: 'No phone number' };
      if (!on.sms) return { id: m.id, status: 'simulated' };
      try { return { id: m.id, status: 'sent', via: String((await placeCall(phone, m.body, m.answerUrl)) || '') }; }
      catch (e) { log(`call to ${rcpt} failed: ${e.message}`); return { id: m.id, status: 'failed', error: e.message }; }
    }
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
    on, deliver, e164, verifyTwilio, smsStatus,
    route, warmRoutes, geo, warmGeo, places, loadRoutes, saveRoutes,
    // A browser key (restricted to your site) for drawing Google maps; never the server key.
    mapsKey: env.GOOGLE_MAPS_BROWSER_KEY || '',
    flightHook, prefetchFlights, pollFlights,
    pay,
    // What the owner's Connections screen shows. Never includes key values.
    status() {
      return {
        sms: { on: on.sms, voice: on.sms && !!voiceFrom(), service: 'Twilio', from: on.sms ? String(env.TWILIO_FROM).replace(/^(\+?\d{2})\d+(\d{2})$/, '$1•••$2') : '' },
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
// The HTML version of an email: the company's logo (or name) on top, the
// message in a box with "Label: value" lines as a table, and the company's
// terms and phone at the bottom. The plain text goes along for old mail apps.
const hesc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const linkify = (x) => hesc(x).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:#1a56db;word-break:break-all">${u}</a>`);
// Booking emails get a printable PDF; the value is the PDF's heading.
const PDF_KINDS = { confirm: 'Booking confirmation', office_new: 'New booking', changed: 'Booking changed', office_changed: 'Booking changed', receipt: 'Receipt' };
const HEADINGS = { ...PDF_KINDS, chauffeur: 'Your chauffeur', en_route: 'On the way', approach: '10 minutes away', arrived: 'Chauffeur arrived', reminder: 'Ride reminder', reminder24: 'Ride reminder', quote: 'Your quote', invoice: 'Invoice' };
// The company's banner, or else its logo, as an inline email attachment.
function inlinePic(co) {
  const banner = !!(co && co.bannerData);
  const x = String((co && (co.bannerData || co.logoData)) || '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!x) return null;
  const ext = x[1] === 'jpeg' ? 'jpg' : x[1];
  return { cid: banner ? 'brand-banner' : 'brand-logo', filename: `${banner ? 'banner' : 'logo'}.${ext}`, content: x[2], banner };
}
function emailHtml(m, opt) {
  const co = m.company || {};
  const color = /^#[0-9a-f]{6}$/i.test(co.color || '') ? co.color : '#222222';
  let lines = String(m.body || '').replace(/\r/g, '').split('\n');
  // The "Company:" first line is the header now.
  if (lines.length && co.name && lines[0].trim() === `${co.name}:`) lines = lines.slice(1);
  let terms = '';
  lines = lines.filter((l) => { const t = l.match(/^Terms and Conditions:\s*(\S+)\s*$/); if (t) { terms = t[1]; return false; } return true; });
  const blocks = []; let cur = [];
  for (const l of lines) { if (l.trim()) cur.push(l); else if (cur.length) { blocks.push(cur); cur = []; } }
  if (cur.length) blocks.push(cur);
  const kv = (l) => { const x = l.match(/^([A-Z][^:]{0,40}):\s+(.+)$/); return x && !/https?$/i.test(x[1]) ? x : null; };
  const row = (x, i) => `<tr><td style="padding:11px 14px;background:${i % 2 ? '#ffffff' : '#f7f7f8'};border-bottom:1px solid #ececee;width:36%;vertical-align:top;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6b6f76;font-weight:700">${hesc(x[1])}</td><td style="padding:10px 14px;background:${i % 2 ? '#ffffff' : '#f7f7f8'};border-bottom:1px solid #ececee;vertical-align:top;font-size:15px;line-height:1.4;color:#111111;font-weight:700;word-break:break-word;overflow-wrap:anywhere">${linkify(x[2])}</td></tr>`;
  const html = blocks.map((b) => {
    const kvs = b.map(kv);
    if (kvs.every(Boolean) && (b.length > 1 || /^Total\b/.test(b[0]))) return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;table-layout:fixed;border-collapse:separate;border:1px solid #e3e3e6;border-radius:10px;overflow:hidden;margin:0 0 18px">${kvs.map(row).join('')}</table>`;
    return `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#222222">${b.map(linkify).join('<br>')}</p>`;
  }).join('');
  const heading = HEADINGS[m.kind] || '';
  const banner = opt && opt.cid && opt.banner ? `<img src="cid:${opt.cid}" alt="${hesc(co.name)}" width="580" style="width:100%;max-width:580px;height:auto;display:block;border:0">` : '';
  const src = opt && opt.cid && !opt.banner ? `cid:${opt.cid}` : co.logoUrl;
  const logo = src ? `<img src="${hesc(src)}" alt="${hesc(co.name)}" width="180" style="width:180px;max-width:70%;height:auto;display:block;margin:0 auto;border:0">` : `<div style="font-size:24px;font-weight:800;color:#111111;text-align:center;letter-spacing:-.01em">${hesc(co.name || '')}</div>`;
  const title = heading ? `<tr><td style="padding:0 24px 18px;text-align:center"><div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:${color}">${hesc(heading)}</div>${m.ref ? `<div style="font-size:26px;font-weight:800;color:#111111;margin-top:4px;letter-spacing:.01em">${hesc(m.ref)}</div>` : ''}</td></tr>` : '';
  const pdfNote = opt && opt.pdf ? `<tr><td style="padding:0 24px 18px"><div style="border:1px dashed #cfd0d4;border-radius:10px;padding:12px 14px;font-size:13px;color:#333333;background:#fafafa">&#128196; A printable PDF of this booking is attached.</div></td></tr>` : '';
  const contact = [co.phone ? `<a href="tel:${hesc(String(co.phone).replace(/[^\d+]/g, ''))}" style="color:#111111;text-decoration:none;font-weight:700">${hesc(co.phone)}</a>` : '', co.email ? `<a href="mailto:${hesc(co.email)}" style="color:#111111;text-decoration:none">${hesc(co.email)}</a>` : ''].filter(Boolean).join(' &nbsp;&middot;&nbsp; ');
  const termsLink = terms || co.termsUrl ? `<div style="margin-top:8px"><a href="${hesc(terms || co.termsUrl)}" style="color:#6b6f76">Terms and Conditions</a></div>` : '';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"></head><body style="margin:0;padding:0;background:#f1f1f3">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f1f3"><tr><td style="padding:24px 10px;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="width:100%;max-width:580px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e3e3e6">
${banner ? '' : `<tr><td style="height:5px;background:${color};font-size:0;line-height:0">&nbsp;</td></tr>`}
${banner ? `<tr><td style="padding:0;font-size:0;line-height:0">${banner}</td></tr><tr><td style="height:22px;font-size:0;line-height:0">&nbsp;</td></tr>` : `<tr><td style="padding:26px 24px 18px">${logo}</td></tr>`}
${title}
<tr><td style="padding:0 24px 6px;word-break:break-word;overflow-wrap:anywhere">${html}</td></tr>
${pdfNote}
<tr><td style="background:#f7f7f8;border-top:1px solid #ececee;padding:18px 24px;text-align:center;font-size:13px;line-height:1.6;color:#333333">${co.name ? `<div style="font-weight:700;color:#111111">${hesc(co.name)}</div>` : ''}${contact ? `<div>${contact}</div>` : ''}${termsLink}</td></tr>
</table></td></tr></table></body></html>`;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref())]);

module.exports = { createProviders, encodeForm, emailHtml, inlinePic };
