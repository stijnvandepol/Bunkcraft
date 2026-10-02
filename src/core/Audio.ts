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

  /** Pause all audio while the tab is hidden (scheduled music would keep playing). */
  setSuspended(suspended: boolean): void {
    if (!this.ctx) return;
    if (suspended && this.ctx.state === 'running') void this.ctx.suspend();
    else if (!suspended && this.ctx.state === 'suspended') void this.ctx.resume();
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
        if (event === 'hurt') {
          this.voice('sawtooth', 130 * p, 85 * p, 0.28, v * 0.5);
          this.noiseBurst(400, 1, 0.2, v * 0.25);
        } else if (event === 'death') {
          this.voice('sawtooth', 110 * p, 45 * p, 1.1, v * 0.55);
          this.noiseBurst(250, 1, 0.9, v * 0.3);
        } else {
          // Idle groan: a slow wobbling growl.
          this.voice('sawtooth', 95 * p, 70 * p, 0.8, v * 0.5);
          this.voice('sawtooth', 100 * p, 62 * p, 0.7, v * 0.25, 0.1);
          this.noiseBurst(300, 1, 0.6, v * 0.25);
        }
        break;
      case 'skeleton': {
        // Rattling bones: a few dry clicks, more of them and louder on death.
        const clicks = event === 'death' ? 7 : event === 'hurt' ? 3 : 2;
        for (let i = 0; i < clicks; i++) {
          this.noiseBurst((1700 + Math.random() * 1800) * p, 3, 0.04 + Math.random() * 0.03, v * 0.55, 'bandpass', i * (0.045 + Math.random() * 0.03));
        }
        this.voice('triangle', 700 * p, 400 * p, 0.08, v * 0.15);
        break;
      }
      case 'spider':
        // Hiss: bright filtered noise, short and sharp when hurt.
        this.noiseBurst(5500 * p, 0.7, event === 'idle' ? 0.45 : 0.3, v * 0.45, 'highpass');
        if (event !== 'idle') this.voice('square', 1100 * p, 600 * p, 0.1, v * 0.15);
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

  /** Bow release: a short twang. */
  playBow(power: number): void {
    this.voice('triangle', 520 + power * 200, 180, 0.18, 0.35);
    this.noiseBurst(1800, 0.9, 0.12, 0.25);
  }

  /** Arrow thunk into a block or mob. */
  playArrowHit(volume: number): void {
    if (volume <= 0) return;
    this.noiseBurst(700, 1.4, 0.07, Math.min(1, volume) * 0.45);
  }

  /** Flint and steel strike, then the TNT fuse hiss. */
  playIgnite(volume: number): void {
    this.noiseBurst(2600, 1.2, 0.08, Math.min(1, volume) * 0.5);
    this.noiseBurst(3500, 0.6, 1.4, Math.min(1, volume) * 0.5, 'highpass', 0.05);
  }

  /** Advancement toast: a short rising chime. */
  playAdvancement(): void {
    this.voice('sine', 659, 659, 0.3, 0.22);
    this.voice('sine', 880, 880, 0.3, 0.22, 0.12);
    this.voice('sine', 1319, 1319, 0.5, 0.2, 0.24);
  }

  /** A door swinging open (creak) or shut (thud); `volume` 0..1. */
  playDoor(open: boolean, volume = 1): void {
    if (!this.ready) return;
    if (open) {
      this.voice('triangle', 150, 210, 0.1, 0.1 * volume);
      this.noiseBurst(520, 1.2, 0.12, 0.28 * volume);
    } else {
      this.noiseBurst(230, 1, 0.1, 0.55 * volume, 'lowpass');
      this.voice('sine', 95, 60, 0.1, 0.3 * volume);
    }
  }

  /** Lava meeting water: a short hiss. */
  playFizz(volume: number): void {
    if (volume <= 0.02) return;
    this.noiseBurst(4200, 0.5, 0.5, 0.35 * volume, 'highpass');
    this.noiseBurst(1200, 0.8, 0.25, 0.2 * volume);
  }

  /** A bucket filled from or emptied into a liquid. */
  playBucket(lava: boolean): void {
    this.noiseBurst(lava ? 500 : 1400, 0.7, 0.3, 0.4, 'bandpass');
    this.voice('sine', lava ? 140 : 260, lava ? 90 : 150, 0.2, 0.15);
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

  // ---------------------------------------------------------------- arcade weapons

  /**
   * Gunshot per weapon; `volume` 0..1 already includes the distance falloff for other players'
   * shots (see {@link gunVolume}). Each weapon gets its own mix of crack, body and thump.
   */
  playGun(weapon: string, volume: number): void {
    if (volume <= 0.02) return;
    const v = Math.min(1, volume);
    const p = 0.95 + Math.random() * 0.1;
    switch (weapon) {
      case 'rifle':
        this.noiseBurst(2200 * p, 0.7, 0.09, v * 0.7);
        this.noiseBurst(500, 0.6, 0.12, v * 0.5, 'lowpass');
        this.voice('sine', 150 * p, 55, 0.1, v * 0.6);
        break;
      case 'smg':
        this.noiseBurst(3000 * p, 0.8, 0.05, v * 0.55);
        this.voice('square', 260 * p, 110, 0.05, v * 0.25);
        this.voice('sine', 170, 70, 0.06, v * 0.4);
        break;
      case 'shotgun':
        this.noiseBurst(1400, 0.5, 0.2, v * 0.9);
        this.noiseBurst(300, 0.5, 0.35, v * 0.8, 'lowpass');
        this.voice('sine', 100 * p, 38, 0.3, v * 0.9);
        // Pump action a moment later.
        this.noiseBurst(1200, 2, 0.03, v * 0.3, 'bandpass', 0.38);
        this.noiseBurst(900, 2, 0.04, v * 0.3, 'bandpass', 0.5);
        break;
      case 'sniper':
        this.noiseBurst(3400, 0.5, 0.12, v * 1.0, 'highpass');
        this.noiseBurst(350, 0.4, 0.55, v * 0.9, 'lowpass');
        this.voice('sine', 80, 28, 0.45, v * 1.0);
        this.noiseBurst(600, 0.5, 0.4, v * 0.25, 'lowpass', 0.12);
        break;
      case 'pistol':
        this.noiseBurst(2600 * p, 0.8, 0.06, v * 0.6);
        this.voice('triangle', 320 * p, 120, 0.07, v * 0.45);
        this.voice('sine', 130, 60, 0.07, v * 0.35);
        break;
      case 'knife':
        this.noiseBurst(2800, 0.6, 0.11, v * 0.35, 'highpass');
        this.noiseBurst(1400, 0.8, 0.12, v * 0.25, 'bandpass', 0.03);
        break;
      default:
        this.noiseBurst(2000, 0.7, 0.08, v * 0.5);
    }
  }

  /** Reload: magazine out, magazine in, bolt (or pump for the shotgun) as three clicks. */
  playReload(reloadSec: number): void {
    const click = (f: number, delay: number, vol: number) => {
      this.voice('square', f, f * 0.45, 0.025, vol, delay);
      this.noiseBurst(f * 1.5, 1.5, 0.03, vol * 0.8, 'bandpass', delay);
    };
    click(1100, 0.05, 0.22);
    click(800, Math.max(0.1, reloadSec * 0.55), 0.26);
    click(1400, Math.max(0.2, reloadSec - 0.15), 0.22);
  }

  /** Trigger on an empty magazine. */
  playEmpty(): void {
    this.voice('square', 900, 400, 0.03, 0.2);
  }

  /** White tick when your bullet hits a player; higher and doubled for a headshot. */
  playHitMarker(head: boolean): void {
    this.voice('sine', head ? 2400 : 1700, head ? 2400 : 1700, 0.05, 0.35);
    if (head) this.voice('sine', 3200, 3200, 0.06, 0.28, 0.045);
  }

  /** Kill confirmation: a bright two-note ding. */
  playKillDing(): void {
    this.voice('sine', 1318, 1318, 0.28, 0.32);
    this.voice('sine', 1760, 1760, 0.32, 0.3, 0.08);
    this.voice('triangle', 2637, 2637, 0.2, 0.12, 0.08);
  }

  /** Little whoosh when you respawn. */
  playSpawn(): void {
    this.voice('sine', 300, 900, 0.25, 0.18);
  }

  /** Bullet hitting a block somewhere (own or other players' shots). */
  playBulletImpact(volume: number): void {
    if (volume <= 0.03) return;
    this.noiseBurst(1600 + Math.random() * 600, 1.2, 0.05, Math.min(1, volume) * 0.3);
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

/** Volume 0..1 for another player's gunshot: full close by, fading out over 60 blocks. */
export function gunVolume(distance: number): number {
  return Math.max(0, 1 - distance / 60) ** 1.5;
}
