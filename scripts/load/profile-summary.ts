/**
 * Summarises a V8 .cpuprofile (node --cpu-prof): self and inclusive time per function and self time per file.
 *
 *   npx tsx scripts/load/profile-summary.ts <file.cpuprofile> [top=25]
 *
 * Inclusive time counts a function once per sample even when it recurses. "(idle)" is the event loop
 * waiting; the percentages of the other rows are of the busy time.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

interface Node { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
interface Profile { nodes: Node[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number }

const file = process.argv[2];
const TOP = Number(process.argv[3] ?? 25);
if (!file) {
  console.error('usage: profile-summary.ts <file.cpuprofile> [top]');
  process.exit(1);
}
const prof = JSON.parse(readFileSync(file, 'utf8')) as Profile;
const root = resolve(import.meta.dirname, '../..');

const byId = new Map<number, Node>();
const parent = new Map<number, number>();
for (const n of prof.nodes) byId.set(n.id, n);
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

const shortUrl = (url: string) => {
  if (!url) return '';
  const p = url.replace(/^file:\/\//, '');
  if (p.includes('/node_modules/')) return `node_modules/${p.split('/node_modules/').pop()}`;
  return p.startsWith('/') ? relative(root, p) : p;
};
const label = (n: Node) => {
  const f = n.callFrame;
  const name = f.functionName || '(anonymous)';
  const url = shortUrl(f.url);
  return url ? `${name}  ${url}:${f.lineNumber + 1}` : name;
};

const self = new Map<string, number>();
const incl = new Map<string, number>();
const perFile = new Map<string, number>();
let total = 0, idle = 0, gc = 0;
for (let i = 0; i < prof.samples.length; i++) {
  const dt = (prof.timeDeltas[i] ?? 0) / 1000; // ms
  const n = byId.get(prof.samples[i]);
  if (!n) continue;
  total += dt;
  const name = n.callFrame.functionName;
  if (name === '(idle)') { idle += dt; continue; }
  if (name === '(garbage collector)') gc += dt;
  const l = label(n);
  self.set(l, (self.get(l) ?? 0) + dt);
  const f = shortUrl(n.callFrame.url) || name;
  perFile.set(f, (perFile.get(f) ?? 0) + dt);
  const seen = new Set<string>();
  for (let id: number | undefined = n.id; id !== undefined; id = parent.get(id)) {
    const k = label(byId.get(id)!);
    if (seen.has(k)) continue;
    seen.add(k);
    incl.set(k, (incl.get(k) ?? 0) + dt);
  }
}
const busy = total - idle;
const pct = (v: number) => `${((v / busy) * 100).toFixed(1).padStart(5)} %`;
const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);

console.log(`profile ${file}`);
console.log(`wall ${(total / 1000).toFixed(1)} s, busy ${(busy / 1000).toFixed(1)} s (${((busy / total) * 100).toFixed(1)} % of one core), GC ${pct(gc)} of busy\n`);
console.log('self time (busy %):');
for (const [k, v] of top(self, TOP)) console.log(`  ${pct(v)}  ${(v / 1000).toFixed(2).padStart(7)} s  ${k}`);
console.log('\ninclusive time (busy %), skipping (root) and program:');
for (const [k, v] of top(incl, TOP + 3).filter(([k]) => !k.startsWith('(root)') && !k.startsWith('(program)')).slice(0, TOP)) {
  console.log(`  ${pct(v)}  ${(v / 1000).toFixed(2).padStart(7)} s  ${k}`);
}
console.log('\nself time per file:');
for (const [k, v] of top(perFile, 15)) console.log(`  ${pct(v)}  ${k}`);
