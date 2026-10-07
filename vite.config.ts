/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Cross-origin isolation unlocks SharedArrayBuffer, which ONNX Runtime needs
// for multi-threaded WASM inference (several times faster on multi-core).
// bin/legible.mjs sends the same headers when serving the built app.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { include: ['tests/*.test.ts'], testTimeout: 180_000 },
});
