/**
 * The mix graph.
 *
 *   sfx ─┐                             ┌─ caveSend ─ convolver ─ caveWet ─┐
 *        ├─ world ─ duck ─ waterLP ────┤                                   ├─ master ─ compressor ─ softClip ─ out
 * ambient┘                             └──────────────────────────────────┤
 *   ui ─────────────────────────────────────────────────────────────────── ┤
 *   music ─ musicDuck ──────────────────────────────────────────────────── ┘
 *
 * Category gains (sound / ambient / ui / music) sit in front of the master bus, which ends in a compressor
 * and a soft clipper, so explosions plus sixteen players firing cannot clip the output. `duck` and `musicDuck`
 * dip the world and the music for a moment when a sound that matters plays (hit confirm, kill, low health).
 */
export interface Mix {
  sfx: GainNode;
  ambient: GainNode;
  ui: GainNode;
  music: GainNode;
  /** Low-pass over world sounds (sfx + ambient): closes under water. */
  waterLP: BiquadFilterNode;
  /** Short reverb for sfx in caves. */
  caveWet: GainNode;
  master: GainNode;
  compressor: DynamicsCompressorNode;
  /** Ducking stages: world sounds and music dip under important UI cues (see AudioEngine.duck). */
  duck: GainNode;
  musicDuck: GainNode;
}

/** Transparent below 0.7, then a smooth knee that never exceeds ~0.92. */
export function softClipCurve(n = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    curve[i] = Math.sign(x) * (a < 0.7 ? a : 0.7 + 0.28 * Math.tanh((a - 0.7) / 0.28));
  }
  return curve;
}

export function buildMix(ctx: BaseAudioContext): Mix {
  const master = ctx.createGain();
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -16;
  compressor.knee.value = 10;
  compressor.ratio.value = 6;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.2;
  const clip = ctx.createWaveShaper();
  clip.curve = softClipCurve();
  master.connect(compressor).connect(clip).connect(ctx.destination);

  const sfx = ctx.createGain();
  const ambient = ctx.createGain();
  const ui = ctx.createGain();
  const music = ctx.createGain();
  const world = ctx.createGain();
  const waterLP = ctx.createBiquadFilter();
  waterLP.type = 'lowpass';
  waterLP.frequency.value = 20000;
  const duck = ctx.createGain();
  const musicDuck = ctx.createGain();
  sfx.connect(world);
  ambient.connect(world);
  world.connect(duck).connect(waterLP).connect(master);
  ui.connect(master);
  music.connect(musicDuck).connect(master);

  // Cave reverb: sfx and ambience bleed into a short dark room.
  const caveSend = ctx.createGain();
  caveSend.gain.value = 0.5;
  const conv = ctx.createConvolver();
  conv.buffer = roomImpulse(ctx, 1.4);
  const caveWet = ctx.createGain();
  caveWet.gain.value = 0;
  waterLP.connect(caveSend).connect(conv).connect(caveWet).connect(master);

  return { sfx, ambient, ui, music, waterLP, caveWet, master, compressor, duck, musicDuck };
}

/** Short decaying stereo noise: a small stone room. */
function roomImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let y = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      y += (0.35 * (1 - t) + 0.05) * ((Math.random() * 2 - 1) - y);
      d[i] = y * (1 - t) ** 2.2 * 1.4;
    }
  }
  return buf;
}

/** Noise sources: white for bursts, pink and brown (smooth, loopable) for the ambience beds. */
export function makeNoiseBuffers(ctx: BaseAudioContext): { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer } {
  const sr = ctx.sampleRate;
  const white = ctx.createBuffer(1, sr * 2, sr);
  const w = white.getChannelData(0);
  for (let i = 0; i < w.length; i++) w[i] = Math.random() * 2 - 1;

  const len = sr * 4;
  const fade = Math.floor(sr * 0.15);
  const pinkRaw = new Float32Array(len + fade);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < pinkRaw.length; i++) {
    const x = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + x * 0.0555179;
    b1 = 0.99332 * b1 + x * 0.0750759;
    b2 = 0.969 * b2 + x * 0.153852;
    b3 = 0.8665 * b3 + x * 0.3104856;
    b4 = 0.55 * b4 + x * 0.5329522;
    b5 = -0.7616 * b5 - x * 0.016898;
    pinkRaw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.11;
    b6 = x * 0.115926;
  }
  const brownRaw = new Float32Array(len + fade);
  let last = 0;
  for (let i = 0; i < brownRaw.length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    brownRaw[i] = last * 3.5;
  }
  const pink = ctx.createBuffer(1, len, sr);
  const brown = ctx.createBuffer(1, len, sr);
  loopable(pinkRaw, pink.getChannelData(0), fade);
  loopable(brownRaw, brown.getChannelData(0), fade);
  return { white, pink, brown };
}

/**
 * Copy `raw` (length n + fade) into `out` (length n) so that it loops without a click: the first `fade`
 * samples are a cross-fade into the tail that would have followed the end.
 */
function loopable(raw: Float32Array, out: Float32Array, fade: number): void {
  const n = out.length;
  for (let i = 0; i < n; i++) out[i] = raw[i];
  for (let i = 0; i < fade; i++) {
    const a = i / fade; // 0 = continue the tail, 1 = the real start
    out[i] = raw[i] * a + raw[n + i] * (1 - a);
  }
}
