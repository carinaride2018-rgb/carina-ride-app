'use strict';
// Phone notifications for the App Store and Google Play apps, without extra
// packages. Android goes through Firebase Cloud Messaging (FCM v1), iPhone
// straight to Apple (APNs). Web Push (webpush.js) keeps serving browsers and
// home-screen installs; this only handles subscriptions saved by the store apps,
// whose endpoint looks like "fcm:<token>" or "apns:<token>".
//
// Settings (each half is optional; leave one out and that platform is skipped):
//   FCM_SERVICE_ACCOUNT  the Firebase service account JSON, pasted whole
//   APNS_KEY             the .p8 key text from Apple (Keys > Apple Push Notifications)
//   APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID (e.g. com.limorelay.app)
//   APNS_SANDBOX=on      only for test builds run from Xcode
const crypto = require('crypto');
const http2 = require('http2');

const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
const isNative = (endpoint) => /^(fcm|apns):/.test(String(endpoint || ''));

function createNativePush(env) {
  let fcm = null, apns = null;
  if (env.FCM_SERVICE_ACCOUNT) {
    try {
      const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT);
      fcm = { sa, key: crypto.createPrivateKey(sa.private_key), token: '', until: 0 };
    } catch (e) { console.error('FCM_SERVICE_ACCOUNT is not valid JSON:', e.message); }
  }
  if (env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_BUNDLE_ID) {
    try {
      apns = {
        key: crypto.createPrivateKey(env.APNS_KEY.replace(/\\n/g, '\n')),
        host: env.APNS_HOST || (env.APNS_SANDBOX === 'on' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com'),
        jwt: '', at: 0, session: null,
      };
    } catch (e) { console.error('APNS_KEY is not a valid .p8 key:', e.message); }
  }
  if (!fcm && !apns) return null;

  // Google: trade a signed note for an access token, good for an hour.
  async function fcmToken() {
    if (fcm.token && Date.now() < fcm.until) return fcm.token;
    const now = Math.floor(Date.now() / 1000), uri = fcm.sa.token_uri || 'https://oauth2.googleapis.com/token';
    const body = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ iss: fcm.sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: uri, iat: now, exp: now + 3600 })}`;
    const jwt = `${body}.${crypto.sign('sha256', Buffer.from(body), fcm.key).toString('base64url')}`;
    const res = await fetch(uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}` });
    const j = await res.json();
    if (!res.ok || !j.access_token) throw new Error('Firebase sign-in failed: ' + (j.error_description || j.error || res.status));
    fcm.token = j.access_token; fcm.until = Date.now() + (Number(j.expires_in || 3600) - 300) * 1000;
    return fcm.token;
  }
  async function sendFcm(token, p) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${fcm.sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + await fcmToken(), 'content-type': 'application/json' },
      body: JSON.stringify({ message: {
        token,
        notification: { title: p.title || '', body: p.body || '' },
        data: { hash: String(p.hash || ''), tag: String(p.tag || '') },
        android: { priority: 'high', notification: { tag: String(p.tag || ''), sound: 'default' } },
      } }),
    });
    if (res.ok) return 'sent';
    const j = await res.json().catch(() => ({}));
    const code = JSON.stringify(j.error || {});
    if (res.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(code)) return 'gone';
    if (res.status === 400 && /INVALID_ARGUMENT/.test(code) && /token/i.test(code)) return 'gone';
    throw new Error('FCM ' + res.status + ' ' + code.slice(0, 200));
  }

  // Apple: a signed note (renewed every 50 minutes) over one HTTP/2 connection.
  function apnsJwt() {
    if (apns.jwt && Date.now() - apns.at < 50 * 60e3) return apns.jwt;
    const body = `${b64u({ alg: 'ES256', kid: env.APNS_KEY_ID })}.${b64u({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })}`;
    apns.jwt = `${body}.${crypto.sign('sha256', Buffer.from(body), { key: apns.key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    apns.at = Date.now();
    return apns.jwt;
  }
  function apnsSession() {
    if (apns.session && !apns.session.closed && !apns.session.destroyed) return apns.session;
    apns.session = http2.connect(apns.host);
    apns.session.on('error', () => { apns.session = null; });
    apns.session.on('goaway', () => { apns.session = null; });
    apns.session.setTimeout(10 * 60e3, () => { if (apns.session) apns.session.close(); apns.session = null; });
    return apns.session;
  }
  function sendApns(token, p) {
    const payload = JSON.stringify({ aps: { alert: { title: p.title || '', body: p.body || '' }, sound: 'default', 'thread-id': String(p.tag || '') }, hash: p.hash || '', tag: p.tag || '' });
    return new Promise((resolve, reject) => {
      const req = apnsSession().request({
        ':method': 'POST', ':path': '/3/device/' + token,
        authorization: 'bearer ' + apnsJwt(), 'apns-topic': env.APNS_BUNDLE_ID,
        'apns-push-type': 'alert', 'apns-priority': '10', 'content-type': 'application/json',
        ...(p.tag ? { 'apns-collapse-id': String(p.tag).slice(0, 64) } : {}),
      });
      let status = 0, data = '';
      req.setTimeout(15000, () => { req.close(); reject(new Error('APNs timed out')); });
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        if (status === 200) return resolve('sent');
        if (status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(data)) return resolve('gone');
        reject(new Error('APNs ' + status + ' ' + data.slice(0, 200)));
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  return {
    ready: { android: !!fcm, ios: !!apns },
    // Same shape as webpush.js send(): resolves 'sent', 'gone' or 'skipped'.
    async send(sub, payload) {
      const m = /^(fcm|apns):(.+)$/.exec(String(sub.endpoint || ''));
      if (!m) return 'skipped';
      try {
        if (m[1] === 'fcm') return fcm ? await sendFcm(m[2], payload) : 'skipped';
        return apns ? await sendApns(m[2], payload) : 'skipped';
      } catch (e) { console.error('phone notification', e.message); return 'error'; }
    },
  };
}

module.exports = { createNativePush, isNative };
