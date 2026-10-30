'use strict';
// A small PDF writer for booking emails, with no outside packages.
// bookingPdf(m, label) turns one outbox message into a printable Letter page:
// the company's logo and name on top, the "Label: value" lines as a table,
// other lines as paragraphs, and the company's phone and email at the bottom.
const zlib = require('zlib');

// Helvetica glyph widths (1/1000 em) for ASCII 32..126, from the standard AFM.
const HW = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
// Helvetica-Bold widths for the same range.
const HBW = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

// The standard fonts use WinAnsi: keep ASCII, map common typographic marks,
// and replace anything else so the PDF never shows broken characters.
const ANSI = { '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '·': 0xb7, '…': 0x85, 'é': 0xe9, 'è': 0xe8, 'á': 0xe1, 'ñ': 0xf1, 'ü': 0xfc, 'ö': 0xf6, 'ä': 0xe4, ' ': 0x20 };
function ansi(s) {
  let out = '';
  for (const ch of String(s == null ? '' : s)) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c < 127) out += ch;
    else if (ANSI[ch]) out += String.fromCharCode(ANSI[ch]);
    else if (c === 0x2192) out += '->';
    else out += '?';
  }
  return out;
}
function width(s, size, bold) {
  const w = bold ? HBW : HW;
  let t = 0;
  for (const ch of ansi(s)) { const c = ch.charCodeAt(0); t += c >= 32 && c < 127 ? w[c - 32] : 556; }
  return (t * size) / 1000;
}
function wrap(text, size, bold, max) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (width(next, size, bold) <= max) { line = next; continue; }
      if (line) out.push(line);
      // A word longer than the line (a long email or link) is cut by character.
      let w = word;
      while (width(w, size, bold) > max) {
        let n = w.length;
        while (n > 1 && width(w.slice(0, n), size, bold) > max) n--;
        out.push(w.slice(0, n)); w = w.slice(n);
      }
      line = w;
    }
    out.push(line);
  }
  return out;
}
const pstr = (s) => `(${ansi(s).replace(/[\\()]/g, (c) => '\\' + c)})`;
const rgb = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); const n = parseInt(m ? m[1] : '222222', 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((x) => x.toFixed(3)).join(' '); };

// ---- Images: PNG (8-bit, not interlaced) and JPEG ----------------------------
function decodeImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  try { return /png/i.test(m[1]) ? decodePng(buf) : decodeJpeg(buf); } catch (e) { return null; }
}
function decodeJpeg(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const mk = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) {
      const h = buf.readUInt16BE(i + 5), w = buf.readUInt16BE(i + 7), comps = buf[i + 9];
      return { w, h, filter: '/DCTDecode', cs: comps === 1 ? '/DeviceGray' : comps === 4 ? '/DeviceCMYK' : '/DeviceRGB', data: buf, smask: null };
    }
    i += 2 + len;
  }
  return null;
}
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  let p = 8, w, h, depth, type, interlace, plte = null, trns = null; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
    else if (kind === 'PLTE') plte = d;
    else if (kind === 'tRNS') trns = d;
    else if (kind === 'IDAT') idat.push(d);
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace) return null;
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!ch) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0, b = y ? px[dst - stride + x] : 0, c = x >= ch && y ? px[dst - stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  const color = Buffer.alloc(w * h * 3), alpha = Buffer.alloc(w * h); let hasAlpha = false;
  for (let i = 0; i < w * h; i++) {
    let r, g, b, al = 255;
    if (type === 2) { r = px[i * 3]; g = px[i * 3 + 1]; b = px[i * 3 + 2]; }
    else if (type === 6) { r = px[i * 4]; g = px[i * 4 + 1]; b = px[i * 4 + 2]; al = px[i * 4 + 3]; }
    else if (type === 0) { r = g = b = px[i]; }
    else if (type === 4) { r = g = b = px[i * 2]; al = px[i * 2 + 1]; }
    else { const k = px[i]; r = plte[k * 3]; g = plte[k * 3 + 1]; b = plte[k * 3 + 2]; if (trns && k < trns.length) al = trns[k]; }
    color[i * 3] = r; color[i * 3 + 1] = g; color[i * 3 + 2] = b; alpha[i] = al; if (al < 255) hasAlpha = true;
  }
  return { w, h, filter: '/FlateDecode', cs: '/DeviceRGB', data: zlib.deflateSync(color), smask: hasAlpha ? zlib.deflateSync(alpha) : null };
}

// ---- Page content from the message -------------------------------------------
// Same reading as the HTML email: blank lines split blocks; a block of
// "Label: value" lines is a table, anything else is a paragraph.
function parseBody(m) {
  const co = m.company || {};
  let lines = String(m.body || '').replace(/\r/g, '').split('\n');
  if (lines.length && co.name && lines[0].trim() === `${co.name}:`) lines = lines.slice(1);
  lines = lines.filter((l) => !/^Terms and Conditions:\s*\S+\s*$/.test(l));
  const blocks = []; let cur = [];
  for (const l of lines) { if (l.trim()) cur.push(l); else if (cur.length) { blocks.push(cur); cur = []; } }
  if (cur.length) blocks.push(cur);
  const kv = (l) => { const x = l.match(/^([A-Z][A-Za-z ]{1,32}):\s+(.+)$/); return x && !/^https?:/.test(x[1]) ? [x[1], x[2]] : null; };
  return blocks.map((b) => { const rows = b.map(kv); return rows.every(Boolean) && b.length > 1 ? { rows } : { text: b.join('\n') }; });
}

function bookingPdf(m, title) {
  const co = m.company || {};
  const brand = /^#[0-9a-f]{6}$/i.test(co.color || '') ? co.color : '#222222';
  const W = 612, H = 792, L = 54, R = W - 54, CW = R - L;
  const pages = []; let ops = [], y = 0;
  const img = decodeImage(co.logoData);
  const text = (s, x, yy, size, bold, color) => ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color || '#111111')} rg ${x.toFixed(2)} ${yy.toFixed(2)} Td ${pstr(s)} Tj ET`);
  const rect = (x, yy, w, h, color) => ops.push(`${rgb(color)} rg ${x.toFixed(2)} ${yy.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  const line = (x1, y1, x2, y2, color, wd) => ops.push(`${rgb(color)} RG ${wd || 0.6} w ${x1} ${y1.toFixed(2)} m ${x2} ${y2.toFixed(2)} l S`);
  const footer = () => {
    line(L, 58, R, 58, '#d9d9d9');
    const bits = [co.name, co.phone, co.email].filter(Boolean).join('   |   ');
    text(bits, L, 42, 9, false, '#555555');
    const n = `Page ${pages.length + 1}`;
    text(n, R - width(n, 9), 42, 9, false, '#555555');
  };
  const newPage = (first) => {
    if (!first) { footer(); pages.push(ops.join('\n')); ops = []; }
    if (first) {
      // Header: white with the logo on the left, the document title on the right,
      // and a band in the company color under it.
      const top = H - 40;
      if (img) {
        const bh = 78, bw = Math.min(200, (img.w / img.h) * bh);
        ops.push(`q ${bw.toFixed(2)} 0 0 ${(bw * img.h / img.w).toFixed(2)} ${L} ${(top - bw * img.h / img.w).toFixed(2)} cm /Im1 Do Q`);
      }
      if (!img) text(co.name || '', L, top - 30, 20, true, '#111111');
      const t1 = String(title || 'Booking').toUpperCase();
      text(t1, R - width(t1, 9, true), top - 14, 9, true, brand);
      const t2 = m.ref || '';
      if (t2) text(t2, R - width(t2, 22, true), top - 40, 22, true, '#111111');
      const t3 = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      text(`Issued ${t3}`, R - width(`Issued ${t3}`, 9), top - 56, 9, false, '#666666');
      rect(L, top - 98, CW, 3, brand);
      y = top - 130;
    } else y = H - 60;
  };
  const need = (h) => { if (y - h < 80) newPage(false); };
  newPage(true);

  for (const b of parseBody(m)) {
    if (b.text) {
      for (const l of wrap(b.text, 11, false, CW)) { need(16); text(l, L, y, 11, false, '#222222'); y -= 15.5; }
      y -= 10;
      continue;
    }
    // A table: label column in gray, value in bold, a thin rule between rows.
    const lw = 150, vx = L + lw + 12, vw = R - vx - 10;
    need(30);
    line(L, y + 12, R, y + 12, '#111111', 1);
    b.rows.forEach(([k, v], i) => {
      const vl = wrap(v, 11, true, vw), h = Math.max(1, vl.length) * 15 + 12;
      need(h);
      if (i % 2 === 0) rect(L, y - h + 12, CW, h, '#f5f5f5');
      text(k.toUpperCase(), L + 10, y - 3, 8, true, '#666666');
      vl.forEach((t, j) => text(t, vx, y - 4 - j * 15, 11, true, '#111111'));
      y -= h;
      line(L, y + 12, R, y + 12, '#e2e2e2');
    });
    y -= 20;
  }
  // Passenger copies get a reminder to keep the page; the office copy doesn't.
  if (['confirm', 'changed', 'receipt'].includes(m.kind)) { need(40); text('Please keep this page with you on the day of your ride.', L, y, 9, false, '#666666'); }
  footer(); pages.push(ops.join('\n'));

  // ---- Assemble the objects ----
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const catalog = add(null), pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  let imObj = null;
  if (img) {
    const sm = img.smask ? add({ dict: `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, data: img.smask }) : null;
    imObj = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace ${img.cs} /BitsPerComponent 8 /Filter ${img.filter}${sm ? ` /SMask ${sm} 0 R` : ''}`, data: img.data });
  }
  const kids = pages.map((c) => {
    const content = add({ dict: '<< /Filter /FlateDecode', data: zlib.deflateSync(Buffer.from(c, 'latin1')) });
    return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${imObj ? ` /XObject << /Im1 ${imObj} 0 R >>` : ''} >> /Contents ${content} 0 R >>`);
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title ${pstr(`${co.name || ''} ${title || ''}`.trim())} /Producer (LimoRelay) >>`);

  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = parts[0].length; const xref = [];
  objs.forEach((o, i) => {
    xref.push(pos);
    const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
    const body = typeof o === 'string' ? Buffer.from(o + '\n', 'latin1')
      : Buffer.concat([Buffer.from(`${o.dict} /Length ${o.data.length} >>\nstream\n`, 'latin1'), o.data, Buffer.from('\nendstream\n', 'latin1')]);
    const tail = Buffer.from('endobj\n', 'latin1');
    parts.push(head, body, tail); pos += head.length + body.length + tail.length;
  });
  const xs = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${xref.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xs, 'latin1'));
  return Buffer.concat(parts);
}

module.exports = { bookingPdf, parseBody };
