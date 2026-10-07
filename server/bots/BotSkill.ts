import { BOT_LEVELS, type BotLevel } from '../../src/modes/Realms';

/**
 * Bot difficulty: human-like limits on perception and aim. Every number is a *limit* a person has too
 * (reaction time, how fast and how precisely the mouse moves, how wide they look), never extra knowledge:
 * bots see only what has a line of sight, hear only shots and hits, and shoot through the same server
 * validation as a player.
 *
 * The values are tuned by the simulated duels in tests/botBalance.test.ts: easy loses clearly to an average
 * player, veteran is strong but loses to a skilled one.
 */
export type BotDifficulty = BotLevel;
export const BOT_DIFFICULTIES: BotDifficulty[] = BOT_LEVELS;

export function parseBotDifficulty(v: unknown): BotDifficulty | null {
  return BOT_DIFFICULTIES.includes(v as BotDifficulty) ? (v as BotDifficulty) : null;
}

export interface BotSkill {
  /** Seconds from first seeing an enemy to the first shot (mean; each sighting varies ±25%). */
  reaction: number;
  /** Highest turn rate of the view (degrees per second). Below the anti-cheat's snap rate (600) by design. */
  turnSpeed: number;
  /** How quickly the view closes in on the aim point (1/s, exponential). */
  aimRate: number;
  /** Standard deviation (degrees) of the slowly drifting aim error while tracking. */
  aimError: number;
  /** Extra error (degrees) right after acquiring a target; decays over `settle` seconds. */
  acquireError: number;
  settle: number;
  /** The target is perceived this many seconds late (tracking lag on movers). */
  trackLag: number;
  /** Chance per engagement to aim at the head instead of the chest. */
  headChance: number;
  /** Fires once the view is within this many target half-widths of the (perceived) aim point. */
  fireCone: number;
  /** Clicks per second on semi-automatic weapons. */
  maxCps: number;
  /** Half angle (degrees) of the view cone in which enemies are noticed; within NEAR they are always noticed. */
  fov: number;
  /** Farthest distance at which an enemy is noticed (blocks). */
  noticeRange: number;
  /** Disengages for cover below this health (0 = never). */
  retreatHealth: number;
  /** 0..1: how much the bot strafes in a fight (0 = walks straight on). */
  strafe: number;
  /** Aims down the sights at range. */
  ads: boolean;
}

export const BOT_SKILLS: Record<BotDifficulty, BotSkill> = {
  easy: {
    reaction: 0.7, turnSpeed: 170, aimRate: 4, aimError: 3.4, acquireError: 14, settle: 0.7, trackLag: 0.24,
    headChance: 0.04, fireCone: 3.2, maxCps: 3, fov: 55, noticeRange: 45, retreatHealth: 0, strafe: 0.15, ads: false,
  },
  normal: {
    reaction: 0.45, turnSpeed: 260, aimRate: 6, aimError: 2.1, acquireError: 10, settle: 0.5, trackLag: 0.16,
    headChance: 0.12, fireCone: 2.4, maxCps: 4.5, fov: 65, noticeRange: 60, retreatHealth: 30, strafe: 0.45, ads: true,
  },
  hard: {
    reaction: 0.32, turnSpeed: 360, aimRate: 8, aimError: 1.35, acquireError: 7, settle: 0.4, trackLag: 0.11,
    headChance: 0.2, fireCone: 1.8, maxCps: 6, fov: 75, noticeRange: 75, retreatHealth: 40, strafe: 0.7, ads: true,
  },
  veteran: {
    reaction: 0.25, turnSpeed: 450, aimRate: 10, aimError: 0.95, acquireError: 5, settle: 0.32, trackLag: 0.08,
    headChance: 0.28, fireCone: 1.4, maxCps: 7, fov: 80, noticeRange: 90, retreatHealth: 45, strafe: 0.85, ads: true,
  },
};

/** Enemies this close are always noticed (footsteps), whatever the view direction. */
export const NOTICE_NEAR = 6;

/** A skill with a little personal variation (±`spread`) so a lobby of one difficulty is not a row of clones. */
export function skillFor(d: BotDifficulty, rng: () => number, spread = 0.1): BotSkill {
  const s = { ...BOT_SKILLS[d] };
  const k = 1 + (rng() * 2 - 1) * spread;
  // Better on one axis is usually better on the others too: one factor for the whole profile.
  s.reaction *= k; s.aimError *= k; s.acquireError *= k; s.trackLag *= k;
  s.turnSpeed = Math.min(560, s.turnSpeed / k);
  return s;
}

const CALLSIGNS = [
  'Viper', 'Hawk', 'Ghost', 'Rook', 'Nova', 'Blitz', 'Echo', 'Raven', 'Talon', 'Frost', 'Onyx', 'Jinx', 'Scout', 'Bolt',
  'Ember', 'Moss', 'Flint', 'Sable', 'Rogue', 'Dusk', 'Comet', 'Pike', 'Wren', 'Brick', 'Gale', 'Spud', 'Nugget', 'Pixel',
];

/** Display name prefix: brackets are not allowed in player names, so nobody can pose as a bot (or a bot as a player). */
export const BOT_PREFIX = '[BOT] ';

/** A call sign not used by anybody in `taken` (lower case names). */
export function botName(taken: ReadonlySet<string>, rng: () => number): string {
  const start = Math.floor(rng() * CALLSIGNS.length);
  for (let i = 0; i < CALLSIGNS.length; i++) {
    const n = BOT_PREFIX + CALLSIGNS[(start + i) % CALLSIGNS.length];
    if (!taken.has(n.toLowerCase())) return n;
  }
  for (let k = 2; ; k++) {
    const n = `${BOT_PREFIX}${CALLSIGNS[start]}${k}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}
