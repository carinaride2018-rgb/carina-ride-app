'use strict';
/*
 * HighLevel (GoHighLevel / LeadConnector) API, for the link in core.js.
 * Uses a sub-account Private Integration token (HighLevel: Settings, Private
 * Integrations) with these scopes: contacts.readonly, opportunities.readonly,
 * opportunities.write. No dependencies: Node 18+ fetch.
 */
const BASE = 'https://services.leadconnectorhq.com';
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function api(token, method, path, body) {
  let r;
  try {
    r = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { const err = new Error(`HighLevel could not be reached (${e.message}).`); err.retry = true; throw err; }
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch (e) { /* not JSON */ }
  if (!r.ok) {
    const msg = String((Array.isArray(j.message) ? j.message.join(', ') : j.message) || j.error || text || r.statusText).slice(0, 160);
    const err = new Error(r.status === 401 ? 'HighLevel refused the token. Check it is the whole Private Integration token and that it has the contacts and opportunities scopes.'
      : r.status === 403 ? `HighLevel says the token can't do this (${msg}). Check the token's scopes and that it belongs to this sub-account.` : `HighLevel ${r.status}: ${msg}`);
    err.status = r.status;
    throw err;
  }
  return j;
}

// 10-digit US numbers get +1; others keep their own country code.
function e164(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return d.length >= 8 ? '+' + d : '';
}

function createHighLevel() {
  const pipeCache = new Map();
  async function pipelines(token, locationId) {
    const k = locationId + ':' + token.slice(-8), hit = pipeCache.get(k);
    if (hit && Date.now() - hit.at < 10 * 60e3) return hit.list;
    const j = await api(token, 'GET', `/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`);
    const list = (j.pipelines || []).map((p) => ({ id: p.id, name: p.name, stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name })) }));
    pipeCache.set(k, { at: Date.now(), list });
    return list;
  }
  async function stages(job) {
    const list = await pipelines(job.token, job.locationId);
    const p = list.find((x) => norm(x.name) === norm(job.pipeline)) || (list.length === 1 ? list[0] : null);
    if (!p) throw new Error(`HighLevel has no pipeline named "${job.pipeline}". Pipelines there: ${list.map((x) => x.name).join(', ') || 'none'}.`);
    const st = (n) => p.stages.find((s) => norm(s.name) === norm(n)) || null;
    return { pipeline: p, booked: st(job.bookedStage), done: st(job.doneStage) };
  }
  async function findContact(job) {
    if (job.contactId) return job.contactId;
    const tries = [];
    const phone = e164(job.phone);
    if (phone) tries.push({ number: phone });
    if (job.email) tries.push({ email: job.email });
    for (const t of tries) {
      const j = await api(job.token, 'GET', `/contacts/search/duplicate?${new URLSearchParams({ locationId: job.locationId, ...t })}`);
      if (j.contact && j.contact.id) return j.contact.id;
    }
    return '';
  }
  async function findOpportunity(job, pipelineId, contactId) {
    const j = await api(job.token, 'GET', `/opportunities/search?${new URLSearchParams({ location_id: job.locationId, contact_id: contactId, pipeline_id: pipelineId, limit: '20' })}`);
    const list = (j.opportunities || []).slice().sort((a, b) => String(b.createdAt || b.dateAdded || '').localeCompare(String(a.createdAt || a.dateAdded || '')));
    // A new booking moves the contact's open quote; a finished or cancelled ride
    // may also find the one it moved before (already won).
    return list.find((o) => o.status === 'open') || (job.want === 'booked' ? null : list[0]) || null;
  }
  // Moves the contact's HighLevel quote to match the ride. Returns
  // { ok, oppId, contactId } or { skip } when HighLevel has nothing to move.
  async function sync(job) {
    const s = await stages(job);
    let oppId = job.opportunityId, contactId = job.contactId;
    if (!oppId) {
      contactId = await findContact(job);
      if (!contactId) return { skip: 'No HighLevel contact with this phone or email' };
      const o = await findOpportunity(job, s.pipeline.id, contactId);
      if (!o) return { skip: 'No open quote for this contact in HighLevel' };
      oppId = o.id;
    }
    const stage = job.want === 'done' ? s.done : job.want === 'booked' ? s.booked : null;
    const body = job.want === 'lost' ? { status: 'lost' }
      : { pipelineId: s.pipeline.id, status: 'won', ...(stage ? { pipelineStageId: stage.id } : {}), ...(job.value > 0 ? { monetaryValue: job.value } : {}) };
    try { await api(job.token, 'PUT', `/opportunities/${encodeURIComponent(oppId)}`, body); }
    catch (e) {
      // The quote was deleted in HighLevel: look it up again next time.
      if (e.status === 404 && job.opportunityId) { const err = new Error('That HighLevel quote is gone. Looking for another one next time.'); err.lostOpp = true; throw err; }
      throw e;
    }
    return { ok: true, oppId, contactId };
  }
  // The Test button: can the token read the pipeline and its stages?
  async function test(job) {
    if (!job.token) return { ok: false, error: 'Paste the Private Integration token first.' };
    if (!job.locationId) return { ok: false, error: 'Enter the Location ID first.' };
    pipeCache.clear();
    const s = await stages(job);
    const miss = [[job.bookedStage, s.booked], [job.doneStage, s.done]].filter(([, x]) => !x).map(([n]) => `"${n}"`);
    if (miss.length) return { ok: false, error: `The pipeline "${s.pipeline.name}" has no stage ${miss.join(' or ')}. Its stages: ${s.pipeline.stages.map((x) => x.name).join(', ')}.` };
    return { ok: true, note: `Connected. Pipeline "${s.pipeline.name}", stages ${s.booked.name} and ${s.done.name} found.` };
  }
  return { sync, test };
}

module.exports = { createHighLevel, e164 };
