#!/usr/bin/env node
// Starts Legible locally and opens it in your browser.
// Builds the app first if it hasn't been built yet (or the source changed).
import { execSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const args = new Set(process.argv.slice(2));

function newestMtime(path) {
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  return Math.max(st.mtimeMs, ...readdirSync(path).map((f) => newestMtime(join(path, f))));
}

const built = existsSync(join(dist, 'index.html'));
const stale = built && ['src', 'index.html', 'public/favicon.svg'].some((p) => newestMtime(join(root, p)) > statSync(join(dist, 'index.html')).mtimeMs);
if (!built || stale || args.has('--rebuild')) {
  console.log(built ? 'Source changed — rebuilding…' : 'First run — building Legible…');
  try {
    execSync('npm run build --silent', { cwd: root, stdio: 'pipe' });
  } catch (e) {
    process.stderr.write(e.stdout?.toString() ?? '');
    process.stderr.write(e.stderr?.toString() ?? '');
    process.exit(1);
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.icc': 'application/octet-stream',
};

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(dist, path === '/' ? 'index.html' : path));
  if (!file.startsWith(dist + sep) && file !== dist) return res.writeHead(403).end();
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    // Cross-origin isolation enables multi-threaded OCR.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cache-Control': file.includes(`${sep}assets${sep}`) || file.includes(`${sep}models${sep}`) ? 'max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
});

function openBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// A fixed port keeps the browser's model cache warm between runs.
const PORT = Number(process.env.PORT) || 5199;
server.once('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  server.listen(0, '127.0.0.1');
});
server.on('listening', () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`\n  Legible is running at ${url}\n  Press Ctrl+C to quit.\n`);
  if (!args.has('--no-open')) openBrowser(url);
});
server.listen(PORT, '127.0.0.1');
process.on('SIGINT', () => process.exit(0));
