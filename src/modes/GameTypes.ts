/**
 * Multiplayer game types. "minecraft" is the sandbox (survival/creative/hardcore, building,
 * mobs). The arcade types are round-based shooters on a fixed arena, in the spirit of Krunker:
 * fast movement, hitscan weapons, health that regenerates, respawns and a scoreboard.
 */
export type GameType = 'minecraft' | 'tdm' | 'ffa';

export type Team = 'red' | 'blue';

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
}

export const GAME_TYPES: GameTypeDef[] = [
  {
    id: 'minecraft', name: 'Minecraft', description: 'Build, mine and survive together in a shared world',
    arcade: false, teams: false, scoreLimit: 0, timeLimitSec: 0,
  },
  {
    id: 'tdm', name: 'Team Deathmatch', description: 'Red against blue on an arena: first team to the score limit wins',
    arcade: true, teams: true, scoreLimit: 30, timeLimitSec: 600,
  },
  {
    id: 'ffa', name: 'Free For All', description: 'Everyone for themselves: first to the score limit wins',
    arcade: true, teams: false, scoreLimit: 20, timeLimitSec: 600,
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
