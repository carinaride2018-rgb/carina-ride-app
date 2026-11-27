/*
 * A small WebSocket server side (RFC 6455), text messages only, no dependencies.
 * Used for Twilio ConversationRelay (the fast phone voice in phoneagent.js).
 *
 *   const ws = accept(req, socket, head);   // from server.on('upgrade')
 *   ws.onmessage = (text) => {}; ws.onclose = () => {};
 *   ws.send('...'); ws.close();
 */
'use strict';
const crypto = require('crypto');

const MAX = 1 << 20; // 1 MB per message is plenty for JSON from Twilio

function accept(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const acceptKey = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`);
  socket.setNoDelay(true);
  socket.setTimeout(0);

  const ws = { open: true, onmessage: null, onclose: null, send, close };
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let parts = [], partsLen = 0;

  function frame(op, payload) {
    const len = payload.length;
    const h = len < 126 ? Buffer.from([0x80 | op, len])
      : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255])
      : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
    return Buffer.concat([h, payload]);
  }
  function send(text) {
    if (!ws.open) return false;
    try { socket.write(frame(1, Buffer.from(String(text), 'utf8'))); return true; } catch (e) { return false; }
  }
  function close(code) {
    if (!ws.open) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code || 1000, 0);
    try { socket.write(frame(8, p)); } catch (e) { /* already gone */ }
    done();
    setTimeout(() => socket.destroy(), 1000).unref();
  }
  function done() {
    if (!ws.open) return;
    ws.open = false;
    if (ws.onclose) try { ws.onclose(); } catch (e) { console.error('websocket close', e); }
  }

  function parse() {
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(MAX)) return close(1009); len = Number(big); at = 10; }
      if (len > MAX) return close(1009);
      const need = at + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(at + (masked ? 4 : 0), need);
      if (masked) {
        const m = buf.subarray(at, at + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
      }
      buf = buf.subarray(need);
      if (op === 8) { try { socket.write(frame(8, payload.subarray(0, 2))); } catch (e) { /* gone */ } done(); socket.end(); return; }
      if (op === 9) { try { socket.write(frame(10, payload)); } catch (e) { /* gone */ } continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2 || op === 0) {
        parts.push(payload); partsLen += payload.length;
        if (partsLen > MAX) return close(1009);
        if (fin) {
          const text = Buffer.concat(parts).toString('utf8');
          parts = []; partsLen = 0;
          if (ws.onmessage) Promise.resolve().then(() => ws.onmessage(text)).catch((e) => console.error('websocket message', e));
        }
      }
    }
  }
  socket.on('data', (d) => { buf = buf.length ? Buffer.concat([buf, d]) : d; parse(); });
  socket.on('close', done);
  socket.on('end', done);
  socket.on('error', done);
  if (buf.length) setImmediate(parse);
  return ws;
}

module.exports = { accept };
