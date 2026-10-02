import { KIND_SHAPE, profileFor, type BlockSound, type BlockSoundKind } from './profiles';
import { Priority, VoiceLimiter } from './voiceLimiter';

/** Minimum level worth a voice: below this the sound is inaudible next to everything else. */
const MIN_VOLUME = 0.004;

export interface NoiseOpts {
  /** Playback rate of the noise buffer (shifts the spectrum a little, adds variation). */
  rate?: number;
  /** Attack in seconds. */
  attack?: number;
  /** Split the burst into this many grains (crunch of gravel, sand, snow). */
  grains?: number;
}

export interface ToneOpts {
  attack?: number;
  /** Low-pass cut-off; 0 = none. Default 2400 (the classic soft voice). */
  lp?: number;
  /** Cap on the voice's priority score contribution. */
  curve?: 'exp' | 'linear';
}

/**
 * Low-level voice factory over a (real or offline) AudioContext: oscillator tones and filtered noise bursts
 * routed to `out`, each one counted against the global voice limit. Everything the engine plays is made of
 * these two primitives, so the voice limit and the priority rules cover all sounds.
 */
export class Synth {
  /** Destination of voices created from now on (the engine swaps it for positional sounds). */
  out: AudioNode;
  /** Priority of voices created from now on. */
  priority: number = Priority.Normal;

  constructor(readonly ctx: BaseAudioContext, out: AudioNode, readonly noise: AudioBuffer, readonly limiter: VoiceLimiter) {
    this.out = out;
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /** Oscillator with a pitch glide f0 -> f1 and an attack/exponential decay envelope. */
  tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0, opts: ToneOpts = {}): void {
    if (vol < MIN_VOLUME) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const stop = () => stopVoice(ctx, g, o);
    if (!this.limiter.request(ctx.currentTime, this.priority, vol, t + dur + 0.05, stop)) return;
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const attack = opts.attack ?? Math.min(0.03, dur / 4);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const lpFreq = opts.lp ?? 2400;
    if (lpFreq > 0) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = lpFreq;
      o.connect(lp).connect(g).connect(this.out);
    } else {
      o.connect(g).connect(this.out);
    }
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Filtered noise burst (hiss, explosion, crunch). `grains` > 1 makes several quick bumps. */
  noiseBurst(freq: number, q: number, dur: number, vol: number, type: BiquadFilterType = 'bandpass', delay = 0, opts: NoiseOpts = {}): void {
    if (vol < MIN_VOLUME) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    const stop = () => stopVoice(ctx, g, src);
    if (!this.limiter.request(ctx.currentTime, this.priority, vol, t + dur + 0.05, stop)) return;
    src.buffer = this.noise;
    src.loop = dur > 0.9;
    src.playbackRate.value = opts.rate ?? 1;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const grains = opts.grains ?? 1;
    const attack = opts.attack ?? 0.004;
    g.gain.setValueAtTime(0, t);
    if (grains <= 1) {
      g.gain.linearRampToValueAtTime(vol, t + Math.min(attack, dur / 3));
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    } else {
      // Grains: quick bumps with a falling level, irregular spacing.
      const slot = dur / grains;
      for (let i = 0; i < grains; i++) {
        const gt = t + i * slot * (0.85 + Math.random() * 0.3);
        const level = vol * (1 - (i / grains) * 0.55) * (0.7 + Math.random() * 0.3);
        g.gain.linearRampToValueAtTime(0, gt);
        g.gain.linearRampToValueAtTime(level, gt + 0.003);
        g.gain.exponentialRampToValueAtTime(Math.max(0.001, level * 0.08), gt + slot * 0.8);
      }
      g.gain.linearRampToValueAtTime(0, t + dur);
    }
    src.connect(f).connect(g).connect(this.out);
    src.start(t, Math.random() * (this.noise.duration - dur - 0.1 > 0 ? this.noise.duration - dur - 0.1 : 0.2));
    src.stop(t + dur + 0.05);
  }

  // ---------------------------------------------------------------- block sounds

  /**
   * One block sound, layered: grainy filtered noise (the material), a resonant band-pass layer (the body),
   * a gliding sine thump (the weight) and short tonal partials (glass tink, metal ring).
   * `pitch` varies per call (see AudioEngine) so no two hits are identical.
   */
  block(kind: BlockSoundKind, sound: BlockSound | string, volume = 1, pitch = 1): void {
    const prof = profileFor(sound);
    const shape = KIND_SHAPE[kind];
    const dur = shape.dur * (prof.length ?? 1);
    const vol = shape.vol * prof.gain * volume * (kind === 'step' ? prof.stepGain ?? 1 : 1);
    const stepShift = kind === 'step' ? 0.85 : 1;
    const grains = prof.grains ? Math.max(1, Math.round(prof.grains * shape.grainShare)) : 1;
    this.noiseBurst(prof.noise.freq * stepShift * pitch, prof.noise.q, dur, vol * prof.noise.gain, prof.noise.type, 0, { rate: pitch, grains });
    if (prof.body) {
      const comp = 1 + Math.min(prof.body.q, 14) * 0.25; // narrow band-pass removes energy: make it up
      this.noiseBurst(prof.body.freq * pitch, prof.body.q, dur * 0.85, vol * prof.body.gain * comp * 0.55, 'bandpass', 0.001, { rate: pitch });
    }
    if (prof.thump && shape.thump) this.tone('sine', prof.thump * pitch, prof.thump * 0.5 * pitch, dur * 0.8, vol * 0.5, 0, { lp: 0 });
    if (prof.tone) {
      const scale = kind === 'break' ? 1 : kind === 'place' ? 0.5 : kind === 'step' ? 0.3 : 0.4;
      const n = Math.min(prof.tone.freqs.length, kind === 'break' ? 4 : 2);
      for (let i = 0; i < n; i++) {
        const delay = (prof.tone.scatter ?? 0) * Math.random() * (i + 1);
        this.tone(prof.tone.wave, prof.tone.freqs[i] * pitch * (0.97 + Math.random() * 0.06), prof.tone.freqs[i] * pitch, prof.tone.decay * (kind === 'break' ? 1 : 0.6), vol * prof.tone.gain * scale, delay, { lp: 0, attack: 0.002 });
      }
    }
  }

  /** Landing on a surface: the step sound scaled up plus a body thud for heavy falls. */
  landing(surface: BlockSound | string, volume: number, heavy: 'soft' | 'medium' | 'heavy'): void {
    this.block('place', surface, Math.min(1.3, volume), 0.9);
    if (heavy !== 'soft') {
      this.tone('sine', 85, 40, 0.18, volume * 0.55, 0, { lp: 0 });
      this.noiseBurst(220, 0.6, 0.16, volume * 0.5, 'lowpass');
    }
    if (heavy === 'heavy') this.noiseBurst(500, 0.8, 0.22, volume * 0.35, 'lowpass', 0.03);
  }

  /** Falling into water: a splash with a few bubbles. */
  splash(volume: number): void {
    const v = Math.min(1, volume);
    this.noiseBurst(2600, 0.5, 0.45, v * 0.55, 'bandpass', 0, { attack: 0.01 });
    this.noiseBurst(600, 0.7, 0.5, v * 0.7, 'lowpass', 0, { attack: 0.008 });
    this.noiseBurst(1400, 1, 0.3, v * 0.3, 'bandpass', 0.05, { grains: 4 });
    for (let i = 0; i < 3; i++) {
      const f = 260 + Math.random() * 300;
      this.tone('sine', f, f * 2.2, 0.07, v * 0.18, 0.05 + i * 0.07 + Math.random() * 0.04, { lp: 0 });
    }
  }

  /** One swimming stroke. */
  swim(volume = 1): void {
    this.noiseBurst(1000 + Math.random() * 400, 0.7, 0.22, 0.25 * volume, 'bandpass', 0, { attack: 0.05 });
    this.noiseBurst(400, 0.8, 0.25, 0.2 * volume, 'lowpass', 0.02, { attack: 0.06 });
  }

  /** A quick cloth whoosh (jump, swing). */
  whoosh(volume = 1): void {
    this.noiseBurst(700 + Math.random() * 200, 0.5, 0.1, 0.12 * volume, 'bandpass', 0, { attack: 0.03 });
  }

  /** Armour piece clinking against another (placeholder until armour exists). */
  clink(material: 'leather' | 'chain' | 'iron' | 'gold' | 'diamond', volume = 1): void {
    if (material === 'leather') {
      this.noiseBurst(1100, 0.8, 0.07, 0.12 * volume, 'bandpass');
      return;
    }
    const base = material === 'chain' ? 2600 : material === 'iron' ? 1900 : material === 'gold' ? 2200 : 3100;
    const p = 0.95 + Math.random() * 0.1;
    this.tone('sine', base * p, base * p, 0.12, 0.09 * volume, 0, { lp: 0, attack: 0.001 });
    this.tone('sine', base * 2.7 * p, base * 2.7 * p, 0.08, 0.05 * volume, 0.004, { lp: 0, attack: 0.001 });
    this.noiseBurst(base * 1.4, 1.5, 0.04, 0.07 * volume, 'bandpass');
  }

  // ---------------------------------------------------------------- UI

  ui(name: UiSoundName): void {
    switch (name) {
      case 'click':
        this.tone('square', 880, 560, 0.04, 0.12, 0, { lp: 3200, attack: 0.001 });
        this.noiseBurst(2400, 1.2, 0.025, 0.1, 'bandpass');
        break;
      case 'hover':
        this.tone('sine', 1500, 1500, 0.03, 0.04, 0, { lp: 0, attack: 0.002 });
        break;
      case 'back':
        this.tone('square', 600, 380, 0.05, 0.11, 0, { lp: 2600, attack: 0.001 });
        break;
      case 'inventoryMove':
        this.noiseBurst(1700, 1.1, 0.05, 0.22, 'bandpass');
        this.tone('sine', 520, 400, 0.05, 0.09, 0, { lp: 0 });
        break;
      case 'equip':
        this.noiseBurst(2200, 1.4, 0.07, 0.18, 'bandpass');
        this.tone('triangle', 900, 1250, 0.09, 0.1, 0.02, { lp: 0 });
        this.tone('triangle', 1350, 1350, 0.12, 0.08, 0.06, { lp: 0 });
        break;
      case 'craft':
        this.tone('sine', 700, 700, 0.08, 0.12, 0, { lp: 0 });
        this.tone('sine', 1050, 1050, 0.14, 0.12, 0.06, { lp: 0 });
        break;
      case 'chat':
        this.tone('sine', 1180, 1180, 0.07, 0.13, 0, { lp: 0, attack: 0.002 });
        this.tone('sine', 1560, 1560, 0.09, 0.11, 0.07, { lp: 0, attack: 0.002 });
        break;
      case 'error':
        this.tone('square', 180, 140, 0.12, 0.12, 0, { lp: 900 });
        this.tone('square', 150, 110, 0.14, 0.12, 0.1, { lp: 900 });
        break;
      case 'advancement':
        this.tone('sine', 659, 659, 0.3, 0.22);
        this.tone('sine', 880, 880, 0.3, 0.22, 0.12);
        this.tone('sine', 1319, 1319, 0.5, 0.2, 0.24);
        this.tone('triangle', 2637, 2637, 0.35, 0.05, 0.24, { lp: 0 });
        break;
    }
  }
}

export type UiSoundName = 'click' | 'hover' | 'back' | 'inventoryMove' | 'equip' | 'craft' | 'chat' | 'error' | 'advancement';

export const UI_SOUND_NAMES: readonly UiSoundName[] = ['click', 'hover', 'back', 'inventoryMove', 'equip', 'craft', 'chat', 'error', 'advancement'];

function stopVoice(ctx: BaseAudioContext, g: GainNode, src: AudioScheduledSourceNode): void {
  try {
    const t = ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setTargetAtTime(0, t, 0.004);
    src.stop(t + 0.03);
  } catch {
    // Already stopped (or never started): nothing to do.
  }
}
