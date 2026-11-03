/*
 * Other card gateways a limo company can pick instead of Stripe:
 *
 *   Authorize.net   the company's own API Login ID + Transaction Key.
 *                   Cards are saved in Authorize.net Customer Profiles (CIM):
 *                   the customer types the card on Authorize.net's hosted
 *                   page, we keep only the profile ids and charge them later.
 *   PayPal          the company's own REST app Client ID + Secret.
 *                   The customer approves on PayPal (vault, "save for later");
 *                   we keep the vault token and charge it later.
 *
 * Both work like the Stripe flow: save the card on the gateway's page, come
 * back, charge it off-session (fare, extras, fees), refund it on cancel.
 * Credentials never leave the server; core.js keeps them sealed (see server.js).
 * No dependencies: Node 18+ fetch only.
 */
'use strict';
const crypto = require('crypto');

const TIMEOUT_MS = 20000;
async function http(url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = (await r.text()).replace(/^﻿/, '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    return { status: r.status, data, text };
  } finally { clearTimeout(timer); }
}
const usd = (cents) => (Math.round(cents) / 100).toFixed(2);
const cut = (s, n) => String(s || '').slice(0, n);
class GatewayError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }

// ---- Authorize.net (JSON API, Customer Profiles) ------------------------------
function authnet(cred) {
  const api = cred.sandbox ? 'https://apitest.authorize.net/xml/v1/request.api' : 'https://api.authorize.net/xml/v1/request.api';
  const auth = { name: cred.loginId, transactionKey: cred.key };
  async function call(name, body) {
    const r = await http(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [name]: { merchantAuthentication: auth, ...body } }) });
    if (!r.data) throw new GatewayError(`Authorize.net answered ${r.status}`, r.status >= 500 ? 502 : r.status || 502);
    return r.data;
  }
  const errOf = (d) => {
    const tr = d && d.transactionResponse;
    const e = tr && tr.errors && tr.errors[0];
    if (e) return e.errorText;
    const m = d && d.messages && d.messages.message && d.messages.message[0];
    return m ? m.text : 'Authorize.net error';
  };
  const ok = (d) => d && d.messages && d.messages.resultCode === 'Ok';
  return {
    async verify() {
      const d = await call('authenticateTestRequest', {});
      if (!ok(d)) throw new GatewayError(`Authorize.net: ${errOf(d)}`, 400);
      return true;
    },
    // A customer profile, then a one-time token for Authorize.net's hosted "add card" page.
    async setup(p, returnUrl) {
      const d = await call('createCustomerProfileRequest', { profile: { merchantCustomerId: cut(crypto.randomBytes(8).toString('hex'), 20), description: cut(p.description, 255), ...(p.email ? { email: cut(p.email, 255) } : {}) }, validationMode: 'none' });
      if (!ok(d) || !d.customerProfileId) throw new GatewayError(`Authorize.net: ${errOf(d)}`, 400);
      const h = await call('getHostedProfilePageRequest', { customerProfileId: d.customerProfileId, hostedProfileSettings: { setting: [
        { settingName: 'hostedProfileReturnUrl', settingValue: returnUrl },
        { settingName: 'hostedProfileReturnUrlText', settingValue: 'Continue' },
        { settingName: 'hostedProfilePageBorderVisible', settingValue: 'true' },
        { settingName: 'hostedProfileManageOptions', settingValue: 'showPayment' },
        { settingName: 'hostedProfileValidationMode', settingValue: cred.sandbox ? 'testMode' : 'liveMode' },
        { settingName: 'hostedProfileBillingAddressOptions', settingValue: 'showNone' },
      ] } });
      if (!ok(h) || !h.token) throw new GatewayError(`Authorize.net: ${errOf(h)}`, 400);
      return { customer: d.customerProfileId, token: h.token, postUrl: cred.sandbox ? 'https://test.authorize.net/customer/addPayment' : 'https://accept.authorize.net/customer/addPayment' };
    },
    // The card the customer just added (the newest payment profile).
    async cardOf(s) {
      const d = await call('getCustomerProfileRequest', { customerProfileId: s.customer, unmaskExpirationDate: true });
      const list = (ok(d) && d.profile && d.profile.paymentProfiles) || [];
      const pp = list[list.length - 1];
      if (!pp || !pp.customerPaymentProfileId) return null;
      const cc = (pp.payment && pp.payment.creditCard) || {};
      const exp = /^(\d{4})-(\d{2})$/.exec(cc.expirationDate || '');
      return { customer: s.customer, pm: pp.customerPaymentProfileId, brand: cc.cardType || 'Card', last4: String(cc.cardNumber || '').replace(/\D/g, '').slice(-4), exp: exp ? `${exp[2]}/${exp[1].slice(2)}` : '' };
    },
    async charge(x) {
      const profile = { customerProfileId: x.customer, paymentProfile: { paymentProfileId: x.pm } };
      const run = (tx) => call('createTransactionRequest', { refId: cut(x.id, 20), transactionRequest: tx });
      const result = (d) => {
        const tr = d && d.transactionResponse;
        if (tr && tr.responseCode === '1') return { ok: true, ref: tr.transId };
        if (tr && tr.responseCode === '4') return { ok: true, ref: tr.transId, held: true };
        return { ok: false, error: errOf(d) };
      };
      try {
        if (x.kind === 'refund') {
          // A refund needs the charge to have settled (overnight); before that,
          // a full refund is a void of the charge.
          const d = await run({ transactionType: 'refundTransaction', amount: usd(x.amount), profile, refTransId: x.refundOf });
          const r = result(d);
          if (r.ok || !(x.origAmount && x.amount >= x.origAmount)) return r;
          return result(await run({ transactionType: 'voidTransaction', refTransId: x.refundOf }));
        }
        return result(await run({ transactionType: 'authCaptureTransaction', amount: usd(x.amount), profile, order: { invoiceNumber: cut(x.meta && (x.meta.trip || x.meta.invoice), 20), description: cut(x.description, 255) } }));
      } catch (e) {
        return { retry: true, error: e.message };
      }
    },
  };
}

// ---- PayPal (REST, vault v3) ---------------------------------------------------
const ppTokens = new Map();
function paypal(cred) {
  const base = cred.sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  async function token() {
    const k = `${cred.sandbox ? 's' : 'l'}:${cred.clientId}`;
    const t = ppTokens.get(k);
    if (t && t.until > Date.now()) return t.token;
    const r = await http(`${base}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${cred.clientId}:${cred.secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    if (r.status !== 200 || !r.data || !r.data.access_token) throw new GatewayError(`PayPal: ${(r.data && (r.data.error_description || r.data.error)) || 'sign-in failed'}`, r.status >= 500 ? 502 : 400);
    ppTokens.set(k, { token: r.data.access_token, until: Date.now() + Math.max(60, (r.data.expires_in || 3000) - 120) * 1000 });
    return r.data.access_token;
  }
  async function call(method, path, body, reqId) {
    const r = await http(`${base}${path}`, { method, headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', ...(reqId ? { 'PayPal-Request-Id': reqId } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (r.status >= 400) {
      const d = r.data || {};
      const msg = (d.details && d.details[0] && (d.details[0].description || d.details[0].issue)) || d.message || `PayPal answered ${r.status}`;
      throw new GatewayError(`PayPal: ${msg}`, r.status, d);
    }
    return r.data || {};
  }
  return {
    async verify() { await token(); return true; },
    // A setup token: the customer approves on PayPal to let the company charge later.
    async setup(p, returnUrl, cancelUrl) {
      const d = await call('POST', '/v3/vault/setup-tokens', { payment_source: { paypal: { description: cut(p.description, 127), usage_type: 'MERCHANT', customer_type: 'CONSUMER', permit_multiple_payment_tokens: true,
        experience_context: { return_url: returnUrl, cancel_url: cancelUrl, shipping_preference: 'NO_SHIPPING', brand_name: cut(p.brand || '', 127) || undefined, vault_instruction: 'ON_PAYER_APPROVAL' } } } }, crypto.randomUUID());
      const link = (d.links || []).find((l) => l.rel === 'approve');
      if (!d.id || !link) throw new GatewayError('PayPal did not return an approval page.', 502);
      return { token: d.id, url: link.href };
    },
    async cardOf(s) {
      const d = await call('POST', '/v3/vault/payment-tokens', { payment_source: { token: { id: s.token, type: 'SETUP_TOKEN' } } }, `pt-${s.token}`);
      if (!d.id) return null;
      const pp = (d.payment_source && d.payment_source.paypal) || {};
      return { customer: (d.customer && d.customer.id) || '', pm: d.id, brand: 'PayPal', last4: '', label: cut(pp.email_address || '', 120), exp: '' };
    },
    async charge(x) {
      try {
        if (x.kind === 'refund') {
          const d = await call('POST', `/v2/payments/captures/${encodeURIComponent(x.refundOf)}/refund`, { amount: { currency_code: 'USD', value: usd(x.amount) } }, x.id);
          return d.status === 'COMPLETED' || d.status === 'PENDING' ? { ok: true, ref: d.id } : { ok: false, error: `Refund ${String(d.status || '').toLowerCase()}` };
        }
        const d = await call('POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: usd(x.amount) }, description: cut(x.description, 127), ...(x.meta && x.meta.trip ? { invoice_id: cut(`${x.meta.trip}-${x.id}`, 127) } : {}) }], payment_source: { paypal: { vault_id: x.pm } } }, x.id);
        const cap = d.purchase_units && d.purchase_units[0] && d.purchase_units[0].payments && d.purchase_units[0].payments.captures && d.purchase_units[0].payments.captures[0];
        if (d.status === 'COMPLETED' && cap && (cap.status === 'COMPLETED' || cap.status === 'PENDING')) return { ok: true, ref: cap.id };
        return { ok: false, error: cap ? `Payment ${String(cap.status).toLowerCase()}` : `Payment ${String(d.status || 'failed').toLowerCase()}` };
      } catch (e) {
        if (!e.status || e.status >= 500 || e.status === 429) return { retry: true, error: e.message };
        return { ok: false, error: e.message };
      }
    },
  };
}

const GATEWAYS = { authnet, paypal };
const gateway = (g) => {
  const make = g && GATEWAYS[g.kind];
  if (!make) throw new GatewayError('Unknown payment service.', 400);
  return make(g.cred || {});
};
module.exports = { gateway, GatewayError };
