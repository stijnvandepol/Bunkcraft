/**
 * Bundles the game server (server/index.ts plus the shared src/ code it imports, ws and fflate) into one
 * plain-JS file, so production runs `node dist-server/index.js`: no TypeScript transpiling at start-up,
 * no tsx/esbuild helper process and no node_modules at runtime.
 *
 *   node scripts/build-server.mjs          # → dist-server/index.js (+ .map)
 *
 * The server reads its version from ../package.json next to dist-server/, so ship package.json with it.
 * Development keeps `npm run server` (tsx watch) and needs no build.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'dist-server');

rmSync(outdir, { recursive: true, force: true });
const t0 = performance.now();
const result = await build({
  absWorkingDir: root,
  entryPoints: ['server/index.ts'],
  outfile: 'dist-server/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  // The oldest Node the Docker image and the systemd guide support.
  target: 'node22',
  sourcemap: true,
  // Readable stack traces in the logs matter more than a few hundred KB on disk.
  minify: false,
  legalComments: 'none',
  // ws loads these optional native speed-ups in a try/catch; without them it uses its JS fallback.
  external: ['bufferutil', 'utf-8-validate'],
  // ws is CommonJS: give the ESM bundle a real `require` for Node's built-in modules.
  banner: { js: "import { createRequire as __bunkCreateRequire } from 'node:module';\nconst require = __bunkCreateRequire(import.meta.url);" },
  metafile: true,
  logLevel: 'warning',
});
const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
console.log(`dist-server/index.js: ${(bytes / 1024).toFixed(0)} KiB in ${Math.round(performance.now() - t0)} ms`);
