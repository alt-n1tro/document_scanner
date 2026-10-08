import type { Backend, ModelTier, OcrPage, WorkerRequest, WorkerResponse } from './types';

export type EngineState =
  | { kind: 'loading'; loaded: number; total: number; cached: boolean }
  | { kind: 'ready'; threads: number; backend: string }
  | { kind: 'error'; message: string };

interface Pending {
  resolve: (p: OcrPage) => void;
  reject: (e: Error) => void;
  onProgress?: (fraction: number) => void;
}

/** Runs PP-OCRv6 in a dedicated worker so the page stays smooth while scanning. */
export class OcrClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private readyPromise: Promise<void>;
  state: EngineState = { kind: 'loading', loaded: 0, total: 0, cached: false };

  constructor(
    readonly tier: ModelTier,
    private onState: (s: EngineState) => void,
    backend: Backend = 'auto',
  ) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.readyPromise = new Promise((resolve, reject) => {
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        switch (msg.type) {
          case 'model-progress':
            this.set({ kind: 'loading', loaded: msg.loaded, total: msg.total, cached: msg.cached });
            break;
          case 'ready':
            this.set({ kind: 'ready', threads: msg.threads, backend: msg.backend });
            resolve();
            break;
          case 'init-error':
            this.set({ kind: 'error', message: msg.message });
            reject(new Error(msg.message));
            break;
          case 'page-progress': {
            // Detection is quick; recognition dominates, so weight it 80%.
            const f = msg.stage === 'detect' ? 0.2 * (msg.done / msg.total) : 0.2 + 0.8 * (msg.total ? msg.done / msg.total : 1);
            this.pending.get(msg.id)?.onProgress?.(f);
            break;
          }
          case 'result':
            this.pending.get(msg.id)?.resolve(msg.page);
            this.pending.delete(msg.id);
            break;
          case 'error':
            this.pending.get(msg.id)?.reject(new Error(msg.message));
            this.pending.delete(msg.id);
            break;
        }
      };
      this.worker.onerror = (e) => {
        const message = e.message || 'The OCR engine failed to start.';
        this.set({ kind: 'error', message });
        reject(new Error(message));
        for (const p of this.pending.values()) p.reject(new Error(message));
        this.pending.clear();
      };
    });
    this.readyPromise.catch(() => {});
    this.post({ type: 'init', tier, baseUrl: new URL('./', document.baseURI).href, backend });
  }

  private set(s: EngineState) {
    this.state = s;
    this.onState(s);
  }

  private post(msg: WorkerRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer);
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Takes ownership of the bitmap (it is transferred to the worker). */
  async recognize(bitmap: ImageBitmap, onProgress?: (fraction: number) => void): Promise<OcrPage> {
    await this.readyPromise;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.post({ type: 'ocr', id, bitmap }, [bitmap]);
    });
  }

  /** Abandons in-flight pages (their late results are ignored) but keeps the engine loaded. */
  cancelPending() {
    for (const p of this.pending.values()) p.reject(new Error('cancelled'));
    this.pending.clear();
  }

  dispose() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('cancelled'));
    this.pending.clear();
  }
}
