import { describe, expect, it } from 'vitest';
import { detPostprocess } from '../src/ocr/detect';
import { type Point, minAreaRect, orderQuad, rectCorners } from '../src/ocr/geometry';
import { orderLines } from '../src/ocr/layout';
import { ctcDecode, lineFrame, toWords } from '../src/ocr/recognize';
import type { OcrLine } from '../src/ocr/types';

describe('geometry', () => {
  it('fits the minimum-area rectangle of a rotated box', () => {
    const a = Math.PI / 12;
    const pts: Point[] = [];
    for (let u = 0; u <= 100; u += 5) for (let v = 0; v <= 20; v += 5) pts.push([u * Math.cos(a) - v * Math.sin(a), u * Math.sin(a) + v * Math.cos(a)]);
    const r = minAreaRect(pts);
    expect(Math.max(r.w, r.h)).toBeCloseTo(100, 5);
    expect(Math.min(r.w, r.h)).toBeCloseTo(20, 5);
  });

  it('orders corners TL, TR, BR, BL', () => {
    const q = orderQuad([[10, 10], [0, 10], [10, 0], [0, 0]]);
    expect(q).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
  });

  it('reads tall boxes top-to-bottom like PaddleOCR', () => {
    const f = lineFrame([[0, 0], [10, 0], [10, 100], [0, 100]]);
    expect(f.length).toBe(100);
    expect(f.thickness).toBe(10);
    expect(f.origin).toEqual([10, 0]);
    expect(f.u).toEqual([0, 1]);
  });
});

describe('detection post-processing', () => {
  it('turns a probability blob into an unclipped box in source pixels', () => {
    const w = 64, h = 32;
    const pred = new Float32Array(w * h);
    for (let y = 12; y < 20; y++) for (let x = 10; x < 50; x++) pred[y * w + x] = 0.9;
    const [box] = detPostprocess(pred, w, h, w * 2, h * 2, { thresh: 0.3, boxThresh: 0.6, unclipRatio: 1.5 });
    const r = minAreaRect(box.quad);
    // Kernel spans pixel centres 10..49 x 12..19; unclip grows each side.
    expect(r.w).toBeGreaterThan(2 * 40);
    expect(r.h).toBeGreaterThan(2 * 8);
    expect(r.cx).toBeCloseTo(2 * 30, 0);
    expect(r.cy).toBeCloseTo(2 * 16, 0);
    expect(rectCorners(r)).toHaveLength(4);
  });
});

describe('CTC decoding with positions', () => {
  const dict = ['a', 'b', ' '];
  // 10 timesteps over a 80 px tensor: each step is 8 px.
  const probs = (seq: number[]) => {
    const out = new Float32Array(seq.length * 4);
    seq.forEach((c, t) => (out[t * 4 + c] = 1));
    return out;
  };

  it('collapses repeats, drops blanks and records where each char fired', () => {
    const { chars } = ctcDecode(probs([0, 1, 1, 0, 2, 0, 0, 3, 0, 1]), 0, 10, 4, dict, 80, 80, 80);
    expect(chars.map((c) => c.ch).join('')).toBe('ab a');
    expect(chars[0].x).toBe(16); // run of steps 1-2 spans 8..24 px
    expect(chars[1].x).toBe(36);
  });

  it('keeps repeated letters separated by a blank', () => {
    const { chars } = ctcDecode(probs([1, 0, 1]), 0, 3, 4, dict, 24, 24, 24);
    expect(chars.map((c) => c.ch).join('')).toBe('aa');
  });
});

describe('word extents', () => {
  const c = (ch: string, x: number) => ({ ch, x, prob: 1 });

  it('splits on emitted spaces and on wide visual gaps', () => {
    const chars = [c('1', 10), c('2', 20), c('3', 30), c('+', 120), c('4', 130), c(' ', 150), c('x', 170)];
    const words = toWords(chars, 200, 30);
    expect(words.map((w) => w.text)).toEqual(['123', '+4', 'x']);
    expect(words[0].x0).toBeCloseTo(5);
    expect(words[0].x1).toBeCloseTo(35);
  });

  it('never lets neighbouring words overlap', () => {
    const words = toWords([c('a', 10), c(' ', 14), c('b', 16)], 30, 40);
    expect(words[0].x1).toBeLessThanOrEqual(words[1].x0);
  });
});

describe('reading order', () => {
  const line = (text: string, x: number, y: number, w: number, h = 20): OcrLine => ({
    text,
    score: 1,
    words: [{ text, x0: 0, x1: w }],
    join: 'none',
    frame: { origin: [x, y], u: [1, 0], v: [0, 1], length: w, thickness: h },
  });

  it('reads two columns column by column, below a full-width heading', () => {
    const lines = [
      line('Heading spanning the page', 0, 0, 600),
      line('L1', 0, 50, 280), line('R1', 320, 50, 280),
      line('L2', 0, 75, 280), line('R2', 320, 75, 280),
      line('L3', 0, 100, 280), line('R3', 320, 100, 280),
    ];
    expect(orderLines(lines).map((l) => l.text)).toEqual(['Heading spanning the page', 'L1', 'L2', 'L3', 'R1', 'R2', 'R3']);
  });

  it('reads tables row by row', () => {
    const lines = [line('Name', 0, 0, 60), line('Qty', 100, 0, 40), line('Pen', 0, 30, 40), line('3', 100, 30, 15), line('Ink', 0, 60, 40), line('12', 100, 60, 25)];
    const out = orderLines(lines);
    expect(out.map((l) => l.text)).toEqual(['Name', 'Qty', 'Pen', '3', 'Ink', '12']);
    expect(out.map((l) => l.join)).toEqual(['none', 'space', 'newline', 'space', 'newline', 'space']);
  });
});
