import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Longest side, in pixels, a page is ever rasterized/scanned at. */
export const MAX_SIDE = 5000;
/** Tiny pages (labels, receipts) are rendered at least this large, whatever the dpi. */
const PDF_MIN_LONG_SIDE = 1400;

/** Selectable PDF render resolutions (a PDF page is 72 points per inch). */
export const DPI_OPTIONS = [150, 220, 300, 400] as const;
export const DEFAULT_DPI = 220;

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
  /** Re-rasterize at a new resolution (PDFs only; images keep their own pixels). */
  rerender(dpi: number): void;
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
    rerender: () => {},
    destroy: () => URL.revokeObjectURL(url),
  };
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b && b.type === 'image/webp' ? resolve(b) : canvas.toBlob((p) => (p ? resolve(p) : reject(new Error('Could not encode page'))), 'image/png')), 'image/webp', 0.94),
  );
}

async function loadPdf(file: File, password: string | undefined, initialDpi: number): Promise<SourceDoc> {
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

  // Page sizes in PDF points; pixel sizes and scales follow the chosen dpi.
  const points: { w: number; h: number }[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
    points.push({ w: vp.width, h: vp.height });
  }
  const scales: number[] = [];
  const pages: PageSize[] = [];
  let dpi = 0;
  const layout = (next: number) => {
    dpi = next;
    points.forEach(({ w, h }, i) => {
      const long = Math.max(w, h);
      const scale = Math.min(MAX_SIDE / long, Math.max(PDF_MIN_LONG_SIDE / long, dpi / 72));
      scales[i] = scale;
      pages[i] = { width: Math.round(w * scale), height: Math.round(h * scale) };
    });
  };
  layout(initialDpi);

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
    rerender(next) {
      if (next === dpi) return;
      layout(next);
      for (const u of urls.values()) URL.revokeObjectURL(u);
      urls.clear();
      blobs.clear();
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

export function openDocument(file: File, password?: string, dpi = DEFAULT_DPI): Promise<SourceDoc> {
  return isPdf(file) ? loadPdf(file, password, dpi) : loadImage(file);
}
