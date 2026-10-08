import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-web/wasm';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { type Engine, runOcr } from '../src/ocr/pipeline';
import type { OcrPage } from '../src/ocr/types';

const root = join(import.meta.dirname, '..');
const fixtures = join(import.meta.dirname, 'fixtures');

interface GtWord { text: string; x0: number; y0: number; x1: number; y1: number }

/** Box-filter resize, good enough to stand in for the browser's canvas scaling. */
function resize(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = y * fy, sy1 = Math.min(sh, (y + 1) * fy);
    for (let x = 0; x < dw; x++) {
      const sx0 = x * fx, sx1 = Math.min(sw, (x + 1) * fx);
      const acc = [0, 0, 0, 0];
      let wsum = 0;
      for (let yy = Math.floor(sy0); yy < Math.ceil(sy1); yy++) {
        const wy = Math.min(yy + 1, sy1) - Math.max(yy, sy0);
        for (let xx = Math.floor(sx0); xx < Math.ceil(sx1); xx++) {
          const w = wy * (Math.min(xx + 1, sx1) - Math.max(xx, sx0));
          const p = (yy * sw + xx) * 4;
          for (let c = 0; c < 4; c++) acc[c] += src[p + c] * w;
          wsum += w;
        }
      }
      for (let c = 0; c < 4; c++) out[(y * dw + x) * 4 + c] = acc[c] / wsum;
    }
  }
  return out;
}

async function loadEngine(tier: string): Promise<Engine> {
  ort.env.wasm.numThreads = 1;
  const dir = join(root, 'public/models', tier);
  const manifest = JSON.parse(readFileSync(join(root, 'public/models/manifest.json'), 'utf8'))[tier];
  const det = await ort.InferenceSession.create(readFileSync(join(dir, 'det.onnx')));
  const rec = await ort.InferenceSession.create(readFileSync(join(dir, 'rec.onnx')));
  const run = async (s: ort.InferenceSession, data: Float32Array, dims: number[]) => {
    const t = (await s.run({ x: new ort.Tensor('float32', data, dims) }))[s.outputNames[0]];
    return { data: t.data as Float32Array, dims: t.dims };
  };
  return {
    det: (d, dims) => run(det, d, dims),
    rec: (d, dims) => run(rec, d, dims),
    dict: JSON.parse(readFileSync(join(dir, 'dict.json'), 'utf8')),
    detParams: { thresh: manifest.det.thresh, boxThresh: manifest.det.boxThresh, unclipRatio: manifest.det.unclipRatio },
  };
}

async function ocrFixture(engine: Engine, name: string): Promise<{ page: OcrPage; gt: GtWord[] }> {
  const png = PNG.sync.read(readFileSync(join(fixtures, `${name}.png`)));
  const data = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength);
  const img = { data, width: png.width, height: png.height };
  const page = await runOcr(engine, img, {
    detMaxSide: 2048,
    minScore: 0.5,
    recWidthBudget: 4800,
    resize: (w, h) => resize(data, png.width, png.height, w, h),
  });
  return { page, gt: JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8')).words };
}

/** Page-space quad of an OCR word: its span along the line, full line thickness. */
function wordCorners(line: OcrPage['lines'][number], x0: number, x1: number) {
  const { origin: [ox, oy], u: [ux, uy], v: [vx, vy], thickness: t } = line.frame;
  return [[x0, 0], [x1, 0], [x1, t], [x0, t]].map(([a, b]) => [ox + ux * a + vx * b, oy + uy * a + vy * b]);
}

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function evaluate(page: OcrPage, gt: GtWord[]) {
  const ocrWords = page.lines.flatMap((l) =>
    l.words.map((w) => {
      const c = wordCorners(l, w.x0, w.x1);
      const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
      return { text: w.text, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    }),
  );
  // Match each ground-truth word to the OCR word with the same text whose centre is closest.
  const used = new Set<number>();
  const errs: number[] = [];
  let matched = 0;
  for (const g of gt) {
    let best = -1, bestD = Infinity;
    ocrWords.forEach((o, i) => {
      if (used.has(i) || o.text !== g.text) return;
      const d = Math.hypot((o.x0 + o.x1) / 2 - (g.x0 + g.x1) / 2, (o.y0 + o.y1) / 2 - (g.y0 + g.y1) / 2);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0 && bestD < 40) {
      used.add(best);
      matched++;
      const o = ocrWords[best];
      errs.push(Math.abs(o.x0 - g.x0), Math.abs(o.x1 - g.x1));
    }
  }
  errs.sort((a, b) => a - b);
  const gtText = gt.map((w) => w.text).join(' ');
  const ocrText = ocrWords.map((w) => w.text).join(' ');
  return {
    wordRecall: matched / gt.length,
    cer: levenshtein(gtText, ocrText) / gtText.length,
    edgeMedian: errs[errs.length >> 1],
    edgeP95: errs[Math.floor(errs.length * 0.95)],
  };
}

describe.each(['small', 'tiny'])('PP-OCRv6 %s', (tier) => {
  let engine: Engine;

  it('loads', async () => {
    engine = await loadEngine(tier);
  }, 60_000);

  it.each(['report', 'report-rotated'])('reads %s with word-accurate geometry', async (name) => {
    const t0 = Date.now();
    const { page, gt } = await ocrFixture(engine, name);
    const m = evaluate(page, gt);
    console.log(tier, name, `${Date.now() - t0}ms`, JSON.stringify(m));
    expect(m.cer).toBeLessThan(tier === 'small' ? 0.01 : 0.02);
    expect(m.wordRecall).toBeGreaterThan(tier === 'small' ? 0.98 : 0.95);
    // Word edges (in 2x-rendered pixels) must land on the real glyphs.
    expect(m.edgeMedian).toBeLessThan(3.5);
    expect(m.edgeP95).toBeLessThan(9);
  }, 180_000);
});
