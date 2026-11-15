// PDF Studio - client-side PDF viewer/editor.
// Rendering: pdf.js. Editing/saving: pdf-lib. Nothing is uploaded anywhere.
import * as pdfjsLib from './lib/pdf.min.js';

const {
  PDFDocument, StandardFonts, rgb, degrees, LineCapStyle, BlendMode,
  PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup,
} = PDFLib;

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.js', import.meta.url).href;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------- state
const S = {
  bytes: null, name: 'document.pdf', pdf: null, password: undefined,
  pv: [],                 // [{page, vp1}]
  zoom: 1.25, tool: 'select',
  annots: [], sel: null,  // sel = annotation id
  selPages: new Set(), cur: 0,
  undo: [], redo: [],
  viewOnly: false, gen: 0, hits: [], pendingImage: null, fileHandle: null,
  defaults: {
    highlight: { color: '#ffe14d' },
    rect: { color: '#e53935', width: 2 },
    text: { color: '#000000', size: 14 },
    ink: { color: '#1d4ed8', width: 2 },
  },
  nextId: 1,
};

// ---------------------------------------------------------------- helpers
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), err ? 6000 : 2500);
}
function fail(e, prefix = 'Error') {
  console.error(e);
  toast(`${prefix}: ${e && e.message ? e.message : e}`, true);
}
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
};
const hexToRgb = (h) => {
  const n = parseInt(h.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hasDoc = () => !!S.bytes;
function download(bytes, name, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const baseName = () => S.name.replace(/\.pdf$/i, '');
const loadDoc = (bytes) => PDFDocument.load(bytes, { updateMetadata: false });

function modal({ title, body, actions = [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }], onReady }) {
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<h3></h3><div class="body"></div><div class="actions"></div>`;
    $('h3', m).textContent = title;
    const b = $('.body', m);
    if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
    const act = $('.actions', m);
    const close = (value) => { bg.remove(); resolve({ value, q: (s) => $(s, m), qa: (s) => $$(s, m) }); };
    actions.forEach((a) => {
      const btn = document.createElement('button');
      btn.textContent = a.label; if (a.primary) btn.className = 'primary';
      btn.onclick = () => close(a.value); act.appendChild(btn);
    });
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(false); });
    bg.appendChild(m); document.body.appendChild(bg);
    onReady && onReady(m);
    const first = $('input,select,textarea', m); first && first.focus();
  });
}

// "1-3,5" -> [0,1,2,4]
function parseRange(str, n) {
  const out = new Set();
  for (const part of str.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`Bad range "${part}"`);
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > n) throw new Error(`Range "${part}" is outside 1-${n}`);
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  if (!out.size) throw new Error('No pages selected');
  return [...out].sort((x, y) => x - y);
}

// ---------------------------------------------------------------- history
const snapshot = () => ({ bytes: S.bytes, annots: structuredClone(S.annots) });
function checkpoint() { S.undo.push(snapshot()); if (S.undo.length > 60) S.undo.shift(); S.redo = []; syncButtons(); }
async function restore(snap) {
  const sameBytes = snap.bytes === S.bytes;
  S.bytes = snap.bytes; S.annots = structuredClone(snap.annots); S.sel = null;
  if (sameBytes) renderAnnots(); else await reload();
  syncButtons();
}
async function undo() { if (!S.undo.length) return; S.redo.push(snapshot()); await restore(S.undo.pop()); }
async function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); await restore(S.redo.pop()); }

// ---------------------------------------------------------------- loading
async function openPdfjs(bytes) {
  for (;;) {
    try {
      return await pdfjsLib.getDocument({ data: bytes.slice(), password: S.password }).promise;
    } catch (err) {
      if (err && err.name === 'PasswordException') {
        const r = await modal({
          title: err.code === 2 ? 'Wrong password - try again' : 'This PDF is password protected',
          body: '<div class="row"><label>Password</label><input type="password" id="pw"></div>',
        });
        if (!r.value) throw err;
        S.password = r.q('#pw').value;
      } else throw err;
    }
  }
}

async function loadFile(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await openBytes(bytes, file.name);
  } catch (e) { fail(e, 'Could not open file'); }
}

async function openBytes(bytes, name) {
  S.password = undefined; S.fileHandle = null;
  const pdf = await openPdfjs(bytes);
  pdf.destroy();
  S.bytes = bytes; S.name = name; S.annots = []; S.undo = []; S.redo = []; S.sel = null;
  S.selPages.clear(); S.hits = []; S.cur = 0;
  S.viewOnly = false;
  try { await loadDoc(bytes); } catch (e) {
    S.viewOnly = true;
    toast('This PDF is encrypted or cannot be edited. Opened in view-only mode.', true);
  }
  await reload();
  $('#empty').hidden = true;
  document.title = `${name} - PDF Studio`;
  syncButtons();
}

async function reload(keepPage = S.cur) {
  const gen = ++S.gen;
  if (S.pdf) { try { S.pdf.destroy(); } catch { /* ignore */ } }
  S.pdf = await openPdfjs(S.bytes);
  const n = S.pdf.numPages;
  const pv = [];
  for (let i = 1; i <= n; i++) { const page = await S.pdf.getPage(i); pv.push({ page, vp1: page.getViewport({ scale: 1 }) }); }
  if (gen !== S.gen) return;
  S.pv = pv; S.cur = clamp(keepPage, 0, n - 1);
  $('#pageTotal').textContent = `/ ${n}`;
  $('#pageNum').max = n;
  buildViews(); buildThumbs();
  scrollToPage(S.cur, false);
  refreshForms(); updateDocInfo();
}

// ---------------------------------------------------------------- page views
let pageObserver, thumbObserver;
function buildViews() {
  const host = $('#pages'); host.innerHTML = '';
  pageObserver && pageObserver.disconnect();
  pageObserver = new IntersectionObserver((ents) => {
    ents.forEach((e) => { if (e.isIntersecting) renderPage(+e.target.dataset.i); });
  }, { root: $('#viewer'), rootMargin: '900px 0px' });
  S.pv.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'page'; d.dataset.i = i;
    d.style.width = p.vp1.width * S.zoom + 'px'; d.style.height = p.vp1.height * S.zoom + 'px';
    const c = document.createElement('canvas'); c.className = 'main'; d.appendChild(c);
    const svg = el('svg', { class: 'overlay', viewBox: `0 0 ${p.vp1.width} ${p.vp1.height}` });
    svg.addEventListener('pointerdown', (e) => onDown(e, i));
    svg.addEventListener('pointermove', (e) => onMove(e, i));
    svg.addEventListener('pointerup', (e) => onUp(e, i));
    svg.addEventListener('pointercancel', (e) => onUp(e, i));
    svg.addEventListener('dblclick', (e) => onDbl(e, i));
    d.appendChild(svg);
    host.appendChild(d); pageObserver.observe(d);
    p.rendered = false;
  });
  renderAnnots(); applyToolClass();
}

async function renderPage(i) {
  const p = S.pv[i]; if (!p || p.rendered || p.rendering) return;
  p.rendering = true;
  const gen = S.gen;
  try {
    const host = $(`.page[data-i="${i}"] canvas.main`); if (!host) return;
    let dpr = window.devicePixelRatio || 1;
    const w = p.vp1.width * S.zoom, h = p.vp1.height * S.zoom;
    while (w * h * dpr * dpr > 24e6 && dpr > 0.5) dpr -= 0.25;
    const vp = p.page.getViewport({ scale: S.zoom * dpr });
    host.width = Math.ceil(vp.width); host.height = Math.ceil(vp.height);
    host.style.width = w + 'px'; host.style.height = h + 'px';
    await p.page.render({ canvasContext: host.getContext('2d'), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    if (gen === S.gen) p.rendered = true;
  } catch (e) { if (!(e && e.name === 'RenderingCancelledException')) console.warn('render', i, e); }
  finally { p.rendering = false; }
}

function buildThumbs() {
  const host = $('#thumbs'); host.innerHTML = '';
  thumbObserver && thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver((ents) => {
    ents.forEach((e) => { if (e.isIntersecting) { renderThumb(+e.target.dataset.i); thumbObserver.unobserve(e.target); } });
  }, { root: host, rootMargin: '300px 0px' });
  S.pv.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'thumb'; d.dataset.i = i; d.draggable = !S.viewOnly;
    const scale = 110 / p.vp1.width;
    const c = document.createElement('canvas');
    c.width = Math.round(p.vp1.width * scale); c.height = Math.round(p.vp1.height * scale);
    d.appendChild(c);
    const n = document.createElement('div'); n.className = 'n'; n.textContent = i + 1; d.appendChild(n);
    d.addEventListener('click', (e) => thumbClick(e, i));
    d.addEventListener('dragstart', (e) => {
      if (!S.selPages.has(i)) { S.selPages = new Set([i]); markThumbs(); }
      e.dataTransfer.setData('text/plain', 'pages'); e.dataTransfer.effectAllowed = 'move';
    });
    d.addEventListener('dragover', (e) => {
      if (!S.selPages.size) return; e.preventDefault();
      const after = e.offsetY > d.clientHeight / 2;
      $$('.thumb').forEach((t) => t.classList.remove('dropbefore', 'dropafter'));
      d.classList.add(after ? 'dropafter' : 'dropbefore');
    });
    d.addEventListener('dragleave', () => d.classList.remove('dropbefore', 'dropafter'));
    d.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      const after = e.offsetY > d.clientHeight / 2;
      $$('.thumb').forEach((t) => t.classList.remove('dropbefore', 'dropafter'));
      reorder([...S.selPages].sort((a, b) => a - b), after ? i + 1 : i);
    });
    host.appendChild(d); thumbObserver.observe(d);
  });
  markThumbs();
}
async function renderThumb(i) {
  const p = S.pv[i]; const c = $(`.thumb[data-i="${i}"] canvas`); if (!p || !c) return;
  try {
    const vp = p.page.getViewport({ scale: c.width / p.vp1.width });
    await p.page.render({ canvasContext: c.getContext('2d'), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
  } catch { /* ignore cancelled renders */ }
}
function markThumbs() {
  $$('.thumb').forEach((t) => {
    const i = +t.dataset.i;
    t.classList.toggle('sel', S.selPages.has(i)); t.classList.toggle('cur', i === S.cur);
  });
}
let lastClicked = 0;
function thumbClick(e, i) {
  if (e.shiftKey) {
    const [a, b] = [Math.min(lastClicked, i), Math.max(lastClicked, i)];
    S.selPages = new Set(); for (let k = a; k <= b; k++) S.selPages.add(k);
  } else if (e.ctrlKey || e.metaKey) {
    S.selPages.has(i) ? S.selPages.delete(i) : S.selPages.add(i); lastClicked = i;
  } else { S.selPages = new Set([i]); lastClicked = i; }
  markThumbs(); scrollToPage(i);
}

function scrollToPage(i, smooth = true) {
  const d = $(`.page[data-i="${i}"]`); if (!d) return;
  const v = $('#viewer');
  v.scrollTo({ top: d.offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' });
  S.cur = i; $('#pageNum').value = i + 1; markThumbs();
}
$('#viewer').addEventListener('scroll', () => {
  cancelAnimationFrame(scrollTick.r);
  scrollTick.r = requestAnimationFrame(scrollTick);
});
function scrollTick() {
  const v = $('#viewer'); const mid = v.scrollTop + v.clientHeight / 3;
  let best = 0;
  for (const d of $$('.page')) { if (d.offsetTop <= mid) best = +d.dataset.i; else break; }
  if (best !== S.cur) { S.cur = best; $('#pageNum').value = best + 1; markThumbs(); }
}

function setZoom(z) {
  if (!hasDoc()) return;
  const v = $('#viewer'); const ratio = v.scrollTop / Math.max(1, v.scrollHeight);
  S.zoom = clamp(z, 0.25, 5); $('#zoomLabel').textContent = Math.round(S.zoom * 100) + '%';
  buildViews(); v.scrollTop = ratio * v.scrollHeight;
}
function fitWidth() {
  if (!hasDoc()) return;
  const w = $('#viewer').clientWidth - 40;
  setZoom(w / S.pv[S.cur].vp1.width);
}

// ---------------------------------------------------------------- annotations: model + drawing
const RECTLIKE = new Set(['highlight', 'rect', 'redact', 'whiteout', 'image']);
function newAnnot(a) { a.id = S.nextId++; S.annots.push(a); return a; }
const byId = (id) => S.annots.find((a) => a.id === id);

function renderAnnots() {
  $$('.page').forEach((d) => {
    const i = +d.dataset.i; const svg = $('svg.overlay', d); svg.innerHTML = '';
    S.annots.filter((a) => a.page === i && !a.editing).forEach((a) => drawAnnot(svg, a));
    S.hits.filter((h) => h.page === i).forEach((h) => {
      el('rect', { x: h.x, y: h.y, width: h.w, height: h.h, fill: '#fde047', 'fill-opacity': .5, stroke: '#ca8a04', 'stroke-width': .8, 'pointer-events': 'none' }, svg);
    });
    const sa = byId(S.sel);
    if (sa && sa.page === i && !sa.editing) {
      const node = svg.querySelector(`[data-id="${sa.id}"]`);
      if (node) {
        const b = node.getBBox();
        el('rect', { x: b.x - 2, y: b.y - 2, width: b.width + 4, height: b.height + 4, fill: 'none', stroke: '#2563eb', 'stroke-width': 1, 'stroke-dasharray': '4 3', 'pointer-events': 'none' }, svg);
        if (RECTLIKE.has(sa.type)) {
          const hnd = el('circle', { cx: b.x + b.width + 2, cy: b.y + b.height + 2, r: 5, fill: '#2563eb', class: 'a handle', 'data-handle': sa.id }, svg);
          hnd.style.cursor = 'nwse-resize';
        }
      }
    }
  });
}

function drawAnnot(svg, a) {
  let n;
  switch (a.type) {
    case 'highlight':
      n = el('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: a.color, 'fill-opacity': .45, style: 'mix-blend-mode:multiply' }); break;
    case 'rect':
      n = el('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: 'none', stroke: a.color, 'stroke-width': a.width, 'pointer-events': 'visibleStroke' }); break;
    case 'whiteout':
      n = el('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: '#fff', stroke: '#9ca3af', 'stroke-width': .5, 'stroke-dasharray': '3 2' }); break;
    case 'redact':
      n = el('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: '#000', 'fill-opacity': .8, stroke: '#ef4444', 'stroke-width': 1, 'stroke-dasharray': '4 3' }); break;
    case 'ink':
      n = el('g', {});
      el('polyline', { points: a.points.map((p) => p.join(',')).join(' '), fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, n);
      el('polyline', { points: a.points.map((p) => p.join(',')).join(' '), fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(a.width, 10), 'stroke-linecap': 'round', 'pointer-events': 'stroke' }, n);
      break;
    case 'image':
      n = el('image', { x: a.x, y: a.y, width: a.w, height: a.h, href: a.dataUrl, preserveAspectRatio: 'none' }); break;
    case 'text': {
      n = el('text', { x: a.x, y: a.y, fill: a.color, 'font-size': a.size, 'font-family': 'Helvetica, Arial, sans-serif', style: 'white-space:pre' });
      a.text.split('\n').forEach((line, k) => {
        const t = el('tspan', { x: a.x, y: a.y + a.size * (0.85 + 1.2 * k) }, n); t.textContent = line || ' ';
      });
      break;
    }
    default: return;
  }
  n.setAttribute('class', 'a'); n.setAttribute('data-id', a.id);
  svg.appendChild(n);
}

// ---- pointer interaction
let drag = null;
function svgPt(e, svg) {
  const r = svg.getBoundingClientRect();
  return { x: (e.clientX - r.left) / S.zoom, y: (e.clientY - r.top) / S.zoom };
}
const DRAW_TOOLS = new Set(['highlight', 'rect', 'redact', 'whiteout', 'ink']);

function onDown(e, i) {
  if (!hasDoc() || e.button > 0) return;
  const svg = e.currentTarget; const pt = svgPt(e, svg);
  S.cur = i; $('#pageNum').value = i + 1; markThumbs();
  if (S.viewOnly && S.tool !== 'select') { toast('View-only document: editing is disabled.', true); return; }

  if (S.tool === 'select') {
    const handle = e.target.closest && e.target.closest('[data-handle]');
    const node = e.target.closest && e.target.closest('[data-id]');
    if (handle) {
      const a = byId(+handle.dataset.handle); S.sel = a.id;
      drag = { mode: 'resize', a, svg, start: pt, orig: { w: a.w, h: a.h }, moved: false };
    } else if (node) {
      const a = byId(+node.dataset.id); S.sel = a.id; syncProps();
      drag = { mode: 'move', a, svg, start: pt, orig: structuredClone(a), moved: false };
    } else { S.sel = null; syncProps(); }
    svg.setPointerCapture(e.pointerId); renderAnnots(); return;
  }
  if (DRAW_TOOLS.has(S.tool)) {
    svg.setPointerCapture(e.pointerId);
    const d = S.defaults[S.tool] || {};
    drag = { mode: 'draw', tool: S.tool, svg, start: pt, cur: pt, pts: [[pt.x, pt.y]], d, page: i };
    drag.preview = S.tool === 'ink'
      ? el('polyline', { fill: 'none', stroke: d.color, 'stroke-width': d.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none' }, svg)
      : el('rect', { fill: S.tool === 'highlight' ? d.color : 'none', 'fill-opacity': .4, stroke: S.tool === 'rect' ? d.color : '#2563eb', 'stroke-width': 1, 'stroke-dasharray': '3 2', 'pointer-events': 'none' }, svg);
    return;
  }
  if (S.tool === 'text') { e.preventDefault(); openTextEditor(i, pt.x, pt.y); return; }
  if (S.tool === 'place' && S.pendingImage) {
    const im = S.pendingImage;
    const w = Math.min(160, S.pv[i].vp1.width * 0.4); const h = w * (im.h / im.w);
    checkpoint();
    const a = newAnnot({ type: 'image', page: i, x: clamp(pt.x - w / 2, 0, S.pv[i].vp1.width - w), y: clamp(pt.y - h / 2, 0, S.pv[i].vp1.height - h), w, h, dataUrl: im.dataUrl });
    S.sel = a.id; setTool('select'); renderAnnots();
  }
}
function onMove(e, i) {
  if (!drag) return;
  const pt = svgPt(e, drag.svg);
  if (drag.mode === 'draw') {
    drag.cur = pt;
    if (drag.tool === 'ink') {
      drag.pts.push([+pt.x.toFixed(2), +pt.y.toFixed(2)]);
      drag.preview.setAttribute('points', drag.pts.map((p) => p.join(',')).join(' '));
    } else {
      const r = normRect(drag.start, pt);
      ['x', 'y'].forEach((k) => drag.preview.setAttribute(k, r[k]));
      drag.preview.setAttribute('width', r.w); drag.preview.setAttribute('height', r.h);
    }
  } else if (drag.mode === 'move') {
    const dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 2) return;
    if (!drag.moved) { drag.moved = true; S.undo.push({ bytes: S.bytes, annots: [...S.annots.filter((x) => x.id !== drag.a.id).map((x) => structuredClone(x)), structuredClone(drag.orig)] }); S.redo = []; syncButtons(); }
    const a = drag.a;
    if (a.type === 'ink') a.points = drag.orig.points.map(([x, y]) => [x + dx, y + dy]);
    else { a.x = drag.orig.x + dx; a.y = drag.orig.y + dy; }
    renderAnnots();
  } else if (drag.mode === 'resize') {
    if (!drag.moved) { drag.moved = true; S.undo.push({ bytes: S.bytes, annots: S.annots.map((x) => (x === drag.a ? { ...structuredClone(x), w: drag.orig.w, h: drag.orig.h } : structuredClone(x))) }); S.redo = []; syncButtons(); }
    const a = drag.a;
    a.w = Math.max(4, drag.orig.w + pt.x - drag.start.x);
    a.h = a.type === 'image' ? a.w * (drag.orig.h / drag.orig.w) : Math.max(4, drag.orig.h + pt.y - drag.start.y);
    renderAnnots();
  }
}
function onUp(e, i) {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.mode !== 'draw') return;
  d.preview.remove();
  if (d.tool === 'ink') {
    if (d.pts.length < 2) return;
    checkpoint();
    const a = newAnnot({ type: 'ink', page: d.page, points: d.pts, color: d.d.color, width: d.d.width });
    S.sel = a.id;
  } else {
    const r = normRect(d.start, d.cur); if (r.w < 3 || r.h < 3) return;
    checkpoint();
    const a = newAnnot({ type: d.tool, page: d.page, x: r.x, y: r.y, w: r.w, h: r.h, color: d.d.color, width: d.d.width });
    S.sel = a.id;
  }
  syncProps(); renderAnnots();
}
const normRect = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

function onDbl(e, i) {
  const node = e.target.closest && e.target.closest('[data-id]'); if (!node) return;
  const a = byId(+node.dataset.id); if (a && a.type === 'text') openTextEditor(i, a.x, a.y, a);
}

function openTextEditor(i, x, y, existing) {
  const page = $(`.page[data-i="${i}"]`); if (!page) return;
  const size = existing ? existing.size : S.defaults.text.size;
  const color = existing ? existing.color : S.defaults.text.color;
  if (existing) { existing.editing = true; renderAnnots(); }
  const ta = document.createElement('textarea'); ta.className = 'texted'; ta.value = existing ? existing.text : '';
  Object.assign(ta.style, { left: x * S.zoom + 'px', top: y * S.zoom + 'px', fontSize: size * S.zoom + 'px', color, minWidth: '120px', minHeight: size * 1.4 * S.zoom + 'px' });
  const fit = () => { ta.style.height = '0'; ta.style.height = ta.scrollHeight + 'px'; ta.style.width = '0'; ta.style.width = Math.max(120, ta.scrollWidth + 6) + 'px'; };
  ta.addEventListener('input', fit); page.appendChild(ta); fit(); ta.focus();
  let done = false;
  const commit = (cancel) => {
    if (done) return; done = true;
    const text = ta.value.replace(/\s+$/, ''); ta.remove();
    if (existing) existing.editing = false;
    if (!cancel) {
      if (existing) {
        if (!text) { checkpoint(); S.annots = S.annots.filter((a) => a !== existing); }
        else if (text !== existing.text) { const keep = existing.text; existing.text = text; const cp = snapshot(); existing.text = keep; S.undo.push(cp); S.redo = []; existing.text = text; syncButtons(); }
      } else if (text) {
        checkpoint(); const a = newAnnot({ type: 'text', page: i, x, y, text, size, color }); S.sel = a.id;
      }
    }
    syncProps(); renderAnnots();
    if (!existing) setTool('select');
  };
  ta.addEventListener('blur', () => commit(false));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { commit(true); e.stopPropagation(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { commit(false); e.preventDefault(); }
    e.stopPropagation();
  });
}

// ---------------------------------------------------------------- tools + properties bar
function setTool(t) {
  S.tool = t;
  $$('#tools button[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  if (t !== 'select') S.sel = null;
  applyToolClass(); renderAnnots(); syncProps();
}
function applyToolClass() {
  $$('svg.overlay').forEach((s) => {
    s.classList.toggle('tool-select', S.tool === 'select');
    s.classList.toggle('drawing', S.tool !== 'select');
  });
}
function syncProps() {
  const a = byId(S.sel);
  const type = a ? a.type : S.tool;
  const hasColor = ['highlight', 'rect', 'text', 'ink'].includes(type);
  $('#props').hidden = !(hasColor || a);
  if ($('#props').hidden) return;
  const d = S.defaults[type] || {};
  const src = a || d;
  $('#propColor').hidden = !hasColor; $('#propColor').parentElement.hidden = !hasColor;
  if (hasColor) $('#propColor').value = src.color || d.color || '#000000';
  const sizeKey = type === 'text' ? 'size' : (type === 'rect' || type === 'ink') ? 'width' : null;
  $('#propSizeLabel').hidden = !sizeKey;
  if (sizeKey) { $('#propSizeName').textContent = sizeKey === 'size' ? 'Font size' : 'Line width'; $('#propSize').value = src[sizeKey] ?? d[sizeKey]; }
  $('#btnDelAnnot').hidden = !a;
}
$('#propColor').addEventListener('input', (e) => {
  const a = byId(S.sel); const type = a ? a.type : S.tool;
  if (S.defaults[type]) S.defaults[type].color = e.target.value;
  if (a) { a.color = e.target.value; renderAnnots(); }
});
$('#propSize').addEventListener('input', (e) => {
  const a = byId(S.sel); const type = a ? a.type : S.tool; const v = +e.target.value; if (!(v > 0)) return;
  const key = type === 'text' ? 'size' : 'width';
  if (S.defaults[type]) S.defaults[type][key] = v;
  if (a) { a[key] = v; renderAnnots(); }
});
function deleteSelected() {
  const a = byId(S.sel); if (!a) return;
  checkpoint(); S.annots = S.annots.filter((x) => x !== a); S.sel = null; syncProps(); renderAnnots();
}
$('#btnDelAnnot').onclick = deleteSelected;

// ---------------------------------------------------------------- signature + images
async function fileToImage(file) {
  const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Unsupported image')); i.src = url; });
  let dataUrl = url;
  if (!/^data:image\/(png|jpeg);/.test(url)) {
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0); dataUrl = c.toDataURL('image/png');
  }
  return { dataUrl, w: img.naturalWidth, h: img.naturalHeight };
}
function startPlacing(img) { S.pendingImage = img; setTool('place'); toast('Click on the page where it should go.'); }

$('#btnImage').onclick = () => { if (!hasDoc()) return; $('#fileImage').value = ''; $('#fileImage').click(); };
$('#fileImage').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { startPlacing(await fileToImage(f)); } catch (err) { fail(err); }
};

$('#btnSign').onclick = async () => {
  if (!hasDoc()) return;
  let saved = null; try { saved = localStorage.getItem('pdfstudio.sig'); } catch { /* storage may be blocked */ }
  const wrap = document.createElement('div');
  wrap.innerHTML = `<p class="small">Draw your signature with mouse, finger or stylus.</p><canvas width="600" height="220"></canvas>
    <div class="actions" style="justify-content:flex-start;margin-top:8px"><button type="button" id="sigClear">Clear</button><button type="button" id="sigUpload">Use an image…</button>${saved ? '<button type="button" id="sigSaved">Use saved</button>' : ''}</div>
    <label class="small"><input type="checkbox" id="sigKeep" checked> Remember on this device (stored in this browser only)</label>`;
  const cv = $('canvas', wrap); const g = cv.getContext('2d');
  g.lineWidth = 3.2; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#0b1f5c';
  let down = false, used = false;
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
  cv.onpointerdown = (e) => { down = true; used = true; cv.setPointerCapture(e.pointerId); g.beginPath(); g.moveTo(...pos(e)); };
  cv.onpointermove = (e) => { if (down) { g.lineTo(...pos(e)); g.stroke(); } };
  cv.onpointerup = () => { down = false; };
  $('#sigClear', wrap).onclick = () => { g.clearRect(0, 0, cv.width, cv.height); used = false; };
  $('#sigUpload', wrap).onclick = () => { wrap.closest('.modal-bg').remove(); $('#fileImage').value = ''; $('#fileImage').click(); };
  const p = modal({ title: 'Signature', body: wrap, actions: [{ label: 'Place on page', value: true, primary: true }, { label: 'Cancel', value: false }] });
  const savedBtn = $('#sigSaved', wrap);
  if (savedBtn) savedBtn.onclick = () => { const im = new Image(); im.onload = () => { g.clearRect(0, 0, cv.width, cv.height); g.drawImage(im, 0, 0); used = true; }; im.src = saved; };
  const r = await p;
  if (!r.value || !used) return;
  const id = g.getImageData(0, 0, cv.width, cv.height); let x0 = cv.width, y0 = cv.height, x1 = 0, y1 = 0;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) if (id.data[(y * cv.width + x) * 4 + 3] > 8) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (x1 <= x0) return;
  const pad = 6; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(cv.width, x1 + pad); y1 = Math.min(cv.height, y1 + pad);
  const out = document.createElement('canvas'); out.width = x1 - x0; out.height = y1 - y0;
  out.getContext('2d').drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  const dataUrl = out.toDataURL('image/png');
  if ($('#sigKeep', wrap).checked) { try { localStorage.setItem('pdfstudio.sig', dataUrl); } catch { /* ignore */ } }
  startPlacing({ dataUrl, w: out.width, h: out.height });
};

// ---------------------------------------------------------------- baking annotations into the PDF
async function bake() {
  if (!S.annots.length) return false;
  const doc = await loadDoc(S.bytes);
  const pages = doc.getPages();
  let font = null;
  const imgCache = new Map();
  const embedImg = async (url) => {
    if (!imgCache.has(url)) {
      const raw = Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0));
      imgCache.set(url, /^data:image\/png/.test(url) ? await doc.embedPng(raw) : await doc.embedJpg(raw));
    }
    return imgCache.get(url);
  };
  const safe = (s) => [...s].map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');

  for (const a of S.annots) {
    const pg = pages[a.page]; if (!pg) continue;
    const vp = S.pv[a.page].vp1; const R = vp.rotation || 0;
    const P = (x, y) => vp.convertToPdfPoint(x, y);
    const box = () => {
      const [x1, y1] = P(a.x, a.y), [x2, y2] = P(a.x + a.w, a.y + a.h);
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    };
    switch (a.type) {
      case 'highlight': pg.drawRectangle({ ...box(), color: hexToRgb(a.color), opacity: 0.45, blendMode: BlendMode.Multiply, borderWidth: 0 }); break;
      case 'whiteout': pg.drawRectangle({ ...box(), color: rgb(1, 1, 1), borderWidth: 0 }); break;
      case 'rect': pg.drawRectangle({ ...box(), borderColor: hexToRgb(a.color), borderWidth: a.width }); break;
      case 'ink':
        for (let k = 1; k < a.points.length; k++) {
          const [sx, sy] = P(...a.points[k - 1]); const [ex, ey] = P(...a.points[k]);
          pg.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: a.width, color: hexToRgb(a.color), lineCap: LineCapStyle.Round });
        }
        break;
      case 'text': {
        font = font || await doc.embedFont(StandardFonts.Helvetica);
        a.text.split('\n').forEach((line, k) => {
          if (!line.trim()) return;
          const [x, y] = P(a.x, a.y + a.size * (0.85 + 1.2 * k));
          pg.drawText(safe(line), { x, y, size: a.size, font, color: hexToRgb(a.color), rotate: degrees(R) });
        });
        break;
      }
      case 'image': {
        const im = await embedImg(a.dataUrl); const [x, y] = P(a.x, a.y + a.h);
        pg.drawImage(im, { x, y, width: a.w, height: a.h, rotate: degrees(R) }); break;
      }
      default: break;
    }
  }
  let bytes = await doc.save();

  // Redaction: rasterize affected pages so the underlying text/graphics are really gone.
  const redactPages = [...new Set(S.annots.filter((a) => a.type === 'redact').map((a) => a.page))];
  if (redactPages.length) {
    const tmp = await openPdfjs(bytes); const d2 = await loadDoc(bytes);
    const SCALE = 2.5;
    for (const pi of redactPages) {
      const page = await tmp.getPage(pi + 1); const vp = page.getViewport({ scale: SCALE });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
      g.fillStyle = '#000';
      S.annots.filter((a) => a.type === 'redact' && a.page === pi).forEach((a) => g.fillRect(a.x * SCALE, a.y * SCALE, a.w * SCALE, a.h * SCALE));
      const jpg = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92)).then((b) => b.arrayBuffer());
      const w1 = S.pv[pi].vp1.width, h1 = S.pv[pi].vp1.height;
      const np = d2.insertPage(pi, [w1, h1]); const im = await d2.embedJpg(jpg);
      np.drawImage(im, { x: 0, y: 0, width: w1, height: h1 });
      d2.removePage(pi + 1);
    }
    tmp.destroy(); bytes = await d2.save();
  }
  S.bytes = bytes; S.annots = []; S.sel = null;
  await reload();
  return true;
}

// ---------------------------------------------------------------- save / print / open
async function currentBytes() { await bake(); return S.bytes; }
async function save() {
  if (!hasDoc()) return;
  try {
    if (S.viewOnly) { toast('View-only document cannot be re-saved with edits.', true); return; }
    if (S.annots.length) checkpoint();
    const bytes = await currentBytes();
    if (window.showSaveFilePicker) {
      try {
        if (!S.fileHandle) S.fileHandle = await window.showSaveFilePicker({ suggestedName: S.name, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
        const w = await S.fileHandle.createWritable(); await w.write(bytes); await w.close();
        S.name = S.fileHandle.name; toast('Saved ' + S.name); return;
      } catch (e) { if (e && e.name === 'AbortError') return; S.fileHandle = null; /* fall through to download */ }
    }
    download(bytes, S.name); toast('Downloaded ' + S.name);
  } catch (e) { fail(e, 'Save failed'); }
}
async function printDoc() {
  if (!hasDoc()) return;
  try {
    if (S.annots.length) checkpoint();
    const bytes = await currentBytes();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const fr = document.createElement('iframe'); fr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    fr.src = url; document.body.appendChild(fr);
    fr.onload = () => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch { window.open(url); } setTimeout(() => { fr.remove(); URL.revokeObjectURL(url); }, 60000); };
  } catch (e) { fail(e, 'Print failed'); }
}
$('#btnOpen').onclick = $('#btnOpen2').onclick = () => { $('#fileOpen').value = ''; $('#fileOpen').click(); };
$('#fileOpen').onchange = (e) => e.target.files[0] && loadFile(e.target.files[0]);
$('#btnSave').onclick = save; $('#btnPrint').onclick = printDoc;
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
$('#btnNew').onclick = async () => {
  const d = await PDFDocument.create(); d.addPage([595.28, 841.89]);
  await openBytes(await d.save(), 'untitled.pdf');
};

// drag & drop open
let dragDepth = 0;
addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; $('#dropMask').hidden = false; } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropMask').hidden = true; } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropMask').hidden = true;
  const f = e.dataTransfer?.files?.[0]; if (f && /pdf$/i.test(f.type || f.name)) loadFile(f);
});

// ---------------------------------------------------------------- page operations
function editable() { if (!hasDoc()) return false; if (S.viewOnly) { toast('View-only document: editing is disabled.', true); return false; } return true; }
const targets = () => (S.selPages.size ? [...S.selPages].sort((a, b) => a - b) : [S.cur]);

async function pageOp(fn, keepPage) {
  if (!editable()) return;
  try {
    checkpoint(); await bake();
    const doc = await loadDoc(S.bytes);
    await fn(doc);
    S.bytes = await doc.save();
    await reload(keepPage ?? S.cur);
  } catch (e) { S.undo.pop(); fail(e, 'Operation failed'); await reload().catch(() => {}); }
  syncButtons();
}
async function rotate(delta) {
  const t = targets();
  await pageOp((doc) => { const ps = doc.getPages(); t.forEach((i) => ps[i].setRotation(degrees(((ps[i].getRotation().angle + delta) % 360 + 360) % 360))); });
}
async function deletePages() {
  const t = targets();
  if (t.length >= S.pv.length) return toast('A PDF needs at least one page.', true);
  await pageOp((doc) => { [...t].reverse().forEach((i) => doc.removePage(i)); }, Math.min(t[0], S.pv.length - t.length - 1));
  S.selPages.clear(); markThumbs();
}
async function duplicatePages() {
  const t = targets();
  await pageOp(async (doc) => { for (const i of [...t].reverse()) { const [c] = await doc.copyPages(doc, [i]); doc.insertPage(i + 1, c); } });
}
async function insertBlank() {
  const i = S.cur;
  await pageOp((doc) => { const { width, height } = doc.getPage(i).getSize(); doc.insertPage(i + 1, [width, height]); }, i + 1);
}
async function reorder(moving, target) {
  if (!moving.length) return;
  const n = S.pv.length; const rest = [...Array(n).keys()].filter((k) => !moving.includes(k));
  const pos = rest.filter((k) => k < target).length;
  const order = [...rest.slice(0, pos), ...moving, ...rest.slice(pos)];
  if (order.every((v, k) => v === k)) return;
  await pageOp((doc) => {
    const ps = doc.getPages();
    for (let k = n - 1; k >= 0; k--) doc.removePage(k);
    order.forEach((k) => doc.addPage(ps[k]));
  }, pos);
  S.selPages = new Set(moving.map((_, k) => pos + k)); markThumbs();
}
function moveSel(dir) {
  const t = targets();
  if (dir < 0 && t[0] === 0) return; if (dir > 0 && t[t.length - 1] === S.pv.length - 1) return;
  reorder(t, dir < 0 ? t[0] - 1 : t[t.length - 1] + 2);
}
$('.side-actions').addEventListener('click', (e) => {
  const op = e.target.closest('[data-op]')?.dataset.op; if (!op) return;
  ({ rotL: () => rotate(-90), rotR: () => rotate(90), up: () => moveSel(-1), down: () => moveSel(1), dup: duplicatePages, blank: insertBlank, del: deletePages })[op]();
});

// ---- document tab: merge / extract / split / png / properties / flatten
$('#btnMerge').onclick = async () => {
  if (!editable()) return;
  const body = `<div class="row"><label>PDF or image files</label><input type="file" id="mf" multiple accept="application/pdf,image/*"></div>
    <div class="row"><label>Insert</label><select id="mpos"><option value="after">After current page (${S.cur + 1})</option><option value="start">At the start</option><option value="end">At the end</option></select></div>`;
  const r = await modal({ title: 'Insert / merge files', body, actions: [{ label: 'Insert', value: true, primary: true }, { label: 'Cancel', value: false }] });
  const files = r.value ? [...r.q('#mf').files] : []; if (!files.length) return;
  const mode = r.q('#mpos').value;
  await pageOp(async (doc) => {
    let at = mode === 'start' ? 0 : mode === 'end' ? doc.getPageCount() : S.cur + 1;
    const first = at;
    for (const f of files) {
      if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) {
        const src = await loadDoc(new Uint8Array(await f.arrayBuffer()));
        const cps = await doc.copyPages(src, src.getPageIndices());
        cps.forEach((p) => doc.insertPage(at++, p));
      } else {
        const im = await fileToImage(f); const raw = Uint8Array.from(atob(im.dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
        const emb = /png/.test(im.dataUrl.slice(0, 20)) ? await doc.embedPng(raw) : await doc.embedJpg(raw);
        const s = Math.min(1, 595 / im.w, 842 / im.h) || 1; const w = im.w * s, h = im.h * s;
        const p = doc.insertPage(at++, [w, h]); p.drawImage(emb, { x: 0, y: 0, width: w, height: h });
      }
    }
    S.__goto = first;
  });
  if (S.__goto != null) { scrollToPage(S.__goto, false); delete S.__goto; }
};
async function extractTo(indices, name) {
  const src = await loadDoc(await currentBytes());
  const out = await PDFDocument.create();
  (await out.copyPages(src, indices)).forEach((p) => out.addPage(p));
  download(await out.save(), name);
}
$('#btnExtract').onclick = async () => {
  if (!hasDoc()) return;
  const def = S.selPages.size ? compressRange([...S.selPages].sort((a, b) => a - b)) : String(S.cur + 1);
  const r = await modal({ title: 'Extract pages to a new PDF', body: `<div class="row"><label>Pages (e.g. 1-3,5) of ${S.pv.length}</label><input type="text" id="rg" value="${def}"></div>` });
  if (!r.value) return;
  try { await extractTo(parseRange(r.q('#rg').value, S.pv.length), `${baseName()}-extract.pdf`); toast('Extracted.'); } catch (e) { fail(e); }
};
$('#btnSplit').onclick = async () => {
  if (!hasDoc()) return;
  const r = await modal({ title: 'Split into parts', body: `<div class="row"><label>Pages per part (document has ${S.pv.length})</label><input type="number" id="n" min="1" value="1"></div><p class="small">Each part downloads as a separate file. Your browser may ask to allow multiple downloads.</p>` });
  if (!r.value) return;
  const n = Math.max(1, +r.q('#n').value | 0); const total = S.pv.length;
  try { for (let s = 0, part = 1; s < total; s += n, part++) await extractTo([...Array(Math.min(n, total - s)).keys()].map((k) => s + k), `${baseName()}-part${part}.pdf`); toast('Split complete.'); } catch (e) { fail(e); }
};
function compressRange(a) {
  const out = []; let s = a[0], p = a[0];
  for (let k = 1; k <= a.length; k++) { if (a[k] === p + 1) { p = a[k]; continue; } out.push(s === p ? `${s + 1}` : `${s + 1}-${p + 1}`); s = p = a[k]; }
  return out.join(',');
}
$('#btnPng').onclick = async () => {
  if (!hasDoc()) return;
  try {
    if (S.annots.length) checkpoint();
    await bake();
    const p = S.pv[S.cur]; const vp = p.page.getViewport({ scale: 2 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await p.page.render({ canvasContext: g, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    download(await blob.arrayBuffer(), `${baseName()}-page${S.cur + 1}.png`, 'image/png');
  } catch (e) { fail(e); }
};
$('#btnProps').onclick = async () => {
  if (!editable()) return;
  const doc = await loadDoc(S.bytes);
  const f = (id, label) => `<div class="row"><label>${label}</label><input type="text" id="${id}"></div>`;
  const r = await modal({
    title: 'Document properties',
    body: f('t', 'Title') + f('a', 'Author') + f('s', 'Subject') + f('k', 'Keywords (comma separated)'),
    onReady: (m) => {
      $('#t', m).value = doc.getTitle() || ''; $('#a', m).value = doc.getAuthor() || '';
      $('#s', m).value = doc.getSubject() || ''; $('#k', m).value = doc.getKeywords() || '';
    },
  });
  if (!r.value) return;
  await pageOp((d) => {
    d.setTitle(r.q('#t').value); d.setAuthor(r.q('#a').value); d.setSubject(r.q('#s').value);
    d.setKeywords(r.q('#k').value.split(',').map((x) => x.trim()).filter(Boolean));
  });
};
async function updateDocInfo() {
  const kb = (S.bytes.length / 1024).toFixed(0);
  $('#docInfo').textContent = `${S.name} · ${S.pv.length} page(s) · ${kb} KB${S.viewOnly ? ' · view-only' : ''}`;
}

// ---------------------------------------------------------------- forms
async function refreshForms() {
  const host = $('#formBody'); host.innerHTML = '';
  if (S.viewOnly) { host.textContent = 'Not available for view-only documents.'; return; }
  let doc, fields;
  try { doc = await loadDoc(S.bytes); fields = doc.getForm().getFields(); } catch { host.textContent = 'Could not read form fields.'; return; }
  if (!fields.length) { host.textContent = 'This PDF has no fillable form fields.'; return; }
  const wrap = document.createElement('div');
  fields.forEach((f, idx) => {
    const row = document.createElement('div'); row.className = 'field';
    const lab = document.createElement('label'); lab.textContent = f.getName(); row.appendChild(lab);
    let input;
    if (f instanceof PDFTextField) { input = document.createElement('input'); input.type = 'text'; input.value = f.getText() || ''; }
    else if (f instanceof PDFCheckBox) { input = document.createElement('input'); input.type = 'checkbox'; input.checked = f.isChecked(); }
    else if (f instanceof PDFDropdown || f instanceof PDFOptionList || f instanceof PDFRadioGroup) {
      input = document.createElement('select');
      const opts = f.getOptions(); const sel = f.getSelected ? f.getSelected() : null;
      const cur = Array.isArray(sel) ? sel[0] : sel;
      ['', ...opts].forEach((o) => { const op = document.createElement('option'); op.value = o; op.textContent = o || '(none)'; if (o === cur) op.selected = true; input.appendChild(op); });
    } else { const s = document.createElement('span'); s.className = 'small'; s.textContent = 'Unsupported field type (button/signature)'; row.appendChild(s); wrap.appendChild(row); return; }
    input.dataset.idx = idx; row.appendChild(input); wrap.appendChild(row);
  });
  const btn = document.createElement('button'); btn.className = 'primary'; btn.textContent = 'Apply form values';
  btn.onclick = () => applyForm(wrap);
  host.appendChild(wrap); host.appendChild(btn);
}
async function applyForm(wrap) {
  await pageOp((doc) => {
    const form = doc.getForm(); const fields = form.getFields();
    $$('[data-idx]', wrap).forEach((inp) => {
      const f = fields[+inp.dataset.idx];
      if (f instanceof PDFTextField) { f.setText(inp.value || undefined); }
      else if (f instanceof PDFCheckBox) { inp.checked ? f.check() : f.uncheck(); }
      else if (f instanceof PDFDropdown) { inp.value ? f.select(inp.value) : f.clear(); }
      else if (f instanceof PDFOptionList) { inp.value ? f.select(inp.value) : f.clear(); }
      else if (f instanceof PDFRadioGroup) { if (inp.value) f.select(inp.value); }
    });
    form.updateFieldAppearances();
  });
  toast('Form updated.');
}
$('#btnFlatten').onclick = async () => {
  if (!editable()) return;
  await pageOp((doc) => { const f = doc.getForm(); f.updateFieldAppearances(); f.flatten(); });
  toast('Form fields flattened (no longer editable).');
};

// ---------------------------------------------------------------- search
$('#searchForm').addEventListener('submit', async (e) => {
  e.preventDefault(); if (!hasDoc()) return;
  const q = $('#searchInput').value.trim(); const list = $('#searchResults'); list.innerHTML = '';
  S.hits = []; renderAnnots();
  if (!q) { $('#searchStatus').textContent = ''; return; }
  $('#searchStatus').textContent = 'Searching…';
  const ql = q.toLowerCase(); let count = 0; const results = [];
  for (let i = 0; i < S.pv.length; i++) {
    const tc = await S.pv[i].page.getTextContent(); const vp = S.pv[i].vp1;
    for (const it of tc.items) {
      if (!it.str) continue; const s = it.str.toLowerCase(); let from = 0, at;
      while ((at = s.indexOf(ql, from)) !== -1) {
        from = at + ql.length; count++;
        const [x1, y1, x2, y2] = vp.convertToViewportRectangle([it.transform[4], it.transform[5], it.transform[4] + it.width, it.transform[5] + it.height]);
        const left = Math.min(x1, x2), top = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
        const hit = { page: i, x: left + w * at / s.length, y: top, w: w * ql.length / s.length, h };
        S.hits.push(hit); results.push({ hit, ctx: it.str });
      }
    }
  }
  $('#searchStatus').textContent = count ? `${count} match(es). Highlight positions are approximate.` : 'No matches. (Scanned pages without a text layer cannot be searched.)';
  results.slice(0, 500).forEach((r) => {
    const li = document.createElement('li'); li.innerHTML = `<b>p.${r.hit.page + 1}</b> `; li.append(document.createTextNode(r.ctx.slice(0, 90)));
    li.onclick = () => { scrollToPage(r.hit.page); }; list.appendChild(li);
  });
  renderAnnots();
});

// ---------------------------------------------------------------- UI wiring
function syncButtons() {
  $('#btnUndo').disabled = !S.undo.length; $('#btnRedo').disabled = !S.redo.length;
  const dis = !hasDoc();
  ['btnSave', 'btnPrint', 'btnSign', 'btnImage', 'btnMerge', 'btnExtract', 'btnSplit', 'btnPng', 'btnProps', 'btnFlatten'].forEach((id) => { $('#' + id).disabled = dis; });
  $$('#tools button[data-tool]').forEach((b) => { b.disabled = dis; });
  $$('.side-actions button').forEach((b) => { b.disabled = dis; });
}
$('#tools').addEventListener('click', (e) => { const t = e.target.closest('[data-tool]')?.dataset.tool; if (t) setTool(t); });
$('#zoomIn').onclick = () => setZoom(S.zoom * 1.2); $('#zoomOut').onclick = () => setZoom(S.zoom / 1.2); $('#zoomFit').onclick = fitWidth;
$('#pageNum').addEventListener('change', (e) => { if (hasDoc()) scrollToPage(clamp((+e.target.value | 0) - 1, 0, S.pv.length - 1)); });
$('#btnPanel').onclick = () => $('#panel').classList.toggle('closed');
$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tabbody').forEach((t) => { t.hidden = t.id !== 'tab-' + b.dataset.tab; });
}));
$('#viewer').addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });
addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey; const typing = /input|textarea|select/i.test(e.target.tagName);
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#btnOpen').click(); }
  else if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); printDoc(); }
  else if (!typing && mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (!typing && mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && S.sel) { e.preventDefault(); deleteSelected(); }
  else if (e.key === 'Escape' && !typing) { S.pendingImage = null; setTool('select'); }
});
addEventListener('beforeunload', (e) => { if (S.undo.length) { e.preventDefault(); e.returnValue = ''; } });

// PWA
let deferredInstall;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; $('#btnInstall').hidden = false; });
$('#btnInstall').onclick = async () => { if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; $('#btnInstall').hidden = true; } };
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});

syncButtons();
// test/debug hook
window.__pdfstudio = { S, openBytes, bake, reorder, rotate };
