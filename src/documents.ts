import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Longest side, in pixels, pages are rasterized/scanned at. */
const MAX_SIDE = 4096;
/** PDF pages are rendered at ~220 dpi or at least this long side, whichever is larger. */
const PDF_MIN_LONG_SIDE = 2200;
const PDF_DPI = 220;

export interface PageSize {
  width: number;
  height: number;
}

export interface SourceDoc {
  kind: 'pdf' | 'image';
  pages: PageSize[];
  /** A displayable image for the page (blob URL). Cached; cheap after the first call. */
  pageUrl(index: number): Promise<string>;
  /** A fresh bitmap for OCR; the caller owns (and must close/transfer) it. */
  pageBitmap(index: number): Promise<ImageBitmap>;
  destroy(): void;
}

export class PasswordRequired extends Error {
  constructor(readonly incorrect: boolean) {
    super(incorrect ? 'Incorrect password' : 'Password required');
  }
}

export class UnsupportedFile extends Error {}

export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export function isSupported(file: File): boolean {
  return isPdf(file) || file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?)$/i.test(file.name);
}

async function loadImage(file: File): Promise<SourceDoc> {
  let probe: ImageBitmap;
  try {
    probe = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const heic = /hei[cf]$/i.test(file.name) || /hei[cf]/.test(file.type);
    throw new UnsupportedFile(
      heic ? 'HEIC photos aren’t supported by this browser. Export as JPEG and try again.' : 'This image format can’t be opened.',
    );
  }
  const { width, height } = probe;
  probe.close();
  const url = URL.createObjectURL(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  return {
    kind: 'image',
    pages: [{ width: Math.round(width * scale), height: Math.round(height * scale) }],
    pageUrl: async () => url,
    pageBitmap: () =>
      createImageBitmap(file, {
        imageOrientation: 'from-image',
        ...(scale < 1 ? { resizeWidth: Math.round(width * scale), resizeHeight: Math.round(height * scale), resizeQuality: 'high' as const } : {}),
      }),
    destroy: () => URL.revokeObjectURL(url),
  };
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b && b.type === 'image/webp' ? resolve(b) : canvas.toBlob((p) => (p ? resolve(p) : reject(new Error('Could not encode page'))), 'image/png')), 'image/webp', 0.94),
  );
}

async function loadPdf(file: File, password?: string): Promise<SourceDoc> {
  const base = new URL('./pdfjs/', document.baseURI).href;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    password,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    enableXfa: false,
  });
  let pdf: pdfjs.PDFDocumentProxy;
  try {
    pdf = await task.promise;
  } catch (e) {
    if (e instanceof Error && e.name === 'PasswordException') {
      throw new PasswordRequired((e as Error & { code?: number }).code === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    }
    throw new UnsupportedFile('This PDF appears to be damaged and can’t be opened.');
  }

  const scales: number[] = [];
  const pages: PageSize[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
    const long = Math.max(vp.width, vp.height);
    const scale = Math.min(MAX_SIDE / long, Math.max(PDF_MIN_LONG_SIDE / long, PDF_DPI / 72));
    scales.push(scale);
    pages.push({ width: Math.round(vp.width * scale), height: Math.round(vp.height * scale) });
  }

  // Rendering is serialized: pdf.js rasterizes on the main thread.
  let chain: Promise<unknown> = Promise.resolve();
  const blobs = new Map<number, Promise<Blob>>();
  const urls = new Map<number, string>();
  let destroyed = false;

  const render = (index: number): Promise<Blob> => {
    let p = blobs.get(index);
    if (!p) {
      p = chain.then(async () => {
        if (destroyed) throw new Error('cancelled');
        const page = await pdf.getPage(index + 1);
        const { width, height } = pages[index];
        const viewport = page.getViewport({ scale: scales[index] });
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { alpha: false })!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        await page.render({ canvas, canvasContext: ctx, viewport, background: '#ffffff' }).promise;
        page.cleanup();
        const blob = await canvasToBlob(canvas);
        canvas.width = canvas.height = 0;
        return blob;
      });
      chain = p.catch(() => {});
      blobs.set(index, p);
      p.catch(() => blobs.delete(index));
    }
    return p;
  };

  return {
    kind: 'pdf',
    pages,
    async pageUrl(index) {
      let url = urls.get(index);
      if (!url) {
        url = URL.createObjectURL(await render(index));
        urls.set(index, url);
      }
      return url;
    },
    async pageBitmap(index) {
      return createImageBitmap(await render(index));
    },
    destroy() {
      destroyed = true;
      for (const u of urls.values()) URL.revokeObjectURL(u);
      urls.clear();
      blobs.clear();
      void task.destroy();
    },
  };
}

export function openDocument(file: File, password?: string): Promise<SourceDoc> {
  return isPdf(file) ? loadPdf(file, password) : loadImage(file);
}
