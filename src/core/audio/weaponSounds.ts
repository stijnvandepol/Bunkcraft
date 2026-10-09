/**
 * Weapon sound design as data (no Web Audio here, so it is testable): every gunshot is three layers
 * plus a tail, built from the engine's two primitives (filtered noise and gliding tones):
 *
 *   transient  short bright noise crack (the supersonic snap / muzzle blast), < 0.1 s
 *   body       band-limited noise and a falling sine thump (the weight of the cartridge)
 *   tail       long low-passed noise: outdoors an echo with a late slap off the far walls,
 *              indoors (AudioEnvironment.enclosure) a few early reflections and a short bright room
 *
 * A far shot is not just a quieter near shot: past FAR_LEVEL it switches to a distant recipe (a soft
 * pop and a muffled boom), and the spatial chain low-passes it further with distance and walls.
 */

import { t } from '../../ui/i18n';

export interface GunSound {
  /** Transient: band-pass centre (Hz), Q, seconds, gain. */
  crack: readonly [number, number, number, number];
  /** Body noise: low-pass cut-off (Hz), Q, seconds, gain. */
  body: readonly [number, number, number, number];
  /** Thump: sine from f0 to f1 (Hz) in seconds, gain. */
  thump: readonly [number, number, number, number];
  /** Tail: low-pass cut-off (Hz), seconds, gain. */
  tail: readonly [number, number, number];
  /** Action click heard close by (Hz; 0 = none) and its gain. */
  mech: readonly [number, number];
  /** Blocks at which the shot fades out completely. */
  earshot: number;
}

export const GUN_SOUNDS: Record<string, GunSound> = {
  rifle: { crack: [2300, 0.7, 0.07, 0.7], body: [600, 0.6, 0.12, 0.55], thump: [150, 55, 0.11, 0.6], tail: [420, 0.55, 0.32], mech: [2600, 0.12], earshot: 90 },
  smg: { crack: [3100, 0.8, 0.045, 0.55], body: [800, 0.7, 0.07, 0.4], thump: [180, 75, 0.06, 0.42], tail: [520, 0.35, 0.22], mech: [3200, 0.14], earshot: 70 },
  shotgun: { crack: [1500, 0.5, 0.11, 0.85], body: [340, 0.5, 0.3, 0.85], thump: [100, 36, 0.3, 0.9], tail: [300, 0.9, 0.5], mech: [0, 0], earshot: 100 },
  lmg: { crack: [2000, 0.6, 0.08, 0.72], body: [480, 0.6, 0.16, 0.65], thump: [125, 45, 0.15, 0.72], tail: [380, 0.7, 0.36], mech: [1900, 0.16], earshot: 100 },
  burst: { crack: [2800, 0.7, 0.055, 0.6], body: [650, 0.6, 0.08, 0.42], thump: [165, 60, 0.07, 0.5], tail: [460, 0.45, 0.26], mech: [2900, 0.1], earshot: 85 },
  dmr: { crack: [2600, 0.6, 0.09, 0.8], body: [450, 0.5, 0.24, 0.7], thump: [110, 40, 0.2, 0.8], tail: [360, 0.8, 0.4], mech: [2200, 0.12], earshot: 120 },
  semisniper: { crack: [3000, 0.55, 0.1, 0.9], body: [400, 0.45, 0.32, 0.8], thump: [95, 34, 0.3, 0.9], tail: [330, 1.0, 0.45], mech: [2000, 0.12], earshot: 140 },
  sniper: { crack: [3400, 0.5, 0.12, 1.0], body: [350, 0.4, 0.5, 0.9], thump: [80, 28, 0.45, 1.0], tail: [280, 1.3, 0.55], mech: [0, 0], earshot: 160 },
  battle: { crack: [2100, 0.65, 0.085, 0.8], body: [520, 0.55, 0.17, 0.7], thump: [120, 44, 0.16, 0.78], tail: [400, 0.7, 0.38], mech: [2300, 0.13], earshot: 110 },
  lever: { crack: [2000, 0.6, 0.09, 0.82], body: [420, 0.5, 0.26, 0.75], thump: [105, 38, 0.22, 0.82], tail: [340, 0.85, 0.42], mech: [0, 0], earshot: 115 },
  antimat: { crack: [3000, 0.45, 0.16, 1.0], body: [260, 0.35, 0.6, 1.0], thump: [60, 22, 0.6, 1.0], tail: [220, 1.6, 0.6], mech: [0, 0], earshot: 200 },
  pistol: { crack: [2600, 0.8, 0.05, 0.6], body: [700, 0.7, 0.08, 0.4], thump: [130, 60, 0.07, 0.35], tail: [520, 0.35, 0.2], mech: [3400, 0.14], earshot: 60 },
  mpistol: { crack: [3300, 0.9, 0.04, 0.5], body: [900, 0.7, 0.06, 0.32], thump: [190, 85, 0.05, 0.32], tail: [600, 0.3, 0.18], mech: [3600, 0.14], earshot: 55 },
  revolver: { crack: [1800, 0.6, 0.1, 0.9], body: [380, 0.5, 0.3, 0.8], thump: [95, 36, 0.25, 0.9], tail: [320, 0.8, 0.42], mech: [0, 0], earshot: 100 },
};

/** Fallback for an unknown weapon id. */
export const DEFAULT_GUN_SOUND = GUN_SOUNDS.rifle;

/** A suppressor: earshot and loudness drop, the crack becomes a "thwip". */
export const SUPPRESSED_EARSHOT = 24;
export const SUPPRESSED_GAIN = 0.45;
/** Below this distance gain a positional shot uses the distant recipe. */
export const FAR_LEVEL = 0.45;

export function gunSound(id: string): GunSound {
  return GUN_SOUNDS[id] ?? DEFAULT_GUN_SOUND;
}

/** Blocks at which a shot of this weapon fades out (suppressed shots carry much less far). */
export function gunEarshot(id: string, suppressed: boolean): number {
  if (id === 'knife') return 16;
  return suppressed ? SUPPRESSED_EARSHOT : gunSound(id).earshot;
}

/**
 * How the tail is split by the room: 0 = open air (long echo, late slap), 1 = small closed room
 * (early reflections, short tail). Returns the outdoor share; the indoor share is 1 minus it.
 */
export function outdoorShare(enclosure: number): number {
  const t = Math.min(1, Math.max(0, (enclosure - 0.3) / 0.35));
  return 1 - t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- mechanical sounds

/** Weapon handling sounds (reload steps, bolt, dry fire, aiming). */
export type MechKind =
  | 'magout' | 'magin' | 'charge' | 'boltup' | 'boltback' | 'boltfwd' | 'shell' | 'pump'
  | 'cylopen' | 'cylclose' | 'eject' | 'coveropen' | 'coverclose' | 'belt' | 'dry' | 'adsin' | 'adsout' | 'switch' | 'scopein' | 'zoom';

export const MECH_KINDS: readonly MechKind[] = [
  'magout', 'magin', 'charge', 'boltup', 'boltback', 'boltfwd', 'shell', 'pump', 'cylopen', 'cylclose', 'eject', 'coveropen', 'coverclose', 'belt',
  'dry', 'adsin', 'adsout', 'switch', 'scopein', 'zoom',
];

/** Reload sequences: [progress 0..1, sound]. Each weapon class has its own. */
export type ReloadStep = readonly [number, MechKind];

const MAG_RELOAD: readonly ReloadStep[] = [[0.12, 'magout'], [0.58, 'magin'], [0.86, 'charge']];
const PISTOL_RELOAD: readonly ReloadStep[] = [[0.1, 'magout'], [0.62, 'magin'], [0.88, 'boltfwd']];

export const RELOAD_STEPS: Record<string, readonly ReloadStep[]> = {
  rifle: MAG_RELOAD,
  smg: MAG_RELOAD,
  burst: MAG_RELOAD,
  dmr: MAG_RELOAD,
  semisniper: [[0.12, 'magout'], [0.55, 'magin'], [0.8, 'boltback'], [0.9, 'boltfwd']],
  lmg: [[0.08, 'coveropen'], [0.22, 'magout'], [0.5, 'magin'], [0.64, 'belt'], [0.8, 'coverclose'], [0.92, 'charge']],
  shotgun: [[0.16, 'shell'], [0.32, 'shell'], [0.48, 'shell'], [0.64, 'shell'], [0.8, 'shell'], [0.92, 'pump']],
  sniper: [[0.08, 'boltup'], [0.18, 'boltback'], [0.34, 'magout'], [0.62, 'magin'], [0.82, 'boltfwd'], [0.92, 'boltup']],
  battle: MAG_RELOAD,
  lever: [[0.12, 'shell'], [0.28, 'shell'], [0.44, 'shell'], [0.6, 'shell'], [0.76, 'shell'], [0.9, 'boltback'], [0.96, 'boltfwd']],
  antimat: [[0.06, 'boltup'], [0.16, 'boltback'], [0.3, 'magout'], [0.6, 'magin'], [0.84, 'boltfwd'], [0.94, 'boltup']],
  pistol: PISTOL_RELOAD,
  mpistol: PISTOL_RELOAD,
  revolver: [[0.1, 'cylopen'], [0.24, 'eject'], [0.45, 'shell'], [0.58, 'shell'], [0.72, 'shell'], [0.88, 'cylclose']],
};

export function reloadSteps(id: string): readonly ReloadStep[] {
  return RELOAD_STEPS[id] ?? MAG_RELOAD;
}

/** Seconds after a bolt-action shot when the bolt is worked (up/back, then forward/down). */
export const BOLT_DELAY = 0.32;
/** Seconds from the bolt coming back to it closing again. */
export const BOLT_FORWARD = 0.2;

/**
 * When a bolt or lever cycles after a shot: back after `delay`, forward `forward` later, both squeezed so the whole cycle ends
 * before the next shot can go out (the 0.5 s lever carbine used to fire again before its bolt closed: a lost sound, a restarted
 * animation). `anim` is how long the hand's animation may take.
 */
export function boltTimes(intervalSec: number): { delay: number; forward: number; anim: number } {
  const scale = Math.min(1, (intervalSec * 0.9) / (BOLT_DELAY + BOLT_FORWARD));
  const delay = BOLT_DELAY * scale;
  // The hand's animation (BOLT_TIME in the viewmodel, 0.55 s) starts at the bolt coming back and must be done by the next shot too.
  return { delay, forward: BOLT_FORWARD * scale, anim: Math.max(0.15, Math.min(0.55, intervalSec * 0.95 - delay)) };
}

// ---------------------------------------------------------------- announcer and stingers

/** Medals for kills close together (multi-kill) and kills in one life (killstreak). */
export type AnnounceKind = 'double' | 'triple' | 'multi' | 'streak3' | 'streak5' | 'streak10' | 'headshot';

/** Seconds between two kills that still count as one multi-kill. */
export const MULTI_KILL_WINDOW = 3.5;

/** The medal (if any) for the n-th kill of a multi-kill chain and of a killstreak. Multi-kills win over streaks. */
export function medalFor(multi: number, streak: number): AnnounceKind | null {
  if (multi >= 4) return 'multi';
  if (multi === 3) return 'triple';
  if (multi === 2) return 'double';
  if (streak === 10) return 'streak10';
  if (streak === 5) return 'streak5';
  if (streak === 3) return 'streak3';
  return null;
}

export const MEDAL_TEXT: Record<AnnounceKind, string> = {
  double: 'DOUBLE KILL', triple: 'TRIPLE KILL', multi: 'MULTI KILL',
  streak3: 'KILLSTREAK 3', streak5: 'KILLSTREAK 5: RAMPAGE', streak10: 'KILLSTREAK 10: UNSTOPPABLE', headshot: 'HEADSHOT',
};

/** The medal banner text in the current language (MEDAL_TEXT is the English source). */
export function medalText(kind: AnnounceKind): string {
  return t(`arc.medal.${kind}`, MEDAL_TEXT[kind]);
}

/** Match start / end cues. */
export type StingerKind = 'start' | 'win' | 'lose' | 'draw';
