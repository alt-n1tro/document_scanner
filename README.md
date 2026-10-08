# Legible

A local tool for getting text out of PDFs and images. Run one command and your browser opens. Pick any number of documents, and every page is scanned with **PP-OCRv6** and gets invisible text laid exactly over the printed words. Select, copy, search (Ctrl/⌘ F) or export it, like Live Text on macOS. Everything runs on your machine.

## Usage

```bash
npm install      # once
npm link         # once: puts a `legible` command on your PATH
legible          # builds if needed, starts a local server, opens the browser
```

Without `npm link`, run `npm start` from this folder. Press Ctrl+C to quit.

- `legible --no-open` starts the server without opening a browser.
- `legible --rebuild` forces a rebuild (the launcher also rebuilds on its own when `src/` changed).
- The port is fixed (5199; override with `PORT=…`), so the browser keeps the models cached between runs.

## Features

- **Many documents at once.** Use multi-select in the file picker, drag and drop, or paste a screenshot (Ctrl/⌘ V). PDFs of any length and all common image formats work, including phone photos (EXIF orientation is respected).
- **One continuous scroll view** with a document sidebar, page indicator and zoom.
- **Invisible, exact text layer.** Selection highlights sit on the actual glyphs. Double-click selects a word, drag selects lines, and Ctrl/⌘ A selects everything.
- **Clean copies.** Copied text keeps line breaks, paragraphs, two-column reading order and table rows.
- **Copy all / Export .txt**, per document or for everything.
- **Private and offline.** Models ship with the app and are served from your own machine.
- **PDF resolution (150 / 220 / 300 / 400 dpi, default 300).** Pick it in the sidebar. The choice is remembered, and changing it re-scans the PDFs you have open. A scanned PDF is a fixed-resolution picture: rendering below its scan resolution loses detail, rendering above adds none, so match or exceed your scanner's dpi. Images are always read at their own pixel size.
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
npm run dev          # hot-reloading dev server on http://localhost:5173
npm test             # unit + engine accuracy tests (Node, runs the real models)
npm run test:e2e     # Playwright end-to-end tests against the production build
```

`npm run dev` and `npm run build` first run `scripts/prepare-assets.mjs`. That script copies the models into `public/models/` and verifies every model file against a pinned SHA-256. It also copies the pdf.js CMaps, standard fonts and decoders into `public/pdfjs/`. Nothing is loaded from the internet at runtime.

To run the e2e tests with a pre-installed Chromium, set `CHROMIUM_PATH=/path/to/chrome`. To force the CPU path (for example, to troubleshoot a GPU driver), open the app with `?backend=wasm`.

The local server sends `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers. They enable `SharedArrayBuffer`, which multi-threaded inference needs. If you ever host `dist/` elsewhere, send the same headers.

## Models

PP-OCRv6 detection and recognition models by PaddlePaddle (Apache-2.0), from PaddleOCR v3.7.0, revision `b03f464`. The ONNX exports come from the npm packages `@arcships/light-ocr-model-ppocrv6-{small,tiny}`, pinned by version, lockfile integrity and per-file SHA-256. Their `inference.yml` files are PaddlePaddle's originals, and the DB thresholds (`thresh`, `box_thresh`, `unclip_ratio`) are read from them.

## Known limitations

- Pages rotated 90° or 180° as a whole are not auto-rotated. PP-OCRv6's document-orientation classifier isn't included. Small skew and phone-photo perspective are handled.
- The Fast (tiny) model excludes Japanese and occasionally drops a space in monospaced text.
- PDFs are always OCR'd, even when they already contain a text layer, so all documents behave the same.
- HEIC photos only open in browsers that can decode them (Safari).
