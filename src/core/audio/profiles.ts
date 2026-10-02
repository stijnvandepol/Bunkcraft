/**
 * Sound profiles for blocks. A new block only declares a `sound` type in the BlockRegistry; to add a
 * brand new type, add one entry to {@link SOUND_PROFILES} below (the `BlockSound` union follows from it).
 * Pure data, no Web Audio, so it is importable from the world code and from tests.
 */

export type NoiseFilter = 'bandpass' | 'highpass' | 'lowpass';

export interface ToneLayer {
  /** Partial frequencies (Hz), played together. */
  freqs: number[];
  wave: 'sine' | 'triangle' | 'square';
  /** Decay time in seconds. */
  decay: number;
  gain: number;
  /** Random start offset per partial (s): gives glass shards and metal rings their scatter. */
  scatter?: number;
}

export interface SoundProfile {
  /** Main noise layer: the "material". */
  noise: { type: NoiseFilter; freq: number; q: number; gain: number };
  /** Second noise layer through a resonant band-pass: the "body" of the hit (wood knock, stone clack). */
  body?: { freq: number; q: number; gain: number };
  /** Sine thump that glides down (Hz), the weight of the block. */
  thump?: number;
  /** Short tonal parts (ring of metal, tink of glass). */
  tone?: ToneLayer;
  /** Break/place are made of this many grains of the noise layer (gravel, sand, snow, leaves crunch). */
  grains?: number;
  /** Pitch randomisation range (multiplier). */
  pitch: [number, number];
  /** Overall level. */
  gain: number;
  /** How long break/place last relative to the default (1). */
  length?: number;
  /** Footsteps are this much louder/softer than the base step level (1). */
  stepGain?: number;
}

const p = (lo: number, hi: number): [number, number] => [lo, hi];

export const SOUND_PROFILES = {
  stone: { noise: { type: 'bandpass', freq: 1500, q: 0.9, gain: 0.8 }, body: { freq: 420, q: 4, gain: 0.55 }, thump: 110, pitch: p(0.9, 1.12), gain: 0.9 },
  wood: { noise: { type: 'bandpass', freq: 700, q: 1.6, gain: 0.7 }, body: { freq: 260, q: 7, gain: 0.9 }, thump: 150, pitch: p(0.88, 1.15), gain: 1.0, stepGain: 1.5 },
  grass: { noise: { type: 'bandpass', freq: 2800, q: 0.55, gain: 0.7 }, body: { freq: 900, q: 0.8, gain: 0.25 }, grains: 3, pitch: p(0.85, 1.2), gain: 0.7, stepGain: 0.9 },
  gravel: { noise: { type: 'bandpass', freq: 1700, q: 0.7, gain: 0.9 }, body: { freq: 420, q: 1.2, gain: 0.4 }, grains: 5, pitch: p(0.85, 1.2), gain: 0.85 },
  sand: { noise: { type: 'highpass', freq: 2400, q: 0.4, gain: 0.55 }, body: { freq: 1300, q: 0.6, gain: 0.25 }, grains: 4, pitch: p(0.9, 1.15), gain: 0.55 },
  glass: { noise: { type: 'highpass', freq: 3400, q: 0.6, gain: 0.5 }, tone: { freqs: [2400, 3100, 4300, 5200], wave: 'triangle', decay: 0.16, gain: 0.22, scatter: 0.05 }, grains: 4, pitch: p(0.92, 1.12), gain: 0.65, stepGain: 0.7 },
  wool: { noise: { type: 'lowpass', freq: 750, q: 0.5, gain: 0.9 }, thump: 90, pitch: p(0.9, 1.1), gain: 0.8, stepGain: 1.2 },
  snow: { noise: { type: 'bandpass', freq: 2100, q: 0.45, gain: 0.6 }, body: { freq: 700, q: 0.7, gain: 0.3 }, grains: 4, pitch: p(0.88, 1.1), gain: 0.6, stepGain: 0.85 },
  // Added with the audio rework: new content only has to pick one of these.
  metal: { noise: { type: 'bandpass', freq: 3000, q: 1.8, gain: 0.35 }, body: { freq: 900, q: 6, gain: 0.5 }, tone: { freqs: [820, 1730, 2650, 3900], wave: 'sine', decay: 0.32, gain: 0.2, scatter: 0.004 }, thump: 130, pitch: p(0.92, 1.1), gain: 0.85, length: 1.3 },
  ladder: { noise: { type: 'bandpass', freq: 900, q: 2, gain: 0.55 }, body: { freq: 520, q: 9, gain: 0.7 }, pitch: p(0.9, 1.2), gain: 0.75, length: 0.8, stepGain: 1.5 },
  bamboo: { noise: { type: 'bandpass', freq: 1500, q: 2.4, gain: 0.5 }, body: { freq: 640, q: 14, gain: 1.0 }, tone: { freqs: [660, 1320], wave: 'sine', decay: 0.09, gain: 0.18 }, pitch: p(0.9, 1.25), gain: 0.85, length: 0.9, stepGain: 1.3 },
  dirt: { noise: { type: 'bandpass', freq: 950, q: 0.7, gain: 0.85 }, body: { freq: 300, q: 1.5, gain: 0.5 }, thump: 95, grains: 2, pitch: p(0.85, 1.15), gain: 0.85 },
  wetgrass: { noise: { type: 'bandpass', freq: 1600, q: 0.8, gain: 0.7 }, body: { freq: 500, q: 1.4, gain: 0.5 }, grains: 3, pitch: p(0.8, 1.1), gain: 0.75 },
  water: { noise: { type: 'bandpass', freq: 1200, q: 0.9, gain: 0.7 }, body: { freq: 380, q: 3, gain: 0.5 }, grains: 4, pitch: p(0.8, 1.25), gain: 0.7, length: 1.2 },
} as const satisfies Record<string, SoundProfile>;

/** Every sound type a block can declare. Extend {@link SOUND_PROFILES} to add one. */
export type BlockSound = keyof typeof SOUND_PROFILES;

export type BlockSoundKind = 'break' | 'place' | 'step' | 'hit';

export const BLOCK_SOUND_KINDS: readonly BlockSoundKind[] = ['break', 'place', 'step', 'hit'];

/** Per-kind shape: duration, level and grain share. */
export const KIND_SHAPE: Record<BlockSoundKind, { dur: number; vol: number; grainShare: number; tone: boolean; thump: boolean }> = {
  break: { dur: 0.26, vol: 0.95, grainShare: 1, tone: true, thump: true },
  place: { dur: 0.14, vol: 0.8, grainShare: 0.6, tone: false, thump: true },
  hit: { dur: 0.07, vol: 0.45, grainShare: 0.3, tone: false, thump: false },
  step: { dur: 0.1, vol: 0.7, grainShare: 0.4, tone: false, thump: false },
};

/** Profile for a sound type; unknown types (bad data) fall back to stone instead of throwing. */
export function profileFor(sound: string): SoundProfile {
  return (SOUND_PROFILES as Record<string, SoundProfile>)[sound] ?? SOUND_PROFILES.stone;
}

export function isBlockSound(sound: string): sound is BlockSound {
  return Object.prototype.hasOwnProperty.call(SOUND_PROFILES, sound);
}

/**
 * Footstep surface for the block under the player. Blocks without a solid cube under them
 * (liquids, ladders) override the block's own sound type.
 */
export function stepSurface(sound: BlockSound | string, opts: { inWater?: boolean; onLadder?: boolean } = {}): BlockSound {
  if (opts.onLadder) return 'ladder';
  if (opts.inWater) return 'water';
  return isBlockSound(sound) ? sound : 'stone';
}

/**
 * Pick a variant index in [0, n) that differs from the last one played (no immediate repeats).
 * `r` is a random number in [0, 1).
 */
export function pickVariant(n: number, last: number, r: number): number {
  if (n <= 1) return 0;
  const k = Math.min(n - 2, Math.floor(r * (n - 1)));
  return k >= last && last >= 0 ? k + 1 : k;
}
