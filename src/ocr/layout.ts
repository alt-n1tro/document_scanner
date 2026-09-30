import type { OcrLine } from './types';

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface Item extends Box {
  line: OcrLine;
  h: number;
}

interface Block extends Box {
  items: Item[];
}

/**
 * Line boxes in a deskewed frame: everything is rotated so the page's
 * dominant text direction is horizontal. Axis-aligned reasoning (rows,
 * columns, gaps) is then valid for tilted scans and phone photos too.
 */
function toItems(lines: OcrLine[]): Item[] {
  const angles = lines
    .filter((l) => l.frame.length > l.frame.thickness * 2)
    .map((l) => Math.atan2(l.frame.u[1], l.frame.u[0]))
    .sort((a, b) => a - b);
  const angle = angles.length ? angles[angles.length >> 1] : 0;
  const cos = Math.cos(-angle), sin = Math.sin(-angle);
  return lines.map((line) => {
    const { origin, u, v, length, thickness } = line.frame;
    const xs: number[] = [], ys: number[] = [];
    for (const [a, b] of [[0, 0], [length, 0], [length, thickness], [0, thickness]]) {
      const x = origin[0] + u[0] * a + v[0] * b;
      const y = origin[1] + u[1] * a + v[1] * b;
      xs.push(x * cos - y * sin);
      ys.push(x * sin + y * cos);
    }
    return { line, h: thickness, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  });
}

const overlapX = (a: Box, b: Box) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);

/**
 * Groups lines into text blocks (paragraphs / column segments) by linking
 * each wide line to the line directly beneath it. Short fragments such as
 * table cells are deliberately left unlinked so tables read row by row.
 */
function buildBlocks(items: Item[]): Block[] {
  // Table rows: items sharing a row with a nearby short fragment (a row
  // label, a cell). They are never chained vertically, so tables read
  // across each row instead of down each column.
  const short = (i: Item) => i.x1 - i.x0 < i.h * 6;
  const tabular = new Set<Item>();
  for (const a of items) {
    for (const c of items) {
      if (c === a || !(short(a) || short(c))) continue;
      if (Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0) < Math.min(a.h, c.h) * 0.5) continue;
      const gap = c.x0 >= a.x1 ? c.x0 - a.x1 : a.x0 >= c.x1 ? a.x0 - c.x1 : -1;
      if (gap >= 0 && gap < Math.max(a.h, c.h) * 3) {
        tabular.add(a);
        tabular.add(c);
      }
    }
  }

  const next = new Map<Item, Item>();
  const hasPrev = new Set<Item>();
  const byTop = items.slice().sort((a, b) => a.y0 - b.y0);
  for (const a of byTop) {
    if (short(a) || tabular.has(a)) continue;
    let best: Item | null = null;
    for (const b of byTop) {
      if (b === a || hasPrev.has(b) || tabular.has(b)) continue;
      const gap = b.y0 - a.y1;
      const centerGap = (b.y0 + b.y1) / 2 - (a.y0 + a.y1) / 2;
      if (centerGap < a.h * 0.6 || gap > Math.max(a.h, b.h) * 0.8) continue;
      if (Math.abs(b.h - a.h) > Math.max(a.h, b.h) * 0.35) continue;
      // Same column: substantial overlap and a shared left edge or containment.
      const ov = overlapX(a, b);
      if (ov < Math.min(a.x1 - a.x0, b.x1 - b.x0) * 0.5) continue;
      if (Math.abs(b.x0 - a.x0) > a.h * 2 && b.x0 < a.x0) continue;
      if (!best || b.y0 < best.y0) best = b;
    }
    if (best) {
      next.set(a, best);
      hasPrev.add(best);
    }
  }
  const blocks: Block[] = [];
  for (const start of byTop) {
    if (hasPrev.has(start)) continue;
    const chain: Item[] = [];
    for (let it: Item | undefined = start; it; it = next.get(it)) chain.push(it);
    blocks.push({
      items: chain,
      x0: Math.min(...chain.map((i) => i.x0)),
      x1: Math.max(...chain.map((i) => i.x1)),
      y0: Math.min(...chain.map((i) => i.y0)),
      y1: Math.max(...chain.map((i) => i.y1)),
    });
  }
  return blocks;
}

/** Splits boxes into groups separated by gaps of at least `minGap` along one axis. */
function split<T extends Box>(boxes: T[], lo: (b: T) => number, hi: (b: T) => number, minGap: number): T[][] {
  const sorted = boxes.slice().sort((a, b) => lo(a) - lo(b));
  const groups: T[][] = [];
  let group: T[] = [];
  let end = -Infinity;
  for (const b of sorted) {
    if (group.length && lo(b) - end >= minGap) {
      groups.push(group);
      group = [];
    }
    group.push(b);
    end = Math.max(end, hi(b));
  }
  if (group.length) groups.push(group);
  return groups;
}

/**
 * Recursive XY-cut over blocks: bands at vertical gaps, columns at
 * horizontal gaps. Vertical extents are trimmed slightly so boxes whose
 * padding touches don't fuse into one band.
 */
function xyCut(blocks: Block[], colGap: number, trim: number, out: Block[][]): void {
  if (blocks.length === 0) return;
  const bands = split(blocks, (b) => b.y0 + trim, (b) => b.y1 - trim, 0.0001);
  if (bands.length > 1) {
    for (const b of bands) xyCut(b, colGap, trim, out);
    return;
  }
  const cols = split(blocks, (b) => b.x0, (b) => b.x1, colGap);
  if (cols.length > 1) {
    for (const c of cols) xyCut(c, colGap, trim, out);
    return;
  }
  // One band, no clear column gap: a single row of tightly spaced cells.
  out.push(blocks.slice().sort((a, b) => a.x0 - b.x0));
}

/**
 * Orders lines for reading and annotates how each joins its predecessor
 * when copied: same row -> space, next line -> newline, new block with a
 * visible gap or a column jump -> blank line.
 */
export function orderLines(lines: OcrLine[]): OcrLine[] {
  if (lines.length === 0) return [];
  const items = toItems(lines);
  const hs = items.map((i) => i.h).sort((a, b) => a - b);
  const median = hs[hs.length >> 1];
  const groups: Block[][] = [];
  xyCut(buildBlocks(items), median * 0.9, median * 0.2, groups);

  const out: OcrLine[] = [];
  let prev: Item | null = null;
  for (const group of groups) {
    group.forEach((block) => {
      block.items.forEach((it, ii) => {
        if (!prev) it.line.join = 'none';
        else if (ii > 0) it.line.join = 'newline';
        else if (
          it.y0 < prev.y1 - prev.h * 0.3 &&
          it.y1 > prev.y0 + prev.h * 0.3 &&
          it.x0 >= prev.x1 - prev.h * 0.5
        ) {
          // Next cell on the same visual row (tables, label/value pairs).
          it.line.join = 'space';
        } else {
          const gap = it.y0 - prev.y1;
          it.line.join = it.y0 < prev.y0 - prev.h * 0.5 || gap > Math.max(prev.h, it.h) * 0.95 ? 'paragraph' : 'newline';
        }
        out.push(it.line);
        prev = it;
      });
    });
  }
  return out;
}
