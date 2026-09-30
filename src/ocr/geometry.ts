export type Point = [number, number];
/** Quadrilateral in clockwise order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

const cross = (o: Point, a: Point, b: Point) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Andrew's monotone chain. Returns the hull counter-clockwise (in y-down space: clockwise on screen). */
export function convexHull(points: Point[]): Point[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export interface RotatedRect {
  cx: number;
  cy: number;
  /** Extent along `ux,uy`. */
  w: number;
  /** Extent along the perpendicular (-uy, ux). */
  h: number;
  ux: number;
  uy: number;
}

/** Minimum-area enclosing rectangle via rotating calipers over the hull edges. */
export function minAreaRect(points: Point[]): RotatedRect {
  const hull = convexHull(points);
  if (hull.length === 1) return { cx: hull[0][0], cy: hull[0][1], w: 0, h: 0, ux: 1, uy: 0 };
  let best: RotatedRect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy;
      const v = -p[0] * uy + p[1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = { cx: cu * ux - cv * uy, cy: cu * uy + cv * ux, w: maxU - minU, h: maxV - minV, ux, uy };
    }
  }
  return best!;
}

export function rectCorners(r: RotatedRect): Point[] {
  const hx = (r.w / 2) * r.ux, hy = (r.w / 2) * r.uy;
  const vx = -(r.h / 2) * r.uy, vy = (r.h / 2) * r.ux;
  return [
    [r.cx - hx - vx, r.cy - hy - vy],
    [r.cx + hx - vx, r.cy + hy - vy],
    [r.cx + hx + vx, r.cy + hy + vy],
    [r.cx - hx + vx, r.cy - hy + vy],
  ];
}

/**
 * Orders four corners as TL, TR, BR, BL — the same rule PaddleOCR's
 * `get_mini_boxes` uses: the two left-most points form the left edge,
 * and within each pair the upper point comes first.
 */
export function orderQuad(pts: Point[]): Quad {
  const s = pts.slice().sort((a, b) => a[0] - b[0]);
  const [l0, l1] = s[0][1] <= s[1][1] ? [s[0], s[1]] : [s[1], s[0]];
  const [r0, r1] = s[2][1] <= s[3][1] ? [s[2], s[3]] : [s[3], s[2]];
  return [l0, r0, r1, l1];
}

export const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Homography mapping the unit square corners (0,0),(1,0),(1,1),(0,1)
 * onto the quad. Returns [a,b,c,d,e,f,g,h] with
 * x = (a u + b v + c) / (g u + h v + 1), y = (d u + e v + f) / (g u + h v + 1).
 */
export function squareToQuad(q: Quad): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    if (Math.abs(den) > 1e-12) {
      g = (dx3 * dy2 - dx2 * dy3) / den;
      h = (dx1 * dy3 - dx3 * dy1) / den;
    }
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}
