# Legible

Drop in PDFs and images. Every page is scanned with **PP-OCRv6**, and you get invisible text laid exactly over the printed words. You can select, copy, search (Ctrl/⌘ F) and export text from any scan, like Live Text on macOS. Everything runs in the browser. Files are never uploaded.

## Features

- **Many documents at once.** Use multi-select in the file picker, drag and drop, or paste a screenshot (Ctrl/⌘ V). PDFs of any length and all common image formats work, including phone photos (EXIF orientation is respected).
- **One continuous scroll view** with a document sidebar, page indicator and zoom.
- **Invisible, exact text layer.** Selection highlights sit on the actual glyphs. Double-click selects a word, drag selects lines, and Ctrl/⌘ A selects everything.
- **Clean copies.** Copied text keeps line breaks, paragraphs, two-column reading order and table rows.
- **Copy all / Export .txt**, per document or for everything.
- **Private and offline-capable.** Models are cached on the device after the first visit.
- **Accurate / Fast modes.** PP-OCRv6 *small* (31 MB) or *tiny* (6 MB). The default is Accurate on desktop and Fast on touch devices.
- **WebGPU acceleration** when the device has a real GPU. Otherwise multi-threaded WASM SIMD.

## How the overlay stays exact

The usual approach stretches one string of text across a whole detected line, so any gap between the font's spacing and the print makes words drift. Legible places every **word** individually:

1. **Detection:** PP-OCRv6 DB model. Text regions → min-area rectangles → unclip, following PaddleOCR's `DBPostProcess`.
2. **Recognition:** each line is sampled straight from the full-resolution page into the recognizer tensor, with no intermediate crop.
3. **Positions from CTC.** The greedy CTC decoder records *which timestep* emitted each character. Timesteps map linearly back onto the line, which gives every character's position, and from that every word's left and right edge.
4. **Rendering:** each line is a box mapped onto the page with a CSS `matrix()` (so rotated and tilted lines are followed). Each word is a `<span>` placed at its measured edge and scaled with `scale(sx, sy)` to cover exactly that word. The glyph metrics are measured at runtime for the platform's actual font. Spaces are real, selectable spans that fill the gap between words.
5. **Selection:** an opaque highlight is blended with `mix-blend-mode: multiply`, so the ink shows through and adjacent word highlights never stack into seams. A PDF.js-style end-of-content sentinel stops drag-selection from jumping across empty space.
6. **Copying** uses a custom `copy` handler that rebuilds the text from the layout model: line breaks, paragraph breaks, and XY-cut reading order across columns and tables.

On the test fixtures, word edges land within about 1 CSS px (median) of the true glyph positions, and the painted highlight matches the word box to 0 px (see `tests/e2e`).

## Development

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # engine accuracy tests (Node, runs the real models)
npm run test:e2e     # Playwright end-to-end tests against the production build
npm run build        # static site in dist/
```

`npm run dev`/`build` first run `scripts/prepare-assets.mjs`. That script copies the models into `public/models/` and verifies every model file against a pinned SHA-256. It also copies the pdf.js CMaps, standard fonts and decoders into `public/pdfjs/`. Nothing is loaded from a third-party CDN at runtime.

To run the e2e tests with a pre-installed Chromium, set `CHROMIUM_PATH=/path/to/chrome`.

To force the CPU path (for example, to troubleshoot a GPU driver), open the app with `?backend=wasm`.

## Deploying

`dist/` is a static site. Host it anywhere, **but it must be served with cross-origin isolation headers**. They enable `SharedArrayBuffer`, which multi-threaded inference needs. Without them the app still works, only single-threaded and several times slower.

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Ready-made configs are included for Netlify / Cloudflare Pages (`public/_headers`) and Vercel (`vercel.json`). Model files never change for a given hash, so cache them for a long time. The app also keeps a verified copy in Cache Storage.

## Models

PP-OCRv6 detection and recognition models by PaddlePaddle (Apache-2.0), from PaddleOCR v3.7.0, revision `b03f464`. The ONNX exports come from the npm packages `@arcships/light-ocr-model-ppocrv6-{small,tiny}`, pinned by version, lockfile integrity and per-file SHA-256. Their `inference.yml` files are PaddlePaddle's originals, and the DB thresholds (`thresh`, `box_thresh`, `unclip_ratio`) are read from them.

## Known limitations

- Pages rotated 90° or 180° as a whole are not auto-rotated. PP-OCRv6's document-orientation classifier isn't included. Small skew and phone-photo perspective are handled.
- The Fast (tiny) model excludes Japanese and occasionally drops a space in monospaced text.
- PDFs are always OCR'd, even when they already contain a text layer, so all documents behave the same.
- HEIC photos only open in browsers that can decode them (Safari).
