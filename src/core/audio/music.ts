import { BIOME } from '../../world/Biomes';
import { glide } from './glide';
import {
  PULSE_STEP, chooseMood, generatePhrase, midiToHz, nextGap, pulseAt, type Mood, type MusicMode, type PhraseNote, type PulseEvent,
} from './musicTheory';

/**
 * Generative score: sparse piano phrases with long silences (C418-like) over a long dark reverb, picked per
 * mode (menu / game / arcade), biome, time of day and depth. In arcade matches a quiet driving pulse (kick,
 * bass, hats) underlies the match while it is `live`. Everything is synthesised; no samples.
 */
export class MusicDirector {
  /** Entry node: connect a gain here (music category volume). */
  readonly input: GainNode;
  private readonly muffle: BiquadFilterNode;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private mode: MusicMode = 'menu';
  private nextPhraseAt = 2;
  private clock = 0;
  private biome: number = BIOME.PLAINS;
  private dayFactor = 1;
  private cave = 0;
  private underwater = false;
  private intensity = 0;
  private intensityTarget = 0;
  private pulseStep = 0;
  private pulseTime = 0;
  private readonly pulseEvents: PulseEvent[] = [];
  /** Silence between phrases is what makes the music feel calm; remember what we last played. */
  lastMood: Mood | null = null;
  phrasesPlayed = 0;

  constructor(private readonly ctx: BaseAudioContext, dest: AudioNode, private readonly noise: AudioBuffer, reverbSeconds = 4.6) {
    this.input = ctx.createGain();
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.62;
    const reverb = ctx.createConvolver();
    reverb.buffer = darkImpulse(ctx, reverbSeconds, 2.4);
    this.input.connect(this.muffle);
    this.muffle.connect(this.dry).connect(dest);
    this.muffle.connect(reverb).connect(this.wet).connect(dest);
  }

  setMode(mode: MusicMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // A new mode starts soon (a menu should not be silent for a minute) but never abruptly.
    this.nextPhraseAt = this.clock + (mode === 'menu' ? 1.5 : mode === 'arcade' ? 3 : 6 + Math.random() * 8);
    this.pulseTime = 0;
  }

  getMode(): MusicMode {
    return this.mode;
  }

  /** Context from the world: biome, daylight, cave factor (0..1), underwater. */
  setContext(biome: number, dayFactor: number, cave: number, underwater: boolean): void {
    this.biome = biome;
    this.dayFactor = dayFactor;
    this.cave = cave;
    this.underwater = underwater;
  }

  /** 0..1: strength of the arcade pulse (the match is live). */
  setIntensity(v: number): void {
    this.intensityTarget = Math.min(1, Math.max(0, v));
  }

  update(dt: number, running: boolean): void {
    if (!running) return;
    const ctx = this.ctx;
    this.clock += dt;

    // Depth and water darken the music instead of cutting it.
    const cutoff = this.underwater ? 450 : 20000 * (1 - this.cave * 0.9) + 1400 * this.cave;
    glide(this.muffle.frequency, Math.max(300, cutoff), ctx.currentTime, 0.6, 20);

    this.intensity += (this.intensityTarget - this.intensity) * Math.min(1, dt * 0.8);
    if (this.mode === 'off') return;

    if (this.clock >= this.nextPhraseAt) {
      const mood = chooseMood(this.mode, this.biome, this.dayFactor, this.cave);
      this.nextPhraseAt = this.clock + nextGap(Math.random, mood);
      this.playPhrase(ctx.currentTime + 0.1, mood);
    }

    if (this.mode === 'arcade' && this.intensity > 0.02) this.schedulePulse(ctx.currentTime + 0.25);
    else this.pulseTime = 0;
  }

  /** Play one phrase starting at `at` (AudioContext time). */
  playPhrase(at: number, mood: Mood = chooseMood(this.mode === 'off' ? 'game' : this.mode, this.biome, this.dayFactor, this.cave)): PhraseNote[] {
    const notes = generatePhrase(Math.random, mood);
    for (const n of notes) this.piano(midiToHz(n.midi), at + n.at, n.len, n.vel);
    // A quiet pad under some phrases: gives the piano a floor to ring on.
    if (Math.random() < 0.4 && notes.length > 0) this.pad(midiToHz(mood.root), at, mood);
    this.lastMood = mood;
    this.phrasesPlayed++;
    return notes;
  }

  /** Schedule pulse steps up to `until`. Public so offline renders can lay out a few bars. */
  schedulePulse(until: number): void {
    if (this.pulseTime === 0) {
      this.pulseTime = this.ctx.currentTime + 0.05;
      this.pulseStep = 0;
    }
    while (this.pulseTime < until) {
      pulseAt(this.pulseStep, this.intensity, this.pulseEvents);
      for (const e of this.pulseEvents) this.pulseHit(e, this.pulseTime);
      this.pulseStep++;
      this.pulseTime += PULSE_STEP;
    }
  }

  /** Soft piano: slightly inharmonic partials with their own decays, a hammer tick and velocity-dependent brightness. */
  piano(freq: number, at: number, len: number, vel: number): void {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, at);
    out.gain.linearRampToValueAtTime(vel, at + 0.012);
    out.gain.exponentialRampToValueAtTime(vel * 0.4, at + 0.5);
    out.gain.exponentialRampToValueAtTime(0.0008, at + len);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(9000, 1200 + vel * 5000 + freq * 2);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-0.6, Math.min(0.6, (Math.log2(freq / 261) * 0.25)));
    out.connect(lp).connect(pan).connect(this.input);
    const B = 0.0003;
    for (const [k, amp, decay] of [[1, 1, 1], [2, 0.3, 0.55], [3, 0.12, 0.35], [4, 0.05, 0.22], [5, 0.025, 0.15]] as const) {
      const f = freq * k * Math.sqrt(1 + B * k * k);
      if (f > 9000) break;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(amp, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + len * decay);
      o.connect(g).connect(out);
      o.start(at);
      o.stop(at + len * decay + 0.05);
    }
    // Hammer: a very short filtered noise tick.
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = Math.min(6000, freq * 4);
    nf.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(vel * 0.18, at);
    ng.gain.exponentialRampToValueAtTime(0.001, at + 0.03);
    n.connect(nf).connect(ng).connect(out);
    n.start(at, Math.random());
    n.stop(at + 0.05);
  }

  private pad(freq: number, at: number, mood: Mood): void {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const len = 9;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(mood.vel * 0.13, at + 3);
    g.gain.linearRampToValueAtTime(0, at + len);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    g.connect(lp).connect(this.input);
    for (const m of [1, 1.5, 2.002]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * m;
      o.detune.value = (Math.random() - 0.5) * 12;
      o.connect(g);
      o.start(at);
      o.stop(at + len + 0.1);
    }
  }

  private pulseHit(e: PulseEvent, at: number): void {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.connect(this.input);
    if (e.kind === 'kick') {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(120, at);
      o.frequency.exponentialRampToValueAtTime(42, at + 0.14);
      g.gain.setValueAtTime(0.5 * e.vel, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.22);
      o.connect(g);
      o.start(at);
      o.stop(at + 0.25);
    } else if (e.kind === 'bass') {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = midiToHz(e.midi ?? 33);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 380;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.3 * e.vel, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, at + PULSE_STEP * 1.8);
      o.connect(lp).connect(g);
      o.start(at);
      o.stop(at + PULSE_STEP * 2);
    } else {
      const n = ctx.createBufferSource();
      n.buffer = this.noise;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 7000;
      g.gain.setValueAtTime(0.07 * e.vel, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.04);
      n.connect(hp).connect(g);
      n.start(at, Math.random());
      n.stop(at + 0.06);
    }
  }
}

/** Reverb impulse: decorrelated stereo noise whose highs fade faster than its lows (a dark, long hall). */
export function darkImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const pre = Math.floor(ctx.sampleRate * 0.02);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let y = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / (len - pre);
      const a = 0.55 * (1 - t) ** 1.5 + 0.04; // one-pole low-pass that closes over time
      y += a * ((Math.random() * 2 - 1) - y);
      d[i] = y * (1 - t) ** decay * 1.6;
    }
  }
  return buf;
}
