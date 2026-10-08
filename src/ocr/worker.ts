/// <reference lib="webworker" />
import type * as Ort from 'onnxruntime-web';
import { type Engine, runOcr } from './pipeline';
import type { Backend, ModelTier, WorkerRequest, WorkerResponse } from './types';

declare const self: DedicatedWorkerGlobalScope;

const post = (msg: WorkerResponse) => self.postMessage(msg);

// Very large photos are downsampled before OCR; coordinates are reported in
// the downsampled space and scaled back by the page view.
const MAX_OCR_SIDE = 5000;
const DET_MAX_SIDE = 2048;

interface ManifestEntry {
  det: { file: string; bytes: number; sha256: string; thresh: number; boxThresh: number; unclipRatio: number };
  rec: { file: string; bytes: number; sha256: string };
  dict: { file: string };
}

let engine: Engine | null = null;
let gpuMode = false;
let queue: Promise<unknown> = Promise.resolve();

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Fetches a model with byte-level progress, caching verified copies in Cache Storage. */
async function fetchModel(url: string, sha: string, onBytes: (n: number) => void): Promise<ArrayBuffer> {
  const key = `${url}?sha256=${sha}`;
  const cache = 'caches' in self ? await caches.open('legible-models-v1').catch(() => null) : null;
  const hit = await cache?.match(key);
  if (hit) {
    const buf = await hit.arrayBuffer();
    if ((await sha256Hex(buf)) === sha) {
      onBytes(buf.byteLength);
      return buf;
    }
    await cache?.delete(key);
  }
  const res = await fetch(key);
  if (!res.ok || !res.body) throw new Error(`Could not download ${url} (${res.status})`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    onBytes(value.byteLength);
  }
  const bytes = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.byteLength;
  }
  if ((await sha256Hex(bytes.buffer)) !== sha) throw new Error('Model download was corrupted. Please reload.');
  await cache?.put(key, new Response(bytes.slice().buffer)).catch(() => {});
  return bytes.buffer;
}

type OrtModule = typeof Ort;

/**
 * WebGPU when the device has a usable adapter (typically 5-10x faster),
 * otherwise multi-threaded WASM. Each runtime is its own lazily loaded
 * chunk, so devices only download the one they use.
 */
async function loadRuntime(pref: Backend): Promise<{ ort: OrtModule; gpu: boolean }> {
  type Adapter = { isFallbackAdapter?: boolean; info?: { isFallbackAdapter?: boolean } };
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: object): Promise<Adapter | null> } }).gpu;
  if (pref !== 'wasm' && gpu) {
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      const software = adapter?.isFallbackAdapter || adapter?.info?.isFallbackAdapter;
      if (adapter && (!software || pref === 'webgpu')) return { ort: await import('onnxruntime-web/webgpu'), gpu: true };
    } catch {
      /* fall through to WASM */
    }
  }
  return { ort: await import('onnxruntime-web/wasm'), gpu: false };
}

async function init(tier: ModelTier, baseUrl: string, pref: Backend) {
  const { ort, gpu } = await loadRuntime(pref);
  const threads = self.crossOriginIsolated ? Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8)) : 1;
  ort.env.wasm.numThreads = threads;

  const root = new URL(`models/`, baseUrl);
  const manifest: Record<ModelTier, ManifestEntry> = await (await fetch(new URL('manifest.json', root))).json();
  const m = manifest[tier];
  const total = m.det.bytes + m.rec.bytes;
  let loaded = 0;
  let last = 0;
  const onBytes = (n: number) => {
    loaded += n;
    const now = performance.now();
    if (now - last > 80 || loaded >= total) {
      last = now;
      post({ type: 'model-progress', loaded, total });
    }
  };
  const [detBuf, recBuf, dict] = await Promise.all([
    fetchModel(new URL(`${tier}/${m.det.file}`, root).href, m.det.sha256, onBytes),
    fetchModel(new URL(`${tier}/${m.rec.file}`, root).href, m.rec.sha256, onBytes),
    fetch(new URL(`${tier}/${m.dict.file}`, root)).then((r) => r.json() as Promise<string[]>),
  ]);
  const create = async (buf: ArrayBuffer, useGpu: boolean) =>
    ort.InferenceSession.create(new Uint8Array(buf), {
      executionProviders: [useGpu ? 'webgpu' : 'wasm'],
      graphOptimizationLevel: 'all',
    });
  let backend = gpu ? 'webgpu' : 'wasm';
  let det: Ort.InferenceSession, rec: Ort.InferenceSession;
  try {
    det = await create(detBuf, gpu);
    rec = await create(recBuf, gpu);
  } catch (e) {
    if (!gpu) throw e;
    backend = 'wasm';
    det = await create(detBuf, false);
    rec = await create(recBuf, false);
  }
  const run = async (s: Ort.InferenceSession, data: Float32Array, dims: number[]) => {
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, dims) });
    const t = out[s.outputNames[0]];
    return { data: t.data as Float32Array, dims: t.dims };
  };
  const detParams = { thresh: m.det.thresh, boxThresh: m.det.boxThresh, unclipRatio: m.det.unclipRatio };
  const makeEngine = (d: Ort.InferenceSession, r: Ort.InferenceSession): Engine => ({
    det: (x, dims) => run(d, x, dims),
    rec: (x, dims) => run(r, x, dims),
    dict,
    detParams,
  });
  engine = makeEngine(det, rec);
  gpuMode = backend === 'webgpu';
  if (gpuMode && !(await gpuSelfTest(engine))) {
    // A software adapter or a misbehaving driver: use the CPU instead.
    await Promise.all([det.release(), rec.release()]).catch(() => {});
    backend = 'wasm';
    gpuMode = false;
    engine = makeEngine(await create(detBuf, false), await create(recBuf, false));
  }
  post({ type: 'ready', backend, threads });
}

/**
 * Before trusting the GPU, read a known phrase: it must come back exactly
 * right, and (after shader compilation) quickly. Software adapters such as
 * SwiftShader pass correctness but are far slower than WASM.
 */
async function gpuSelfTest(e: Engine): Promise<boolean> {
  const phrase = 'Legible 2048 quick brown fox';
  const c = new OffscreenCanvas(640, 96);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#111';
  ctx.font = '36px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(phrase, 24, 48);
  const img = { data: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
  const resize = (w: number, h: number) => {
    const r = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
    r.drawImage(c, 0, 0, w, h);
    return r.getImageData(0, 0, w, h).data;
  };
  const opts = { detMaxSide: 1024, minScore: 0, recWidthBudget: 4800, recWidthStep: 64, resize };
  try {
    // First run includes shader compilation; give up early on hopeless adapters.
    const warm = await Promise.race([
      runOcr(e, img, opts).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 8000)),
    ]);
    if (!warm) {
      console.info('[legible] WebGPU self-test: too slow, using WASM');
      return false;
    }
    const t0 = performance.now();
    const page = await runOcr(e, img, opts);
    const ms = performance.now() - t0;
    const text = page.lines.map((l) => l.text).join(' ').replace(/\s+/g, '');
    const ok = text === phrase.replace(/\s+/g, '') && ms < 400;
    console.info(`[legible] WebGPU self-test: ${ok ? 'passed' : 'failed'} (${ms.toFixed(0)} ms, read "${text}")`);
    return ok;
  } catch {
    return false;
  }
}

function pixels(bitmap: ImageBitmap, w: number, h: number): Uint8ClampedArray {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Transparent regions (PNG screenshots, scans with alpha) read as white paper.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

async function ocr(id: number, bitmap: ImageBitmap) {
  const t0 = performance.now();
  try {
    if (!engine) throw new Error('OCR engine is not ready');
    const scale = Math.min(1, MAX_OCR_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const img = { data: pixels(bitmap, width, height), width, height };
    const page = await runOcr(engine, img, {
      detMaxSide: DET_MAX_SIDE,
      minScore: 0.5,
      recWidthBudget: 4800,
      recWidthStep: gpuMode ? 64 : 1,
      resize: (w, h) => pixels(bitmap, w, h),
      onProgress: (stage, done, total) => post({ type: 'page-progress', id, stage, done, total }),
    });
    post({ type: 'result', id, page, ms: performance.now() - t0 });
  } catch (e) {
    post({ type: 'error', id, message: e instanceof Error ? e.message : String(e) });
  } finally {
    bitmap.close();
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    init(msg.tier, msg.baseUrl, msg.backend).catch((err) =>
      post({ type: 'init-error', message: err instanceof Error ? err.message : String(err) }),
    );
  } else if (msg.type === 'ocr') {
    // One page at a time: ORT already uses every core for a single page.
    queue = queue.then(() => ocr(msg.id, msg.bitmap));
  }
};
