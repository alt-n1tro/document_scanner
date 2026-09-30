import { type Point, type Quad, dist, minAreaRect, orderQuad, rectCorners } from './geometry';

export interface DetParams {
  thresh: number;
  boxThresh: number;
  unclipRatio: number;
  maxCandidates?: number;
  minSize?: number;
}

export interface DetBox {
  quad: Quad;
  score: number;
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * Picks the detector input size. Documents need a generous resolution so
 * small print survives; very large photos are capped to keep WASM
 * inference time and memory bounded. Dimensions are multiples of 32.
 */
export function detInputSize(w: number, h: number, maxSide: number, minSide = 1024): [number, number] {
  const long = Math.max(w, h);
  let scale = 1;
  if (long > maxSide) scale = maxSide / long;
  else if (long < minSide) scale = Math.min(minSide / long, 3);
  const round32 = (v: number) => Math.max(32, Math.round((v * scale) / 32) * 32);
  return [round32(w), round32(h)];
}

/** RGBA pixels -> normalized NCHW float tensor in BGR channel order (as the Paddle models expect). */
export function detPreprocess(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const plane = w * h;
  const out = new Float32Array(3 * plane);
  // Channel c of the tensor holds B, G, R for c = 0, 1, 2.
  const sB = 1 / (255 * STD[0]), sG = 1 / (255 * STD[1]), sR = 1 / (255 * STD[2]);
  const mB = MEAN[0] / STD[0], mG = MEAN[1] / STD[1], mR = MEAN[2] / STD[2];
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    out[i] = rgba[p + 2] * sB - mB;
    out[plane + i] = rgba[p + 1] * sG - mG;
    out[2 * plane + i] = rgba[p] * sR - mR;
  }
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function quadArea(q: Point[]): number {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const [x1, y1] = q[i];
    const [x2, y2] = q[(i + 1) % q.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function inConvexQuad(q: Point[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (Math.abs(c) < 1e-9) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Mean probability inside the box ("fast" box score in PaddleOCR's DBPostProcess). */
function boxScore(pred: Float32Array, w: number, h: number, q: Point[]): number {
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  let sum = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (inConvexQuad(q, x, y)) {
        sum += pred[y * w + x];
        n++;
      }
    }
  }
  return n ? sum / n : 0;
}

/**
 * Differentiable-binarization post-processing: threshold the probability
 * map, take each connected text region, fit a minimum-area rectangle,
 * score it, and expand it by the unclip distance (the offset the model was
 * trained to shrink text kernels by). Returns quads in source-image pixels.
 */
export function detPostprocess(
  pred: Float32Array,
  w: number,
  h: number,
  srcW: number,
  srcH: number,
  params: DetParams,
): DetBox[] {
  const { thresh, boxThresh, unclipRatio, maxCandidates = 3000, minSize = 3 } = params;
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const boxes: DetBox[] = [];
  const sx = srcW / w, sy = srcH / h;
  let next = 0;

  for (let start = 0; start < w * h && next < maxCandidates; start++) {
    if (labels[start] !== 0 || pred[start] <= thresh) continue;
    next++;
    // 8-connected flood fill, tracking the left/right extent of each row:
    // those extremes are all the convex hull needs.
    const rowMin = new Map<number, number>();
    const rowMax = new Map<number, number>();
    let sp = 0;
    stack[sp++] = start;
    labels[start] = next;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % w, y = (idx - x) / w;
      const mn = rowMin.get(y);
      if (mn === undefined || x < mn) rowMin.set(y, x);
      const mx = rowMax.get(y);
      if (mx === undefined || x > mx) rowMax.set(y, x);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= w) continue;
          const n = ny * w + nx;
          if (labels[n] === 0 && pred[n] > thresh) {
            labels[n] = next;
            stack[sp++] = n;
          }
        }
      }
    }

    const pts: Point[] = [];
    for (const [y, x] of rowMin) {
      pts.push([x, y]);
      const xm = rowMax.get(y)!;
      if (xm !== x) pts.push([xm, y]);
    }
    const rect = minAreaRect(pts);
    if (Math.min(rect.w, rect.h) < minSize) continue;
    const corners = rectCorners(rect);
    const score = boxScore(pred, w, h, corners);
    if (score < boxThresh) continue;

    // Offsetting a rectangle by d and re-fitting the min-area rect yields
    // the rectangle grown by d on every side.
    const area = quadArea(corners);
    const perimeter = 2 * (rect.w + rect.h);
    const d = perimeter > 0 ? (area * unclipRatio) / perimeter : 0;
    const grown = { ...rect, w: rect.w + 2 * d, h: rect.h + 2 * d };
    if (Math.min(grown.w, grown.h) < minSize + 2) continue;

    // Pixel indices -> continuous source coordinates (pixel i spans [i, i+1)).
    const q = orderQuad(rectCorners(grown)).map(
      ([x, y]) => [clamp((x + 0.5) * sx, 0, srcW), clamp((y + 0.5) * sy, 0, srcH)] as Point,
    ) as Quad;
    if (dist(q[0], q[1]) < 1 || dist(q[0], q[3]) < 1) continue;
    boxes.push({ quad: q, score });
  }
  return boxes;
}
