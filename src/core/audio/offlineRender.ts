import { AudioEngine } from '../Audio';
import { at, buildCatalog } from './catalog';

/**
 * Offline renderer for the audio report (scripts/audio-report.py drives it from Playwright through the Vite
 * dev server): plays catalog sounds on an OfflineAudioContext, returns levels and a 16-bit mono WAV.
 * Exposed as `window.__audio` when imported; it is never loaded by the game itself.
 */
const SAMPLE_RATE = 44100;

export interface RenderResult {
  name: string;
  seconds: number;
  /** Linear peak over both channels. */
  peak: number;
  /** RMS in dBFS over the whole render. */
  rmsDb: number;
  /** RMS in dBFS over the samples above -50 dBFS only (how loud the sound is while it sounds). */
  activeRmsDb: number;
  /** Seconds of the render until the signal falls and stays below -60 dBFS. */
  tailSeconds: number;
  renderMs: number;
  nan: boolean;
  wavBase64?: string;
}

function makeEngine(seconds: number): { engine: AudioEngine; ctx: OfflineAudioContext } {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const engine = new AudioEngine();
  engine.attach(ctx, true);
  engine.setVolumes(100, 100, 100, 100);
  return { engine, ctx };
}

function analyse(name: string, seconds: number, buf: AudioBuffer, renderMs: number, wav: boolean): RenderResult {
  const l = buf.getChannelData(0), r = buf.getChannelData(1);
  const n = l.length;
  let peak = 0, sum = 0, nan = false, activeSum = 0, activeN = 0, lastLoud = 0;
  const gate = 10 ** (-50 / 20), tailGate = 10 ** (-60 / 20);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = l[i], b = r[i];
    if (Number.isNaN(a) || Number.isNaN(b)) { nan = true; continue; }
    mono[i] = (a + b) * 0.5;
    peak = Math.max(peak, Math.abs(a), Math.abs(b));
    const e = (a * a + b * b) * 0.5;
    sum += e;
    if (Math.abs(a) > gate || Math.abs(b) > gate) { activeSum += e; activeN++; }
    if (Math.abs(a) > tailGate || Math.abs(b) > tailGate) lastLoud = i;
  }
  const db = (x: number) => 10 * Math.log10(Math.max(x, 1e-12));
  const res: RenderResult = {
    name, seconds, peak, rmsDb: db(sum / n), activeRmsDb: db(activeN ? activeSum / activeN : 0), tailSeconds: lastLoud / SAMPLE_RATE, renderMs, nan,
  };
  if (wav) res.wavBase64 = toWavBase64(mono, SAMPLE_RATE);
  return res;
}

function toWavBase64(samples: Float32Array, sr: number): string {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function catalogNames(): { name: string; rmsMin: number }[] {
  return buildCatalog().map((c) => ({ name: c.name, rmsMin: c.rmsMin ?? -75 }));
}

export async function renderOne(name: string, wav = true): Promise<RenderResult> {
  const entry = buildCatalog().find((c) => c.name === name);
  if (!entry) throw new Error(`unknown sound ${name}`);
  const { engine, ctx } = makeEngine(entry.seconds);
  entry.play(engine);
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  return analyse(name, entry.seconds, buf, performance.now() - t0, wav);
}

export interface WorstCaseResult extends RenderResult {
  /** Shots requested, voices refused and voices stolen by the limiter. */
  shots: number;
  dropped: number;
  stolen: number;
  /** Main-thread time spent scheduling, per 60 Hz frame (ms) and the worst slice (ms). */
  scheduleMsPerFrame: number;
  worstSliceMs: number;
  /** Render time / audio duration: below 1 the audio thread keeps up (offline rendering is not realtime, so this is a proxy). */
  realtimeFactor: number;
}

/**
 * An explosion next to the listener and sixteen players firing sub-machine guns (12 shots/s each) from
 * all around, in rain, with music playing. Shots are scheduled in 23 ms slices while the offline clock
 * advances (suspend/resume), like the game loop does, so the voice limiter sees realistic time.
 */
export async function renderWorstCase(seconds = 6, wav = true): Promise<WorstCaseResult> {
  const { engine, ctx } = makeEngine(seconds);
  engine.setListener(0, 65.6, 0, 0);
  const env = engine.env;
  env.x = 0; env.y = 65; env.z = 0; env.enclosure = 0.1; env.skyLight = 15;
  engine.setWeather(1, false);
  engine.setMusicMode('arcade');
  engine.setMusicIntensity(1);
  const players = 16;
  const phase = new Float64Array(players);
  for (let i = 0; i < players; i++) phase[i] = (i * 0.37) % 1;
  const slice = 1024 / SAMPLE_RATE;
  let shots = 0, tickMs = 0, worst = 0;
  const tick = (first: boolean) => {
    const t0 = performance.now();
    engine.update(slice);
    if (first) engine.playExplosion(1, at(4, 3));
    for (let p = 0; p < players; p++) {
      phase[p] += slice * 12;
      if (phase[p] >= 1) {
        phase[p] -= 1;
        const a = (p / players) * Math.PI * 2, r = 6 + (p % 4) * 6;
        engine.playGun('smg', 1, at(Math.cos(a) * r, Math.sin(a) * r));
        shots++;
      }
    }
    const dt = performance.now() - t0;
    tickMs += dt;
    worst = Math.max(worst, dt);
  };
  tick(true);
  const total = Math.floor(seconds / slice);
  const waits: Promise<void>[] = [];
  for (let k = 1; k < total; k++) {
    waits.push(ctx.suspend(k * slice).then(() => { tick(false); void ctx.resume(); }));
  }
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  const renderMs = performance.now() - t0;
  await Promise.all(waits);
  const base = analyse('worst-case', seconds, buf, renderMs, wav);
  const lim = engine.internals.limiter;
  return {
    ...base, shots, dropped: lim.dropped, stolen: lim.stolen,
    scheduleMsPerFrame: tickMs / (seconds * 60), worstSliceMs: worst, realtimeFactor: renderMs / 1000 / seconds,
  };
}

(window as unknown as { __audio: unknown }).__audio = { catalogNames, renderOne, renderWorstCase };
