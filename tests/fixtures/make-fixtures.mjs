// Renders synthetic documents with known word positions (ground truth) as
// PNG + PDF. Run: node tests/fixtures/make-fixtures.mjs
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const executablePath = process.env.CHROMIUM_PATH || undefined;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #fff; color: #111; font-family: "Liberation Serif", "Times New Roman", serif; }
  .page { width: 850px; height: 1100px; padding: 72px 80px; box-sizing: border-box; background: #fff; transform-origin: 50% 50%; }
  h1 { font-family: "Liberation Sans", Arial, sans-serif; font-size: 30px; margin: 0 0 6px; }
  .sub { font-family: "Liberation Sans", Arial, sans-serif; color: #555; font-size: 14px; margin-bottom: 26px; }
  p { font-size: 16px; line-height: 1.45; margin: 0 0 14px; }
  .cols { display: flex; gap: 40px; margin-top: 10px; }
  .cols p { flex: 1; font-size: 14px; }
  table { border-collapse: collapse; font-family: "Liberation Sans", Arial, sans-serif; font-size: 14px; margin: 18px 0; }
  td, th { padding: 5px 18px 5px 0; text-align: left; }
  .small { font-size: 11px; color: #333; }
  .mono { font-family: "Liberation Mono", monospace; font-size: 13px; }
</style></head><body><div class="page" id="page">
  <h1>Quarterly Operations Report</h1>
  <div class="sub">Prepared by the Planning Office · March 14, 2026 · Ref. QX-2291/B</div>
  <p>The distribution network processed 48,317 orders during the quarter, an increase of 12.4% compared with the same period last year. Average delivery time fell from 3.8 days to 2.9 days.</p>
  <div class="cols">
    <p>Left column: warehouse capacity was expanded in Rotterdam and Lyon. Both sites now operate two shifts, and the new sorting line reduced manual handling by roughly one third.</p>
    <p>Right column: customer satisfaction scores improved in every region. The largest gain was recorded in the northern territory, where response times halved after the new support desk opened.</p>
  </div>
  <table>
    <tr><th>Region</th><th>Orders</th><th>Growth</th><th>Rating</th></tr>
    <tr><td>North</td><td>12,904</td><td>+18.2%</td><td>4.7</td></tr>
    <tr><td>South</td><td>9,431</td><td>+7.5%</td><td>4.4</td></tr>
    <tr><td>West</td><td>15,002</td><td>+11.9%</td><td>4.6</td></tr>
  </table>
  <p class="mono">Invoice #A-10593  total: $1,284.50  (due 2026-04-30)</p>
  <p>Next steps include a review of supplier contracts, a pilot for weekend deliveries, and an audit of returns handling.</p>
  <p class="small">This document is intended for internal use only. Figures are preliminary and may be revised after the annual audit is completed.</p>
</div></body></html>`;

async function render(browser, name, rotateDeg) {
  const page = await browser.newPage({ viewport: { width: 850, height: 1100 }, deviceScaleFactor: 2 });
  await page.setContent(PAGE);
  if (rotateDeg) await page.evaluate((d) => (document.getElementById('page').style.transform = `rotate(${d}deg) scale(0.96)`), rotateDeg);
  await page.evaluate(() => document.fonts.ready);
  const words = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.getElementById('page'), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const re = /\S+/g;
      let m;
      while ((m = re.exec(n.data))) {
        const r = document.createRange();
        r.setStart(n, m.index);
        r.setEnd(n, m.index + m[0].length);
        const b = r.getBoundingClientRect();
        out.push({ text: m[0], x0: b.left * 2, y0: b.top * 2, x1: b.right * 2, y1: b.bottom * 2 });
      }
    }
    return out;
  });
  await page.screenshot({ path: join(here, `${name}.png`) });
  writeFileSync(join(here, `${name}.json`), JSON.stringify({ width: 1700, height: 2200, words }, null, 1));
  if (!rotateDeg) {
    await page.pdf({ path: join(here, `${name}.pdf`), width: '850px', height: '1100px', printBackground: true });
  }
  await page.close();
}

const LETTER = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: 612pt 792pt; margin: 0; }
  body { margin: 0; font-family: "Liberation Sans", Arial, sans-serif; color: #222; }
  .p { width: 612pt; height: 792pt; padding: 60pt; box-sizing: border-box; break-after: page; }
  h2 { font-size: 20pt; margin: 0 0 14pt; }
  p { font-size: 11pt; line-height: 1.5; margin: 0 0 10pt; }
</style></head><body>
  <div class="p"><h2>Page one: Introduction</h2><p>Welcome to the multi-page test document. Each page carries a unique marker so the scanner can be checked page by page.</p><p>Marker: ALPHA-7731</p></div>
  <div class="p"><h2>Page two: Details</h2><p>The second page lists items: apples, oranges, and pears. Prices are 1.25, 0.99 and 2.10 respectively.</p><p>Marker: BRAVO-2204</p></div>
  <div class="p"><h2>Page three: Summary</h2><p>In summary, the scanner must keep text selectable across every page of a long document.</p><p>Marker: CHARLIE-9058</p></div>
</body></html>`;

async function renderPhoto(browser) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1500 }, deviceScaleFactor: 1 });
  await page.setContent(PAGE.replace('<body>', '<body style="background:#6b6259;display:flex;align-items:center;justify-content:center;height:1500px;overflow:hidden">'));
  await page.evaluate(() => {
    const el = document.getElementById('page');
    el.style.transform = 'perspective(1800px) rotateX(9deg) rotateZ(-1.5deg) scale(1.2)';
    el.style.filter = 'blur(0.6px) contrast(0.9) brightness(0.97)';
    el.style.boxShadow = '0 30px 60px rgba(0,0,0,.45)';
    el.style.background = 'linear-gradient(115deg, #fff 0%, #f4f1ea 55%, #d9d4ca 100%)';
  });
  await page.screenshot({ path: join(here, 'photo.jpg'), type: 'jpeg', quality: 78 });
  await page.close();
}

const browser = await chromium.launch({ executablePath });
await render(browser, 'report', 0);
await render(browser, 'report-rotated', 2.5);
await renderPhoto(browser);
{
  const page = await browser.newPage();
  await page.setContent(LETTER);
  await page.pdf({ path: join(here, 'multipage.pdf'), preferCSSPageSize: true });
  await page.close();
}
await browser.close();
console.log('fixtures written');
