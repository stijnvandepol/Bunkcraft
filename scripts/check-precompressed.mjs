/**
 * Every precompressed copy in dist/ (.gz, .br) must decompress to exactly the file next to it: the
 * server serves these copies first, so a stale copy ships different code than the build (as with the
 * unreplaced `__VITE_PRELOAD__` that broke the lazily loaded arcade code).
 *
 *   node scripts/check-precompressed.mjs [dir=dist]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

const dir = process.argv[2] ?? 'dist';
const bad = [];
let checked = 0;
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    const m = /^(.*)\.(gz|br)$/.exec(p);
    if (!m || !existsSync(m[1])) continue;
    const packed = readFileSync(p);
    const plain = m[2] === 'gz' ? gunzipSync(packed) : brotliDecompressSync(packed);
    checked++;
    if (!plain.equals(readFileSync(m[1]))) bad.push(p);
    else if (/\.js$/.test(m[1]) && plain.includes('__VITE_PRELOAD__')) bad.push(`${p} (unreplaced __VITE_PRELOAD__)`);
  }
};
walk(dir);
if (bad.length) {
  console.error(`precompressed copies that differ from their file:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(`ok   ${checked} precompressed copies match their files`);
