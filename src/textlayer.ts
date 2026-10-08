import type { OcrPage } from './ocr/types';

/**
 * The invisible, selectable text layer.
 *
 * Coordinates are the OCR image's pixels; the whole layer is scaled to
 * the displayed page with one CSS transform. Each detected line gets its
 * own box mapped onto the page with an affine `matrix()` (so rotated or
 * tilted lines follow the print exactly), and every word inside it is a
 * span positioned at the word's measured location and stretched with
 * `scale()` to cover precisely that word — nothing is left to the font's
 * natural width, so spaces and font differences can't accumulate drift.
 */

const FONT_PX = 100;
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const FONT = `${FONT_PX}px ${FONT_FAMILY}`;

let metrics: { ascentBox: number; ctx: CanvasRenderingContext2D; cache: Map<string, number> } | null = null;

/**
 * Height of the font's content area (what selection highlights paint) at
 * FONT_PX, measured from the real DOM so it matches whatever font the
 * platform resolves.
 */
function getMetrics() {
  if (metrics) return metrics;
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${FONT};line-height:normal;font-kerning:normal`;
  probe.textContent = 'Hg';
  document.body.appendChild(probe);
  const ascentBox = probe.getBoundingClientRect().height || FONT_PX * 1.2;
  probe.remove();
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.font = FONT;
  metrics = { ascentBox, ctx, cache: new Map() };
  return metrics;
}

function textWidth(text: string): number {
  const m = getMetrics();
  let w = m.cache.get(text);
  if (w === undefined) {
    w = m.ctx.measureText(text).width || FONT_PX * 0.5;
    if (m.cache.size > 20000) m.cache.clear();
    m.cache.set(text, w);
  }
  return w;
}

function span(cls: string, text: string, x: number, width: number, height: number): HTMLSpanElement {
  const m = getMetrics();
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  const sx = Math.max(width, 0.01) / textWidth(text);
  const sy = height / m.ascentBox;
  el.style.left = `${x}px`;
  el.style.transform = `scale(${sx},${sy})`;
  return el;
}

export function buildTextLayer(page: OcrPage): HTMLDivElement {
  const m = getMetrics();
  const layer = document.createElement('div');
  layer.className = 'text-layer';
  layer.style.width = `${page.width}px`;
  layer.style.height = `${page.height}px`;
  layer.style.setProperty('--ocr-w', String(page.width));
  layer.style.fontFamily = FONT_FAMILY;
  layer.style.setProperty('--line-h', `${m.ascentBox}px`);

  const frag = document.createDocumentFragment();
  for (const line of page.lines) {
    const { origin, u, v, length, thickness } = line.frame;
    const ln = document.createElement('div');
    ln.className = 'ln';
    ln.dataset.join = line.join;
    ln.style.width = `${length}px`;
    ln.style.height = `${thickness}px`;
    ln.style.transform = `matrix(${u[0]},${u[1]},${v[0]},${v[1]},${origin[0]},${origin[1]})`;
    line.words.forEach((w, i) => {
      if (i > 0) {
        // The gap between words is a real, selectable space that exactly
        // fills the gap, so highlights run continuously across the line.
        const prev = line.words[i - 1];
        ln.appendChild(span('s', ' ', prev.x1, w.x0 - prev.x1, thickness));
      }
      ln.appendChild(span('w', w.text, w.x0, w.x1 - w.x0, thickness));
    });
    frag.appendChild(ln);
  }
  // Keeps drag-selection from jumping when the pointer is over empty page
  // areas (same technique as PDF.js' endOfContent).
  const end = document.createElement('div');
  end.className = 'eoc';
  frag.appendChild(end);
  layer.appendChild(frag);

  return layer;
}

/**
 * Keeps drag-selection anchored while the pointer crosses empty page
 * space. During a drag every layer's end-of-content sentinel expands to
 * cover its page, and the one in the layer being extended is moved right
 * after the line holding the selection focus — so empty space resolves to
 * "here", not "end of page" (the PDF.js technique).
 */
export function enableSelectionTracking(container: HTMLElement) {
  let dragging = false;
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    container.classList.remove('selecting');
    for (const layer of Array.from(container.querySelectorAll('.text-layer'))) {
      const eoc = layer.querySelector(':scope > .eoc');
      if (eoc && eoc !== layer.lastElementChild) layer.appendChild(eoc);
    }
  };
  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !(e.target as Element).closest('.text-layer')) return;
    dragging = true;
    container.classList.add('selecting');
  });
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  window.addEventListener('blur', stop);
  document.addEventListener('selectionchange', () => {
    if (!dragging) return;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.focusNode) return;
    const focus = sel.focusNode.nodeType === Node.ELEMENT_NODE ? (sel.focusNode as Element) : sel.focusNode.parentElement;
    const ln = focus?.closest('.ln');
    const layer = ln?.parentElement;
    if (!ln || !layer) return;
    const eoc = layer.querySelector(':scope > .eoc');
    if (!eoc) return;
    const range = sel.getRangeAt(0);
    const backward = range.startContainer === sel.focusNode && range.startOffset === sel.focusOffset && !sel.isCollapsed;
    // Over empty space the browser snaps the focus to the nearest boundary
    // of the neighbouring line; following that would walk the sentinel (and
    // the selection) one line further on every pointer move.
    const edge = lineEdge(ln, sel.focusNode, sel.focusOffset);
    if ((edge === 'start' && eoc.nextElementSibling === ln) || (edge === 'end' && eoc.previousElementSibling === ln)) return;
    const ref = backward ? ln : ln.nextSibling;
    if (ref !== eoc && eoc.nextSibling !== ref) layer.insertBefore(eoc, ref);
  });
}

/** Whether a DOM position sits at the very start or end of a line's text. */
function lineEdge(ln: Element, node: Node, offset: number): 'start' | 'end' | null {
  const first = ln.firstElementChild, last = ln.lastElementChild;
  if (node === ln) return offset === 0 ? 'start' : offset >= ln.childNodes.length ? 'end' : null;
  const span = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const len = node.nodeType === Node.TEXT_NODE ? (node as Text).length : node.childNodes.length;
  if (span === first && offset === 0) return 'start';
  if (span === last && offset >= len) return 'end';
  return null;
}

const SEPARATORS: Record<string, string> = { none: '', space: ' ', newline: '\n', paragraph: '\n\n' };

/** Plain text of a page in reading order. */
export function pageText(page: OcrPage): string {
  return page.lines.map((l, i) => (i === 0 ? '' : SEPARATORS[l.join]) + l.text).join('');
}

/**
 * Text for the current selection, rebuilt from the layout model rather
 * than from the browser's serialization of absolutely positioned spans
 * (which would drop line breaks and invent stray spaces).
 * Returns null when the selection doesn't touch any text layer.
 */
export function selectedText(sel: Selection): string | null {
  if (sel.rangeCount === 0 || sel.isCollapsed) return null;
  const parts: string[] = [];
  let touched = false;
  for (let r = 0; r < sel.rangeCount; r++) {
    const range = sel.getRangeAt(r);
    const root = range.commonAncestorContainer;
    const scope = root.nodeType === Node.ELEMENT_NODE ? (root as Element) : root.parentElement;
    if (!scope) continue;
    const layers: Element[] = scope.closest('.text-layer')
      ? [scope.closest('.text-layer')!]
      : Array.from(scope.querySelectorAll('.text-layer'));
    for (const layer of layers) {
      if (!range.intersectsNode(layer)) continue;
      let pageStarted = false;
      for (const ln of Array.from(layer.children) as HTMLElement[]) {
        if (!ln.classList.contains('ln') || !range.intersectsNode(ln)) continue;
        let text = '';
        for (const el of Array.from(ln.children)) {
          const node = el.firstChild;
          if (!node || !range.intersectsNode(node)) continue;
          const data = (node as Text).data;
          const s = node === range.startContainer ? range.startOffset : 0;
          const e = node === range.endContainer ? range.endOffset : data.length;
          text += data.slice(s, e);
        }
        if (!text.trim()) continue;
        const sep = !touched ? '' : !pageStarted ? '\n\n' : SEPARATORS[ln.dataset.join ?? 'newline'] || '\n';
        parts.push(sep + text.replace(/^ +| +$/g, ''));
        touched = true;
        pageStarted = true;
      }
    }
  }
  return touched ? parts.join('') : null;
}
