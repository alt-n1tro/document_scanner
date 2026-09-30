import { type Quad, dist } from './geometry';

export const REC_HEIGHT = 48;
const MIN_TENSOR_W = 320;
const MAX_TENSOR_W = 3200;

/**
 * A text line's local coordinate frame in source-image pixels. Text runs
 * along `u` (length `length`) and its glyphs extend along `v` (length
 * `thickness`), starting at `origin` (the text's top-left corner).
 */
export interface LineFrame {
  origin: [number, number];
  u: [number, number];
  v: [number, number];
  length: number;
  thickness: number;
}

/** Mirrors PaddleOCR's crop orientation: boxes much taller than wide are read top-to-bottom (rot90 CCW). */
export function lineFrame(q: Quad): LineFrame {
  const [tl, tr, br, bl] = q;
  const w = Math.max(dist(tl, tr), dist(bl, br));
  const h = Math.max(dist(tl, bl), dist(tr, br));
  const unit = (a: [number, number], b: [number, number]): [number, number] => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  if (h / w >= 1.5) {
    return { origin: tr, u: unit(tr, br), v: unit(tr, tl), length: h, thickness: w };
  }
  return { origin: tl, u: unit(tl, tr), v: unit(tl, bl), length: w, thickness: h };
}

export interface ImageSource {
  data: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
}

/** Content width (in tensor pixels) a line occupies once scaled to the recognizer height. */
export function recContentWidth(f: LineFrame): number {
  return Math.min(MAX_TENSOR_W, Math.max(1, Math.ceil((REC_HEIGHT * f.length) / Math.max(f.thickness, 1))));
}

/** Padded batch width. `step` > 1 buckets widths so GPU backends reuse compiled shaders. */
export function recTensorWidth(frames: LineFrame[], step = 1): number {
  let w = MIN_TENSOR_W;
  for (const f of frames) w = Math.max(w, recContentWidth(f));
  return Math.min(MAX_TENSOR_W, Math.ceil(w / step) * step);
}

/**
 * Samples the line straight from the page into a normalized, BGR, CHW
 * slice of the batch tensor. Bilinear taps are averaged over a small grid
 * when downscaling so thin strokes don't alias away. Padding stays 0,
 * which is what PaddleOCR pads with after normalization.
 */
export function writeRecInput(
  img: ImageSource,
  f: LineFrame,
  out: Float32Array,
  offset: number,
  tensorW: number,
): number {
  const rw = Math.min(recContentWidth(f), tensorW);
  const plane = REC_HEIGHT * tensorW;
  const stepU = f.length / rw;
  const stepV = f.thickness / REC_HEIGHT;
  const nu = Math.min(4, Math.max(1, Math.ceil(stepU)));
  const nv = Math.min(4, Math.max(1, Math.ceil(stepV)));
  const taps = nu * nv;
  const { data, width: W, height: H } = img;
  const [ox, oy] = f.origin;
  const [ux, uy] = f.u;
  const [vx, vy] = f.v;

  for (let j = 0; j < REC_HEIGHT; j++) {
    for (let i = 0; i < rw; i++) {
      let r = 0, g = 0, b = 0;
      for (let sj = 0; sj < nv; sj++) {
        const tv = (j + (sj + 0.5) / nv) * stepV;
        for (let si = 0; si < nu; si++) {
          const tu = (i + (si + 0.5) / nu) * stepU;
          // Continuous coords -> pixel-index coords for bilinear sampling.
          const x = ox + ux * tu + vx * tv - 0.5;
          const y = oy + uy * tu + vy * tv - 0.5;
          const xc = Math.min(Math.max(x, 0), W - 1);
          const yc = Math.min(Math.max(y, 0), H - 1);
          const x0 = Math.floor(xc), y0 = Math.floor(yc);
          const x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
          const fx = xc - x0, fy = yc - y0;
          const p00 = (y0 * W + x0) * 4, p10 = (y0 * W + x1) * 4;
          const p01 = (y1 * W + x0) * 4, p11 = (y1 * W + x1) * 4;
          const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
          r += data[p00] * w00 + data[p10] * w10 + data[p01] * w01 + data[p11] * w11;
          g += data[p00 + 1] * w00 + data[p10 + 1] * w10 + data[p01 + 1] * w01 + data[p11 + 1] * w11;
          b += data[p00 + 2] * w00 + data[p10 + 2] * w10 + data[p01 + 2] * w01 + data[p11 + 2] * w11;
        }
      }
      const k = 1 / (taps * 127.5);
      const idx = offset + j * tensorW + i;
      out[idx] = b * k - 1;
      out[idx + plane] = g * k - 1;
      out[idx + 2 * plane] = r * k - 1;
    }
  }
  return rw;
}

export interface DecodedChar {
  ch: string;
  /** Centre of the character along the line, in source pixels from the frame origin. */
  x: number;
  prob: number;
}

/**
 * Greedy CTC decode that also keeps *where* each character fired. CTC
 * emissions are peaky and sit on the glyph, so timestep index maps back to
 * a horizontal position — this is what lets the invisible text be laid out
 * word-by-word instead of being stretched across the whole line.
 */
export function ctcDecode(
  probs: Float32Array,
  offset: number,
  steps: number,
  classes: number,
  dict: string[],
  tensorW: number,
  contentW: number,
  lineLength: number,
): { chars: DecodedChar[]; score: number } {
  const chars: DecodedChar[] = [];
  const pxPerStep = tensorW / steps;
  const toSource = lineLength / contentW;
  let prev = 0;
  let runStart = 0;
  let current: { idx: number; start: number; end: number; prob: number } | null = null;
  const flush = () => {
    if (!current) return;
    const center = ((current.start + current.end + 1) / 2) * pxPerStep;
    chars.push({ ch: dict[current.idx - 1] ?? '', x: Math.min(center, contentW) * toSource, prob: current.prob });
    current = null;
  };
  for (let t = 0; t < steps; t++) {
    const base = offset + t * classes;
    let best = 0, bestP = probs[base];
    for (let c = 1; c < classes; c++) {
      const p = probs[base + c];
      if (p > bestP) {
        bestP = p;
        best = c;
      }
    }
    if (best !== prev) {
      flush();
      runStart = t;
      if (best !== 0) current = { idx: best, start: runStart, end: t, prob: bestP };
    } else if (current) {
      current.end = t;
      current.prob = Math.max(current.prob, bestP);
    }
    prev = best;
  }
  flush();
  const valid = chars.filter((c) => c.ch !== '');
  const score = valid.length ? valid.reduce((s, c) => s + c.prob, 0) / valid.length : 0;
  return { chars: valid, score };
}

export interface Word {
  text: string;
  /** Start/end along the line in source pixels, relative to the frame origin. */
  x0: number;
  x1: number;
}

/**
 * Splits decoded characters into words and estimates each word's extent.
 * Each character's centre is known; its half-width is estimated from the
 * spacing of neighbouring characters. Adjacent words never overlap.
 */
export function toWords(chars: DecodedChar[], lineLength: number, thickness: number): Word[] {
  // The recognizer sometimes runs visually separate fields together
  // ("12,904+18.2%"). A gap far wider than the line's normal character
  // pitch is a word break, whether or not a space was emitted.
  const steps: number[] = [];
  for (let i = 1; i < chars.length; i++) {
    if (!/\s/.test(chars[i].ch) && !/\s/.test(chars[i - 1].ch)) steps.push(chars[i].x - chars[i - 1].x);
  }
  steps.sort((a, b) => a - b);
  const typical = steps.length ? steps[steps.length >> 1] : thickness * 0.5;
  const breakGap = Math.max(typical * 3, thickness * 0.9);

  const groups: DecodedChar[][] = [];
  let cur: DecodedChar[] = [];
  for (const c of chars) {
    if (/\s/.test(c.ch)) {
      if (cur.length) groups.push(cur);
      cur = [];
      continue;
    }
    if (cur.length && c.x - cur[cur.length - 1].x > breakGap) {
      groups.push(cur);
      cur = [];
    }
    cur.push(c);
  }
  if (cur.length) groups.push(cur);
  if (!groups.length) return [];

  // Typical character pitch across the line, used for one-letter words.
  const nonSpace = chars.filter((c) => !/\s/.test(c.ch));
  let linePitch = thickness * 0.5;
  if (nonSpace.length >= 2) {
    const span = nonSpace[nonSpace.length - 1].x - nonSpace[0].x;
    linePitch = Math.max(span / (nonSpace.length - 1), 1);
  }

  const words: Word[] = groups.map((g) => {
    const pitch = g.length >= 2 ? (g[g.length - 1].x - g[0].x) / (g.length - 1) : linePitch;
    const half = Math.max(pitch, thickness * 0.2) / 2;
    return { text: g.map((c) => c.ch).join(''), x0: g[0].x - half, x1: g[g.length - 1].x + half };
  });

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    w.x0 = Math.max(0, w.x0);
    w.x1 = Math.min(lineLength, w.x1);
    if (i > 0 && words[i - 1].x1 > w.x0) {
      const mid = (words[i - 1].x1 + w.x0) / 2;
      words[i - 1].x1 = mid;
      w.x0 = mid;
    }
    if (w.x1 <= w.x0) w.x1 = w.x0 + 1;
  }
  return words;
}
