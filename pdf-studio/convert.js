// PDF Studio - conversion engine (all client-side).
// To PDF : docx (mammoth), xlsx/csv (exceljs), txt, md, html, images.
// From PDF: png/jpg images, txt, docx (text only), xlsx (heuristic tables).
const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;

// ------------------------------------------------------------ lazy script loading
const loaded = new Map();
export function loadScript(rel) {
  if (!loaded.has(rel)) {
    loaded.set(rel, new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = new URL(rel, import.meta.url).href;
      s.onload = res; s.onerror = () => rej(new Error('Could not load ' + rel)); document.head.appendChild(s);
    }));
  }
  return loaded.get(rel);
}

export const PAGE_SIZES = { A4: [595.28, 841.89], Letter: [612, 792], Legal: [612, 1008], A3: [841.89, 1190.55], A5: [419.53, 595.28] };

export class ConvertError extends Error {}

// ------------------------------------------------------------ fonts + safe text
async function makeFonts(doc) {
  return {
    r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique), bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    m: await doc.embedFont(StandardFonts.Courier), mb: await doc.embedFont(StandardFonts.CourierBold),
  };
}
const hexc = (h) => String.fromCharCode(parseInt(h, 16));
const STRIP_RE = new RegExp('[' + hexc('200B') + '-' + hexc('200F') + hexc('2028') + hexc('2029') + hexc('FEFF') + '\\r\\n]');
const XML_BAD = new RegExp('[' + hexc('0000') + '-' + hexc('0008') + hexc('000B') + hexc('000C') + hexc('000E') + '-' + hexc('001F') + hexc('FFFE') + hexc('FFFF') + ']', 'g');
const okCache = new WeakMap();
export function safe(font, s) {
  let m = okCache.get(font); if (!m) okCache.set(font, (m = new Map()));
  let out = '';
  for (let ch of s) {
    if (ch === ' ' || ch === ' ' || ch === ' ') ch = ' ';
    if (ch === '\t') ch = '    ';
    if (STRIP_RE.test(ch)) continue;
    let ok = m.get(ch);
    if (ok === undefined) { try { font.encodeText(ch); ok = true; } catch { ok = false; } m.set(ch, ok); }
    out += ok ? ch : '?';
  }
  return out;
}
const fontFor = (f, st) => (st.mono ? (st.bold ? f.mb : f.m) : st.bold && st.italic ? f.bi : st.bold ? f.b : st.italic ? f.i : f.r);

// ------------------------------------------------------------ layout engine
class Layout {
  constructor(doc, fonts, { size = PAGE_SIZES.A4, landscape = false, margin = 54 } = {}) {
    this.doc = doc; this.f = fonts; this.m = margin;
    this.W = landscape ? Math.max(...size) : Math.min(...size); this.H = landscape ? Math.min(...size) : Math.max(...size);
    this.page = null; this.y = 0; this.newPage();
  }
  get cw() { return this.W - 2 * this.m; }
  newPage() { this.page = this.doc.addPage([this.W, this.H]); this.y = this.H - this.m; return this.page; }
  ensure(h) { if (this.y - h < this.m) this.newPage(); }
}

function layoutRuns(f, runs, width, size) {
  const lines = []; let cur = { items: [], w: 0 };
  const push = () => {
    while (cur.items.length && cur.items[cur.items.length - 1].sp) cur.w -= cur.items.pop().w;
    lines.push(cur); cur = { items: [], w: 0 };
  };
  for (const run of runs) {
    if (run.br) { push(); continue; }
    if (run.img) continue;
    const sz = size * (run.scale || 1);
    const font = fontFor(f, run);
    for (const tok of run.text.split(/(\s+)/)) {
      if (!tok) continue;
      if (/^\s+$/.test(tok)) {
        if (cur.items.length) { const w = font.widthOfTextAtSize(' ', sz); cur.items.push({ t: ' ', font, w, run, sz, sp: true }); cur.w += w; }
        continue;
      }
      const t = safe(font, tok); const w = font.widthOfTextAtSize(t, sz);
      if (cur.w + w > width && cur.items.length) push();
      if (w > width) {
        let part = '';
        for (const ch of t) {
          if (part && font.widthOfTextAtSize(part + ch, sz) > width) {
            if (cur.items.length) push();
            cur.items.push({ t: part, font, w: font.widthOfTextAtSize(part, sz), run, sz }); cur.w += font.widthOfTextAtSize(part, sz); push(); part = '';
          }
          part += ch;
        }
        if (part) { const pw = font.widthOfTextAtSize(part, sz); cur.items.push({ t: part, font, w: pw, run, sz }); cur.w += pw; }
      } else { cur.items.push({ t, font, w, run, sz }); cur.w += w; }
    }
  }
  if (cur.items.length) push();
  return lines;
}

const LINK = rgb(0.1, 0.3, 0.8);
function drawLines(L, lines, x, size, { color = rgb(0, 0, 0), bullet = null, lh = 1.3 } = {}) {
  let first = true;
  for (const line of lines) {
    const h = size * lh; L.ensure(h);
    const base = L.y - size; let cx = x;
    if (first && bullet) { L.page.drawText(safe(L.f.r, bullet), { x: x - 14, y: base, size, font: L.f.r, color }); }
    first = false;
    for (const it of line.items) {
      if (!it.sp) L.page.drawText(it.t, { x: cx, y: base, size: it.sz, font: it.font, color: it.run.link ? LINK : color });
      if ((it.run.underline || it.run.link) && !it.sp) L.page.drawLine({ start: { x: cx, y: base - 1.5 }, end: { x: cx + it.w, y: base - 1.5 }, thickness: 0.6, color: it.run.link ? LINK : color });
      cx += it.w;
    }
    L.y -= h;
  }
}

// ------------------------------------------------------------ HTML -> PDF
const INLINE = new Set(['A', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'CODE', 'TT', 'SMALL', 'SUB', 'SUP', 'FONT', 'LABEL', 'S', 'DEL', 'INS', 'MARK', 'ABBR', 'CITE', 'BR', 'IMG', 'KBD', 'SAMP', 'Q']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'META', 'LINK', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
const HSIZE = { H1: 22, H2: 18, H3: 15, H4: 13, H5: 12, H6: 11 };

function collectRuns(nodes, st = {}, out = []) {
  for (const n of nodes) {
    if (n.nodeType === 3) { const t = n.textContent.replace(/\s+/g, ' '); if (t) out.push({ ...st, text: t }); continue; }
    if (n.nodeType !== 1 || SKIP.has(n.tagName)) continue;
    const tag = n.tagName; const s2 = { ...st };
    if (tag === 'BR') { out.push({ br: true }); continue; }
    if (tag === 'IMG') { out.push({ img: n }); continue; }
    if (tag === 'B' || tag === 'STRONG') s2.bold = true;
    else if (tag === 'I' || tag === 'EM' || tag === 'CITE') s2.italic = true;
    else if (tag === 'U' || tag === 'INS') s2.underline = true;
    else if (tag === 'A' && n.getAttribute('href')) s2.link = true;
    else if (tag === 'CODE' || tag === 'TT' || tag === 'KBD' || tag === 'SAMP') s2.mono = true;
    else if (tag === 'SMALL' || tag === 'SUB' || tag === 'SUP') s2.scale = 0.8;
    collectRuns(n.childNodes, s2, out);
  }
  return out;
}
const isInlineNode = (n) => n.nodeType === 3 || (n.nodeType === 1 && INLINE.has(n.tagName));

async function embedAny(doc, src) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(src || ''); if (!m) return null;
  const type = m[1].toLowerCase(); const raw = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  try {
    if (type === 'image/png') return await doc.embedPng(raw);
    if (type === 'image/jpeg' || type === 'image/jpg') return await doc.embedJpg(raw);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0);
    return await doc.embedPng(Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]), (ch) => ch.charCodeAt(0)));
  } catch { return null; }
}

class HtmlRenderer {
  constructor(L) { this.L = L; this.baseSize = 11; }

  async runsBlock(runs, ctx, opts = {}) {
    const { L } = this; let seg = [];
    const flush = (bullet) => {
      if (!seg.length) return false;
      const size = opts.size || ctx.size; const lines = layoutRuns(L.f, seg, ctx.width, size);
      if (lines.length) drawLines(L, lines, ctx.x, size, { bullet, color: opts.color });
      seg = []; return lines.length > 0;
    };
    let bullet = opts.bullet || null; let any = false;
    for (const r of runs) {
      if (r.img) {
        if (flush(bullet)) bullet = null;
        const emb = await embedAny(L.doc, r.img.getAttribute('src'));
        if (emb) {
          const s = Math.min(1, ctx.width / emb.width, (L.H - 2 * L.m) / emb.height); const w = emb.width * s, h = emb.height * s;
          L.ensure(h); L.page.drawImage(emb, { x: ctx.x, y: L.y - h, width: w, height: h }); L.y -= h + 4; any = true;
        }
      } else seg.push(r);
    }
    if (flush(bullet)) any = true;
    if (any) L.y -= opts.after ?? 6;
    return any;
  }

  async children(el, ctx) {
    let buf = [];
    const flush = async () => { if (buf.length) { const runs = collectRuns(buf, ctx.style || {}); buf = []; await this.runsBlock(runs, ctx); } };
    for (const n of el.childNodes) {
      if (isInlineNode(n)) { buf.push(n); continue; }
      if (n.nodeType !== 1 || SKIP.has(n.tagName)) continue;
      await flush(); await this.block(n, ctx);
    }
    await flush();
  }

  async block(el, ctx) {
    const { L } = this; const tag = el.tagName;
    if (HSIZE[tag]) {
      L.y -= HSIZE[tag] * 0.4;
      await this.runsBlock(collectRuns(el.childNodes, { bold: true }), ctx, { size: HSIZE[tag], after: 6 }); return;
    }
    switch (tag) {
      case 'UL': case 'OL': {
        let n = +(el.getAttribute('start') || 1);
        for (const li of el.children) {
          if (li.tagName !== 'LI') continue;
          const bullet = tag === 'OL' ? `${n++}.` : '•';
          const inner = { ...ctx, x: ctx.x + 20, width: ctx.width - 20 };
          let buf = []; let first = true;
          const flush = async () => { if (!buf.length) return; const runs = collectRuns(buf, ctx.style || {}); buf = []; if (await this.runsBlock(runs, inner, { bullet: first ? bullet : null, after: 2 })) first = false; };
          for (const c of li.childNodes) {
            if (isInlineNode(c)) { buf.push(c); continue; }
            if (c.nodeType !== 1) continue;
            await flush();
            if (c.tagName === 'UL' || c.tagName === 'OL') await this.block(c, inner);
            else if (c.tagName === 'P' || c.tagName === 'DIV') { if (await this.runsBlock(collectRuns(c.childNodes, ctx.style || {}), inner, { bullet: first ? bullet : null, after: 2 })) first = false; }
            else await this.block(c, inner);
          }
          await flush();
          if (first) { await this.runsBlock([{ text: ' ' }], inner, { bullet, after: 2 }); }
        }
        L.y -= 4; return;
      }
      case 'TABLE': await this.table(el, ctx); return;
      case 'HR': L.ensure(10); L.page.drawLine({ start: { x: ctx.x, y: L.y - 4 }, end: { x: ctx.x + ctx.width, y: L.y - 4 }, thickness: 0.7, color: rgb(0.6, 0.6, 0.6) }); L.y -= 12; return;
      case 'PRE': {
        const text = el.textContent.replace(/\r/g, '').replace(/\n$/, '');
        monoLines(L, text, ctx.x, ctx.width, 9.5); L.y -= 6; return;
      }
      case 'BLOCKQUOTE': {
        const y0 = L.y; const pg = L.page;
        await this.children(el, { ...ctx, x: ctx.x + 18, width: ctx.width - 18, style: { ...(ctx.style || {}), italic: true } });
        if (L.page === pg) pg.drawLine({ start: { x: ctx.x + 6, y: y0 }, end: { x: ctx.x + 6, y: L.y + 4 }, thickness: 2, color: rgb(0.75, 0.75, 0.75) });
        return;
      }
      case 'IMG': await this.runsBlock([{ img: el }], ctx); return;
      case 'P': case 'LI': case 'FIGCAPTION': case 'DT': case 'DD': case 'SUMMARY': case 'ADDRESS': await this.children(el, ctx); if (!el.querySelector('p,div,ul,ol,table')) { /* spacing already added */ } return;
      default: await this.children(el, ctx);
    }
  }

  cellRuns(cell, style) {
    const out = [];
    const walk = (nodes, st) => {
      for (const n of nodes) {
        if (isInlineNode(n)) { collectRuns([n], st, out); continue; }
        if (n.nodeType !== 1 || SKIP.has(n.tagName)) continue;
        walk(n.childNodes, st); if (out.length && !out[out.length - 1].br) out.push({ br: true });
      }
    };
    walk(cell.childNodes, style);
    while (out.length && (out[out.length - 1].br || (out[out.length - 1].text && !out[out.length - 1].text.trim()))) out.pop();
    return out;
  }

  async table(tbl, ctx) {
    const { L } = this; const size = 9.5; const pad = 4;
    const rows = [...tbl.querySelectorAll('tr')].filter((tr) => tr.closest('table') === tbl);
    if (!rows.length) return;
    const grid = rows.map((tr) => [...tr.children].filter((c) => /^(TD|TH)$/.test(c.tagName)).map((c) => ({
      runs: this.cellRuns(c, c.tagName === 'TH' ? { bold: true } : {}), span: Math.max(1, +c.getAttribute('colspan') || 1), th: c.tagName === 'TH',
    })));
    const ncol = Math.max(1, ...grid.map((r) => r.reduce((a, c) => a + c.span, 0)));
    const nat = Array(ncol).fill(0), min = Array(ncol).fill(0);
    for (const r of grid) {
      let j = 0;
      for (const c of r) {
        if (c.span === 1) {
          const lines1 = layoutRuns(L.f, c.runs, 1e6, size); nat[j] = Math.max(nat[j], ...lines1.map((l) => l.w), 0);
          for (const run of c.runs) if (run.text) for (const w of run.text.split(/\s+/)) min[j] = Math.max(min[j], fontFor(L.f, run).widthOfTextAtSize(safe(fontFor(L.f, run), w), size));
        }
        j += c.span;
      }
    }
    const avail = ctx.width - ncol * 2 * pad;
    nat.forEach((v, k) => { nat[k] = Math.max(v, 12); min[k] = Math.min(Math.max(min[k], 12), nat[k]); });
    let widths; const sumN = nat.reduce((a, b) => a + b, 0), sumM = min.reduce((a, b) => a + b, 0);
    if (sumN <= avail) { const extra = (avail - sumN) / ncol; widths = nat.map((v) => v + extra); }
    else if (sumM >= avail) widths = min.map((v) => (v * avail) / sumM);
    else { const r = (avail - sumM) / (sumN - sumM); widths = min.map((v, k) => v + (nat[k] - v) * r); }
    widths = widths.map((w) => w + 2 * pad);
    for (const r of grid) {
      let j = 0; const cells = []; let rh = size * 1.3 + 2 * pad;
      for (const c of r) {
        const w = widths.slice(j, j + c.span).reduce((a, b) => a + b, 0);
        const lines = layoutRuns(L.f, c.runs, w - 2 * pad, size);
        rh = Math.max(rh, Math.max(1, lines.length) * size * 1.3 + 2 * pad);
        cells.push({ x: widths.slice(0, j).reduce((a, b) => a + b, 0), w, lines, th: c.th }); j += c.span;
      }
      rh = Math.min(rh, L.H - 2 * L.m);
      L.ensure(rh); const top = L.y;
      for (const c of cells) {
        L.page.drawRectangle({ x: ctx.x + c.x, y: top - rh, width: c.w, height: rh, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5, color: c.th ? rgb(0.93, 0.93, 0.93) : undefined });
        const save = L.y; L.y = top - pad; const pg = L.page;
        for (const line of c.lines) { if (L.y - size * 1.3 < top - rh + pad - 0.1 || L.page !== pg) break; drawLines(L, [line], ctx.x + c.x + pad, size); }
        L.y = save;
      }
      L.y = top - rh;
    }
    L.y -= 8;
  }
}

function monoLines(L, text, x, width, size) {
  const per = Math.max(1, Math.floor(width / (0.6 * size))); const lh = size * 1.25;
  for (const raw of text.split('\n')) {
    const line = safe(L.f.m, raw.replace(/\t/g, '    '));
    const chunks = line.length ? line.match(new RegExp(`.{1,${per}}`, 'g')) : [''];
    for (const ch of chunks) { L.ensure(lh); L.page.drawText(ch, { x, y: L.y - size, size, font: L.f.m, color: rgb(0.1, 0.1, 0.1) }); L.y -= lh; }
  }
}

async function newDocWithLayout(opts) {
  const doc = await PDFDocument.create(); doc.setProducer('PDF Studio'); doc.setCreationDate(new Date());
  const f = await makeFonts(doc); const L = new Layout(doc, f, opts);
  return { doc, f, L };
}

export async function htmlToPdf(html, opts = {}) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const { doc, L } = await newDocWithLayout(opts);
  if (parsed.title) doc.setTitle(parsed.title);
  const r = new HtmlRenderer(L);
  await r.children(parsed.body, { x: L.m, width: L.cw, size: 11 });
  return doc.save();
}

export async function textToPdf(text, opts = {}) {
  const { doc, L } = await newDocWithLayout(opts);
  monoLines(L, text.replace(/\r\n?/g, '\n'), L.m, L.cw, 10);
  return doc.save();
}

// ------------------------------------------------------------ markdown (small subset) -> HTML
export function markdownToHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<i>$2</i>').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  const lines = md.replace(/\r\n?/g, '\n').split('\n'); const out = []; let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^```/.test(ln)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre>${esc(buf.join('\n'))}</pre>`); continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(ln))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(ln)) { out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(ln)) { const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, '')); out.push(`<blockquote><p>${inline(buf.join(' '))}</p></blockquote>`); continue; }
    if (/^\s*([-*+]|\d+\.)\s+/.test(ln)) {
      const ordered = /^\s*\d+\./.test(ln); const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''))}</li>`);
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (!ln.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+\.)\s+)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

// ------------------------------------------------------------ Word (.docx) -> PDF
export async function docxToPdf(buf, opts = {}) {
  await loadScript('lib/mammoth.browser.min.js');
  const res = await window.mammoth.convertToHtml({ arrayBuffer: buf });
  return { bytes: await htmlToPdf(res.value, opts), warnings: res.messages.map((m) => m.message).slice(0, 5) };
}

// ------------------------------------------------------------ spreadsheets -> PDF
export function parseCsv(text) {
  text = text.replace(new RegExp('^' + hexc('FEFF')), '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function gridToPdf(L, title, rows, f) {
  while (rows.length && rows[rows.length - 1].every((c) => !c)) rows.pop();
  if (!rows.length) return;
  const ncol = Math.max(...rows.map((r) => r.length)); const size0 = 9;
  const widthOf = (t, bold, sz) => (bold ? f.b : f.r).widthOfTextAtSize(safe(f.r, t), sz);
  const colW = Array(ncol).fill(28);
  rows.forEach((r, ri) => r.forEach((c, j) => { colW[j] = Math.min(220, Math.max(colW[j], widthOf(c, ri === 0, size0) + 8)); }));
  const avail = L.cw; const total = colW.reduce((a, b) => a + b, 0);
  let groups = []; let size = size0; let widths = colW;
  if (total <= avail) groups = [[...Array(ncol).keys()]];
  else if (avail / total >= 0.6) { const s = avail / total; size = Math.max(5.5, size0 * s); widths = colW.map((w) => w * s); groups = [[...Array(ncol).keys()]]; }
  else { let g = [], sum = 0; for (let j = 0; j < ncol; j++) { if (sum + colW[j] > avail && g.length) { groups.push(g); g = []; sum = 0; } g.push(j); sum += colW[j]; } if (g.length) groups.push(g); }
  const rh = size * 1.7; const fit = (t, w, bold) => {
    t = safe(f.r, t); if (widthOf(t, bold, size) <= w - 6) return t;
    let lo = 0, hi = t.length; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (widthOf(t.slice(0, mid) + '...', bold, size) <= w - 6) lo = mid; else hi = mid - 1; }
    return t.slice(0, lo) + '...';
  };
  let gi = 0;
  for (const g of groups) {
    L.newPage(); gi++;
    const heading = groups.length > 1 ? `${title} (columns ${g[0] + 1}-${g[g.length - 1] + 1})` : title;
    L.page.drawText(safe(f.b, heading), { x: L.m, y: L.y - 12, size: 12, font: f.b }); L.y -= 24;
    const drawRow = (r, ri) => {
      let x = L.m; const top = L.y;
      for (const j of g) {
        const w = widths[j]; const hdr = ri === 0;
        L.page.drawRectangle({ x, y: top - rh, width: w, height: rh, borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 0.4, color: hdr ? rgb(0.92, 0.94, 0.97) : undefined });
        const raw = r[j] ?? ''; const t = fit(raw, w, hdr); const num = /^[\s$€£¥-]*[\d.,]+%?\)?$/.test(raw.trim());
        const tw = widthOf(t, hdr, size);
        if (t) L.page.drawText(t, { x: num && !hdr ? x + w - 3 - tw : x + 3, y: top - rh + (rh - size) / 2 + size * 0.15, size, font: hdr ? f.b : f.r });
        x += w;
      }
      L.y -= rh;
    };
    rows.forEach((r, ri) => {
      if (L.y - rh < L.m) { L.newPage(); drawRow(rows[0], 0); }
      drawRow(r, ri);
    });
  }
}

export async function spreadsheetToPdf(file, opts = {}) {
  const ext = file.name.split('.').pop().toLowerCase();
  const sheets = [];
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    sheets.push({ name: file.name, rows: parseCsv(await file.text()) });
  } else if (ext === 'xlsx' || ext === 'xlsm') {
    await loadScript('lib/exceljs.min.js');
    const wb = new window.ExcelJS.Workbook(); await wb.xlsx.load(await file.arrayBuffer());
    wb.eachSheet((ws) => {
      if (ws.state && ws.state !== 'visible') return;
      const rows = []; const maxR = Math.min(ws.rowCount, 20000), maxC = Math.min(ws.columnCount, 200);
      for (let r = 1; r <= maxR; r++) {
        const row = ws.getRow(r); const arr = [];
        for (let c = 1; c <= maxC; c++) { let t = ''; try { t = row.getCell(c).text || ''; } catch { t = ''; } arr.push(String(t)); }
        rows.push(arr);
      }
      sheets.push({ name: ws.name, rows });
    });
  } else throw new ConvertError(`Unsupported spreadsheet type .${ext}. Re-save legacy .xls/.ods files as .xlsx or .csv first.`);
  const { doc, f, L } = await newDocWithLayout({ ...opts, landscape: opts.landscape ?? true, margin: 36 });
  doc.removePage(0);
  for (const s of sheets) await gridToPdf(L, s.name, s.rows, f);
  if (!doc.getPageCount()) doc.addPage([L.W, L.H]);
  return doc.save();
}

// ------------------------------------------------------------ images -> PDF
export async function fileToImage(file) {
  const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new ConvertError('Unsupported or corrupt image: ' + file.name)); i.src = url; });
  let dataUrl = url;
  if (!/^data:image\/(png|jpeg);/.test(url)) {
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0); dataUrl = c.toDataURL('image/png');
  }
  return { dataUrl, w: img.naturalWidth, h: img.naturalHeight };
}
export async function imagesToPdf(files, { fit = 'page', size = PAGE_SIZES.A4 } = {}) {
  const doc = await PDFDocument.create(); doc.setProducer('PDF Studio');
  for (const f of files) {
    const im = await fileToImage(f); const raw = Uint8Array.from(atob(im.dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
    const emb = im.dataUrl.startsWith('data:image/png') ? await doc.embedPng(raw) : await doc.embedJpg(raw);
    if (fit === 'original') { const s = Math.min(1, 1200 / im.w, 1700 / im.h) * 0.75; const p = doc.addPage([im.w * s, im.h * s]); p.drawImage(emb, { x: 0, y: 0, width: im.w * s, height: im.h * s }); }
    else {
      const land = im.w > im.h; const [pw, ph] = land ? [Math.max(...size), Math.min(...size)] : [Math.min(...size), Math.max(...size)];
      const s = Math.min((pw - 36) / im.w, (ph - 36) / im.h); const w = im.w * s, h = im.h * s;
      doc.addPage([pw, ph]).drawImage(emb, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
  }
  return doc.save();
}

// ------------------------------------------------------------ dispatcher: any file -> PDF bytes
const UNSUPPORTED = { doc: 'Word 97-2003 (.doc)', odt: 'OpenDocument text (.odt)', rtf: 'Rich Text (.rtf)', xls: 'Excel 97-2003 (.xls)', ods: 'OpenDocument spreadsheet (.ods)', ppt: 'PowerPoint (.ppt)', pptx: 'PowerPoint (.pptx)', odp: 'OpenDocument presentation (.odp)', pages: 'Apple Pages', numbers: 'Apple Numbers', key: 'Apple Keynote' };
export async function fileToPdfBytes(file, opts = {}) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const warnings = [];
  let bytes;
  if (ext === 'pdf') bytes = new Uint8Array(await file.arrayBuffer());
  else if (ext === 'docx') { const r = await docxToPdf(await file.arrayBuffer(), opts); bytes = r.bytes; warnings.push(...r.warnings); }
  else if (['xlsx', 'xlsm', 'csv', 'tsv'].includes(ext)) bytes = await spreadsheetToPdf(file, opts);
  else if (['txt', 'log', 'json', 'xml', 'yml', 'yaml', 'ini', 'js', 'css', 'py'].includes(ext)) bytes = await textToPdf(await file.text(), opts);
  else if (ext === 'md' || ext === 'markdown') bytes = await htmlToPdf(markdownToHtml(await file.text()), opts);
  else if (ext === 'html' || ext === 'htm') bytes = await htmlToPdf(await file.text(), opts);
  else if (/^image\//.test(file.type) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) bytes = await imagesToPdf([file], opts);
  else if (UNSUPPORTED[ext]) throw new ConvertError(`${UNSUPPORTED[ext]} cannot be converted in the browser. Save it as ${/^(xls|ods|numbers)$/.test(ext) ? '.xlsx or .csv' : /^(ppt|pptx|odp|key)$/.test(ext) ? 'PDF (export from the original app)' : '.docx'} and try again.`);
  else throw new ConvertError(`Unsupported file type: .${ext}`);
  return { bytes, warnings };
}
export async function mergePdfBytes(list) {
  if (list.length === 1) return list[0];
  const out = await PDFDocument.create(); out.setProducer('PDF Studio');
  for (const b of list) { const src = await PDFDocument.load(b, { updateMetadata: false }); (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p)); }
  return out.save();
}

// ------------------------------------------------------------ PDF text extraction (shared)
export async function pageLines(page) {
  const tc = await page.getTextContent();
  const items = [];
  for (const i of tc.items) {
    if (typeof i.str !== 'string') continue;
    const h = Math.hypot(i.transform[2], i.transform[3]) || i.height || 10;
    items.push({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h });
  }
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const ln = lines.find((l) => Math.abs(l.y - it.y) <= 0.45 * Math.max(l.h, it.h));
    if (ln) { ln.items.push(it); ln.h = Math.max(ln.h, it.h); } else lines.push({ y: it.y, h: it.h, items: [it] });
  }
  lines.sort((a, b) => b.y - a.y);
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
    ln.segs = []; let cur = null;
    for (const it of ln.items) {
      if (!it.str.trim() && !cur) continue;
      const gap = cur ? it.x - cur.x2 : 0;
      if (cur && gap <= ln.h * 1.0) { if (gap > ln.h * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' '; cur.text += it.str; cur.x2 = it.x + it.w; }
      else { if (cur) ln.segs.push(cur); cur = { x: it.x, x2: it.x + it.w, y: ln.y, h: it.h, text: it.str }; }
    }
    if (cur) ln.segs.push(cur);
    ln.segs.forEach((s) => { s.text = s.text.replace(/\s+$/, ''); });
    ln.segs = ln.segs.filter((s) => s.text.trim());
    ln.text = ln.segs.map((s) => s.text).join('  ');
  }
  return lines.filter((l) => l.segs.length);
}
export const textSegments = async (page) => (await pageLines(page)).flatMap((l) => l.segs);

export async function pdfToText(pdf, indices, onProgress) {
  const parts = [];
  for (const i of indices) {
    const lines = await pageLines(await pdf.getPage(i + 1));
    parts.push(`--- Page ${i + 1} ---\n` + lines.map((l) => l.text).join('\n'));
    onProgress && onProgress(i);
  }
  return parts.join('\n\n');
}

// ------------------------------------------------------------ PDF -> images
export async function pdfToImages(pdf, indices, { dpi = 150, mime = 'image/png' } = {}, onProgress) {
  const out = []; const ext = mime === 'image/png' ? 'png' : 'jpg';
  for (const i of indices) {
    const page = await pdf.getPage(i + 1); const vp = page.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp, annotationMode: 2 }).promise;
    const blob = await new Promise((r) => c.toBlob(r, mime, 0.92));
    out.push({ name: `page-${String(i + 1).padStart(3, '0')}.${ext}`, bytes: new Uint8Array(await blob.arrayBuffer()) });
    c.width = c.height = 0; onProgress && onProgress(i);
  }
  return out;
}
export async function zipFiles(files) {
  await loadScript('lib/fflate.min.js');
  const o = {}; files.forEach((f) => { o[f.name] = [f.bytes, { level: 0 }]; });
  return window.fflate.zipSync(o);
}

// ------------------------------------------------------------ PDF -> Word (.docx, text only)
const xmlEsc = (s) => s.replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export async function pdfToDocx(pdf, indices, onProgress) {
  await loadScript('lib/fflate.min.js');
  const body = [];
  for (const [k, i] of indices.entries()) {
    const lines = await pageLines(await pdf.getPage(i + 1));
    const hs = lines.map((l) => l.h).sort((a, b) => a - b); const med = hs[Math.floor(hs.length / 2)] || 10;
    let para = [], prev = null, big = false;
    const flush = () => {
      if (!para.length) return;
      const sz = big ? Math.round(Math.min(med * 1.6, 40) * 2) : 0;
      body.push(`<w:p><w:r><w:rPr>${big ? '<w:b/>' : ''}${sz ? `<w:sz w:val="${sz}"/>` : ''}</w:rPr><w:t xml:space="preserve">${xmlEsc(para.join(' '))}</w:t></w:r></w:p>`);
      para = []; big = false;
    };
    for (const l of lines) {
      const gap = prev ? prev.y - l.y : 0; const isBig = l.h > med * 1.25;
      if (prev && (gap > prev.h * 1.7 || isBig !== (big && para.length > 0) )) flush();
      if (!para.length) big = isBig;
      para.push(l.text); prev = l;
    }
    flush();
    if (k < indices.length - 1) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    onProgress && onProgress(i);
  }
  const enc = (s) => new TextEncoder().encode(s);
  const files = {
    '[Content_Types].xml': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}</w:body></w:document>`),
  };
  return window.fflate.zipSync(files);
}

// ------------------------------------------------------------ PDF -> Excel (heuristic table detection)
export async function pdfToXlsx(pdf, indices, onProgress) {
  await loadScript('lib/exceljs.min.js');
  const wb = new window.ExcelJS.Workbook();
  for (const i of indices) {
    const lines = await pageLines(await pdf.getPage(i + 1));
    const xs = lines.flatMap((l) => l.segs.map((s) => s.x)).sort((a, b) => a - b);
    const cols = []; for (const x of xs) { if (!cols.length || x - cols[cols.length - 1].x > 8) cols.push({ x, n: 1 }); else cols[cols.length - 1].n++; }
    const ws = wb.addWorksheet(`Page ${i + 1}`);
    for (const l of lines) {
      const row = [];
      for (const s of l.segs) {
        let k = 0; while (k + 1 < cols.length && s.x - cols[k + 1].x > -8) k++;
        const t = s.text; const isNum = /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/.test(t.trim());
        row[k] = isNum ? Number(t.replace(/,/g, '')) : (row[k] ? row[k] + ' ' + t : t);
      }
      ws.addRow(Array.from(row, (v) => v ?? null));
    }
    ws.columns.forEach((c) => { c.width = 18; });
    onProgress && onProgress(i);
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
