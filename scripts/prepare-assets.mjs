// Copies the PP-OCRv6 ONNX models and pdf.js resources into public/ so
// everything is served from our own origin (no third-party CDNs at
// runtime). Every model file is verified against a pinned SHA-256.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');

// PP-OCRv6 exports published by PaddlePaddle (upstream PaddleOCR v3.7.0,
// revision b03f46425e8ff4442b268ce449e3eef758146cd4), redistributed on npm.
const MODELS = {
  small: {
    pkg: '@arcships/light-ocr-model-ppocrv6-small',
    det: 'd73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e',
    rec: '5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634',
    dict: '6e93cc028ff774c8bef0801ad08391f8284f7ef897013a9aeb9cbd515db3276d',
  },
  tiny: {
    pkg: '@arcships/light-ocr-model-ppocrv6-tiny',
    det: '193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8',
    rec: '9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6',
    dict: '7db82ee59f535f27cedd9f5893e24bf5ed141ef51f5cb076d88053968102c1d1',
  },
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function verified(path, expected) {
  const buf = readFileSync(path);
  const actual = sha256(buf);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${path}\n  expected ${expected}\n  actual   ${actual}`);
  }
  return buf;
}

// DB post-processing thresholds from each model's own inference.yml.
function detPostprocess(yml) {
  const block = yml.split('PostProcess:')[1] ?? '';
  const num = (key) => {
    const m = block.match(new RegExp(`\\b${key}:\\s*([0-9.]+)`));
    if (!m) throw new Error(`Missing ${key} in det inference.yml`);
    return Number(m[1]);
  };
  return { thresh: num('thresh'), boxThresh: num('box_thresh'), unclipRatio: num('unclip_ratio') };
}

const manifest = {};
for (const [tier, spec] of Object.entries(MODELS)) {
  const src = join(nm, spec.pkg, 'bundle');
  const out = join(root, 'public', 'models', tier);
  mkdirSync(out, { recursive: true });

  const det = verified(join(src, 'det/inference.onnx'), spec.det);
  const rec = verified(join(src, 'rec/inference.onnx'), spec.rec);
  const dict = JSON.parse(verified(join(src, 'rec/dictionary.json'), spec.dict).toString('utf8'));
  const post = detPostprocess(readFileSync(join(src, 'det/inference.yml'), 'utf8'));

  writeFileSync(join(out, 'det.onnx'), det);
  writeFileSync(join(out, 'rec.onnx'), rec);
  writeFileSync(join(out, 'dict.json'), JSON.stringify(dict.characters));
  manifest[tier] = {
    det: { file: 'det.onnx', bytes: det.length, sha256: spec.det, ...post },
    rec: { file: 'rec.onnx', bytes: rec.length, sha256: spec.rec },
    dict: { file: 'dict.json', entries: dict.characters.length },
  };
}
writeFileSync(join(root, 'public', 'models', 'manifest.json'), JSON.stringify(manifest, null, 2));

// pdf.js resources: CJK/Adobe CMaps, the 14 standard fonts, JPEG2000/JBIG2
// decoders and ICC profiles. Needed to render many real-world PDFs faithfully.
const pdfOut = join(root, 'public', 'pdfjs');
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  cpSync(join(nm, 'pdfjs-dist', dir), join(pdfOut, dir), { recursive: true });
}

console.log('assets ready:', Object.entries(manifest).map(([t, m]) => `${t} (${((m.det.bytes + m.rec.bytes) / 1e6).toFixed(1)} MB)`).join(', '));
