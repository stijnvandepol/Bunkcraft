/**
 * Micro-benchmark: filling a 16x128x16 chunk (32768 samples) with 3D noise.
 *   JS simplex (the game's SimplexNoise.noise3, f64) | JS Perlin (f32-ish) | WASM scalar | WASM SIMD (4 lanes)
 *
 * Build the wasm (AssemblyScript 0.28, no Rust/Zig/emcc needed):
 *   npm i --prefix /tmp/as assemblyscript
 *   /tmp/as/node_modules/.bin/asc scripts/experiments/wasm/noise.as.ts -o scripts/experiments/wasm/noise.wasm \
 *     --enable simd --runtime stub -O3 --noAssert --initialMemory 4
 * Run:  npx tsx scripts/experiments/bench-wasm-noise.ts
 */
import { readFileSync } from 'node:fs';
import { SimplexNoise } from '../../src/world/Noise';

const N = 16 * 128 * 16;
const S = 0.02;
const simplex = new SimplexNoise(1234);

function hashi(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 1103515245) ^ Math.imul(z, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) & 15;
}
function grad(h: number, x: number, y: number, z: number): number {
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + t * (b - a);
function perlin(x: number, y: number, z: number): number {
  const xf = Math.floor(x), yf = Math.floor(y), zf = Math.floor(z);
  const xi = xf | 0, yi = yf | 0, zi = zf | 0;
  const fx = x - xf, fy = y - yf, fz = z - zf;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const a = lerp(lerp(grad(hashi(xi, yi, zi), fx, fy, fz), grad(hashi(xi + 1, yi, zi), fx - 1, fy, fz), u),
    lerp(grad(hashi(xi, yi + 1, zi), fx, fy - 1, fz), grad(hashi(xi + 1, yi + 1, zi), fx - 1, fy - 1, fz), u), v);
  const b = lerp(lerp(grad(hashi(xi, yi, zi + 1), fx, fy, fz - 1), grad(hashi(xi + 1, yi, zi + 1), fx - 1, fy, fz - 1), u),
    lerp(grad(hashi(xi, yi + 1, zi + 1), fx, fy - 1, fz - 1), grad(hashi(xi + 1, yi + 1, zi + 1), fx - 1, fy - 1, fz - 1), u), v);
  return lerp(a, b, w);
}

const out = new Float32Array(N);
function fillSimplexJs(ox: number, oz: number): void {
  let i = 0;
  for (let y = 0; y < 128; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) out[i++] = simplex.noise3((ox + x) * S, y * S, (oz + z) * S);
}
function fillPerlinJs(ox: number, oz: number): void {
  let i = 0;
  for (let y = 0; y < 128; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) out[i++] = perlin((ox + x) * S, y * S, (oz + z) * S);
}

const bin = readFileSync(new URL('./wasm/noise.wasm', import.meta.url));
const inst = new WebAssembly.Instance(new WebAssembly.Module(bin), { env: { abort() { throw new Error('abort'); } } });
const ex = inst.exports as unknown as { memory: WebAssembly.Memory; fillScalar(p: number, ox: number, oz: number, s: number): void; fillSimd(p: number, ox: number, oz: number, s: number): void };
const wout = new Float32Array(ex.memory.buffer, 1024, N);

function bench(name: string, fn: (ox: number, oz: number) => void, rounds = 400): number {
  for (let i = 0; i < 100; i++) fn(i * 16, i * 7); // warm-up (JIT)
  const t0 = performance.now();
  for (let i = 0; i < rounds; i++) fn(1000 + i * 16, 77 + i * 16);
  const ms = (performance.now() - t0) / rounds;
  console.log(`${name.padEnd(22)} ${ms.toFixed(3)} ms/chunk  (${((ms * 1e6) / N).toFixed(1)} ns/sample)`);
  return ms;
}

// Correctness: JS Perlin vs WASM (f32 vs f64: tiny differences expected)
fillPerlinJs(16, 32); const a = out.slice();
ex.fillScalar(1024, 16, 32, S); const b = wout.slice();
ex.fillSimd(1024, 16, 32, S); const c = wout.slice();
let dScalar = 0, dSimd = 0;
for (let i = 0; i < N; i++) { dScalar = Math.max(dScalar, Math.abs(a[i] - b[i])); dSimd = Math.max(dSimd, Math.abs(a[i] - c[i])); }
console.log(`max |JS - wasm scalar| = ${dScalar.toExponential(1)}, max |JS - wasm simd| = ${dSimd.toExponential(1)}`);

const t1 = bench('JS simplex3 (game)', fillSimplexJs);
const t2 = bench('JS perlin3', fillPerlinJs);
const t3 = bench('WASM scalar perlin3', (ox, oz) => ex.fillScalar(1024, ox, oz, S));
const t4 = bench('WASM SIMD perlin3', (ox, oz) => ex.fillSimd(1024, ox, oz, S));
console.log(`speed-up vs JS perlin: scalar x${(t2 / t3).toFixed(2)}, SIMD x${(t2 / t4).toFixed(2)}; SIMD vs wasm scalar x${(t3 / t4).toFixed(2)}`);
