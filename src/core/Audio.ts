import { Ambience, type ListenerState } from './audio/ambience';
import { STEP_VOLUME, landingKind, landingVolume, splashVolume, type MoveMode } from './audio/cadence';
import { AudioEnvironment, createEnvironment } from './audio/environment';
import { buildMix, makeNoiseBuffers, type Mix } from './audio/mixer';
import { MusicDirector } from './audio/music';
import type { MusicMode } from './audio/musicTheory';
import { SOUND_PROFILES, pickVariant, profileFor, type BlockSound, type BlockSoundKind } from './audio/profiles';
import { MAX_HEAR_DISTANCE, distanceCutoff, distanceGain, occlusionCutoff, occlusionGain, panFor } from './audio/spatial';
import { Synth, type UiSoundName } from './audio/synth';
import { Priority, VoiceLimiter } from './audio/voiceLimiter';

export type { BlockSound } from './audio/profiles';
export { SOUND_PROFILES } from './audio/profiles';
export type { MusicMode } from './audio/musicTheory';
export type { UiSoundName } from './audio/synth';

export interface Vec3 { x: number; y: number; z: number }

/** Called for every sound (also when audio is muted or locked): name like `block.break.stone`, position NaN when not positional. */
export type SoundListener = (name: string, x: number, y: number, z: number, volume: number) => void;

export type ArmorMaterial = 'leather' | 'chain' | 'iron' | 'gold' | 'diamond';

/** Counts solid blocks on the line between two points (for occlusion); installed by the game. */
export type OcclusionProbe = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => number;

/** Most simultaneous oscillator/noise voices; beyond it the least important voice is dropped. */
const MAX_VOICES = 64;
/** Occlusion raycasts per frame (each is at most ~32 block reads). */
const PROBES_PER_FRAME = 6;

/**
 * Fully procedural audio (no audio assets). The engine owns the Web Audio graph; the sound design lives in
 * `./audio/*`: block profiles (`SOUND_PROFILES`), synth voices, ambience, generative music, spatial math.
 * Mob and weapon sounds below are plain `voice()` / `noiseBurst()` recipes: add yours in `playMob` / `playGun`.
 *
 * Every public play method also reports its sound to the listeners ({@link addSoundListener}) so subtitles
 * can show it, even when the sound itself is muted.
 */
/** Mob sound events (see entities/Mob.ts MobSound). */
export type MobSoundEvent = 'idle' | 'hurt' | 'death' | 'fuse' | 'angry' | 'teleport';

export class AudioEngine {
  private ctx: BaseAudioContext | null = null;
  private offline = false;
  private mix!: Mix;
  private synth!: Synth;
  private ambience!: Ambience;
  private music!: MusicDirector;
  private limiter = new VoiceLimiter(MAX_VOICES);

  private soundVolume = 0.8;
  private musicVolume = 0.5;
  private ambientVolume = 0.8;
  private uiVolume = 0.8;
  private userSuspended = false;
  private gestureInstalled = false;

  /** Surroundings of the listener; the game fills it a few times per second (see WorldAudioProbe). */
  readonly env: AudioEnvironment = createEnvironment();
  private readonly listener: ListenerState = { x: 0, y: 0, z: 0, yaw: 0 };
  private hrtf = false;
  private probe: OcclusionProbe | null = null;
  private probeBudget = PROBES_PER_FRAME;
  private armor: ArmorMaterial | null = null;
  private readonly lastVariant = new Map<string, number>();
  private readonly listeners = new Set<SoundListener>();
  /** Single-listener convenience hook; see also {@link addSoundListener}. */
  onSound: SoundListener | null = null;
  private weatherRain = 0;
  private weatherThunder = false;
  private weatherAuto = true;
  private pendingMode: MusicMode = 'menu';
  private pendingIntensity = 0;
  private pendingLightning: ((distance: number) => void) | null = null;

  // ---------------------------------------------------------------- lifecycle

  /** Must be called from a user gesture (browser autoplay policy). Safe to call repeatedly. */
  unlock(): void {
    if (this.offline) return;
    if (this.ctx) {
      this.resumeIfNeeded();
      return;
    }
    const Ctor: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      return;
    }
    this.attach(ctx);
    // iOS Safari only unlocks after something is actually started inside the gesture.
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start(0);
    } catch { /* not fatal */ }
    this.resumeIfNeeded();
    ctx.addEventListener('statechange', () => {
      // iOS reports 'interrupted' after a call or a lock screen: resume on the next gesture.
      if (ctx.state !== 'running' && !this.userSuspended) this.installGestureUnlock();
    });
  }

  /**
   * Browsers (Safari/iOS in particular) only allow audio to start from certain gestures, and may suspend
   * the context again later. Listens for touch/pointer/key/click and (re)starts audio. Idempotent.
   */
  installGestureUnlock(target: Window = window): void {
    if (this.gestureInstalled) return;
    this.gestureInstalled = true;
    const handler = () => {
      if (this.userSuspended) return;
      this.unlock();
    };
    for (const ev of ['touchstart', 'touchend', 'pointerdown', 'keydown', 'click']) target.addEventListener(ev, handler, { passive: true });
  }

  private resumeIfNeeded(): void {
    const ctx = this.ctx as AudioContext | null;
    if (ctx && !this.userSuspended && ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => undefined);
  }

  /**
   * Build the graph on any BaseAudioContext. `unlock` does this with a real context; tests and the offline
   * renderer pass an OfflineAudioContext (`offline = true` lets sounds play without a running clock).
   */
  attach(ctx: BaseAudioContext, offline = false): void {
    if (this.ctx) return;
    this.ctx = ctx;
    this.offline = offline;
    this.mix = buildMix(ctx);
    const { white, pink, brown } = makeNoiseBuffers(ctx);
    this.synth = new Synth(ctx, this.mix.sfx, white, this.limiter);
    this.ambience = new Ambience(ctx, this.synth, this.mix.ambient, pink, brown, this.listener, (n, x, y, z, v) => this.emit(n, x, y, z, v));
    this.ambience.setWeather(this.weatherRain, this.weatherThunder, this.weatherAuto);
    this.ambience.onLightning = this.pendingLightning;
    this.music = new MusicDirector(ctx, this.mix.music, white);
    this.music.setMode(this.pendingMode);
    this.music.setIntensity(this.pendingIntensity);
    this.applyVolumes();
    if (this.hrtf) this.updateListenerNode();
  }

  /** Pause all audio while the tab is hidden (scheduled music would keep playing). */
  setSuspended(suspended: boolean): void {
    this.userSuspended = suspended;
    const ctx = this.ctx as AudioContext | null;
    if (!ctx || this.offline) return;
    if (suspended && ctx.state === 'running') void ctx.suspend().catch(() => undefined);
    else if (!suspended && ctx.state !== 'running') void ctx.resume().catch(() => undefined);
  }

  /** Category volumes 0..100 (the game multiplies master in). `ambient` and `ui` default to `sound`. */
  setVolumes(sound: number, music: number, ambient = sound, ui = sound): void {
    this.soundVolume = sound / 100;
    this.musicVolume = music / 100;
    this.ambientVolume = ambient / 100;
    this.uiVolume = ui / 100;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    this.mix.sfx.gain.value = this.soundVolume * 0.5;
    this.mix.ambient.gain.value = this.ambientVolume * 0.6;
    this.mix.ui.gain.value = this.uiVolume * 0.5;
    this.mix.music.gain.value = this.musicVolume * 0.16;
  }

  private get running(): boolean {
    const ctx = this.ctx;
    return !!ctx && (this.offline || ctx.state === 'running');
  }

  private get ready(): BaseAudioContext | null {
    return this.running && this.soundVolume > 0 ? this.ctx : null;
  }

  // ---------------------------------------------------------------- events for subtitles

  /** Subscribe to every sound (name, position or NaN, loudness 0..1). Returns the unsubscribe function. */
  addSoundListener(fn: SoundListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(name: string, x: number, y: number, z: number, volume: number): void {
    this.onSound?.(name, x, y, z, volume);
    for (const l of this.listeners) l(name, x, y, z, volume);
  }

  private emitAt(name: string, at: Vec3 | undefined, volume: number): void {
    if (at) this.emit(name, at.x, at.y, at.z, volume);
    else this.emit(name, NaN, NaN, NaN, volume);
  }

  // ---------------------------------------------------------------- listener, spatial

  /** Listener (camera) position and yaw; call once per frame. Allocation-free. */
  setListener(x: number, y: number, z: number, yaw: number): void {
    const l = this.listener;
    l.x = x; l.y = y; l.z = z; l.yaw = yaw;
    if (this.hrtf) this.updateListenerNode();
  }

  /** `hrtf` uses a PannerNode with head-related transfer functions (headphones); `stereo` a simple stereo pan. */
  setSpatialMode(mode: 'stereo' | 'hrtf'): void {
    this.hrtf = mode === 'hrtf';
    if (this.hrtf) this.updateListenerNode();
  }

  /** Occlusion by blocks: `probe` returns the solid blocks between two points. Pass null to disable. */
  setOcclusionProbe(probe: OcclusionProbe | null): void {
    this.probe = probe;
  }

  private updateListenerNode(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    const s = this.listener;
    if (l.positionX) {
      l.positionX.value = s.x; l.positionY.value = s.y; l.positionZ.value = s.z;
      l.forwardX.value = -Math.sin(s.yaw); l.forwardY.value = 0; l.forwardZ.value = -Math.cos(s.yaw);
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    }
  }

  /**
   * Chain for a positional sound: distance gain, occlusion, air absorption (low-pass), pan. Returns the node
   * voices connect to, or null when the sound is out of earshot.
   */
  private spatialOut(at: Vec3, maxDist: number): AudioNode | null {
    const ctx = this.ctx!;
    const l = this.listener;
    const dx = at.x - l.x, dy = at.y - l.y, dz = at.z - l.z;
    const d = Math.hypot(dx, dy, dz);
    let gain = distanceGain(d, maxDist);
    if (gain < 0.01) return null;
    let cut = distanceCutoff(d);
    if (this.probe && d > 2 && this.probeBudget > 0) {
      this.probeBudget--;
      const solid = this.probe(l.x, l.y, l.z, at.x, at.y + 0.5, at.z);
      if (solid > 0) {
        gain *= occlusionGain(solid);
        cut *= occlusionCutoff(solid);
      }
    }
    this.synth.level = gain; // applied per voice by the synth: no gain node in the chain
    let entry: AudioNode | null = null;
    let head: AudioNode | null = null;
    if (cut < 9000) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.max(300, cut);
      entry = head = lp;
    }
    let pan: AudioNode;
    if (this.hrtf) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'linear';
      p.rolloffFactor = 0; // distance is handled above
      if (p.positionX) { p.positionX.value = at.x; p.positionY.value = at.y; p.positionZ.value = at.z; }
      pan = p;
    } else {
      const p = ctx.createStereoPanner();
      p.pan.value = panFor(dx, dz, l.yaw);
      pan = p;
    }
    if (head) head.connect(pan);
    else entry = pan;
    pan.connect(this.mix.sfx);
    return entry;
  }

  /** Run `fn` with voices routed to the sfx bus (optionally positional) at a given priority. */
  private placed(at: Vec3 | undefined, maxDist: number, priority: number, fn: () => void): void {
    if (!this.ready) return;
    const s = this.synth;
    const prev = s.priority;
    if (!this.limiter.canAccept(this.ctx!.currentTime, priority, 0.3)) {
      this.limiter.dropped++;
      return;
    }
    if (at) {
      const out = this.spatialOut(at, maxDist);
      if (!out) return;
      s.out = out;
    } else {
      s.out = this.mix.sfx;
      s.level = 1;
    }
    s.priority = priority;
    fn();
    s.out = this.mix.sfx;
    s.priority = prev;
    s.level = 1;
  }

  private pitchFor(sound: string): number {
    const [lo, hi] = profileFor(sound).pitch;
    const last = this.lastVariant.get(sound) ?? -1;
    const v = pickVariant(4, last, Math.random());
    this.lastVariant.set(sound, v);
    return lo + (hi - lo) * ((v + Math.random() * 0.8) / 4);
  }

  // ---------------------------------------------------------------- block, movement

  /** Block sound; `at` makes it positional (other players' edits), without it it is the player's own. */
  play(kind: BlockSoundKind, sound: BlockSound | string, at?: Vec3, volume = 1): void {
    this.emitAt(`block.${kind}.${sound}`, at, volume * (kind === 'hit' || kind === 'step' ? 0.4 : 1));
    this.placed(at, MAX_HEAR_DISTANCE, at ? Priority.Normal : Priority.Player, () => this.synth.block(kind, sound, volume, this.pitchFor(sound)));
  }

  /** The player's footstep on a surface; `foot` alternates 0/1 for a slight pitch change. */
  playStep(surface: BlockSound | string, mode: MoveMode = 'walk', foot = 0): void {
    this.emit(`player.step.${surface}`, NaN, NaN, NaN, 0.3 * STEP_VOLUME[mode]);
    this.placed(undefined, 0, Priority.Player, () => {
      this.synth.block('step', surface, STEP_VOLUME[mode], this.pitchFor(surface) * (foot ? 1.04 : 0.97));
      if (this.armor) this.synth.clink(this.armor, STEP_VOLUME[mode]);
    });
  }

  /** Landing after a fall of `fallDistance` blocks (nothing below 0.9). */
  playLand(surface: BlockSound | string, fallDistance: number): void {
    const v = landingVolume(fallDistance);
    if (v === null) return;
    this.emit('player.land', NaN, NaN, NaN, v);
    this.placed(undefined, 0, Priority.Player, () => this.synth.landing(surface, v, landingKind(fallDistance)));
  }

  playJump(surface: BlockSound | string): void {
    this.emit('player.jump', NaN, NaN, NaN, 0.2);
    this.placed(undefined, 0, Priority.Player, () => {
      this.synth.block('step', surface, 0.6, this.pitchFor(surface) * 1.05);
      this.synth.whoosh(0.8);
    });
  }

  /** Entering water at `speed` blocks/s downwards. */
  playSplash(speed: number): void {
    const v = splashVolume(speed);
    if (v === null) return;
    this.emit('player.splash', NaN, NaN, NaN, v);
    this.placed(undefined, 0, Priority.Player, () => this.synth.splash(v));
  }

  playSwim(): void {
    this.emit('player.swim', NaN, NaN, NaN, 0.2);
    this.placed(undefined, 0, Priority.Player, () => this.synth.swim());
  }

  /** Armour material worn by the player (null = none): every step clinks. Hook for the future armour system. */
  setArmor(material: ArmorMaterial | null): void {
    this.armor = material;
  }

  /** Armour clink on its own (equip, hit). */
  playArmorClink(material: ArmorMaterial = this.armor ?? 'iron'): void {
    this.emit('player.armor', NaN, NaN, NaN, 0.2);
    this.placed(undefined, 0, Priority.Player, () => this.synth.clink(material));
  }

  // ---------------------------------------------------------------- UI

  /** One entry point for interface sounds (see `src/ui/uiSound.ts`). */
  playUi(name: UiSoundName): void {
    this.emit(`ui.${name}`, NaN, NaN, NaN, 0.2);
    if (!this.running || this.uiVolume <= 0) return;
    const s = this.synth;
    const prev = s.priority;
    s.out = this.mix.ui;
    s.priority = Priority.Ui;
    s.ui(name);
    s.out = this.mix.sfx;
    s.priority = prev;
  }

  // ---------------------------------------------------------------- music, weather

  setMusicMode(mode: MusicMode): void {
    this.pendingMode = mode;
    this.music?.setMode(mode);
  }

  /** Arcade pulse strength 0..1 (1 while the match is `live`). */
  setMusicIntensity(v: number): void {
    this.pendingIntensity = v;
    this.music?.setIntensity(v);
  }

  /** Rain 0..1 and whether there is a thunderstorm (random distant thunder unless `autoThunder` is false). */
  setWeather(rain: number, thunder: boolean, autoThunder = true): void {
    this.weatherRain = rain;
    this.weatherThunder = thunder;
    this.weatherAuto = autoThunder;
    this.ambience?.setWeather(rain, thunder, autoThunder);
  }

  /** One thunderclap `distance` blocks away (arrives later the further it is). */
  /** Thunder by loudness (0..1) instead of distance; the weather system works with volumes. */
  playThunderRumble(volume: number): void {
    this.playThunder(Math.max(0, 1 - Math.min(1, volume)) * 120);
  }

  playThunder(distance: number): void {
    if (!this.running || this.ambientVolume <= 0) {
      this.emit('weather.thunder', NaN, NaN, NaN, 0.5);
      return;
    }
    this.ambience.playThunder(distance);
  }

  /** Called when the internal storm timer fires a lightning strike: sync the flash with the sound. */
  setLightningHandler(fn: ((distance: number) => void) | null): void {
    this.pendingLightning = fn;
    if (this.ambience) this.ambience.onLightning = fn;
  }

  // Fire crackle near the listener is driven by `env.fireDist` (set by the world probe); nothing to call.

  // ---------------------------------------------------------------- recipes (voice / noise)

  private voice(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0): void {
    if (!this.ready) return;
    this.synth.tone(type, f0, f1, dur, vol, delay);
  }

  private noiseBurst(freq: number, q: number, dur: number, vol: number, type: BiquadFilterType = 'bandpass', delay = 0): void {
    if (!this.ready) return;
    this.synth.noiseBurst(freq, q, dur, vol, type, delay);
  }

  /**
   * Mob sounds, synthesised per kind. Pass `at` (the mob or message position) for positional sound; without
   * it `volume` already includes the distance falloff.
   */
  playMob(kind: string, event: MobSoundEvent, volume: number, at?: Vec3): void {
    this.emitAt(`mob.${kind}.${event}`, at, volume);
    if (!at && volume <= 0.02) return;
    // Babies (a mob passed as `at` with baby set) speak half an octave higher, like Minecraft's 1.5x pitch.
    const pitch = (at as { baby?: boolean } | undefined)?.baby ? 1.5 : 1;
    this.placed(at, 28, Priority.Normal, () => this.mobRecipe(kind, event, at ? 1 : volume, pitch));
  }

  private mobRecipe(kind: string, event: MobSoundEvent, volume: number, pitch = 1): void {
    const v = volume * (event === 'idle' ? 0.5 : 0.7);
    const p = (0.9 + Math.random() * 0.2) * pitch;
    switch (kind) {
      case 'wolf':
        if (event === 'angry') {
          // Growl: low rumbling saw with noise.
          this.voice('sawtooth', 110 * p, 90 * p, 0.7, v * 0.5);
          this.noiseBurst(350 * p, 1.2, 0.6, v * 0.3);
        } else if (event === 'hurt' || event === 'death') {
          // Whine: a falling squeal.
          this.voice('triangle', 900 * p, event === 'death' ? 300 * p : 600 * p, event === 'death' ? 0.7 : 0.25, v * 0.5);
        } else {
          // Bark: two short punchy notes.
          this.voice('square', 420 * p, 260 * p, 0.09, v * 0.35);
          this.noiseBurst(900 * p, 1, 0.08, v * 0.25);
          this.voice('square', 400 * p, 240 * p, 0.09, v * 0.3, 0.22);
        }
        break;
      case 'enderman':
        if (event === 'teleport') {
          this.voice('sine', 300 * p, 1200 * p, 0.35, v * 0.4);
          this.noiseBurst(2500, 0.5, 0.3, v * 0.2, 'bandpass');
        } else if (event === 'angry') {
          // Scream: detuned high saws.
          this.voice('sawtooth', 820 * p, 700 * p, 0.9, v * 0.3);
          this.voice('sawtooth', 860 * p, 650 * p, 0.9, v * 0.25);
        } else {
          // "Vwoop" murmurs: a pitch-bent sine pair.
          this.voice('sine', 160 * p, 320 * p, 0.3, v * 0.4);
          this.voice('sine', 330 * p, 150 * p, 0.3, v * 0.3, 0.25);
        }
        break;
      case 'slime':
        // Squish: low filtered noise and a wet blip.
        this.noiseBurst(500 * p, 1.5, 0.15, v * 0.45);
        this.voice('sine', 180 * p, 90 * p, 0.12, v * 0.35);
        break;
      case 'witch':
        // Cackle: rising-falling triangle chirps.
        for (let i = 0; i < (event === 'idle' ? 3 : 2); i++) this.voice('triangle', 520 * p, 380 * p, 0.09, v * 0.35, i * 0.12);
        break;
      case 'horse':
        if (event === 'hurt' || event === 'death') this.voice('sawtooth', 480 * p, 260 * p, 0.4, v * 0.4);
        else {
          // Whinny: a fast wobbling falling tone.
          for (let i = 0; i < 4; i++) this.voice('sawtooth', (620 - i * 60) * p, (560 - i * 60) * p, 0.1, v * 0.3, i * 0.08);
        }
        break;
      case 'husk':
      case 'drowned':
        this.mobRecipe('zombie', event, volume, (kind === 'drowned' ? 0.85 : 0.9) * pitch);
        return;
      case 'stray':
        this.mobRecipe('skeleton', event, volume, 0.9 * pitch);
        return;
      case 'cave_spider':
        this.mobRecipe('spider', event, volume, 1.3 * pitch);
        return;
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

  /** Footstep of a mob on `surface`, quiet and pitched by body type. */
  playMobStep(kind: string, surface: BlockSound | string, at: Vec3): void {
    const body = MOB_STEP[kind] ?? MOB_STEP.default;
    this.emitAt(`mob.${kind}.step`, at, body.vol);
    this.placed(at, 18, Priority.Ambient, () => {
      this.synth.block('step', surface, body.vol, this.pitchFor(surface) * body.pitch);
      if (kind === 'spider') this.noiseBurst(3200, 1, 0.03, 0.05, 'highpass');
      if (kind === 'skeleton') this.voice('triangle', 1400, 900, 0.03, 0.04);
    });
  }

  playHurt(): void {
    this.emit('player.hurt', NaN, NaN, NaN, 0.5);
    this.placed(undefined, 0, Priority.Player, () => {
      this.voice('square', 220, 120, 0.12, 0.35);
      this.noiseBurst(600, 1, 0.1, 0.3);
    });
  }

  playExplosion(volume: number, at?: Vec3): void {
    const v = Math.min(1, volume);
    this.emitAt('explosion', at, v);
    this.placed(at, 90, Priority.Player, () => {
      const p = 0.92 + Math.random() * 0.16;
      this.noiseBurst(120 * p, 0.5, 1.7, v * 1.1, 'lowpass');
      this.noiseBurst(900 * p, 0.7, 0.5, v * 0.6);
      this.noiseBurst(2400, 0.5, 0.18, v * 0.4, 'highpass');
      this.voice('sine', 70 * p, 28, 1.1, v * 0.8);
      // Debris rattling down a moment later.
      if (this.ready) this.synth.noiseBurst(1300, 0.6, 0.6, v * 0.3, 'bandpass', 0.18, { grains: 6 });
      this.noiseBurst(200, 0.6, 1.1, v * 0.4, 'lowpass', 0.25);
    });
  }

  /** Bow release: a short twang. */
  playBow(power: number): void {
    this.emit('weapon.bow', NaN, NaN, NaN, power);
    this.placed(undefined, 0, Priority.Player, () => {
      this.voice('triangle', 520 + power * 200, 180, 0.18, 0.35);
      this.noiseBurst(1800, 0.9, 0.12, 0.25);
    });
  }

  /** Arrow thunk into a block or mob. */
  playArrowHit(volume: number, at?: Vec3): void {
    this.emitAt('weapon.arrow_hit', at, volume);
    if (!at && volume <= 0) return;
    this.placed(at, 32, Priority.Normal, () => this.noiseBurst(700, 1.4, 0.07, Math.min(1, at ? 1 : volume) * 0.45));
  }

  /** Flint and steel strike, then the TNT fuse hiss. */
  playIgnite(volume: number): void {
    this.emit('block.ignite', NaN, NaN, NaN, volume);
    this.placed(undefined, 0, Priority.Player, () => {
      this.noiseBurst(2600, 1.2, 0.08, Math.min(1, volume) * 0.5);
      this.noiseBurst(3500, 0.6, 1.4, Math.min(1, volume) * 0.5, 'highpass', 0.05);
    });
  }

  /** Advancement toast: a short rising chime. */
  playAdvancement(): void {
    this.playUi('advancement');
  }

  /** A door swinging open (creak) or shut (thud); `volume` 0..1. */
  playDoor(open: boolean, volume = 1): void {
    this.emit(open ? 'block.door.open' : 'block.door.close', NaN, NaN, NaN, volume);
    this.placed(undefined, 0, Priority.Player, () => {
      if (open) {
        this.voice('triangle', 150, 210, 0.1, 0.1 * volume);
        this.noiseBurst(520, 1.2, 0.12, 0.28 * volume);
      } else {
        this.noiseBurst(230, 1, 0.1, 0.55 * volume, 'lowpass');
        this.voice('sine', 95, 60, 0.1, 0.3 * volume);
      }
    });
  }

  /** Lever, button or pressure plate click (higher when switching on). `at` makes it positional. */
  playClick(on: boolean, at?: Vec3): void {
    this.emitAt(on ? 'block.click.on' : 'block.click.off', at, 0.4);
    this.placed(at, 16, at ? Priority.Normal : Priority.Player, () => {
      this.voice('square', on ? 1500 : 1150, on ? 1300 : 950, 0.03, 0.12);
      this.noiseBurst(on ? 3200 : 2600, 2, 0.03, 0.18);
    });
  }

  /** Piston pushing out (or pulling back): a wooden thump with a short slide. */
  playPiston(extend: boolean, at?: Vec3): void {
    this.emitAt(extend ? 'block.piston.extend' : 'block.piston.contract', at, 0.5);
    this.placed(at, 16, at ? Priority.Normal : Priority.Player, () => {
      this.noiseBurst(extend ? 420 : 360, 1.1, 0.16, 0.45, 'lowpass');
      this.voice('triangle', extend ? 180 : 140, extend ? 120 : 200, 0.12, 0.2);
      this.noiseBurst(1600, 0.8, 0.12, 0.12, 'bandpass', 0.02);
    });
  }

  /**
   * Note block: `rate` is Minecraft's pitch multiplier (0.5 … 2, F♯3 … F♯5 around a base of F♯4 = 370 Hz), the instrument
   * picks the timbre (by the block under it).
   */
  playNote(instrument: string, rate: number, at?: Vec3): void {
    this.emitAt(`block.note.${instrument}`, at, 0.6);
    const f = 370 * rate;
    this.placed(at, 48, at ? Priority.Normal : Priority.Player, () => {
      switch (instrument) {
        case 'basedrum': this.voice('sine', f / 4, f / 8, 0.18, 0.5); this.noiseBurst(200, 1, 0.08, 0.3, 'lowpass'); break;
        case 'snare': this.noiseBurst(f * 4, 0.8, 0.12, 0.35); break;
        case 'hat': this.noiseBurst(f * 12, 2, 0.05, 0.25, 'highpass'); break;
        case 'bass': this.voice('triangle', f / 4, f / 4, 0.4, 0.45); break;
        case 'guitar': this.voice('sawtooth', f / 2, f / 2, 0.35, 0.18); break;
        case 'chime': case 'bell': this.voice('sine', f * 2, f * 2, 0.9, 0.25); this.voice('sine', f * 5.4, f * 5.4, 0.4, 0.06); break;
        case 'flute': this.voice('sine', f * 2, f * 2, 0.45, 0.25); break;
        default: this.voice('triangle', f, f, 0.5, 0.3); this.voice('sine', f * 2, f * 2, 0.25, 0.08); break;
      }
    });
  }

  /** Lava meeting water: a short hiss. */
  playFizz(volume: number): void {
    this.emit('block.fizz', NaN, NaN, NaN, volume);
    if (volume <= 0.02) return;
    this.placed(undefined, 0, Priority.Normal, () => {
      this.noiseBurst(4200, 0.5, 0.5, 0.35 * volume, 'highpass');
      this.noiseBurst(1200, 0.8, 0.25, 0.2 * volume);
    });
  }

  /** A bucket filled from or emptied into a liquid. */
  playBucket(lava: boolean): void {
    this.emit(lava ? 'item.bucket.lava' : 'item.bucket.water', NaN, NaN, NaN, 0.4);
    this.placed(undefined, 0, Priority.Player, () => {
      this.noiseBurst(lava ? 500 : 1400, 0.7, 0.3, 0.4, 'bandpass');
      this.voice('sine', lava ? 140 : 260, lava ? 90 : 150, 0.2, 0.15);
    });
  }

  playPop(): void {
    this.emit('item.pickup', NaN, NaN, NaN, 0.25);
    this.placed(undefined, 0, Priority.Player, () => this.voice('sine', 900 + Math.random() * 400, 1800, 0.08, 0.25));
  }

  playEat(): void {
    this.emit('player.eat', NaN, NaN, NaN, 0.4);
    this.placed(undefined, 0, Priority.Player, () => this.noiseBurst(1600, 0.8, 0.09, 0.4));
  }

  playBurp(): void {
    this.emit('player.burp', NaN, NaN, NaN, 0.3);
    this.placed(undefined, 0, Priority.Player, () => this.voice('sawtooth', 110, 80, 0.3, 0.3));
  }

  // ---------------------------------------------------------------- arcade weapons

  /**
   * Gunshot per weapon; `volume` 0..1 already includes the distance falloff for other players'
   * shots (see {@link gunVolume}); pass `at` instead to place the shot in the stereo field.
   * Each weapon gets its own mix of crack, body and thump.
   */
  playGun(weapon: string, volume: number, at?: Vec3): void {
    this.emitAt(`weapon.${weapon}`, at, volume);
    if (volume <= 0.02) return;
    const own = volume >= 0.99 && !at;
    this.placed(at, 60, own ? Priority.Player : Priority.Normal, () => this.gunRecipe(weapon, Math.min(1, volume)));
  }

  private gunRecipe(weapon: string, v: number): void {
    const p = 0.95 + Math.random() * 0.1;
    // Far shots: only the crack (one voice); the body and thump are inaudible at that range anyway.
    if (this.synth.level < 0.5 && weapon !== 'sniper' && weapon !== 'shotgun' && weapon !== 'revolver') {
      this.noiseBurst(weapon === 'pistol' ? 2400 : 2800 * p, 0.8, 0.06, v * 0.6);
      return;
    }
    switch (weapon) {
      case 'rifle':
        this.noiseBurst(2200 * p, 0.7, 0.09, v * 0.7);
        this.noiseBurst(500, 0.6, 0.12, v * 0.5, 'lowpass');
        this.voice('sine', 150 * p, 55, 0.1, v * 0.6);
        break;
      case 'smg':
        this.noiseBurst(3000 * p, 0.8, 0.05, v * 0.55);
        if (this.synth.level >= 0.75) this.voice('square', 260 * p, 110, 0.05, v * 0.25);
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
      case 'dmr':
        this.noiseBurst(2600 * p, 0.6, 0.1, v * 0.8);
        this.noiseBurst(420, 0.5, 0.25, v * 0.7, 'lowpass');
        this.voice('sine', 110 * p, 40, 0.2, v * 0.8);
        break;
      case 'burst':
        this.noiseBurst(2800 * p, 0.7, 0.06, v * 0.6);
        this.noiseBurst(600, 0.6, 0.08, v * 0.4, 'lowpass');
        this.voice('sine', 160 * p, 60, 0.07, v * 0.5);
        break;
      case 'revolver':
        this.noiseBurst(1800 * p, 0.6, 0.12, v * 0.9);
        this.noiseBurst(380, 0.5, 0.3, v * 0.8, 'lowpass');
        this.voice('sine', 95 * p, 36, 0.25, v * 0.9);
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
    this.emit('weapon.reload', NaN, NaN, NaN, 0.25);
    this.placed(undefined, 0, Priority.Player, () => {
      const click = (f: number, delay: number, vol: number) => {
        this.voice('square', f, f * 0.45, 0.025, vol, delay);
        this.noiseBurst(f * 1.5, 1.5, 0.03, vol * 0.8, 'bandpass', delay);
      };
      click(1100, 0.05, 0.22);
      click(800, Math.max(0.1, reloadSec * 0.55), 0.26);
      click(1400, Math.max(0.2, reloadSec - 0.15), 0.22);
    });
  }

  /** Trigger on an empty magazine. */
  playEmpty(): void {
    this.emit('weapon.empty', NaN, NaN, NaN, 0.2);
    this.placed(undefined, 0, Priority.Player, () => this.voice('square', 900, 400, 0.03, 0.2));
  }

  /** White tick when your bullet hits a player; higher and doubled for a headshot. */
  playHitMarker(head: boolean): void {
    this.emit('weapon.hitmarker', NaN, NaN, NaN, 0.35);
    this.placed(undefined, 0, Priority.Player, () => {
      this.voice('sine', head ? 2400 : 1700, head ? 2400 : 1700, 0.05, 0.35);
      if (head) this.voice('sine', 3200, 3200, 0.06, 0.28, 0.045);
    });
  }

  /** Kill confirmation: a bright two-note ding. */
  playKillDing(): void {
    this.emit('weapon.kill', NaN, NaN, NaN, 0.35);
    this.placed(undefined, 0, Priority.Player, () => {
      this.voice('sine', 1318, 1318, 0.28, 0.32);
      this.voice('sine', 1760, 1760, 0.32, 0.3, 0.08);
      this.voice('triangle', 2637, 2637, 0.2, 0.12, 0.08);
    });
  }

  /**
   * Arcade objective cue (flag taken, zone captured, round won ...): `good` = your side gained, `bad` = it lost,
   * `alarm` = your flag is on the move, `neutral` = something to notice (the hill moved, a round starts).
   */
  playModeCue(kind: 'good' | 'bad' | 'alarm' | 'neutral'): void {
    this.emit(`arcade.cue.${kind}`, NaN, NaN, NaN, 0.35);
    this.placed(undefined, 0, Priority.Ui, () => {
      if (kind === 'good') {
        this.voice('triangle', 784, 784, 0.16, 0.26);
        this.voice('triangle', 988, 988, 0.16, 0.26, 0.1);
        this.voice('triangle', 1319, 1319, 0.3, 0.24, 0.2);
      } else if (kind === 'bad') {
        this.voice('triangle', 659, 659, 0.18, 0.24);
        this.voice('triangle', 523, 523, 0.18, 0.24, 0.12);
        this.voice('triangle', 392, 392, 0.32, 0.22, 0.24);
      } else if (kind === 'alarm') {
        for (let i = 0; i < 3; i++) {
          this.voice('square', 880, 880, 0.12, 0.12, i * 0.24);
          this.voice('square', 660, 660, 0.12, 0.12, i * 0.24 + 0.12);
        }
      } else {
        this.voice('sine', 1047, 1047, 0.22, 0.22);
        this.voice('sine', 1568, 1568, 0.3, 0.16, 0.09);
      }
    });
  }

  /** Little whoosh when you respawn. */
  playSpawn(): void {
    this.emit('player.spawn', NaN, NaN, NaN, 0.2);
    this.placed(undefined, 0, Priority.Player, () => this.voice('sine', 300, 900, 0.25, 0.18));
  }

  /** Bullet hitting a block somewhere (own or other players' shots). */
  playBulletImpact(volume: number, at?: Vec3): void {
    this.emitAt('weapon.impact', at, volume);
    if (volume <= 0.03) return;
    this.placed(at, 40, Priority.Ambient, () => this.noiseBurst(1600 + Math.random() * 600, 1.2, 0.05, Math.min(1, volume) * 0.3));
  }

  // ---------------------------------------------------------------- per frame

  /** Per-frame upkeep: ambience, music, mix parameters. Keep this cheap (< 0.3 ms). */
  update(dt: number): void {
    this.probeBudget = PROBES_PER_FRAME;
    const ctx = this.ctx;
    if (!ctx || !this.running) return;
    const env = this.env;
    const now = ctx.currentTime;
    this.mix.waterLP.frequency.setTargetAtTime(env.underwater ? 650 : 20000, now, env.underwater ? 0.05 : 0.12);
    if (this.ambientVolume > 0 || this.soundVolume > 0) this.ambience.update(dt, env);
    this.mix.caveWet.gain.setTargetAtTime(this.ambience.cave * 0.55, now, 0.5);
    this.music.setContext(env.biome, env.dayFactor, this.ambience.cave, env.underwater);
    this.music.update(dt, this.musicVolume > 0);
  }

  // ---------------------------------------------------------------- debug, tests

  /** One-line report for the F3 overlay. */
  debugLine(): string {
    if (!this.ctx) return 'audio: locked';
    const l = this.limiter;
    return `audio: ${this.ctx.state} voices ${l.activeCount(this.ctx.currentTime)}/${l.max} drop ${l.dropped} steal ${l.stolen} loops ${this.ambience.activeLoops}`;
  }

  /** Internals for the offline renderer and tests. */
  get internals(): { synth: Synth; ambience: Ambience; music: MusicDirector; limiter: VoiceLimiter; mix: Mix } {
    return { synth: this.synth, ambience: this.ambience, music: this.music, limiter: this.limiter, mix: this.mix };
  }
}

/** Mob footstep character: loudness and pitch of the block step sound. */
const MOB_STEP: Record<string, { vol: number; pitch: number }> = {
  pig: { vol: 0.3, pitch: 1.0 },
  cow: { vol: 0.42, pitch: 0.8 },
  sheep: { vol: 0.28, pitch: 0.95 },
  chicken: { vol: 0.2, pitch: 1.6 },
  zombie: { vol: 0.45, pitch: 0.85 },
  skeleton: { vol: 0.35, pitch: 1.15 },
  creeper: { vol: 0.3, pitch: 1.0 },
  spider: { vol: 0.2, pitch: 1.4 },
  default: { vol: 0.3, pitch: 1.0 },
};

/** Volume 0..1 for another player's gunshot: full close by, fading out over 60 blocks. */
export function gunVolume(distance: number): number {
  return Math.max(0, 1 - distance / 60) ** 1.5;
}

/** Keep the registry reachable for tools that list every sound type. */
export const BLOCK_SOUND_TYPES = Object.keys(SOUND_PROFILES) as BlockSound[];
