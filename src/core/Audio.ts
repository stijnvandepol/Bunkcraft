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

  private get ready(): AudioContext | null {
    const ctx = this.ctx;
    return ctx && this.soundVolume > 0 && ctx.state === 'running' ? ctx : null;
  }

  /** Oscillator voice with a pitch glide and an attack/decay envelope. */
  private voice(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0): void {
    const ctx = this.ready;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + Math.min(0.03, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    o.connect(lp).connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Filtered noise burst (hiss, explosion, crunch). */
  private noiseBurst(freq: number, q: number, dur: number, vol: number, type: BiquadFilterType = 'bandpass', delay = 0): void {
    const ctx = this.ready;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = dur > 0.9;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.sfx);
    src.start(t, Math.random() * 0.4);
    src.stop(t + dur + 0.05);
  }

  /** Mob sounds, synthesised per kind; `volume` already includes distance falloff. */
  playMob(kind: string, event: 'idle' | 'hurt' | 'death' | 'fuse', volume: number): void {
    if (volume <= 0.02) return;
    const v = volume * (event === 'idle' ? 0.5 : 0.7);
    const p = 0.9 + Math.random() * 0.2;
    switch (kind) {
      case 'pig':
        this.voice('sawtooth', 210 * p, 150 * p, 0.18, v * 0.5);
        this.voice('sawtooth', 190 * p, 130 * p, 0.16, v * 0.4, 0.2);
        break;
      case 'cow':
        this.voice('sawtooth', 130 * p, 95 * p, 0.9, v * 0.45);
        break;
      case 'sheep':
        for (let i = 0; i < 4; i++) this.voice('sawtooth', 330 * p, 300 * p, 0.12, v * 0.35, i * 0.1);
        break;
      case 'chicken':
        this.voice('square', 900 * p, 700 * p, 0.07, v * 0.25);
        this.voice('square', 1100 * p, 800 * p, 0.06, v * 0.2, 0.09);
        break;
      case 'zombie':
        this.voice('sawtooth', 95 * p, 70 * p, 0.8, v * 0.5);
        this.noiseBurst(300, 1, 0.6, v * 0.25);
        break;
      case 'creeper':
        if (event === 'fuse') this.noiseBurst(3500, 0.6, 1.4, volume * 0.6, 'highpass');
        else this.noiseBurst(2000, 0.8, 0.25, v * 0.4);
        break;
    }
    if (event === 'hurt' || event === 'death') this.voice('triangle', 500 * p, 250 * p, 0.12, v * 0.3);
  }

  playHurt(): void {
    this.voice('square', 220, 120, 0.12, 0.35);
    this.noiseBurst(600, 1, 0.1, 0.3);
  }

  playExplosion(volume: number): void {
    this.noiseBurst(120, 0.5, 1.6, Math.min(1, volume) * 1.2, 'lowpass');
    this.noiseBurst(900, 0.7, 0.5, Math.min(1, volume) * 0.6);
    this.voice('sine', 70, 30, 1.0, Math.min(1, volume) * 0.8);
  }

  playPop(): void {
    this.voice('sine', 900 + Math.random() * 400, 1800, 0.08, 0.25);
  }

  playEat(): void {
    this.noiseBurst(1600, 0.8, 0.09, 0.4);
  }

  playBurp(): void {
    this.voice('sawtooth', 110, 80, 0.3, 0.3);
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
