import './styles.css';
import { PasswordRequired, type SourceDoc, UnsupportedFile, isSupported, openDocument } from './documents';
import { type EngineState, OcrClient } from './ocr/client';
import type { ModelTier, OcrPage } from './ocr/types';
import { buildTextLayer, enableSelectionTracking, pageText, selectedText } from './textlayer';

// ——— State ———

type PageStatus = 'queued' | 'working' | 'done' | 'error';

interface Page {
  doc: Doc;
  index: number;
  width: number;
  height: number;
  status: PageStatus;
  progress: number;
  ocr?: OcrPage;
  el: HTMLDivElement;
  img: HTMLImageElement;
  near: boolean;
}

interface Doc {
  id: number;
  name: string;
  file: File;
  source: SourceDoc | null;
  pages: Page[];
  error?: string;
  el: HTMLElement;
  nav: HTMLLIElement;
  removed: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $('app');
const viewer = $('viewer');
const docsEl = $('docs');
const docList = $('doc-list');
const fileInput = $<HTMLInputElement>('file-input');

const docs: Doc[] = [];
let nextDocId = 1;
let zoom = 1;

const TIER_KEY = 'legible:tier';
const BOXES_KEY = 'legible:boxes';
const storage = {
  get(k: string) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string) {
    try { localStorage.setItem(k, v); } catch { /* private mode */ }
  },
};

// ——— Small helpers ———

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

const ICONS = {
  copy: '<svg viewBox="0 0 20 20"><rect x="6.5" y="6.5" width="10" height="11" rx="2.2"/><path d="M13.5 6.5V5a2 2 0 0 0-2-2H5.5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1"/></svg>',
  close: '<svg viewBox="0 0 20 20"><path d="m6 6 8 8m0-8-8 8"/></svg>',
  check: '<svg viewBox="0 0 20 20"><path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg>',
  alert: '<svg viewBox="0 0 20 20"><path d="M10 6.5v4.5M10 14v.01"/><circle cx="10" cy="10" r="7.5"/></svg>',
};

function toast(message: string, kind: 'ok' | 'error' = 'ok') {
  const t = el('div', `toast ${kind === 'error' ? 'error' : ''}`, `${kind === 'error' ? ICONS.alert : ICONS.check}<span></span>`);
  t.querySelector('span')!.textContent = message;
  const region = $('toasts');
  region.appendChild(t);
  while (region.children.length > 3) region.firstElementChild!.remove();
  setTimeout(() => {
    t.classList.add('out');
    t.addEventListener('animationend', () => t.remove(), { once: true });
  }, 2200);
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers/contexts without the async clipboard API.
    const ta = el('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// ——— OCR engine ———

// Default: the accurate model on desktops; the 6 MB fast model on phones
// and tablets (smaller download, far less CPU). The user's choice sticks.
const storedTier = storage.get(TIER_KEY);
let tier: ModelTier =
  storedTier === 'tiny' || storedTier === 'small' ? storedTier : matchMedia('(pointer: coarse)').matches ? 'tiny' : 'small';
let engine: OcrClient;

function renderEngineState(s: EngineState) {
  const box = $('engine');
  const label = $('engine-label');
  box.dataset.state = s.kind;
  if (s.kind === 'loading') {
    const pct = s.total ? Math.round((s.loaded / s.total) * 100) : 0;
    label.textContent = s.total ? `Downloading text recognition · ${pct}%` : 'Preparing text recognition…';
    $('engine-bar').style.width = `${pct}%`;
    box.title = 'The PP-OCRv6 model is downloaded once and cached on this device.';
  } else if (s.kind === 'ready') {
    label.textContent = 'Ready · on-device';
    box.title = `PP-OCRv6 ${tier} · ${s.backend === 'webgpu' ? 'WebGPU' : `WASM, ${plural(s.threads, 'thread')}`}`;
  } else {
    label.textContent = 'Text recognition unavailable';
    box.title = s.message;
  }
}

function startEngine() {
  engine?.dispose();
  // ?backend=wasm forces the CPU path (useful for troubleshooting GPU drivers).
  const pref = new URLSearchParams(location.search).get('backend');
  engine = new OcrClient(tier, renderEngineState, pref === 'wasm' || pref === 'webgpu' ? pref : 'auto');
  engine.ready().then(pump, (e: Error) => toast(e.message, 'error'));
  document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tier === tier)));
}

// ——— Layout & zoom ———

const MAX_PAGE_W = 880;

function layout() {
  const avail = viewer.clientWidth - (window.innerWidth <= 860 ? 24 : 48);
  const pw = Math.max(200, Math.min(avail, MAX_PAGE_W) * zoom);
  viewer.style.setProperty('--pw', pw.toFixed(2));
  $('zoom-reset').textContent = `${Math.round(zoom * 100)}%`;
}

function setZoom(z: number) {
  // Keep the point at the centre of the view steady while zooming.
  const before = viewer.scrollHeight;
  const anchor = (viewer.scrollTop + viewer.clientHeight / 2) / Math.max(before, 1);
  zoom = Math.min(3, Math.max(0.5, Math.round(z * 100) / 100));
  layout();
  viewer.scrollTop = anchor * viewer.scrollHeight - viewer.clientHeight / 2;
}

new ResizeObserver(layout).observe(viewer);

// ——— Page visibility: lazy image loading + scan priority ———

const pageByEl = new WeakMap<Element, Page>();

const nearObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const page = pageByEl.get(e.target);
      if (!page) continue;
      page.near = e.isIntersecting;
      if (page.near) void showImage(page);
      else if (page.doc.source?.kind === 'pdf' && page.img.src) {
        // Let the browser drop far-away decoded page bitmaps.
        page.img.removeAttribute('src');
        page.img.classList.remove('loaded');
      }
    }
    pump();
  },
  { root: viewer, rootMargin: '150% 0px' },
);

let currentPage: Page | null = null;
const inViewObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting && e.intersectionRatio > 0) {
        const p = pageByEl.get(e.target);
        if (p) currentPage = p;
      }
    }
    updateDock();
  },
  { root: viewer, rootMargin: '-45% 0px -45% 0px' },
);

function updateDock() {
  const all = docs.flatMap((d) => d.pages);
  const p = currentPage && !currentPage.doc.removed ? currentPage : all[0];
  $('dock-page').textContent = p ? `Page ${(all.indexOf(p) + 1).toLocaleString()} of ${all.length.toLocaleString()}` : '—';
  for (const d of docs) d.nav.classList.toggle('active', !!p && p.doc === d);
}

async function showImage(page: Page) {
  if (!page.doc.source || page.img.getAttribute('src')) return;
  try {
    const url = await page.doc.source.pageUrl(page.index);
    if (!page.near || page.doc.removed) return;
    page.img.src = url;
  } catch {
    /* rendering errors surface through the scan */
  }
}

// ——— Scan queue ———

let busy = false;

function nextPage(): Page | null {
  let first: Page | null = null;
  for (const d of docs) {
    for (const p of d.pages) {
      if (p.status !== 'queued') continue;
      if (p.near) return p;
      first ??= p;
    }
  }
  return first;
}

/** Bumped when the engine is replaced, so a stale in-flight scan can't release the queue. */
let generation = 0;

async function pump() {
  if (busy || engine.state.kind !== 'ready') return;
  const page = nextPage();
  if (!page || !page.doc.source) return;
  const gen = generation;
  const client = engine;
  busy = true;
  setStatus(page, 'working');
  try {
    const bitmap = await page.doc.source.pageBitmap(page.index);
    if (gen !== generation) {
      bitmap.close();
      throw new Error('cancelled');
    }
    const ocr = await client.recognize(bitmap, (f) => {
      page.progress = f;
      renderNav(page.doc);
    });
    if (!page.doc.removed) attachText(page, ocr);
  } catch (e) {
    if (!page.doc.removed) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'cancelled') {
        // Interrupted by a model switch: scan again with the new model.
        page.progress = 0;
        setStatus(page, 'queued');
      } else {
        setStatus(page, 'error');
        page.el.appendChild(el('div', 'page-error', 'Couldn’t scan this page'));
      }
    }
  } finally {
    if (gen === generation) {
      busy = false;
      void pump();
    }
  }
}

function setStatus(page: Page, status: PageStatus) {
  page.status = status;
  page.el.dataset.status = status;
  renderNav(page.doc);
}

function attachText(page: Page, ocr: OcrPage) {
  page.ocr = ocr;
  page.el.querySelector('.text-layer')?.remove();
  const layer = buildTextLayer(ocr);
  page.el.appendChild(layer);
  setStatus(page, 'done');
  if (ocr.lines.length && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    layer.classList.add('reveal');
    setTimeout(() => layer.classList.remove('reveal'), 1500);
  }
}

// ——— Documents ———

function docText(d: Doc): string {
  return d.pages
    .filter((p) => p.ocr)
    .map((p) => pageText(p.ocr!))
    .filter(Boolean)
    .join('\n\n');
}

function renderNav(d: Doc) {
  const done = d.pages.filter((p) => p.status === 'done' || p.status === 'error').length;
  const total = d.pages.length;
  const sub = d.nav.querySelector('.doc-sub')!;
  sub.classList.toggle('error', !!d.error);
  if (d.error) {
    sub.textContent = d.error;
  } else if (!d.source) {
    sub.textContent = 'Opening…';
  } else if (done === 0 && !d.pages.some((p) => p.status === 'working')) {
    sub.textContent = `${plural(total, 'page')} · waiting to scan`;
  } else if (done < total) {
    const working = d.pages.find((p) => p.status === 'working');
    const frac = (done + (working ? working.progress : 0)) / total;
    sub.innerHTML = `<span>${total > 1 ? `Scanning ${Math.min(done + 1, total)} of ${total}` : 'Scanning'}</span><span class="mini-bar"><span style="width:${(frac * 100).toFixed(1)}%"></span></span>`;
  } else {
    const words = d.pages.reduce((n, p) => n + (p.ocr?.lines.reduce((m, l) => m + l.words.length, 0) ?? 0), 0);
    sub.innerHTML = `${ICONS.check.replace('<svg', '<svg class="check"')}<span>${plural(total, 'page')} · ${words ? plural(words, 'word') : 'no text found'}</span>`;
  }
  const meta = d.el.querySelector('.doc-head .meta');
  if (meta) meta.textContent = d.source ? plural(total, 'page') : '';
}

function updateAppState() {
  const live = docs.filter((d) => !d.removed);
  app.dataset.state = live.length ? 'docs' : 'empty';
  $('doc-count').textContent = String(live.length);
  updateDock();
}

function removeDoc(d: Doc) {
  d.removed = true;
  d.source?.destroy();
  for (const p of d.pages) {
    nearObserver.unobserve(p.el);
    inViewObserver.unobserve(p.el);
  }
  d.el.remove();
  d.nav.remove();
  docs.splice(docs.indexOf(d), 1);
  updateAppState();
}

function scrollToDoc(d: Doc) {
  d.el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

function createDocShell(file: File): Doc {
  const section = el('section', 'doc');
  const head = el('header', 'doc-head');
  head.innerHTML = `<span class="name"></span><span class="meta"></span><span class="spacer"></span>
    <button class="icon-btn" data-act="copy" title="Copy text from this document" aria-label="Copy text from this document">${ICONS.copy}</button>
    <button class="icon-btn" data-act="remove" title="Remove" aria-label="Remove document">${ICONS.close}</button>`;
  head.querySelector('.name')!.textContent = file.name;
  section.appendChild(head);

  const nav = el('li', 'doc-item');
  nav.tabIndex = 0;
  nav.innerHTML = `<div class="doc-thumb"></div><div class="doc-meta"><div class="doc-name"></div><div class="doc-sub">Opening…</div></div>`;
  nav.querySelector('.doc-name')!.textContent = file.name;
  nav.title = file.name;

  const d: Doc = { id: nextDocId++, name: file.name, file, source: null, pages: [], el: section, nav, removed: false };
  nav.addEventListener('click', () => scrollToDoc(d));
  nav.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      scrollToDoc(d);
    }
  });
  head.addEventListener('click', async (e) => {
    const act = (e.target as Element).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'remove') removeDoc(d);
    if (act === 'copy') {
      const text = docText(d);
      if (!text) return toast(d.pages.some((p) => !p.ocr) ? 'Still scanning — try again in a moment' : 'No text found', 'error');
      if (await writeClipboard(text)) toast(`Copied ${plural(text.length, 'character')}`);
    }
  });
  return d;
}

function askPassword(name: string, incorrect: boolean): Promise<string | null> {
  const dialog = $<HTMLDialogElement>('pw-dialog');
  const input = $<HTMLInputElement>('pw-input');
  $('pw-text').textContent = incorrect ? `That password didn’t work for “${name}”. Try again.` : `“${name}” is password protected.`;
  input.value = '';
  dialog.showModal();
  input.focus();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' && input.value ? input.value : null), { once: true });
  });
}

// Documents open one at a time so a large batch doesn't spike memory,
// while their shells appear immediately in drop order.
let openChain: Promise<void> = Promise.resolve();

function addFiles(files: Iterable<File>) {
  const accepted: Doc[] = [];
  let skipped = 0;
  for (const file of files) {
    if (!isSupported(file)) {
      skipped++;
      continue;
    }
    const d = createDocShell(file);
    docs.push(d);
    docsEl.appendChild(d.el);
    docList.appendChild(d.nav);
    accepted.push(d);
  }
  if (skipped) toast(`${plural(skipped, 'file')} skipped — only PDFs and images are supported`, 'error');
  if (!accepted.length) return;
  updateAppState();
  layout();
  scrollToDoc(accepted[0]);
  for (const d of accepted) openChain = openChain.then(() => openDoc(d));
}

async function openDoc(d: Doc) {
  if (d.removed) return;
  let password: string | undefined;
  for (;;) {
    try {
      d.source = await openDocument(d.file, password);
      break;
    } catch (e) {
      if (e instanceof PasswordRequired) {
        const pw = await askPassword(d.name, e.incorrect);
        if (pw === null) {
          d.error = 'Locked — password not provided';
          break;
        }
        password = pw;
        continue;
      }
      d.error = e instanceof UnsupportedFile ? e.message : 'This file couldn’t be opened.';
      break;
    }
  }
  if (d.removed) {
    d.source?.destroy();
    return;
  }
  if (!d.source) {
    const box = el('div', 'doc-error');
    box.textContent = d.error ?? 'This file couldn’t be opened.';
    d.el.appendChild(box);
    renderNav(d);
    return;
  }

  d.source.pages.forEach((size, index) => {
    const pageEl = el('div', 'page');
    pageEl.style.aspectRatio = `${size.width} / ${size.height}`;
    pageEl.dataset.status = 'queued';
    const img = el('img');
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.addEventListener('load', () => img.classList.add('loaded'));
    pageEl.append(
      el('div', 'page-placeholder'),
      img,
      el('div', 'scan', '<div class="scan-chip"><span class="spinner"></span>Scanning text…</div>'),
      el('div', 'queued-chip', 'Waiting to scan'),
      el('div', 'page-num', `${index + 1}`),
    );
    const page: Page = { doc: d, index, width: size.width, height: size.height, status: 'queued', progress: 0, el: pageEl, img, near: false };
    pageByEl.set(pageEl, page);
    d.pages.push(page);
    d.el.appendChild(pageEl);
    nearObserver.observe(pageEl);
    inViewObserver.observe(pageEl);
  });
  renderNav(d);
  updateDock();
  d.source.pageUrl(0).then((url) => {
    (d.nav.querySelector('.doc-thumb') as HTMLElement).style.backgroundImage = `url("${url}")`;
  }, () => {});
  void pump();
}

// ——— Copy & select ———

document.addEventListener('copy', (e) => {
  const sel = document.getSelection();
  if (!sel) return;
  const text = selectedText(sel);
  if (text === null || !e.clipboardData) return;
  e.clipboardData.setData('text/plain', text);
  e.preventDefault();
});

function selectAllText() {
  const layers = docsEl.querySelectorAll('.text-layer');
  if (!layers.length) return false;
  const range = document.createRange();
  range.setStart(layers[0], 0);
  const last = layers[layers.length - 1];
  range.setEnd(last, last.childNodes.length);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

async function copyAll() {
  const text = docs.map(docText).filter(Boolean).join('\n\n');
  if (!text) return toast(docs.some((d) => d.pages.some((p) => !p.ocr)) ? 'Still scanning — try again in a moment' : 'No text found', 'error');
  if (await writeClipboard(text)) toast(`Copied ${plural(text.length, 'character')} from ${plural(docs.length, 'document')}`);
}

function exportText() {
  const parts = docs.map((d) => {
    const t = docText(d);
    return docs.length > 1 ? `===== ${d.name} =====\n\n${t}` : t;
  });
  const text = parts.join('\n\n\n');
  if (!text.trim()) return toast('No text to export yet', 'error');
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = docs.length === 1 ? `${docs[0].name.replace(/\.[^.]+$/, '')}.txt` : 'legible-export.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ——— Wiring ———

$('add').addEventListener('click', () => fileInput.click());
$('dropcard').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files) addFiles(Array.from(fileInput.files));
  fileInput.value = '';
});
$('copy-all').addEventListener('click', copyAll);
$('export').addEventListener('click', exportText);
$('zoom-in').addEventListener('click', () => setZoom(zoom * 1.2));
$('zoom-out').addEventListener('click', () => setZoom(zoom / 1.2));
$('zoom-reset').addEventListener('click', () => setZoom(1));

document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    const t = b.dataset.tier as ModelTier;
    if (t === tier) return;
    tier = t;
    storage.set(TIER_KEY, t);
    // The in-flight page (if any) is requeued by pump() once the old engine cancels it.
    generation++;
    busy = false;
    startEngine();
    toast(t === 'small' ? 'Accurate mode — applies to pages scanned from now on' : 'Fast mode — applies to pages scanned from now on');
  }),
);

const boxes = $<HTMLInputElement>('show-boxes');
boxes.checked = storage.get(BOXES_KEY) === '1';
docsEl.classList.toggle('show-boxes', boxes.checked);
boxes.addEventListener('change', () => {
  docsEl.classList.toggle('show-boxes', boxes.checked);
  storage.set(BOXES_KEY, boxes.checked ? '1' : '0');
});

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const typing = (e.target as Element).closest?.('input, textarea, [contenteditable="true"], dialog');
  if (!mod || typing) return;
  const k = e.key.toLowerCase();
  if (k === 'o') {
    e.preventDefault();
    fileInput.click();
  } else if (k === 'a' && docs.length) {
    if (selectAllText()) e.preventDefault();
  } else if (k === '=' || k === '+') {
    e.preventDefault();
    setZoom(zoom * 1.2);
  } else if (k === '-') {
    e.preventDefault();
    setZoom(zoom / 1.2);
  } else if (k === '0') {
    e.preventDefault();
    setZoom(1);
  }
});

// Drag and drop anywhere in the window.
let dragDepth = 0;
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('drop-overlay').classList.add('on');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('drop-overlay').classList.remove('on');
  }
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').classList.remove('on');
  addFiles(Array.from(e.dataTransfer!.files));
});

// Paste screenshots / copied images straight in.
document.addEventListener('paste', (e) => {
  if ((e.target as Element).closest?.('input, textarea')) return;
  const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/') || f.type === 'application/pdf');
  if (!files.length) return;
  e.preventDefault();
  const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  addFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `Pasted image ${stamp}${files.length > 1 ? ` (${i + 1})` : ''}.${f.type.split('/')[1] || 'png'}`, { type: f.type }))));
});

window.addEventListener('beforeunload', (e) => {
  if (docs.some((d) => d.pages.some((p) => p.status === 'queued' || p.status === 'working'))) e.preventDefault();
});

enableSelectionTracking(docsEl);
layout();
startEngine();

// Test hook: lets end-to-end tests inspect results without scraping the DOM.
declare global {
  interface Window {
    __legible?: { docs: () => { name: string; pages: (OcrPage | null)[]; error?: string }[] };
  }
}
window.__legible = {
  docs: () => docs.map((d) => ({ name: d.name, pages: d.pages.map((p) => p.ocr ?? null), error: d.error })),
};
