import { BIOME } from '../../world/Biomes';

/** Pure music logic for the generative score: scales, moods per context, phrase and pulse generation. */

export type MusicMode = 'menu' | 'game' | 'arcade' | 'off';
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SCALES = {
  majorPent: [0, 2, 4, 7, 9],
  minorPent: [0, 3, 5, 7, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  /** Open fifths and a second: the "empty" sound of caves and the deep. */
  sus: [0, 2, 7, 9],
} as const;

export type ScaleName = keyof typeof SCALES;

export interface Mood {
  scale: ScaleName;
  /** MIDI note of the root (a low-ish octave; phrases span ~2 octaves above). */
  root: number;
  /** Notes per phrase [min, max]. */
  notes: [number, number];
  /** Seconds of silence between phrases [min, max]. */
  gap: [number, number];
  /** Seconds between notes inside a phrase [min, max]. */
  spacing: [number, number];
  /** Velocity base 0..1. */
  vel: number;
  /** Chance of a second note (a third or fifth) played with a note. */
  harmony: number;
}

export function midiToHz(m: number): number {
  return 440 * 2 ** ((m - 69) / 12);
}

/**
 * Pick the mood for a context. Menu: warm and always something to hear. Game: modal colour per biome,
 * brighter by day, darker and sparser at night, sus/open fifths when deep underground.
 */
export function chooseMood(mode: MusicMode, biome: number, dayFactor: number, cave: number): Mood {
  if (mode === 'menu') {
    return { scale: 'majorPent', root: 48, notes: [6, 11], gap: [7, 16], spacing: [0.7, 1.5], vel: 0.34, harmony: 0.3 };
  }
  if (mode === 'arcade') {
    return { scale: 'minorPent', root: 45, notes: [4, 7], gap: [12, 28], spacing: [0.5, 1.2], vel: 0.3, harmony: 0.15 };
  }
  if (cave > 0.5) {
    return { scale: 'sus', root: 40, notes: [3, 5], gap: [50, 110], spacing: [1.4, 3.2], vel: 0.26, harmony: 0.5 };
  }
  const night = dayFactor < 0.35;
  if (night) {
    const scale: ScaleName = biome === BIOME.DESERT ? 'aeolian' : 'minorPent';
    return { scale, root: 43, notes: [3, 6], gap: [60, 130], spacing: [1.0, 2.4], vel: 0.26, harmony: 0.35 };
  }
  switch (biome) {
    case BIOME.FOREST: return { scale: 'mixolydian', root: 50, notes: [5, 9], gap: [40, 95], spacing: [0.6, 1.7], vel: 0.32, harmony: 0.3 };
    case BIOME.DESERT: return { scale: 'dorian', root: 50, notes: [4, 8], gap: [45, 100], spacing: [0.8, 2.0], vel: 0.3, harmony: 0.25 };
    case BIOME.TAIGA: return { scale: 'dorian', root: 48, notes: [4, 8], gap: [45, 100], spacing: [0.8, 2.0], vel: 0.3, harmony: 0.3 };
    case BIOME.SNOWY: return { scale: 'lydian', root: 53, notes: [4, 8], gap: [45, 105], spacing: [0.9, 2.2], vel: 0.28, harmony: 0.4 };
    case BIOME.MOUNTAINS: return { scale: 'lydian', root: 50, notes: [4, 7], gap: [50, 110], spacing: [1.0, 2.4], vel: 0.3, harmony: 0.4 };
    case BIOME.OCEAN:
    case BIOME.BEACH: return { scale: 'lydian', root: 48, notes: [4, 8], gap: [45, 100], spacing: [0.9, 2.2], vel: 0.28, harmony: 0.35 };
    default: return { scale: 'majorPent', root: 48, notes: [5, 9], gap: [40, 90], spacing: [0.6, 1.6], vel: 0.32, harmony: 0.3 };
  }
}

export interface PhraseNote {
  midi: number;
  /** Seconds after the phrase start. */
  at: number;
  /** Ring length in seconds. */
  len: number;
  vel: number;
}

/** MIDI note for a scale degree (can be negative or above the octave). */
export function scaleNote(scale: ScaleName, root: number, degree: number): number {
  const s = SCALES[scale];
  const oct = Math.floor(degree / s.length);
  const i = degree - oct * s.length;
  return root + oct * 12 + s[i];
}

/**
 * One phrase: an optional low "anchor" note, then a mostly stepwise melody that wanders a little, with the
 * odd leap and a chance of a harmony note. Rests are implicit in the spacing; the phrase ends on a ring-out.
 */
export function generatePhrase(rng: Rng, mood: Mood): PhraseNote[] {
  const out: PhraseNote[] = [];
  const s = SCALES[mood.scale];
  const [nMin, nMax] = mood.notes;
  const count = nMin + Math.floor(rng() * (nMax - nMin + 1));
  let degree = s.length + Math.floor(rng() * s.length); // second octave
  let t = 0;
  if (rng() < 0.7) {
    out.push({ midi: scaleNote(mood.scale, mood.root, [0, 0, 2][Math.floor(rng() * 3)] % s.length), at: 0, len: 7, vel: mood.vel * 1.05 });
    t = 0.4 + rng() * 0.8;
  }
  for (let i = 0; i < count; i++) {
    const r = rng();
    const step = r < 0.3 ? -1 : r < 0.6 ? 1 : r < 0.75 ? -2 : r < 0.9 ? 2 : rng() < 0.5 ? -3 : 3;
    degree = Math.max(s.length - 1, Math.min(s.length * 2 + 2, degree + step));
    const vel = mood.vel * (0.85 + rng() * 0.3);
    const len = 3 + rng() * 2;
    out.push({ midi: scaleNote(mood.scale, mood.root, degree), at: t, len, vel });
    if (rng() < mood.harmony) out.push({ midi: scaleNote(mood.scale, mood.root, degree - 2), at: t + 0.02 + rng() * 0.05, len, vel: vel * 0.6 });
    t += mood.spacing[0] + rng() * (mood.spacing[1] - mood.spacing[0]);
  }
  return out;
}

/** Seconds of silence before the next phrase. */
export function nextGap(rng: Rng, mood: Mood): number {
  return mood.gap[0] + rng() * (mood.gap[1] - mood.gap[0]);
}

// ---------------------------------------------------------------- arcade pulse

export const PULSE_BPM = 108;
/** Seconds per 16th step. */
export const PULSE_STEP = 60 / PULSE_BPM / 4;

export interface PulseEvent {
  kind: 'kick' | 'bass' | 'hat';
  /** Bass note (MIDI). */
  midi?: number;
  vel: number;
}

const BASS_DEGREES = [0, -1, 0, 2, 0, -1, 3, 2];

/**
 * Events on a 16th-note step of the arcade pulse: a soft kick on every beat, hats on off-beats, a sparse
 * minor-pentatonic bass line. Subtle: it should drive, not compete with the gunshots. Allocation-light.
 */
export function pulseAt(step: number, intensity: number, out: PulseEvent[]): number {
  out.length = 0;
  const s = step % 16;
  if (s % 4 === 0) out.push({ kind: 'kick', vel: (s === 0 ? 1 : 0.75) * intensity });
  if (s % 4 === 2) out.push({ kind: 'hat', vel: 0.5 * intensity });
  if (s % 2 === 0 && intensity > 0.3 && (s % 8 !== 6)) {
    const deg = BASS_DEGREES[(s >> 1) % BASS_DEGREES.length];
    out.push({ kind: 'bass', midi: scaleNote('minorPent', 33, deg), vel: 0.7 * intensity });
  }
  return out.length;
}
