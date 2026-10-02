import type { BlockSound } from '../world/BlockRegistry';

interface SoundProfile {
  type: BiquadFilterType;
  freq: number;
  q: number;
  gain: number;
  thump?: number;
  tink?: boolean;
}

const PROFILES: Record<BlockSound, SoundProfile> = {
  stone: { type: 'bandpass', freq: 1100, q: 0.9, gain: 0.9, thump: 110 },
  wood: { type: 'bandpass', freq: 520, q: 2.2, gain: 1.0, thump: 170 },
  grass: { type: 'bandpass', freq: 2600, q: 0.6, gain: 0.7 },
  gravel: { type: 'bandpass', freq: 1400, q: 0.7, gain: 0.85 },
  sand: { type: 'highpass', freq: 2200, q: 0.4, gain: 0.55 },
  glass: { type: 'highpass', freq: 3200, q: 0.6, gain: 0.6, tink: true },
  wool: { type: 'lowpass', freq: 700, q: 0.5, gain: 0.8 },
  snow: { type: 'bandpass', freq: 1900, q: 0.5, gain: 0.6 },
};

// Pentatonic scale over two octaves for the ambient music.
const SCALE = [196.0, 220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];

/**
 * Fully procedural audio (no audio assets): filtered noise bursts for block sounds
 * and a sparse generative "piano" with a synthetic reverb for music.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private sfx!: GainNode;
  private music!: GainNode;
  private reverb!: ConvolverNode;
  private noise!: AudioBuffer;
  private nextPhrase = 4;
  private time = 0;
  private soundVolume = 0.8;
  private musicVolume = 0.5;

  /** Must be called from a user gesture (browser autoplay policy). */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.sfx = ctx.createGain();
    this.music = ctx.createGain();
    this.sfx.connect(ctx.destination);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(3.2, 2.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    this.music.connect(this.reverb).connect(wet).connect(ctx.destination);
    this.music.connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.applyVolumes();
  }

  setVolumes(sound: number, music: number): void {
    this.soundVolume = sound / 100;
    this.musicVolume = music / 100;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    this.sfx.gain.value = this.soundVolume * 0.5;
    this.music.gain.value = this.musicVolume * 0.16;
  }

  private impulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  play(kind: 'break' | 'place' | 'step' | 'hit', sound: BlockSound): void {
    const ctx = this.ctx;
    if (!ctx || this.soundVolume <= 0 || ctx.state !== 'running') return;
    const p = PROFILES[sound];
    const now = ctx.currentTime;
    const dur = kind === 'break' ? 0.22 : kind === 'place' ? 0.12 : kind === 'step' ? 0.09 : 0.06;
    const vol = (kind === 'step' ? 0.35 : kind === 'hit' ? 0.3 : 0.9) * p.gain;

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.75 + Math.random() * 0.5;
    const filter = ctx.createBiquadFilter();
    filter.type = p.type;
    filter.frequency.value = p.freq * (kind === 'step' ? 0.8 : 1) * (0.9 + Math.random() * 0.2);
    filter.Q.value = p.q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vol, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(filter).connect(g).connect(this.sfx);
    src.start(now, Math.random() * 0.5);
    src.stop(now + dur + 0.02);

    if (p.thump && kind !== 'hit') {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(p.thump * (0.9 + Math.random() * 0.2), now);
      o.frequency.exponentialRampToValueAtTime(p.thump * 0.5, now + dur);
      const og = ctx.createGain();
      og.gain.setValueAtTime(vol * 0.5, now);
      og.gain.exponentialRampToValueAtTime(0.001, now + dur * 0.8);
      o.connect(og).connect(this.sfx);
      o.start(now);
      o.stop(now + dur);
    }
    if (p.tink && kind === 'break') {
      for (let i = 0; i < 4; i++) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        const t = now + i * 0.035 + Math.random() * 0.02;
        o.frequency.value = 2200 + Math.random() * 2200;
        const og = ctx.createGain();
        og.gain.setValueAtTime(0.25, t);
        og.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        o.connect(og).connect(this.sfx);
        o.start(t);
        o.stop(t + 0.16);
      }
    }
  }

  private note(freq: number, at: number, length: number, velocity: number): void {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(velocity, at + 0.015);
    g.gain.exponentialRampToValueAtTime(velocity * 0.35, at + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0008, at + length);
    g.connect(this.music);
    for (const [mult, type, amp] of [[1, 'sine', 1], [2, 'sine', 0.22], [3, 'triangle', 0.06]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq * mult;
      o.detune.value = (Math.random() - 0.5) * 6;
      const og = ctx.createGain();
      og.gain.value = amp;
      o.connect(og).connect(g);
      o.start(at);
      o.stop(at + length + 0.05);
    }
  }

  /** Schedules sparse musical phrases with long silences in between. */
  update(dt: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    this.time += dt;
    if (this.time < this.nextPhrase) return;
    this.nextPhrase = this.time + 25 + Math.random() * 45;
    if (this.musicVolume <= 0) return;
    let t = ctx.currentTime + 0.1;
    let idx = 2 + Math.floor(Math.random() * 5);
    const count = 5 + Math.floor(Math.random() * 6);
    this.note(SCALE[idx % 3] / 2, t, 6, 0.35);
    for (let i = 0; i < count; i++) {
      idx = Math.max(0, Math.min(SCALE.length - 1, idx + Math.floor(Math.random() * 5) - 2));
      this.note(SCALE[idx], t, 3.5, 0.28 + Math.random() * 0.12);
      if (Math.random() < 0.25) this.note(SCALE[Math.max(0, idx - 2)], t, 3.5, 0.18);
      t += 0.55 + Math.floor(Math.random() * 3) * 0.35;
    }
  }
}
