'use strict';
// Web Push without extra packages: sends phone notifications through the
// browser's own push service (Apple, Google, Mozilla). No account needed;
// the server signs each message with its own key (VAPID, RFC 8292) and
// encrypts it for the phone (RFC 8291, aes128gcm).
const crypto = require('crypto');
const fs = require('fs');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

// Keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (the usual base64url
// format), or are made once and kept in a file next to the data.
function loadKeys(env, file) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return fromRaw(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  try { const k = JSON.parse(fs.readFileSync(file, 'utf8')); return fromRaw(k.publicKey, k.privateKey); } catch (e) { /* make new ones */ }
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
  try { fs.writeFileSync(file, JSON.stringify({ publicKey: pub, privateKey: jwk.d }), { mode: 0o600 }); } catch (e) { console.error('Could not save push keys:', e.message); }
  return fromRaw(pub, jwk.d);
}
function fromRaw(pub, priv) {
  const raw = unb64u(pub);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('VAPID_PUBLIC_KEY is not a P-256 public key.');
  const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)), d: String(priv) } });
  return { publicKey: b64u(raw), key };
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// Encrypts the message so only that phone can read it.
function encrypt(payload, keys, rand) {
  const uaPub = unb64u(keys.p256dh), auth = unb64u(keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (rand && rand.ephemeral) ecdh.setPrivateKey(rand.ephemeral); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPub);
  const salt = (rand && rand.salt) || crypto.randomBytes(16);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, body]);
}

function createWebPush(env, keyFile) {
  const k = loadKeys(env, keyFile);
  const subject = env.VAPID_SUBJECT || (env.OWNER_EMAIL ? `mailto:${env.OWNER_EMAIL}` : (env.PUBLIC_URL || 'mailto:admin@example.com'));
  const jwts = new Map();
  function vapid(endpoint) {
    const aud = new URL(endpoint).origin, n = Math.floor(Date.now() / 1000);
    const hit = jwts.get(aud);
    if (hit && hit.exp - n > 3600) return hit.header;
    const exp = n + 12 * 3600;
    const data = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify({ aud, exp, sub: subject }))}`;
    const sig = crypto.sign('sha256', Buffer.from(data), { key: k.key, dsaEncoding: 'ieee-p1363' });
    const header = `vapid t=${data}.${b64u(sig)}, k=${k.publicKey}`;
    jwts.set(aud, { exp, header });
    return header;
  }
  // Returns 'sent', 'gone' (the subscription no longer exists) or 'failed'.
  async function send(sub, payload) {
    try {
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high', Authorization: vapid(sub.endpoint) },
        body: encrypt(JSON.stringify(payload), sub.keys),
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 404 || res.status === 410) return 'gone';
      if (!res.ok) { console.error('push', res.status, (await res.text().catch(() => '')).slice(0, 200)); return 'failed'; }
      return 'sent';
    } catch (e) { console.error('push', e.message); return 'failed'; }
  }
  return { publicKey: k.publicKey, send };
}

module.exports = { createWebPush, encrypt };
