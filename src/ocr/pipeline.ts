import { type DetParams, detInputSize, detPostprocess, detPreprocess } from './detect';
import { orderLines } from './layout';
import {
  type ImageSource,
  type LineFrame,
  REC_HEIGHT,
  ctcDecode,
  lineFrame,
  recContentWidth,
  recTensorWidth,
  toWords,
  writeRecInput,
} from './recognize';
import type { OcrLine, OcrPage } from './types';

export interface Tensor {
  data: Float32Array;
  dims: readonly number[];
}

export interface Engine {
  det(input: Float32Array, dims: number[]): Promise<Tensor>;
  rec(input: Float32Array, dims: number[]): Promise<Tensor>;
  dict: string[];
  detParams: DetParams;
}

export interface PipelineOptions {
  /** Longest side fed to the detector. */
  detMaxSide: number;
  /** Lines scoring below this are dropped (PaddleOCR's classic drop_score). */
  minScore: number;
  /** Upper bound on batch tensor width, which bounds recognizer output memory. */
  recWidthBudget: number;
  /** Bucket size for recognizer tensor widths (1 = exact). */
  recWidthStep?: number;
  onProgress?: (stage: 'detect' | 'recognize', done: number, total: number) => void;
  /** Resizes the page to the detector's input size and returns RGBA pixels. */
  resize: (w: number, h: number) => Uint8ClampedArray;
}

export async function runOcr(engine: Engine, img: ImageSource, opts: PipelineOptions): Promise<OcrPage> {
  const [dw, dh] = detInputSize(img.width, img.height, opts.detMaxSide);
  opts.onProgress?.('detect', 0, 1);
  const detIn = detPreprocess(opts.resize(dw, dh), dw, dh);
  const detOut = await engine.det(detIn, [1, 3, dh, dw]);
  const [oh, ow] = detOut.dims.slice(-2);
  const boxes = detPostprocess(detOut.data, ow, oh, img.width, img.height, engine.detParams);
  opts.onProgress?.('detect', 1, 1);

  const frames = boxes.map((b) => lineFrame(b.quad));
  const order = frames.map((_, i) => i).sort((a, b) => recContentWidth(frames[a]) - recContentWidth(frames[b]));

  const lines: (OcrLine | null)[] = new Array(frames.length).fill(null);
  let done = 0;
  opts.onProgress?.('recognize', 0, frames.length);
  for (let start = 0; start < order.length; ) {
    // Grow the batch while the padded tensor stays inside the width budget
    // (lines are sorted by width, so the last one sets the tensor width).
    let end = start + 1;
    while (end < order.length && end - start < 16) {
      const w = recTensorWidth([frames[order[end]]], opts.recWidthStep);
      if (w * (end - start + 1) > opts.recWidthBudget) break;
      end++;
    }
    const idx = order.slice(start, end);
    const batch: LineFrame[] = idx.map((i) => frames[i]);
    const tensorW = recTensorWidth(batch, opts.recWidthStep);
    const sample = 3 * REC_HEIGHT * tensorW;
    const input = new Float32Array(sample * batch.length);
    const contentW = batch.map((f, k) => writeRecInput(img, f, input, k * sample, tensorW));
    const out = await engine.rec(input, [batch.length, 3, REC_HEIGHT, tensorW]);
    const [, steps, classes] = out.dims;
    batch.forEach((f, k) => {
      const { chars, score } = ctcDecode(
        out.data, k * steps * classes, steps, classes, engine.dict, tensorW, contentW[k], f.length,
      );
      const words = toWords(chars, f.length, f.thickness);
      const text = words.map((w) => w.text).join(' ');
      if (text && score >= opts.minScore) {
        lines[idx[k]] = { text, score, frame: f, words, join: 'none' };
      }
    });
    done += batch.length;
    opts.onProgress?.('recognize', done, frames.length);
    start = end;
  }

  return { width: img.width, height: img.height, lines: orderLines(lines.filter((l): l is OcrLine => !!l)) };
}
