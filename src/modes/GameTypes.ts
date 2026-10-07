/**
 * Multiplayer game types. "minecraft" is the sandbox (survival/creative/hardcore, building,
 * mobs). The arcade types are shooters on a fixed arena, in the spirit of Krunker: fast movement,
 * hitscan weapons, health that regenerates, respawns and a scoreboard.
 *
 * Every arcade type is one `GameTypeDef` (pure data: teams, respawn rules, loadout rules, round
 * structure, scoring, HUD widgets, menu options) plus one `ModeLogic` class on the server
 * (`server/modes/<id>.ts`) that implements the rules the data cannot express.
 */
export type GameType =
  | 'minecraft' | 'tdm' | 'ffa' | 'gungame' | 'elimination' | 'hardpoint' | 'domination' | 'ctf'
  | 'killconfirmed' | 'snd' | 'infected' | 'sharpshooter' | 'koth';

export type Team = 'red' | 'blue';

/** Which server class implements the rules (server/modes/*). */
export type ModeLogicId = 'deathmatch' | 'gungame' | 'rounds' | 'zones' | 'ctf' | 'confirm' | 'snd' | 'infected' | 'sharpshooter' | 'koth';

/** What a map must define to host a type (zones, flags, bomb sites); other maps are hidden/skipped for it. */
export type MapFeature = 'zones' | 'flags' | 'sites';

/** `timer`: respawn after `seconds`. `never`: dead until the round is over (spectate). */
export type RespawnRule = 'timer' | 'never';

/** Widgets the client HUD draws for a type. */
export type HudWidget = 'score' | 'zones' | 'flags' | 'rounds' | 'ladder' | 'alive' | 'tags' | 'bomb' | 'infected' | 'roulette';

export interface GameTypeDef {
  id: GameType;
  name: string;
  description: string;
  /** Fixed arena, weapons, no building and no mobs. */
  arcade: boolean;
  teams: boolean;
  /** Defaults for the match settings shown when creating a game. */
  scoreLimit: number;
  timeLimitSec: number;
  /** Rules class; absent on the sandbox. */
  logic?: ModeLogicId;
  /** The unit of `scoreLimit` ("kills", "points", "captures", "rounds", "levels"). */
  scoreUnit?: string;
  /** Choices offered in Create Game for the score limit and the time limit (seconds). Empty score = no score option. */
  options?: { score: number[]; scoreLabel: string; time: number[]; timeLabel: string };
  respawn?: { rule: RespawnRule; seconds: number; protectionSec: number };
  /** Round structure (only for round-based types), all in seconds. */
  rounds?: {
    /** Result banner after a round. */
    postSec: number;
    /** Between rounds: everybody is back at spawn and may change weapon, nobody can be hurt. */
    intermissionSec: number;
    /** Final "3-2-1" before the round goes live (nobody can be hurt). 0 = none. */
    countdownSec: number;
  };
  /** Who chooses the weapons: `free` = the player (loadout menu), `ladder` = the mode (no choice). */
  loadout?: 'free' | 'ladder';
  /** Weapon ids per level (gun game); the last one must be the knife. */
  ladder?: string[];
  friendlyFire?: boolean;
  /** Map data this type needs. */
  requires?: MapFeature[];
  /** Mode-specific numbers: capture times, flag return time, ... */
  params?: Record<string, number>;
  /** Points per kill / per objective action (capture, flag return). */
  scoring?: { kill: number; objective: number };
  /** Client HUD widgets besides the always-present health/ammo/kill feed. */
  hud?: HudWidget[];
  /** Header of the objective column in the scoreboard ("Caps", "Level"); absent = none. */
  scoreColumn?: string;
  /** What the two teams are called when they are roles rather than colours (infected: survivors and infected). */
  teamRoles?: { red: string; blue: string };
}

/**
 * The gun game weapon ladder, ending with the knife. Sniper and shotgun levels are never adjacent.
 * Starts with all-rounders (a shotgun first made the first kill take a minute on big open maps, docs/qa/ARCADE.md) and
 * ends on one-hit weapons, so the finish is tense and fair: a one-pump shotgun, the one-headshot revolver, the one-shot
 * bolt-action sniper, then the one-stab knife that wins (GUN_GAME_FINALE).
 */
export const GUN_GAME_FINALE = ['shotgun', 'revolver', 'sniper', 'knife'];
export const GUN_GAME_LADDER: string[] = [
  'rifle', 'smg', 'battle', 'lmg', 'burst', 'dmr', 'shotgun', 'mpistol', 'semisniper',
  'lever', 'smg', 'rifle', 'pistol', 'antimat', 'burst', ...GUN_GAME_FINALE,
];

/**
 * Sharpshooter: the weapons everybody may be handed (one at a time, the same for all). Every primary of the
 * arsenal; the knife and the plain pistol stay out (a 45 s knife fight is no fun on a big map).
 */
export const SHARPSHOOTER_POOL: string[] = ['rifle', 'smg', 'shotgun', 'lmg', 'burst', 'dmr', 'semisniper', 'sniper', 'revolver', 'mpistol'];

const minutes = (...m: number[]) => m.map((x) => x * 60);

export const GAME_TYPES: GameTypeDef[] = [
  {
    id: 'minecraft', name: 'Minecraft', description: 'Build, mine and survive together in a shared world',
    arcade: false, teams: false, scoreLimit: 0, timeLimitSec: 0,
  },
  {
    id: 'tdm', name: 'Team Deathmatch', description: 'Red against blue on an arena: first team to the score limit wins',
    arcade: true, teams: true, scoreLimit: 30, timeLimitSec: 600,
    logic: 'deathmatch', scoreUnit: 'kills',
    options: { score: [10, 20, 30, 50], scoreLabel: 'Score Limit', time: minutes(5, 10, 15), timeLabel: 'Time Limit' },
    respawn: { rule: 'timer', seconds: 2.5, protectionSec: 2 }, loadout: 'free', friendlyFire: false,
    scoring: { kill: 1, objective: 0 }, hud: ['score'],
  },
  {
    id: 'ffa', name: 'Free For All', description: 'Everyone for themselves: first to the score limit wins',
    arcade: true, teams: false, scoreLimit: 20, timeLimitSec: 600,
    logic: 'deathmatch', scoreUnit: 'kills',
    options: { score: [10, 20, 30, 50], scoreLabel: 'Score Limit', time: minutes(5, 10, 15), timeLabel: 'Time Limit' },
    respawn: { rule: 'timer', seconds: 2.5, protectionSec: 2 }, loadout: 'free', friendlyFire: true,
    scoring: { kill: 1, objective: 0 }, hud: ['score'],
  },
  {
    id: 'gungame', name: 'Gun Game', description: 'Every kill gives you the next weapon, a knife kill sets the victim back: be first through the ladder',
    arcade: true, teams: false, scoreLimit: GUN_GAME_LADDER.length, timeLimitSec: 600,
    logic: 'gungame', scoreUnit: 'levels',
    options: { score: [], scoreLabel: '', time: minutes(5, 8, 10, 15), timeLabel: 'Time Limit' },
    respawn: { rule: 'timer', seconds: 1.5, protectionSec: 1 }, loadout: 'ladder', ladder: GUN_GAME_LADDER, friendlyFire: true,
    scoring: { kill: 1, objective: 0 }, hud: ['ladder'], scoreColumn: 'Level',
  },
  {
    id: 'elimination', name: 'Team Elimination', description: 'Rounds with one life each: wipe the other team to win the round, first to the round limit wins',
    arcade: true, teams: true, scoreLimit: 4, timeLimitSec: 90,
    logic: 'rounds', scoreUnit: 'rounds',
    options: { score: [2, 3, 4, 5], scoreLabel: 'Rounds to Win', time: [60, 90, 120], timeLabel: 'Round Time' },
    respawn: { rule: 'never', seconds: 0, protectionSec: 2 }, loadout: 'free', friendlyFire: false,
    rounds: { postSec: 4, intermissionSec: 5, countdownSec: 3 },
    scoring: { kill: 0, objective: 1 }, hud: ['rounds', 'alive'],
  },
  {
    id: 'hardpoint', name: 'Hardpoint', description: 'Hold the hill: it moves every minute, only the team that stands alone in it scores',
    arcade: true, teams: true, scoreLimit: 250, timeLimitSec: 600,
    logic: 'zones', scoreUnit: 'points',
    options: { score: [100, 150, 250], scoreLabel: 'Score Limit', time: minutes(5, 10, 15), timeLabel: 'Time Limit' },
    respawn: { rule: 'timer', seconds: 3, protectionSec: 2 }, loadout: 'free', friendlyFire: false,
    requires: ['zones'], params: { rotateSec: 60, gapSec: 5, pointsPerSec: 1 },
    scoring: { kill: 0, objective: 1 }, hud: ['score', 'zones'],
  },
  {
    id: 'domination', name: 'Domination', description: 'Capture and hold the points on the map: every point you own scores',
    arcade: true, teams: true, scoreLimit: 100, timeLimitSec: 600,
    logic: 'zones', scoreUnit: 'points',
    options: { score: [50, 100, 150], scoreLabel: 'Score Limit', time: minutes(5, 10, 15), timeLabel: 'Time Limit' },
    respawn: { rule: 'timer', seconds: 3, protectionSec: 2 }, loadout: 'free', friendlyFire: false,
    requires: ['zones'], params: { captureSec: 6, pointEverySec: 2 },
    scoring: { kill: 0, objective: 1 }, hud: ['score', 'zones'],
  },
  {
    id: 'ctf', name: 'Capture the Flag', description: 'Steal the enemy flag and bring it home while yours is safe: first to the capture limit wins',
    arcade: true, teams: true, scoreLimit: 3, timeLimitSec: 600,
    logic: 'ctf', scoreUnit: 'captures',
    options: { score: [1, 3, 5], scoreLabel: 'Captures to Win', time: minutes(5, 8, 10, 15), timeLabel: 'Time Limit' },
    respawn: { rule: 'timer', seconds: 3, protectionSec: 2 }, loadout: 'free', friendlyFire: false,
    requires: ['flags'], params: { carrySlow: 0.1, returnSec: 12, touchRadius: 1.6 },
    scoring: { kill: 0, objective: 1 }, hud: ['score', 'flags'], scoreColumn: 'Caps',
  },
  {
    id: 'killconfirmed', name: 'Kill Confirmed', description: 'A kill only counts when you pick up the tag it drops; grab your fallen teammates\' tags to deny',
    arcade: true, teams: true, scoreLimit: 50, timeLimitSec: 600,
    logic: 'confirm', scoreUnit: 'confirms',
    options: { score: [30, 50, 75], scoreLabel: 'Score Limit', time: minutes(5, 10, 15), timeLabel: 'Time Limit' },
    respawn: { rule: 'timer', seconds: 3, protectionSec: 2 }, loadout: 'free', friendlyFire: false,
    params: { tagSec: 30, touchRadius: 1.6 },
    scoring: { kill: 0, objective: 1 }, hud: ['score', 'tags'], scoreColumn: 'Tags',
  },
  {
    id: 'snd', name: 'Search & Destroy', description: 'One life per round: attackers plant the bomb at A or B, defenders stop them or defuse it; sides swap at half time',
    arcade: true, teams: true, scoreLimit: 4, timeLimitSec: 120,
    logic: 'snd', scoreUnit: 'rounds',
    options: { score: [2, 3, 4, 6], scoreLabel: 'Rounds to Win', time: [90, 120, 150], timeLabel: 'Round Time' },
    respawn: { rule: 'never', seconds: 0, protectionSec: 2 }, loadout: 'free', friendlyFire: false,
    rounds: { postSec: 5, intermissionSec: 6, countdownSec: 3 },
    requires: ['sites'], params: { plantSec: 4, defuseSec: 6, fuseSec: 35 },
    scoring: { kill: 0, objective: 1 }, hud: ['rounds', 'alive', 'bomb'], scoreColumn: 'Bomb',
  },
  {
    id: 'infected', name: 'Infected', description: 'One player starts infected: every survivor they kill joins them. Survive the clock to win',
    arcade: true, teams: true, scoreLimit: 0, timeLimitSec: 300,
    logic: 'infected', scoreUnit: 'survivors',
    options: { score: [], scoreLabel: '', time: minutes(3, 5, 8), timeLabel: 'Time Limit' },
    respawn: { rule: 'timer', seconds: 2, protectionSec: 1.5 }, loadout: 'free', friendlyFire: false,
    // outbreakSec: the infection begins this long after the start; infectedSpeed: run pace of the infected;
    // knifeMul: the infected's knife damage (one stab kills); lastBonus: points for the last survivor.
    params: { outbreakSec: 8, infectedSpeed: 1.12, knifeMul: 2, lastBonus: 3 },
    scoring: { kill: 1, objective: 0 }, hud: ['infected'], scoreColumn: 'Points',
    teamRoles: { red: 'Infected', blue: 'Survivors' },
  },
  {
    id: 'sharpshooter', name: 'Sharpshooter', description: 'Everyone gets the same random weapon, and it changes every 45 seconds',
    arcade: true, teams: false, scoreLimit: 30, timeLimitSec: 600,
    logic: 'sharpshooter', scoreUnit: 'kills',
    options: { score: [20, 30, 40], scoreLabel: 'Score Limit', time: minutes(5, 10, 15), timeLabel: 'Time Limit' },
    respawn: { rule: 'timer', seconds: 2, protectionSec: 1.5 }, loadout: 'ladder', friendlyFire: true,
    params: { rotateSec: 45 },
    scoring: { kill: 1, objective: 0 }, hud: ['score', 'roulette'],
  },
  {
    id: 'koth', name: 'King of the Hill', description: 'Free for all on a moving hill: only the player standing in it alone scores',
    arcade: true, teams: false, scoreLimit: 60, timeLimitSec: 600,
    logic: 'koth', scoreUnit: 'points',
    options: { score: [45, 60, 90], scoreLabel: 'Score Limit', time: minutes(5, 10, 15), timeLabel: 'Time Limit' },
    respawn: { rule: 'timer', seconds: 3, protectionSec: 1.5 }, loadout: 'free', friendlyFire: true,
    requires: ['zones'], params: { rotateSec: 45, gapSec: 4, pointsPerSec: 1 },
    scoring: { kill: 0, objective: 1 }, hud: ['zones'], scoreColumn: 'Points',
  },
];

export function gameTypeDef(id: GameType): GameTypeDef {
  return GAME_TYPES.find((g) => g.id === id) ?? GAME_TYPES[0];
}

export function parseGameType(v: unknown): GameType {
  return GAME_TYPES.some((g) => g.id === v) ? (v as GameType) : 'minecraft';
}

/** Team colours (sRGB hex) for name tags, models and the HUD. */
export const TEAM_COLORS: Record<Team, string> = { red: '#e0463c', blue: '#3c7ae0' };
