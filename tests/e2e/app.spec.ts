import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Page, chromium, expect, test } from '@playwright/test';

const fx = (name: string) => join(import.meta.dirname, '..', 'fixtures', name);

interface GtWord { text: string; x0: number; y0: number; x1: number; y1: number }

async function open(page: Page, tier: 'small' | 'tiny') {
  await page.addInitScript((t) => localStorage.setItem('legible:tier', t), tier);
  await page.goto('./');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
}

async function waitForScans(page: Page, docs: number) {
  await page.waitForFunction(
    (n) => {
      const d = window.__legible?.docs();
      return d && d.length === n && d.every((x) => x.error || (x.pages.length > 0 && x.pages.every(Boolean)));
    },
    docs,
    { timeout: 200_000 },
  );
}

/** Text the app puts on the clipboard for the current selection. */
const copySelection = (page: Page) =>
  page.evaluate(() => {
    const dt = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.getData('text/plain');
  });

const stats = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return { median: s[s.length >> 1], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
};

test('invisible text sits exactly on the printed words', async ({ page }) => {
  await open(page, 'small');
  await page.setInputFiles('#file-input', fx('report.png'));
  await waitForScans(page, 1);
  await checkAlignment(page);

  // Zoomed past the window width, the overlay must still track the page.
  await page.click('#zoom-in');
  await page.click('#zoom-in');
  await expect(page.locator('#zoom-reset')).toHaveText('144%');
  await checkAlignment(page);
});

async function checkAlignment(page: Page) {
  const gt: GtWord[] = JSON.parse(readFileSync(fx('report.json'), 'utf8')).words;
  const spans = await page.evaluate(() => {
    const pg = document.querySelector('.page')!.getBoundingClientRect();
    const k = 1700 / pg.width;
    return Array.from(document.querySelectorAll('.text-layer .w')).map((s) => {
      // What the browser paints for a selection of this word.
      const r = document.createRange();
      r.selectNodeContents(s.firstChild!);
      const b = r.getBoundingClientRect();
      return { text: s.textContent!, x0: (b.left - pg.left) * k, x1: (b.right - pg.left) * k, y0: (b.top - pg.top) * k, y1: (b.bottom - pg.top) * k };
    });
  });

  const used = new Set<number>();
  const edges: number[] = [], tops: number[] = [], bottoms: number[] = [];
  for (const g of gt) {
    let best = -1, bd = Infinity;
    spans.forEach((s, i) => {
      if (used.has(i) || s.text !== g.text) return;
      const d = Math.hypot((s.x0 + s.x1 - g.x0 - g.x1) / 2, (s.y0 + s.y1 - g.y0 - g.y1) / 2);
      if (d < bd) { bd = d; best = i; }
    });
    expect(bd, `word "${g.text}" should be found where it is printed`).toBeLessThan(20);
    used.add(best);
    const s = spans[best];
    edges.push(Math.abs(s.x0 - g.x0), Math.abs(s.x1 - g.x1));
    tops.push(Math.abs(s.y0 - g.y0));
    bottoms.push(Math.abs(s.y1 - g.y1));
  }
  // Units: pixels of the 1700 px-wide page image (≈ 2 px per CSS px at 850 px).
  const e = stats(edges), t = stats(tops), b = stats(bottoms);
  console.log('edge', e, 'top', t, 'bottom', b);
  expect(e.median).toBeLessThan(3.5);
  expect(e.p95).toBeLessThan(9);
  expect(t.p95).toBeLessThan(5);
  expect(b.p95).toBeLessThan(5);
}

test('drag-select copies exactly what was selected, with real line breaks', async ({ page }) => {
  await open(page, 'tiny');
  await page.setInputFiles('#file-input', fx('report.png'));
  await waitForScans(page, 1);

  const a = (await page.locator('.text-layer .w', { hasText: /^The$/ }).first().boundingBox())!;
  const b = (await page.locator('.text-layer .w', { hasText: /^2\.9$/ }).first().boundingBox())!;
  await page.mouse.move(a.x + 1, a.y + a.height / 2);
  await page.mouse.down();
  // Finish the drag in empty space past the end of the line.
  await page.mouse.move(b.x + b.width + 80, b.y + b.height / 2, { steps: 15 });
  await page.mouse.up();
  expect(await copySelection(page)).toBe(
    'The distribution network processed 48,317 orders during the quarter, an increase of 12.4% compared with\n' +
      'the same period last year. Average delivery time fell from 3.8 days to 2.9 days.',
  );

  // Partial words: from inside "distribution" to inside "network".
  await page.evaluate(() => {
    const words = Array.from(document.querySelectorAll('.text-layer .w'));
    const from = words.find((w) => w.textContent === 'distribution')!.firstChild!;
    const to = words.find((w) => w.textContent === 'network')!.firstChild!;
    const r = document.createRange();
    r.setStart(from, 4);
    r.setEnd(to, 3);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
  });
  expect(await copySelection(page)).toBe('ribution net');

  // Columns and tables keep their reading order.
  await page.keyboard.press('ControlOrMeta+a');
  const all = await copySelection(page);
  expect(all).toContain('roughly one third.\n\nRight column: customer satisfaction');
  expect(all).toContain('Region Orders Growth Rating\nNorth 12,904 +18.2% 4.7\nSouth 9,431 +7.5% 4.4\nWest 15,002 +11.9% 4.6');
});

test('many documents at once: multi-page PDF, PDF and a photo', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, 'tiny');
  await page.setInputFiles('#file-input', [fx('multipage.pdf'), fx('report.pdf'), fx('photo.jpg')]);
  await waitForScans(page, 3);

  const docs = await page.evaluate(() => window.__legible!.docs());
  expect(docs.map((d) => d.pages.length)).toEqual([3, 1, 1]);
  const pageText = (p: { lines: { text: string }[] } | null) => p!.lines.map((l) => l.text).join('\n');
  expect(pageText(docs[0].pages[0])).toContain('ALPHA-7731');
  expect(pageText(docs[0].pages[1])).toContain('BRAVO-2204');
  expect(pageText(docs[0].pages[2])).toContain('CHARLIE-9058');
  expect(pageText(docs[1].pages[0])).toContain('Invoice #A-10593');
  expect(pageText(docs[1].pages[0])).toContain('$1,284.50 (due 2026-04-30)');

  // The skewed, perspective-distorted, JPEG "photo" still reads.
  const gt: GtWord[] = JSON.parse(readFileSync(fx('report.json'), 'utf8')).words;
  const photoWords = new Set(pageText(docs[2].pages[0]).split(/\s+/));
  const recall = gt.filter((w) => photoWords.has(w.text)).length / gt.length;
  console.log('photo word recall', recall);
  expect(recall).toBeGreaterThan(0.9);

  await expect(page.locator('#dock-page')).toContainText('of 5');
  await expect(page.locator('.doc-item')).toHaveCount(3);

  await page.click('#copy-all');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip.indexOf('ALPHA-7731')).toBeLessThan(clip.indexOf('CHARLIE-9058'));
  expect(clip.indexOf('CHARLIE-9058')).toBeLessThan(clip.indexOf('Quarterly Operations Report'));
  await expect(page.locator('.toast')).toContainText('Copied');

  // Removing a document drops it everywhere.
  await page.locator('.doc').first().locator('[data-act="remove"]').click();
  await expect(page.locator('.doc-item')).toHaveCount(2);
  await expect(page.locator('#dock-page')).toContainText('of 2');
});

test('rejects unsupported files gracefully', async ({ page }) => {
  await open(page, 'tiny');
  await page.setInputFiles('#file-input', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await expect(page.locator('.toast.error')).toContainText('only PDFs and images');
  await page.setInputFiles('#file-input', { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 garbage') });
  await expect(page.locator('.doc-error')).toContainText('can’t be opened');
});

test('phone layout fits without horizontal scrolling', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  await page.goto('./');
  await page.setInputFiles('#file-input', fx('report.png'));
  await waitForScans(page, 1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const tier = await page.evaluate(() => document.querySelector('#engine')!.getAttribute('title'));
  expect(tier).toContain('tiny');
  await ctx.close();
});

test('PDF resolution is remembered and re-scans open PDFs without moving the text', async ({ page }) => {
  await open(page, 'tiny');
  await page.setInputFiles('#file-input', fx('report.pdf'));
  await waitForScans(page, 1);

  const pageWidth = () => page.evaluate(() => window.__legible!.docs()[0].pages[0]?.width ?? 0);
  const firstWord = () =>
    page.locator('.text-layer .w', { hasText: /^Quarterly$/ }).first().evaluate((w) => {
      const r = w.getBoundingClientRect();
      const pg = w.closest('.page')!.getBoundingClientRect();
      return { x: r.left - pg.left, y: r.top - pg.top, w: r.width, h: r.height };
    });

  await expect(page.locator('#dpi-seg button[aria-checked="true"]')).toHaveText('300');
  const base = await firstWord();
  expect(await pageWidth()).toBeGreaterThan(2500);
  expect(await pageWidth()).toBeLessThan(2800);

  // 150 dpi: the open PDF is re-rendered (half the pixels) and re-scanned.
  await page.click('#dpi-seg button[data-dpi="150"]');
  await page.waitForFunction(() => {
    const w = window.__legible!.docs()[0].pages[0]?.width ?? 0;
    return w > 1100 && w < 1500;
  });
  await expect(page.locator('.text-layer')).toHaveCount(1);
  const after = await firstWord();
  // Same word, same place on screen (within a couple of CSS px), whatever the raster size.
  expect(Math.abs(after.x - base.x)).toBeLessThan(2.5);
  expect(Math.abs(after.y - base.y)).toBeLessThan(2.5);
  expect(Math.abs(after.w - base.w)).toBeLessThan(4);

  // Remembered across reloads, and applied to newly opened PDFs.
  await page.reload();
  await expect(page.locator('#dpi-seg button[aria-checked="true"]')).toHaveText('150');
  await page.setInputFiles('#file-input', fx('report.pdf'));
  await waitForScans(page, 1);
  expect(await pageWidth()).toBeLessThan(1500);
});

test('start-screen scanner graphic plays on start and on hover, then rests', async ({ page }) => {
  await open(page, 'tiny');
  const sweeping = () => page.locator('.s3 b').evaluate((b) => getComputedStyle(b).animationName === 'art-scan');
  expect(await sweeping()).toBe(true); // on start
  await expect.poll(sweeping, { timeout: 10_000 }).toBe(false); // rests after two passes

  await page.hover('#dropcard');
  await expect.poll(sweeping).toBe(true); // hover
  await page.mouse.move(5, 5);
  await expect.poll(sweeping, { timeout: 6_000 }).toBe(false); // finishes the pass, then rests
});

test('switching models never re-downloads, and switching back is instant', async ({ page }) => {
  const modelRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('.onnx')) modelRequests.push(r.url().split('/').slice(-2).join('/').split('?')[0]);
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __labels: string[] };
    w.__labels = [];
    new MutationObserver(() => {
      const l = document.getElementById('engine-label')?.textContent;
      if (l && w.__labels[w.__labels.length - 1] !== l) w.__labels.push(l);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const labels = () => page.evaluate(() => (window as unknown as { __labels: string[] }).__labels);
  const resetLabels = () => page.evaluate(() => ((window as unknown as { __labels: string[] }).__labels = []));
  const engineState = () => page.getAttribute('#engine', 'data-state');

  await page.goto('./');
  await page.setInputFiles('#file-input', fx('report.png')); // the model switch lives in the sidebar
  await waitForScans(page, 1);
  expect(modelRequests.sort()).toEqual(['small/det.onnx', 'small/rec.onnx']);

  // First visit to Fast downloads it once.
  modelRequests.length = 0;
  await page.click('.seg button[data-tier="tiny"]');
  await expect(page.locator('#engine')).toHaveAttribute('data-state', 'ready');
  expect(modelRequests.sort()).toEqual(['tiny/det.onnx', 'tiny/rec.onnx']);

  // Switching back and forth: nothing fetched, and ready the moment the click lands.
  modelRequests.length = 0;
  await resetLabels();
  await page.click('.seg button[data-tier="small"]');
  expect(await engineState()).toBe('ready');
  await page.click('.seg button[data-tier="tiny"]');
  expect(await engineState()).toBe('ready');
  expect(modelRequests).toEqual([]);
  expect((await labels()).filter((l) => /Download|Loading|Preparing/.test(l))).toEqual([]);

  // A fresh page load reads the model from the browser cache: it says "Loading", never "Downloading".
  await page.reload();
  await expect(page.locator('#engine')).toHaveAttribute('data-state', 'ready');
  expect(modelRequests).toEqual([]);
  const seen = await labels();
  expect(seen.some((l) => /Downloading/.test(l))).toBe(false);
  expect(seen.some((l) => /Loading text recognition/.test(l))).toBe(true);
});

test('models are kept on disk across closing and reopening the browser', async ({ baseURL }) => {
  const profile = mkdtempSync(join(tmpdir(), 'legible-profile-'));
  const visit = async () => {
    const ctx = await chromium.launchPersistentContext(profile, process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const page = await ctx.newPage();
    const models: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('.onnx')) models.push(r.url().split('/').slice(-2).join('/').split('?')[0]);
    });
    await page.goto(baseURL!);
    await expect(page.locator('#engine')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    const label = await page.textContent('#engine-label');
    await ctx.close();
    return { models: models.sort(), label };
  };
  try {
    const first = await visit();
    expect(first.models).toEqual(['small/det.onnx', 'small/rec.onnx']); // very first run stores them
    const second = await visit(); // a brand-new browser process on the same profile
    expect(second.models).toEqual([]);
    expect(second.label).toBe('Ready · on-device');
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
