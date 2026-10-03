/**
 * Bundle size check (CI): compares the built main chunk (dist/assets/index-*.js) and the chunk worker with the committed
 * budget in scripts/bundle-budget.json and fails when one grew more than `maxGrowth` (10 %).
 *
 *   npm run build && npm run size:check            # check
 *   npm run build && npm run size:check -- --update # accept the current sizes as the new budget
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

interface Budget { maxGrowth: number; files: Record<string, { bytes: number; gzip: number }> }

const DIST = join(process.cwd(), 'dist', 'assets');
const BUDGET_FILE = join(process.cwd(), 'scripts', 'bundle-budget.json');
/** Logical name → hashed file prefix. */
const TRACKED: Record<string, RegExp> = { main: /^index-.*\.js$/, chunkWorker: /^chunkWorker-.*\.js$/ };

function measure(): Record<string, { bytes: number; gzip: number }> {
  const files = readdirSync(DIST);
  const out: Record<string, { bytes: number; gzip: number }> = {};
  for (const [name, re] of Object.entries(TRACKED)) {
    const matches = files.filter((f) => re.test(f)).map((f) => join(DIST, f));
    if (matches.length === 0) throw new Error(`no ${name} chunk in dist/assets (run npm run build first)`);
    // The biggest match is the real entry (small helper chunks can share the prefix).
    const file = matches.sort((a, b) => statSync(b).size - statSync(a).size)[0];
    const data = readFileSync(file);
    out[name] = { bytes: data.length, gzip: gzipSync(data, { level: 9 }).length };
  }
  return out;
}

const now = measure();
const kb = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
if (process.argv.includes('--update')) {
  const prev = (() => { try { return JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as Budget; } catch { return null; } })();
  writeFileSync(BUDGET_FILE, JSON.stringify({ maxGrowth: prev?.maxGrowth ?? 0.1, files: now } satisfies Budget, null, 2) + '\n');
  console.log('bundle budget updated:', Object.entries(now).map(([k, v]) => `${k} ${kb(v.bytes)} (${kb(v.gzip)} gzip)`).join(', '));
  process.exit(0);
}
const budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as Budget;
let failed = false;
for (const [name, size] of Object.entries(now)) {
  const b = budget.files[name];
  if (!b) { console.log(`${name}: ${kb(size.bytes)} (no budget yet)`); continue; }
  const growth = size.gzip / b.gzip - 1;
  const line = `${name}: ${kb(size.bytes)}, ${kb(size.gzip)} gzip (budget ${kb(b.gzip)} gzip, ${(growth * 100).toFixed(1)} %)`;
  if (growth > budget.maxGrowth) { failed = true; console.error(`FAIL ${line} grew more than ${budget.maxGrowth * 100} %`); } else console.log(`ok   ${line}`);
}
if (failed) {
  console.error('If the growth is intended, run `npm run build && npm run size:check -- --update` and commit scripts/bundle-budget.json.');
  process.exit(1);
}
