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
const { createCore, setProviders, normFlight, isAirport } = require('./core.js');
const { createProviders } = require('./providers.js');
const { gateway, squareOAuth, onSquareTokens } = require('./gateways.js');
const { createWebPush } = require('./webpush.js');
const { createNativePush, isNative } = require('./nativepush.js');
const { createPhoneAgent } = require('./phoneagent.js');

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

// Companies' own Authorize.net / PayPal keys are kept sealed (AES-256-GCM) in
// the data file. The key comes from CREDENTIALS_KEY when set in Render, else
// from a random key file kept next to the data file.
const sealKey = (() => {
  if (process.env.CREDENTIALS_KEY) return crypto.createHash('sha256').update(process.env.CREDENTIALS_KEY).digest();
  const f = path.join(path.dirname(DATA_FILE), 'credentials.key');
  try { const k = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex'); if (k.length === 32) return k; } catch (e) { /* first start */ }
  const k = crypto.randomBytes(32);
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, k.toString('hex'), { mode: 0o600 }); } catch (e) { console.error('credentials key', e.message); }
  return k;
})();
function seal(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', sealKey, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
function unseal(s) {
  try {
    const [v, iv, tag, enc] = String(s || '').split('.');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', sealKey, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8'));
  } catch (e) { return null; }
}

const core = createCore({
  seal, unseal,
  squareOn: squareOAuth.on(),
  // Connecting Authorize.net or PayPal: the keys must work before they're saved.
  async verifyGateway(g) {
    try { await gateway(g).verify(); } catch (e) { const m = String(e.message).replace(/\.+$/, ''); const err = new Error(e.status && e.status < 500 ? `${m}. Check the keys and the test mode switch.` : `${m}. Try again in a minute.`); err.status = 400; throw err; }
  },
  pushKey: push ? push.publicKey : '',
  nativePush: nativePush ? nativePush.ready : null,
  mapsKey: live.mapsKey,
  publicUrl: PUBLIC_URL,
  blank: BLANK,
  // Sample data keeps pretend card payments; a real site without Stripe has none.
  payMode: live.on.cards ? 'stripe' : BLANK ? 'off' : 'demo',
  live: { ...live.on, voiceAgent: !!String(process.env.ANTHROPIC_API_KEY || '').trim() },
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

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.jpg': 'image/jpeg' };
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
  const name = co ? (co.company || co).name + (q.get('r') === 'driver' ? ' Driver' : q.get('r') === 'staff' ? ' Dispatch' : '') : 'LimoRelay';
  const color = co ? (co.company || co).color || '#15171c' : '#15171c';
  send(res, 200, {
    name, short_name: name.length > 14 ? name.split(' ')[0] : name, description: co ? `Book and track rides with ${name}` : 'Limousine booking and dispatch',
    id: co ? `/?c=${slug}${staff ? '&r=staff' : ''}` : '/', start_url: co && !staff ? `/?source=app#book.${slug}` : '/?source=app', scope: '/', display: 'standalone', orientation: 'portrait',
    background_color: '#f4f5f7', theme_color: color,
    icons: co && !coIconDir(slug) && /^data:image\/\w+;base64,/.test((co.company || co).logo || '') ? [
      { src: `/co-icon/${encodeURIComponent(slug)}.svg`, sizes: 'any', type: 'image/svg+xml' },
      { src: `/co-icon/${encodeURIComponent(slug)}.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ] : ((d) => [
      { src: `${d}/icon-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `${d}/icon-512.png`, sizes: '512x512', type: 'image/png' },
      { src: `${d}/maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ])((co && coIconDir(slug)) || '/icons'),
  }, 'application/manifest+json');
}

// ---- Search engines ---------------------------------------------------------------
// robots.txt, sitemap.xml, and the page head filled in for the home page and for
// each company's booking page at /book/<slug> (title, description, link previews,
// and business details Google reads). The app itself still draws the page.
const reqHost = (req) => String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
const xmlEsc = (v) => String(v).replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));
const attr = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const jsonLd = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
let indexHtml = null;
const coUrl = (c) => (c.domain ? `https://${c.domain}/` : `${base}book/${encodeURIComponent(c.slug)}`);
function pageHead(html, h) {
  const tags = [
    `<link rel="canonical" href="${attr(h.url)}">`,
    `<meta property="og:type" content="website">`, `<meta property="og:site_name" content="${attr(h.site)}">`,
    `<meta property="og:title" content="${attr(h.title)}">`, `<meta property="og:description" content="${attr(h.desc)}">`,
    `<meta property="og:url" content="${attr(h.url)}">`, ...(h.image ? [`<meta property="og:image" content="${attr(h.image)}">`] : []),
    `<meta name="twitter:card" content="${h.image ? 'summary_large_image' : 'summary'}">`,
    jsonLd(h.ld),
  ].join('\n  ');
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${attr(h.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${attr(h.desc)}">\n  ${tags}`)
    .replace('<meta charset="utf-8">', `<meta charset="utf-8">${h.go ? `\n  <script>if(!location.hash)history.replaceState(null,'',${JSON.stringify(h.go)});</script>` : ''}`)
    .replace('<div id="app"></div>', `<div id="app"></div>${h.noscript ? `\n  <noscript>${h.noscript}</noscript>` : ''}`);
}
const HOME_DESC = 'Limo booking and dispatch software with a network of chauffeur companies that send each other rides. Booking page, dispatch board, driver and passenger apps included. Free for 30 days.';
function homeHead(html) {
  return pageHead(html, {
    site: 'LimoRelay', url: base, title: 'LimoRelay: limo booking and dispatch software for chauffeur companies', desc: HOME_DESC, image: `${base}icons/icon-512.png`,
    ld: { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'LimoRelay', url: base, applicationCategory: 'BusinessApplication', operatingSystem: 'Web, iOS, Android', description: HOME_DESC,
      offers: { '@type': 'AggregateOffer', priceCurrency: 'USD', lowPrice: '49', highPrice: '199', offerCount: '3' } },
    noscript: '<h1>LimoRelay: limo booking and dispatch software</h1><p>Online booking page, dispatch board, driver app and passenger app for limo and chauffeur companies, plus a network of member companies that send each other rides. Plans from $49 a month, free for 30 days.</p>',
  });
}
// A company's own tab and app icons (public/icons/co/<slug>/), used on its booking pages.
const coIconDir = (slug) => { const d = path.join(PUBLIC, 'icons', 'co', String(slug || '').replace(/[^a-z0-9-]/gi, '')); return slug && fs.existsSync(path.join(d, 'icon-192.png')) ? `/icons/co/${String(slug).replace(/[^a-z0-9-]/gi, '')}` : ''; };
function withCoIcons(html, slug, hasLogo) {
  const d = coIconDir(slug);
  const e = encodeURIComponent(slug || '');
  // Hand-made icons win; otherwise a company with an uploaded logo gets icons made from it.
  if (!d && !hasLogo) return html;
  const fav = d ? `<link rel="icon" href="${d}/favicon-32.png" sizes="32x32" type="image/png">` : `<link rel="icon" href="/co-icon/${e}.svg" type="image/svg+xml">`;
  const fav2 = d ? `<link rel="icon" href="${d}/favicon-48.png" sizes="48x48" type="image/png">` : `<link rel="icon" href="/logo/${e}.png" sizes="any">`;
  const ico = d ? `<link rel="alternate icon" href="${d}/favicon.ico">` : `<link rel="alternate icon" href="/logo/${e}.png">`;
  const apple = d ? `${d}/apple-touch-icon.png` : `/logo/${e}.png`;
  return html.replace(/<link rel="icon" href="icons\/favicon\.svg"[^>]*>/, fav)
    .replace(/<link rel="icon" href="icons\/favicon-32\.png"[^>]*>/, fav2)
    .replace(/<link rel="alternate icon" href="icons\/favicon\.ico">/, ico)
    .replace(/<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png">/, `<link rel="apple-touch-icon" href="${apple}">`)
    .replace(/<link rel="manifest" id="manifest" href="manifest\.webmanifest">/, `<link rel="manifest" id="manifest" href="manifest.webmanifest?c=${e}">`);
}
// A square icon made from a company's uploaded logo: the logo centred on white.
async function coIconSvg(slug) {
  const l = await core.logo(slug);
  if (!l) return null;
  const uri = `data:${l.type};base64,${l.buf.toString('base64')}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512" width="512" height="512"><rect width="512" height="512" rx="96" fill="#fff"/><image x="32" y="32" width="448" height="448" preserveAspectRatio="xMidYMid meet" href="${uri}" xlink:href="${uri}"/></svg>`;
}
function companyHead(html, c) {
  const where = c.city ? ` in ${c.city}` : '';
  const desc = `${c.tagline ? c.tagline.replace(/\.?$/, '. ') : `Chauffeured cars${where}. `}Book a sedan, SUV or van online with an instant price${c.phone ? `, or call ${c.phone}` : ''}.`;
  const url = coUrl(c);
  return pageHead(withCoIcons(html, c.slug, !!c.iconLogo), {
    site: c.name, url, title: c.city ? `${c.name} | Limo and car service in ${c.city}` : `${c.name} | Book your ride online`, desc, image: c.logo ? `${base}logo/${encodeURIComponent(c.slug)}.png` : '',
    go: `/#book.${c.slug}`,
    ld: { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: c.name, url, description: desc, ...(c.phone ? { telephone: c.phone } : {}), ...(c.email ? { email: c.email } : {}),
      ...(c.logo ? { image: `${base}logo/${encodeURIComponent(c.slug)}.png` } : {}), ...(c.city ? { areaServed: c.city, address: { '@type': 'PostalAddress', addressLocality: c.city, addressCountry: 'US' } } : {}) },
    noscript: `<h1>${attr(c.name)}</h1><p>${attr(desc)}</p>`,
  });
}
async function seoRoute(req, res, rel) {
  const host = reqHost(req);
  const slugHere = host ? await core.seo.hostSlug(host) : '';
  if (rel === '/robots.txt') {
    const site = slugHere ? `https://${host}/` : base;
    return send(res, 200, `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /pay/\nDisallow: /twilio/\nSitemap: ${site}sitemap.xml\n`, 'text/plain; charset=utf-8');
  }
  if (rel === '/sitemap.xml') {
    const urls = [];
    if (slugHere) urls.push({ loc: `https://${host}/` });
    else {
      urls.push({ loc: base, pri: '1.0' }, { loc: `${base}privacy.html`, pri: '0.3' }, { loc: `${base}terms.html`, pri: '0.3' });
      for (const c of await core.seo.companies()) urls.push({ loc: coUrl(c), mod: c.updated ? String(c.updated).slice(0, 10) : '', pri: '0.8' });
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${xmlEsc(u.loc)}</loc>${u.mod ? `<lastmod>${u.mod}</lastmod>` : ''}${u.pri ? `<priority>${u.pri}</priority>` : ''}</url>`).join('\n')}\n</urlset>\n`;
    return send(res, 200, xml, 'application/xml; charset=utf-8');
  }
  if (!indexHtml) indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  if (rel.startsWith('/book/')) {
    const c = await core.seo.company(rel.slice(6).replace(/\/+$/, ''));
    if (!c) return redirect(res, `${base}#book.${encodeURIComponent(rel.slice(6).replace(/\/+$/, ''))}`);
    return send(res, 200, companyHead(indexHtml, c), 'text/html; charset=utf-8');
  }
  // The home page: LimoRelay, or a company's own booking address.
  const c = slugHere ? await core.seo.company(slugHere) : null;
  return send(res, 200, c ? companyHead(indexHtml, { ...c, domain: host }) : homeHead(indexHtml), 'text/html; charset=utf-8');
}

let demoHtml = null;
function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/manifest.webmanifest') return serveManifest(req, res);
  if (rel === '/' || rel === '/index.html' || rel === '/robots.txt' || rel === '/sitemap.xml' || rel.startsWith('/book/')) {
    return seoRoute(req, res, rel).catch((e) => { console.error('seo page', e.message); send(res, 500, 'Error', 'text/plain'); });
  }
  // Public demo: the whole app with sample data, no sign-in, nothing is saved or sent.
  if (rel === '/demo' || rel === '/demo/' || rel === '/demo.html') {
    try {
      if (!demoHtml) demoHtml = require('./build-demo.js').buildDemo();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...SECURITY_HEADERS });
      return res.end(demoHtml);
    } catch (e) { console.error('demo page', e.message); return send(res, 500, 'Error', 'text/plain'); }
  }
  if (rel === '/') rel = '/index.html';
  const file = rel === '/core.js' ? path.join(__dirname, 'core.js') : path.join(PUBLIC, path.normalize(rel));
  if (rel !== '/core.js' && !file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  // Videos are streamed in pieces (browsers, Safari above all, ask for byte ranges).
  if (path.extname(file) === '.mp4') return serveVideo(req, res, file);
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

function serveVideo(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain');
    const head = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400', ...SECURITY_HEADERS };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!m || (!m[1] && !m[2])) { res.writeHead(200, { ...head, 'Content-Length': st.size }); return fs.createReadStream(file).pipe(res); }
    let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { ...head, 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
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
const LIMITED = new Set(['auth.login', 'auth.signup', 'public.requestQuote', 'public.acceptQuote', 'public.rate', 'public.requestTrial', 'auth.changeEmail', 'public.forgotPassword', 'public.setPassword', 'owner.testEmail', 'owner.testSms', 'public.companySignup', 'public.guestBook', 'public.affAnswer', 'public.affChauffeur', 'public.affStatus', 'public.affNoShow', 'public.affExtras', 'public.affGotIt', 'public.affSend', 'public.affDriverLink', 'public.saveAcctCard']);

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
    // Where each address is, so flat-rate areas (downtown) can be recognized.
    live.on.maps && out.pairs.length ? live.warmGeo([...new Set(out.pairs.flat())].filter((a) => a && !isAirport(a)), 4000) : null,
    live.on.flights && out.flights.length ? live.prefetchFlights(out.flights, 4000) : null,
  ]);
}

// ---- Card payments (Stripe Connect) -------------------------------------------
// Each limo company connects its own Stripe account; customers pay on Stripe's
// page and the money goes straight to that company.
const base = PUBLIC_URL.endsWith('/') ? PUBLIC_URL : PUBLIC_URL + '/';
const phone = createPhoneAgent({ env: process.env, core, publicUrl: base, warm: (a) => warmFor(a) });
function redirect(res, to) { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', ...SECURITY_HEADERS }); res.end(); }
const bearer = (req) => { const a = req.headers.authorization || ''; return a.startsWith('Bearer ') ? a.slice(7) : null; };
// LimoRelay's own membership payments use the platform's Stripe account (no Stripe-Account header).
const acctOf = (a) => (a === 'platform' ? null : a);

onSquareTokens((companyId, kind, cred) => core.pay.updateGatewayCred(companyId, kind, cred));
// Square sign-ins in progress (state -> company, ten minutes each).
const sqStates = new Map();

// Authorize.net / PayPal / Square card-page visits in progress (an hour each).
const gwSessions = new Map();
const htmlEsc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
async function gwStart(what) {
  for (const [k, v] of gwSessions) if (Date.now() - v.at > 3600e3) gwSessions.delete(k);
  const sid = crypto.randomBytes(12).toString('hex');
  const back = `${base}pay/gw-return?s=${sid}`, cancel = `${base}?payment=cancelled${what.back || ''}`;
  const gw = gateway(what.gw);
  const s = await gw.setup(what, back, cancel);
  gwSessions.set(sid, { ...s, what, kind: what.gw.kind, at: Date.now() });
  return what.gw.kind === 'authnet' ? `${base}pay/anet-go?s=${sid}` : what.gw.kind === 'square' ? `${base}pay/sq-go?s=${sid}` : s.url;
}

async function payRoute(req, res, url, raw) {
  const p = url.pathname;
  const fail = (e) => send(res, e.status && e.status < 500 ? e.status : 502, { ok: false, error: (e.status && e.status < 500 && !e.data) || /^(PayPal|Authorize\.net|Square)/.test(e.message) ? e.message : `Stripe: ${e.message}` });
  const otherGw = p === '/pay/checkout' || p === '/pay/gw-return' || p === '/pay/anet-go' || p.startsWith('/pay/sq-');
  if (!live.on.cards && !otherGw && p !== '/pay/webhook') return send(res, 404, { ok: false, error: 'Card payments are not switched on.' });
  try {
    if (p === '/pay/checkout' && req.method === 'POST') {
      const args = raw ? JSON.parse(raw) : {};
      const what = await core.pay.prepare(bearer(req), args);
      if (what.gw && what.gw.kind !== 'stripe') return send(res, 200, { ok: true, data: { url: await gwStart(what) } });
      if (!live.on.cards) return send(res, 404, { ok: false, error: 'Card payments are not switched on.' });
      const success = `${base}pay/return?s={CHECKOUT_SESSION_ID}&a=${encodeURIComponent(what.account)}`;
      const cancel = `${base}?payment=cancelled${what.back}`;
      const on = { ...what, account: acctOf(what.account) };
      const session = what.mode === 'setup' ? await live.pay.setup(on, success, cancel) : await live.pay.checkout(on, success, cancel);
      return send(res, 200, { ok: true, data: { url: session.url } });
    }
    if (p === '/pay/return' && req.method === 'GET') {
      const sid = url.searchParams.get('s'), acct = url.searchParams.get('a');
      if (!sid || !acct) return redirect(res, base);
      const session = await live.pay.getSession(sid, acctOf(acct));
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
    if (p === '/pay/anet-go' && req.method === 'GET') {
      // Authorize.net's hosted page is opened with a form POST carrying the token.
      const g = gwSessions.get(url.searchParams.get('s') || '');
      if (!g || g.kind !== 'authnet') return redirect(res, `${base}?payment=error`);
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure card page</title></head>
<body style="font-family:system-ui,sans-serif;padding:24px"><p>Opening the secure card page…</p><form id="f" method="post" action="${htmlEsc(g.postUrl)}"><input type="hidden" name="token" value="${htmlEsc(g.token)}"><noscript><button type="submit">Continue</button></noscript></form>
<script>document.getElementById('f').submit()</script></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; form-action https://accept.authorize.net https://test.authorize.net; style-src 'unsafe-inline'" });
      return res.end(html);
    }
    if (p === '/pay/sq-go' && req.method === 'GET') {
      // Square's card box on our own page; the card number goes straight to Square.
      const sid = url.searchParams.get('s') || '';
      const g = gwSessions.get(sid);
      if (!g || g.kind !== 'square') return redirect(res, `${base}?payment=error`);
      const what = g.what, setup = what.mode === 'setup';
      const sdk = g.sandbox ? 'https://sandbox.web.squarecdn.com/v1/square.js' : 'https://web.squarecdn.com/v1/square.js';
      const cancel = `${base}?payment=cancelled${what.back || ''}`;
      const amt = setup ? '' : `$${(what.amount / 100).toFixed(2)}`;
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure card page</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#fff;color:#111;margin:0;padding:24px 16px}main{max-width:460px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}p{color:#444;margin:0 0 16px;font-size:15px}
#card{min-height:90px}button{width:100%;padding:14px;font-size:16px;font-weight:600;border:0;border-radius:10px;background:#111;color:#fff;cursor:pointer}button[disabled]{opacity:.5}#err{color:#b00020;font-size:14px;min-height:20px;margin:8px 0}a{color:#444;font-size:14px}.lock{font-size:13px;color:#666;margin-top:14px}</style>
<script src="${sdk}"></script></head><body><main>
<h1>${setup ? 'Add your card' : `Pay ${amt}`}</h1><p>${htmlEsc(what.description || '')}</p>
<div id="card"></div><div id="err" role="alert"></div>
<button id="go" type="button" disabled>${setup ? 'Save card' : `Pay ${amt}`}</button>
<p class="lock">🔒 Your card goes straight to Square.${setup ? ' Nothing is charged now.' : ''}</p><a href="${htmlEsc(cancel)}">Cancel</a>
</main><script>
(async function () {
  var err = document.getElementById('err'), go = document.getElementById('go');
  try {
    var payments = Square.payments(${JSON.stringify(g.appId)}, ${JSON.stringify(g.locationId)});
    var card = await payments.card();
    await card.attach('#card');
    go.disabled = false;
    go.onclick = async function () {
      go.disabled = true; err.textContent = '';
      try {
        var r = await card.tokenize();
        if (r.status !== 'OK') throw new Error((r.errors && r.errors[0] && r.errors[0].message) || 'Check the card details.');
        var res = await fetch(${JSON.stringify(`${base}pay/sq-card?s=${sid}`)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: r.token }) });
        var d = await res.json();
        if (!d.ok) throw new Error(d.error || 'Something went wrong.');
        location.href = d.data.url;
      } catch (e) { err.textContent = e.message; go.disabled = false; }
    };
  } catch (e) { err.textContent = 'The card box did not load. Refresh the page.'; }
})();
</script></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline' https://*.squarecdn.com https://*.squareup.com https://*.squareupsandbox.com; style-src 'unsafe-inline' https://*.squarecdn.com https://*.cloudfront.net; font-src https://*.squarecdn.com https://*.cloudfront.net data:; img-src https: data:; connect-src 'self' https://*.squareup.com https://*.squareupsandbox.com https://*.squarecdn.com https://*.sentry.io; frame-src https://*.squarecdn.com https://*.squareup.com https://*.squareupsandbox.com" });
      return res.end(html);
    }
    if (p === '/pay/sq-card' && req.method === 'POST') {
      // The card token from Square's box; the card is saved at /pay/gw-return.
      const sid = url.searchParams.get('s') || '';
      const g = gwSessions.get(sid);
      const token = String((raw ? JSON.parse(raw) : {}).token || '').slice(0, 500);
      if (!g || g.kind !== 'square' || g.done || !token) return send(res, 400, { ok: false, error: 'This card page has expired. Go back and try again.' });
      g.nonce = token;
      // Saved here so a declined card shows on the card page and can be fixed.
      try { g.card = await gateway(g.what.gw).cardOf(g); } catch (e) { return send(res, 400, { ok: false, error: String(e.message).replace(/^Square: /, '') }); }
      if (!g.card) return send(res, 400, { ok: false, error: 'Square did not save the card. Try again.' });
      return send(res, 200, { ok: true, data: { url: `${base}pay/gw-return?s=${sid}` } });
    }
    if (p === '/pay/sq-connect' && req.method === 'POST') {
      if (!squareOAuth.on()) return send(res, 404, { ok: false, error: 'Square is not switched on for LimoRelay yet.' });
      const c = await core.pay.company(bearer(req));
      for (const [k, v] of sqStates) if (Date.now() - v.at > 600e3) sqStates.delete(k);
      const state = crypto.randomBytes(16).toString('hex');
      sqStates.set(state, { companyId: c.id, at: Date.now() });
      return send(res, 200, { ok: true, data: { url: squareOAuth.authorizeUrl(state) } });
    }
    if (p === '/pay/sq-callback' && req.method === 'GET') {
      // Back from signing in at Square.
      const key = url.searchParams.get('state') || '';
      const st = sqStates.get(key);
      sqStates.delete(key);
      const code = url.searchParams.get('code');
      if (!st || Date.now() - st.at > 600e3) return redirect(res, `${base}?square=expired`);
      if (!code) return redirect(res, `${base}?square=cancelled`);
      try {
        const r = await squareOAuth.finish(code);
        await core.pay.setGateway(st.companyId, 'square', r);
        runCharges();
        return redirect(res, `${base}?square=ready`);
      } catch (e) {
        console.error('square connect', e.message);
        return redirect(res, `${base}?square=error&m=${encodeURIComponent(String(e.message).slice(0, 160))}`);
      }
    }
    if (p === '/pay/gw-return' && req.method === 'GET') {
      // Back from Authorize.net, PayPal or Square: read the saved card, then save it
      // (setup) or charge it once (paying a ride).
      const sid = url.searchParams.get('s') || '';
      const g = gwSessions.get(sid);
      if (!g) return redirect(res, `${base}?payment=error`);
      if (g.done) return redirect(res, g.done);
      const what = g.what, gw = gateway(what.gw);
      const card = g.card || await gw.cardOf(g);
      if (!card) return redirect(res, `${base}?payment=unpaid${what.back || ''}`);
      let to;
      if (what.mode === 'setup') {
        const done = await core.pay.complete({ account: what.account, sessionId: sid, meta: what.meta, setup: { ...card, gw: what.gw.kind } });
        to = `${base}?cardsaved=${encodeURIComponent(done.ref)}${done.back}`;
        runCharges();
      } else {
        const r = await gw.charge({ id: `pay_${sid}`.slice(0, 40), kind: 'charge', amount: what.amount, customer: card.customer, pm: card.pm, description: what.description, meta: what.meta });
        if (!r.ok) { gwSessions.delete(sid); return redirect(res, `${base}?payment=unpaid${what.back || ''}`); }
        const done = await core.pay.complete({ account: what.account, sessionId: sid, amount: what.amount, meta: what.meta, last4: card.last4 });
        to = `${base}?paid=${encodeURIComponent(done.ref)}${done.back}`;
      }
      g.done = to;
      flushOutbox();
      return redirect(res, to);
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
      // Membership payments happen on the platform account, so they carry no evt.account.
      const kindOf = o && o.metadata && o.metadata.kind;
      if (evt.type === 'checkout.session.completed' && o && !evt.account && (kindOf === 'plancard' || kindOf === 'invoice')) {
        try {
          if (o.mode === 'setup') { const full = await live.pay.getSession(o.id, null); const card = live.pay.cardOf(full); if (card) await core.pay.complete({ account: 'platform', sessionId: o.id, meta: full.metadata || {}, setup: card }); }
          else if (o.payment_status === 'paid') await core.pay.complete({ account: 'platform', sessionId: o.id, amount: o.amount_total, meta: o.metadata || {}, last4: '' });
          runCharges(); flushOutbox();
        } catch (e) { console.error('webhook', e.message); }
      }
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
  if (charging) { chargeAgain = true; return; }
  charging = true;
  try {
    do {
      chargeAgain = false;
      for (const x of await core.pay.pendingCharges()) {
        const r = x.gw && x.gw.kind !== 'stripe' ? await gateway(x.gw).charge(x) : live.on.cards ? await live.pay.charge(x) : { retry: true };
        if (r.retry) { if (r.error) console.error(`card ${x.id}: ${r.error}, will retry`); continue; }
        await core.pay.chargeResult({ tripId: x.tripId, invoiceId: x.invoiceId, clientInvoiceId: x.clientInvoiceId, id: x.id, ...r });
      }
    } while (chargeAgain);
  } catch (e) { console.error('card charges', e.message); }
  charging = false;
  flushOutbox();
}

// ---- Texts coming in (Twilio) ---------------------------------------------------
// In Twilio, set the number's "A message comes in" webhook to <PUBLIC_URL>twilio/sms
// (HTTP POST). Replies land in each company's Inbox. Requests must carry
// Twilio's signature; on the sample-data site without Twilio they're accepted
// unsigned so the Inbox can be tried out.
async function twilioRoute(req, res, url, raw) {
  const xml = (s) => send(res, 200, `<?xml version="1.0" encoding="UTF-8"?><Response>${s || ''}</Response>`, 'text/xml; charset=utf-8');
  if (url.pathname === '/twilio/wake' && req.method === 'POST') {
    // The driver's key press on a wake-up call.
    const params = Object.fromEntries(new URLSearchParams(raw));
    if (live.on.sms ? !live.verifyTwilio(req.headers['x-twilio-signature'], base + 'twilio/wake' + url.search, params) : BLANK) return send(res, 403, 'Forbidden', 'text/plain');
    try {
      const r = await core.wakeAnswer({ key: url.searchParams.get('k'), digits: params.Digits });
      return xml(`<Say voice="Polly.Joanna">${r.ok ? 'Thank you. Have a safe drive.' : 'Please press 1 to confirm you are awake.'}</Say>`);
    } catch (e) { console.error('wake call', e); return xml(); }
  }
  // Calls to the phone agent (phoneagent.js). In Twilio, set the number's
  // "A call comes in" webhook to <PUBLIC_URL>twilio/voice and "Call status
  // changes" to <PUBLIC_URL>twilio/voice/status (HTTP POST).
  if (url.pathname.startsWith('/twilio/voice') && req.method === 'POST') {
    const params = Object.fromEntries(new URLSearchParams(raw));
    // Twilio signs the exact URL it called. Accept PUBLIC_URL, or the host the call
    // came in on (for example www. or the onrender.com address).
    const path = url.pathname.slice(1) + url.search, sig = req.headers['x-twilio-signature'];
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const signed = !live.on.sms ? true : live.verifyTwilio(sig, base + path, params) || (!!host && live.verifyTwilio(sig, `https://${host}/${path}`, params));
    if (live.on.sms ? !signed : BLANK) {
      console.error(`phone agent: refused a call to /${path} because the Twilio signature did not match (${sig ? 'signed' : 'no signature'}, account ${String(params.AccountSid || '').slice(0, 8)}…, PUBLIC_URL ${base}). Check TWILIO_AUTH_TOKEN is the auth token of the Twilio account that owns the number.`);
      return send(res, 403, 'Forbidden', 'text/plain');
    }
    try {
      if (url.pathname === '/twilio/voice') return send(res, 200, await phone.answer(params), 'text/xml; charset=utf-8');
      if (url.pathname === '/twilio/voice/turn') { const out = await phone.turn(params); send(res, 200, out, 'text/xml; charset=utf-8'); flushOutbox(); runCharges(); return; }
      if (url.pathname === '/twilio/voice/wait') { const out = await phone.wait(params); send(res, 200, out, 'text/xml; charset=utf-8'); flushOutbox(); runCharges(); return; }
      if (url.pathname === '/twilio/voice/after') { const out = await phone.after(params); send(res, 200, out, 'text/xml; charset=utf-8'); flushOutbox(); runCharges(); return; }
      if (url.pathname === '/twilio/voice/status') { await phone.status(params); return send(res, 204, '', 'text/plain'); }
    } catch (e) {
      console.error('phone agent', e);
      return xml(`<Say voice="${String(process.env.PHONE_AGENT_VOICE || 'Google.en-US-Chirp3-HD-Aoede').replace(/[^\w.-]/g, '')}">Sorry, something went wrong. Please call back in a minute.</Say><Hangup/>`);
    }
    return send(res, 404, 'Not found', 'text/plain');
  }
  if (url.pathname !== '/twilio/sms' || req.method !== 'POST') return send(res, 404, 'Not found', 'text/plain');
  const params = Object.fromEntries(new URLSearchParams(raw));
  const href = base + 'twilio/sms' + url.search;
  if (live.on.sms ? !live.verifyTwilio(req.headers['x-twilio-signature'], href, params) : BLANK) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const r = await core.inboundSms({ from: params.From, body: params.Body, sid: params.MessageSid || params.SmsSid, media: Number(params.NumMedia) || 0 });
    if (!r.routed && r.ok) console.log(`text from an unknown number ${String(params.From || '').slice(0, -4)}•••• was not matched to a company`);
    xml();
    flushOutbox();
  } catch (e) { console.error('incoming text', e); xml(); }
}

// The owner's Connections screen: which services are real. Never shows keys.
async function connections(token) {
  const me = await core.call(token, 'auth.me', {});
  if (me.user.role !== 'owner') { const e = new Error("Your login can't do that."); e.status = 403; throw e; }
  return { publicUrl: base, sample: !BLANK, ...live.status() };
}

// Sends one email straight through Resend (not the outbox) so the owner sees
// the real result, including Resend's error message.
async function testEmail(token, args) {
  const me = await core.call(token, 'auth.me', {});
  if (me.user.role !== 'owner') { const e = new Error("Your login can't do that."); e.status = 403; throw e; }
  const to = String((args && args.to) || me.user.email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { const e = new Error('Enter a valid email address.'); e.status = 400; throw e; }
  if (!live.on.email) return { to, status: 'off' };
  const r = await live.deliver({ id: 'test', recipient: to, kind: 'test', company: { name: 'LimoRelay', email: 'info@limorelay.com' },
    body: `This is a test email from LimoRelay, sent ${new Date().toUTCString()}. If you can read it, emails from ${base} are working.` });
  return { to, status: r.status, error: r.error || '' };
}

// Sends one text straight through Twilio, then asks Twilio how it went, so the
// owner sees carrier blocks (such as an unregistered A2P number) right away.
const SMS_CODES = {
  30034: 'Blocked because the number is not yet registered for A2P 10DLC. Finish the A2P brand and campaign in Twilio (Messaging, Regulatory compliance) and link this number to the campaign.',
  30032: 'Blocked because this toll-free number is not verified yet. Finish toll-free verification in Twilio.',
  30007: 'The carrier filtered it as spam. Usually fixed by A2P registration.',
  30003: 'The phone is off or can’t be reached.', 30005: 'That number does not exist.', 30006: 'That number can’t get texts (a landline?).',
  21610: 'This phone replied STOP earlier. Text START from it to the business number to opt back in.',
  21608: 'Twilio trial accounts can only text verified numbers. Upgrade the account or verify this number in Twilio.',
};
async function testSms(token, args) {
  const me = await core.call(token, 'auth.me', {});
  if (me.user.role !== 'owner') { const e = new Error("Your login can't do that."); e.status = 403; throw e; }
  const to = live.e164((args && args.to) || '');
  if (!to) { const e = new Error('Enter a mobile number, for example (206) 555-0123.'); e.status = 400; throw e; }
  if (!live.on.sms) return { to, status: 'off' };
  const r = await live.deliver({ id: 'test', recipient: to, kind: 'test', company: { name: 'LimoRelay' }, body: `LimoRelay test text, sent ${new Date().toUTCString()}. If you got this, texts from ${base} are working. Reply STOP to opt out.` });
  if (r.status !== 'sent') return { to, status: r.status, error: r.error || '' };
  let st = { status: 'queued', code: null, message: '' };
  for (let i = 0; i < 4; i++) {
    await new Promise((ok) => setTimeout(ok, 2500));
    try { st = await live.smsStatus(r.via); } catch (e) { break; }
    if (['delivered', 'undelivered', 'failed'].includes(st.status)) break;
  }
  return { to, status: st.status, code: st.code, error: st.code ? (SMS_CODES[st.code] || st.message || `Twilio error ${st.code}`) : '' };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return send(res, 200, { ok: true });
  if (url.pathname.startsWith('/co-icon/')) {
    const slug = url.pathname.slice(9).replace(/\.svg$/, '');
    coIconSvg(slug).then((svg) => { if (!svg) return send(res, 404, 'Not found', 'text/plain'); res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', ...SECURITY_HEADERS }); res.end(svg); }).catch(() => send(res, 500, 'Error', 'text/plain'));
    return;
  }
  if (url.pathname.startsWith('/logo/')) {
    const slug = url.pathname.slice(6).replace(/\.\w+$/, '');
    core.logo(slug).then((l) => { if (!l) return send(res, 404, 'Not found', 'text/plain'); res.writeHead(200, { 'Content-Type': l.type, 'Cache-Control': 'public, max-age=86400' }); res.end(l.buf); }).catch(() => send(res, 500, 'Error', 'text/plain'));
    return;
  }
  if (url.pathname.startsWith('/pay/')) {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
    req.on('end', () => payRoute(req, res, url, Buffer.concat(chunks).toString('utf8')));
    return;
  }
  if (url.pathname.startsWith('/twilio/')) {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 1e5) req.destroy(); else chunks.push(c); });
    req.on('end', () => twilioRoute(req, res, url, Buffer.concat(chunks).toString('utf8')));
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
    if (method.startsWith('public.aff') && args && typeof args === 'object') args.__ip = String(clientIp(req) || '').slice(0, 64);
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    try {
      if (method === 'owner.connections') return send(res, 200, { ok: true, data: await connections(token) });
      if (method === 'owner.testEmail') return send(res, 200, { ok: true, data: await testEmail(token, args) });
      if (method === 'owner.testSms') return send(res, 200, { ok: true, data: await testSms(token, args) });
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
  console.log(`LimoRelay running at http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}${BLANK ? ' (no sample data)' : ''}`);
  const st = live.status();
  console.log('Connections: ' + Object.entries(st).map(([k, v]) => `${k} ${v.on ? 'on' : 'simulated'}`).join(', '));
});
